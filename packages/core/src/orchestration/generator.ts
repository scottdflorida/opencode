export * as OrchestrationPlanGenerator from "./generator"

import path from "path"
import { LLM } from "@opencode-ai/llm"
import {
  GeneratedPlanOutput,
  type Plan,
  type PlanGeneration,
  type PlanQuestion,
  type PolicySnapshot,
  type PlanOutput,
} from "@opencode-ai/schema/orchestration"
import { Context, DateTime, Duration, Effect, Layer, Schema } from "effect"
import { Catalog } from "../catalog"
import { Global } from "../global"
import { Location } from "../location"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { Orchestration } from "../orchestration"
import { ProviderV2 } from "../provider"
import { SessionRunnerModel } from "../session/runner/model"
import { Hash } from "../util/hash"
import { OrchestrationRouting } from "./routing"
import { CodexHarness } from "./harness/codex"

const planSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["plan", "questions"] },
    rationale: { type: "string" },
    questions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          prompt: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          assumption: { type: "string" },
        },
        required: ["key", "prompt", "choices", "assumption"],
        additionalProperties: false,
      },
    },
    clauses: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: { key: { type: "string" }, description: { type: "string" } },
        required: ["key", "description"],
        additionalProperties: false,
      },
    },
    cancelTaskIDs: { type: "array", maxItems: 16, items: { type: "string" } },
    tasks: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          kind: { type: "string", enum: ["agent", "human"] },
          title: { type: "string" },
          description: { type: "string" },
          capabilityTier: { type: ["string", "null"] },
          checkPresets: { type: "array", items: { type: "string" } },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: { key: { type: "string" }, description: { type: "string" } },
              required: ["key", "description"],
              additionalProperties: false,
            },
          },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["key", "kind", "title", "description", "capabilityTier", "checkPresets", "acceptanceCriteria", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "rationale", "questions", "clauses", "cancelTaskIDs", "tasks"],
  additionalProperties: false,
} as const

export class GenerationError extends Schema.TaggedErrorClass<GenerationError>()("Orchestration.GenerationError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly generate: (input: {
    readonly runID: Orchestration.RunID
    readonly profile?: string
    readonly context?: string
  }) => Effect.Effect<Plan | { readonly kind: "questions"; readonly questions: ReadonlyArray<PlanQuestion> }, Orchestration.NotFoundError | Orchestration.InvalidPlanError | GenerationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationPlanGenerator") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const orchestration = yield* Orchestration.Service
    const routing = yield* OrchestrationRouting.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const process = yield* AppProcess.Service

    return Service.of({
      generate: Effect.fn("OrchestrationPlanGenerator.generate")(function* (input) {
        const detail = yield* orchestration.get(input.runID)
        const blockedRequest = detail.humanRequests.findLast((request) =>
          request.status === "answered" && request.time.answered &&
          (["replan", "grant-replan"].includes(request.answer ?? "") || request.answer?.startsWith("cannot:")) &&
          !detail.plans.some((plan) => plan.status === "applied" && plan.time.applied &&
            DateTime.toEpochMillis(plan.time.applied) > DateTime.toEpochMillis(request.time.answered!)),
        )
        const steered = detail.queuedFollowUps.findLast((item) =>
          item.status === "steered" && item.timeSteered &&
          !detail.plans.some((plan) => plan.status === "applied" && plan.time.applied &&
            DateTime.toEpochMillis(plan.time.applied) > DateTime.toEpochMillis(item.timeSteered!)),
        )
        const replan =
          detail.tasks.length > 0 &&
          ((["reviewing_delivery", "clarifying"].includes(detail.run.status) &&
            detail.deliveries.some((delivery) => delivery.review.decision === "gaps")) ||
            (["active", "clarifying"].includes(detail.run.status) && (!!blockedRequest || !!steered)))
        const followUp = detail.followUps.at(-1)
        const newTurn =
          followUp &&
          ["draft", "clarifying"].includes(detail.run.status) &&
          !detail.plans.some((plan) => plan.status === "applied" && DateTime.toEpochMillis(plan.time.created) > DateTime.toEpochMillis(followUp.time))
        if (!replan && !newTurn && (!["draft", "clarifying"].includes(detail.run.status) || detail.tasks.length))
          return yield* new Orchestration.InvalidPlanError({
            message: "This run is not ready for planning",
          })
        if (detail.humanRequests.some((request) => request.kind === "clarification" && !request.taskID && request.status === "open"))
          return yield* new Orchestration.InvalidPlanError({ message: "Answer open planning questions first" })
        if (detail.run.objective.length > 8_000 || (detail.run.context?.length ?? 0) + (input.context?.length ?? 0) > 12_000)
          return yield* new Orchestration.InvalidPlanError({ message: "Planning input is too long" })

        const name = input.profile ?? detail.run.policy?.roles.planner
        const profile = detail.run.policy?.routeProfiles.find((item) => item.name === name)
        if (detail.run.policy && !profile)
          return yield* new GenerationError({ message: `Route profile not found in run policy: ${name}` })
        const route = yield* (profile ? routing.resolveSnapshot(profile) : routing.resolve(name)).pipe(
          Effect.mapError((error) => new GenerationError({ message: `Route profile not found: ${error.profile}` })),
        )
        if (route.status !== "selected" || !route.selected)
          return yield* new GenerationError({ message: `Planning route is ${route.status}` })
        const candidate = route.selected
        const prompt = [
          "You are the planning agent. A separate executor will perform the proposed tasks with write access. Your own read-only access is only for inspecting the repository; it does not limit what the executor can do. Return tasks that produce the changes requested by the objective. Do not add a repository-inspection or planning task unless the objective specifically asks for that artifact. For a small one-file request, return one implementation task.",
          `Objective: ${detail.run.objective}`,
          detail.run.context ? `Assignment context: ${detail.run.context}` : "",
          input.context ? `Operator context: ${input.context}` : "",
          replan
            ? `Supplemental planning: propose only new tasks that close the gap. Do not repeat completed tasks. Existing task keys: ${JSON.stringify(detail.plans.filter((plan) => plan.status === "applied").flatMap((plan) => plan.output.tasks.map((task) => task.key)))}. Current delivery gaps: ${JSON.stringify(detail.deliveries.at(-1)?.review.clauses.filter((clause) => clause.decision !== "met").map((clause) => ({ key: clause.key, decision: clause.decision })) ?? [])}. Blocked request: ${JSON.stringify(blockedRequest ? { taskID: blockedRequest.taskID, answer: blockedRequest.answer } : undefined)}. Guidance sent to planner now: ${JSON.stringify(steered ? { objective: steered.objective, context: steered.context } : undefined)}. Current tasks and dependencies: ${JSON.stringify(detail.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, dependsOn: detail.dependencies.filter((dependency) => dependency.taskID === task.id).map((dependency) => dependency.dependsOnTaskID) })))}. Cancel only failed or unstarted tasks that you replace, including their unstarted dependents. Do not cancel a running or succeeded task. Put their exact IDs in cancelTaskIDs. The delivery clauses still cover the whole assignment and this guidance.`
            : "",
          newTurn
            ? `This is a follow-up turn on the same run branch. The previous delivery is already present in the repository. Propose only tasks for this new objective. Use task keys distinct from all prior turns: ${JSON.stringify(detail.plans.filter((plan) => plan.status === "applied").flatMap((plan) => plan.output.tasks.map((task) => task.key)))}.`
            : "",
          `Available capability tiers: ${JSON.stringify(detail.run.policy?.tiers ?? {})}. Choose one known tier per task when tiers are configured; otherwise use null.`,
          `Available check presets: ${JSON.stringify(Object.fromEntries(Object.entries(detail.run.policy?.checkPresets ?? {}).map(([name, preset]) => [name, preset.description ?? preset.checks.map((check) => check.name).join(", ")])))}. Select only these preset names. Use an empty list when none apply.`,
          detail.run.policy?.clarify === "assume"
            ? "Use reasonable assumptions for missing details and return kind plan with an empty questions array. State assumptions in the rationale."
            : "If an answer is essential to choose the correct implementation, return kind questions with 1 to 5 concise questions, each with answer choices and a default assumption; leave tasks empty. Otherwise return kind plan with an empty questions array.",
          "For kind plan, extract 1 to 8 observable clauses from the whole assignment for final delivery review. For kind questions, leave clauses, cancelTaskIDs, and tasks empty. For an initial plan or follow-up turn, leave cancelTaskIDs empty. Read relevant repository files and propose 1 to 16 concrete software engineering tasks. Use kind agent for implementation work and kind human only for a step that requires the user's own account, approval, or physical action; human tasks use null capability tier. Use unique lowercase keys with letters, digits, and hyphens. Each task needs 1 to 8 observable acceptance criteria with unique keys. Dependencies must refer to earlier task keys and form an acyclic graph. Keep titles short and descriptions actionable. Do not edit files. Do not include commands, checks, routes, model choices, or permissions in the plan.",
        ]
          .filter(Boolean)
          .join("\n\n")
        const finish = (output: GeneratedPlanOutput, generation: PlanGeneration) =>
          Effect.gen(function* () {
            if (output.kind === "questions") {
              if (detail.run.policy?.clarify === "assume")
                return yield* new Orchestration.InvalidPlanError({ message: "Policy requires assumptions and a plan" })
              if (output.tasks.length || output.clauses.length || output.cancelTaskIDs.length || output.questions.length < 1 || output.questions.length > 5)
                return yield* new Orchestration.InvalidPlanError({ message: "Question output must contain 1 to 5 questions and no tasks" })
              if (
                new Set(output.questions.map((question) => question.key)).size !== output.questions.length ||
                output.questions.some(
                  (question) =>
                    !/^[a-z][a-z0-9-]{0,39}$/.test(question.key) ||
                    !question.prompt.trim() ||
                    question.prompt.length > 500 ||
                    !question.assumption.trim() ||
                    question.assumption.length > 500 ||
                    question.choices.length > 5 ||
                    question.choices.some((choice) => !choice.trim() || choice.length > 200),
                )
              )
                return yield* new Orchestration.InvalidPlanError({ message: "Question fields are invalid" })
              yield* Effect.forEach(
                output.questions,
                (question) =>
                  orchestration.openHumanRequest({
                    runID: input.runID,
                    kind: "clarification",
                    prompt: question.prompt,
                    choices: question.choices,
                    assumption: question.assumption,
                  }),
                { discard: true },
              )
              yield* orchestration.setRunStatus({ runID: input.runID, status: "clarifying" })
              return { kind: "questions", questions: output.questions } as const
            }
            if (output.questions.length)
              return yield* new Orchestration.InvalidPlanError({ message: "Plan output must not include questions" })
            const materialized = materialize(output, detail.run.policy)
            if (materialized.status === "invalid")
              return yield* new Orchestration.InvalidPlanError({ message: materialized.message })
            if (detail.run.status === "clarifying" && !replan)
              yield* orchestration.setRunStatus({ runID: input.runID, status: "draft" })
            return yield* orchestration.proposePlan({ runID: input.runID, output: materialized.output, generation })
          })
        if (candidate.type === "harness") {
          if (candidate.harnessID !== "codex")
            return yield* new GenerationError({ message: `Planner harness ${candidate.harnessID} is not supported yet` })
          const schemaPath = AbsolutePath.make(path.join(global.tmp, "orchestration-plan-schema.json"))
          yield* Effect.tryPromise({
            try: () => Bun.write(schemaPath, JSON.stringify(planSchema)),
            catch: (error) => new GenerationError({ message: String(error) }),
          })
          const generated = yield* CodexHarness.plan({
            process,
            candidate,
            directory: replan ? detail.run.workspace?.integration.directory ?? location.directory : location.directory,
            prompt,
            schemaPath,
          }).pipe(Effect.mapError((error) => new GenerationError({ message: error.message })))
          return yield* finish(generated.object, {
              route,
              prompt,
              requestDigest: Hash.sha256(JSON.stringify({ candidate, prompt })),
              latencyMs: generated.latencyMs,
              inputTokens: generated.usage.inputTokens,
              outputTokens: generated.usage.outputTokens,
          })
        }
        const providerID = ProviderV2.ID.make(candidate.providerID)
        const modelID = ModelV2.ID.make(candidate.modelID)
        const selected = (yield* catalog.model.available()).find(
          (model) => model.providerID === providerID && model.id === modelID,
        )
        if (!selected)
          return yield* new GenerationError({
            message: `Model unavailable: ${candidate.providerID}/${candidate.modelID}`,
          })
        const provider = yield* catalog.provider.get(providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(candidate.providerID),
        )
        const credential = connection
          ? yield* integrations.connection
              .resolve(connection)
              .pipe(Effect.mapError((error) => new GenerationError({ message: error.message })))
          : undefined
        const model = yield* SessionRunnerModel.resolveRef(
          ModelV2.Ref.make({
            id: modelID,
            providerID,
            variant: candidate.variant ? ModelV2.VariantID.make(candidate.variant) : undefined,
          }),
          selected,
          credential,
        ).pipe(Effect.mapError((error) => new GenerationError({ message: error.message })))
        const started = Date.now()
        const generated = yield* LLM.generateObject({ model, prompt, schema: GeneratedPlanOutput }).pipe(
          Effect.mapError((error) => new GenerationError({ message: error.message })),
          Effect.timeoutOrElse({
            duration: Duration.seconds(90),
            orElse: () => Effect.fail(new GenerationError({ message: "Planning model timed out" })),
          }),
        )
        return yield* finish(generated.object, {
            route,
            prompt,
            requestDigest: Hash.sha256(JSON.stringify({ candidate, prompt })),
            latencyMs: Date.now() - started,
            inputTokens: generated.usage?.inputTokens,
            outputTokens: generated.usage?.outputTokens,
        })
      }),
    })
  }),
)

function materialize(output: GeneratedPlanOutput, policy?: PolicySnapshot):
  | { readonly status: "valid"; readonly output: PlanOutput }
  | { readonly status: "invalid"; readonly message: string } {
  if (output.clauses.length < 1 || output.clauses.length > 8)
    return { status: "invalid", message: "Plan needs 1 to 8 delivery clauses" }
  const tiers = policy?.tiers ?? {}
  const presets = policy?.checkPresets ?? {}
  const invalid = output.tasks.find((task) =>
    (task.kind === "human" && task.capabilityTier !== null) ||
    (task.kind === "agent" && Object.keys(tiers).length > 0 && (!task.capabilityTier || !(task.capabilityTier in tiers))) ||
    (task.kind === "agent" && Object.keys(tiers).length === 0 && task.capabilityTier !== null) ||
    task.checkPresets.some((name) => !(name in presets)) ||
    new Set(task.checkPresets).size !== task.checkPresets.length ||
    task.checkPresets.flatMap((name) => presets[name]?.checks ?? []).length > 8,
  )
  if (invalid) return { status: "invalid", message: `Task ${invalid.key} has an unknown tier or check preset` }
  return {
    status: "valid",
    output: {
      rationale: output.rationale,
      clauses: output.clauses,
      cancelTaskIDs: output.cancelTaskIDs,
      tasks: output.tasks.map((task) => ({
        key: task.key,
        kind: task.kind,
        title: task.title,
        description: task.description,
        capabilityTier: task.capabilityTier ?? undefined,
        checks: task.checkPresets.flatMap((name) => presets[name]?.checks ?? []),
        acceptanceCriteria: task.acceptanceCriteria,
        dependsOn: task.dependsOn,
      })),
    },
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Orchestration.node,
    OrchestrationRouting.node,
    Catalog.node,
    Integration.node,
    Global.node,
    Location.node,
    AppProcess.node,
    llmClient,
  ],
})
