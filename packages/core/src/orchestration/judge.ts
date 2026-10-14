export * as OrchestrationJudge from "./judge"

import path from "path"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import { LLM } from "@opencode-ai/llm"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import type { ChoiceRequest, ChoiceResult } from "@opencode-ai/schema/typed-judge"
import { Catalog } from "../catalog"
import { Global } from "../global"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { SessionRunnerModel } from "../session/runner/model"
import { TypedJudge } from "../typed-judge"
import { Hash } from "../util/hash"
import { OrchestrationExecutor } from "./executor"
import { CodexHarness } from "./harness/codex"
import { OrchestrationRouting } from "./routing"

const maximumPatchCharacters = 60_000
const maximumOutputCharacters = 2_000
const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const LlmAnswers = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ choice: Schema.String, confidence: Probability })),
})
const decisionSchema = (keys: string[]) => ({
  type: "object",
  properties: {
    answers: {
      type: "object",
      properties: Object.fromEntries(keys.map((key) => [key, {
        type: "object",
        properties: { choice: { type: "string" }, confidence: { type: "number" } },
        required: ["choice", "confidence"],
        additionalProperties: false,
      }])),
      required: keys,
      additionalProperties: false,
    },
  },
  required: ["answers"],
  additionalProperties: false,
})

export function assess(input: {
  run: Orchestration.Run
  task: Orchestration.Task
  evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>
  history?: ReadonlyArray<string>
}) {
  return input.run.policy?.roles.judge.provider === "experiment" ? assessExperiment(input) : assessSingle(input)
}

function assessSingle(input: {
  run: Orchestration.Run
  task: Orchestration.Task
  evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>
  history?: ReadonlyArray<string>
}) {
  return Effect.gen(function* () {
    const policy = input.run.policy
    if (!policy) return undefined

    const workspace = input.evaluations.find((evaluation) => evaluation.kind === "workspace")
    const patch = typeof workspace?.evidence.patch === "string" ? workspace.evidence.patch : ""
    const gateFailures = [
      ...(!patch ? ["empty_patch"] : []),
      ...(workspace?.evidence.truncated === true ? ["patch_truncated"] : []),
      ...input.evaluations
        .filter((evaluation) => evaluation.status === "failed")
        .map((evaluation) => `failed:${evaluation.kind}`),
      ...(!input.task.acceptanceCriteria.length ? ["missing_acceptance_criteria"] : []),
    ]
    if (gateFailures.length && policy.acceptance.skipJudgeOnRegression)
      return {
        decision: "revise",
        confidence: 1,
        gateFailures,
        criteria: [],
      } satisfies Orchestration.AttemptVerdict

    const state = {
      objective: input.run.objective.slice(0, 8_000),
      task: {
        title: input.task.title.slice(0, 500),
        description: input.task.description?.slice(0, 8_000) ?? null,
        acceptanceCriteria: input.task.acceptanceCriteria,
      },
      patch: patch.slice(0, maximumPatchCharacters),
      patchTruncated: patch.length > maximumPatchCharacters || workspace?.evidence.truncated === true,
      checks: input.evaluations
        .filter((evaluation) => evaluation.kind.startsWith("check:") || evaluation.kind.startsWith("harness:"))
        .map((evaluation) => ({
          kind: evaluation.kind,
          status: evaluation.status,
          command: typeof evaluation.evidence.command === "string" ? evaluation.evidence.command : null,
          stdout:
            typeof evaluation.evidence.stdout === "string"
              ? evaluation.evidence.stdout.slice(0, maximumOutputCharacters)
              : null,
          stderr:
            typeof evaluation.evidence.stderr === "string"
              ? evaluation.evidence.stderr.slice(0, maximumOutputCharacters)
              : null,
          exitCode: typeof evaluation.evidence.exitCode === "number" ? evaluation.evidence.exitCode : null,
          baselineExitCode:
            typeof evaluation.evidence.baseline === "object" &&
            evaluation.evidence.baseline !== null &&
            "exitCode" in evaluation.evidence.baseline &&
            typeof evaluation.evidence.baseline.exitCode === "number"
              ? evaluation.evidence.baseline.exitCode
              : null,
        })),
      history: input.history?.slice(-8) ?? [],
    }
    if (policy.roles.judge.provider === "llm")
      return yield* assessLlm({ run: input.run, task: input.task, state, gateFailures })
    const judge = yield* TypedJudge.Service
    const criteria = yield* Effect.forEach(
      input.task.acceptanceCriteria,
      (criterion) => {
        const request: ChoiceRequest = {
          purpose: "attempt_criterion",
          state: { ...state, criterion },
          question: {
            instructions: `Judge only acceptance criterion ${criterion.key} against the patch and checks.`,
            criteria: {
              met: "The patch and available checks support this criterion.",
              not_met: "The patch contradicts or fails this criterion.",
              unclear: "The available evidence cannot establish whether this criterion is met.",
            },
          },
          fallback: "unclear",
        }
        return judge.choice(request, { authoritative: true }).pipe(
          Effect.map((option) => {
            const result = Option.getOrElse(option, () => unavailable())
            return {
              key: criterion.key,
              decision:
                result.status === "valid" && result.answer
                  ? (result.answer.choice as "met" | "not_met" | "unclear")
                  : ("unclear" as const),
              request,
              result,
            }
          }),
        )
      },
      { concurrency: "unbounded" },
    )
    const request: ChoiceRequest = {
      purpose: "attempt_verdict",
      state,
      question: {
        instructions:
          "Choose whether this coding attempt satisfies the task. Use the patch, acceptance criteria, and check evidence.",
        criteria: {
          accept: "The attempt meets the task and its acceptance criteria with sufficient evidence.",
          revise: "The attempt needs changes or more verification before acceptance.",
          needs_human: "A human decision or missing external information is required to proceed.",
        },
      },
      fallback: "revise",
    }
    const result = Option.getOrElse(yield* judge.choice(request, { authoritative: true }), () => unavailable())
    const answer = result.status === "valid" ? result.answer : undefined
    const decision =
      gateFailures.length ||
      !answer ||
      (answer.choice === "accept" &&
        (answer.confidence < policy.acceptance.minConfidence ||
          criteria.some((criterion) => criterion.decision !== "met")))
        ? "revise"
        : answer.choice === "needs_human"
          ? "needs_human"
          : answer.choice === "accept"
            ? "accept"
            : "revise"
    return {
      decision,
      confidence: answer?.confidence ?? 0,
      gateFailures,
      criteria,
      overall: { request, result },
    } satisfies Orchestration.AttemptVerdict
  })
}

function assessExperiment(input: {
  run: Orchestration.Run
  task: Orchestration.Task
  evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>
  history?: ReadonlyArray<string>
}) {
  return Effect.gen(function* () {
    const experiment = input.run.policy?.roles.judge.experiment
    if (!experiment) return undefined
    const names = Object.keys(experiment.arms).sort()
    if (!names.length) return undefined
    const assignment = Number.parseInt(Hash.sha256(`${experiment.seed}:${input.task.id}`).slice(0, 8), 16)
    const authoritativeArm = experiment.authoritative === "random"
      ? names[assignment % names.length]!
      : experiment.authoritative
    const selected = experiment.assignment === "split" ? [authoritativeArm] : names
    const arms = yield* Effect.forEach(selected, (name) => Effect.gen(function* () {
      const role = experiment.arms[name]
      if (!role || !input.run.policy) return { arm: name, verdict: {
        decision: "revise" as const,
        confidence: 0,
        gateFailures: ["judge_arm_missing"],
        criteria: [],
      } }
      const run = {
        ...input.run,
        policy: {
          ...input.run.policy,
          roles: { ...input.run.policy.roles, judge: role },
        },
      }
      const assessed = yield* assessSingle({ ...input, run }).pipe(Effect.exit)
      return {
        arm: name,
        verdict: Exit.isSuccess(assessed) && assessed.value
          ? assessed.value
          : { decision: "revise" as const, confidence: 0, gateFailures: ["judge_arm_failed"], criteria: [] },
      }
    }), { concurrency: "unbounded" })
    const verdict = arms.find((arm) => arm.arm === authoritativeArm)?.verdict
    if (!verdict) return undefined
    return {
      ...verdict,
      experiment: {
        assignment: experiment.assignment,
        authoritativeArm,
        seed: experiment.seed,
        arms,
      },
    } satisfies Orchestration.AttemptVerdict
  })
}

export function choose(input: {
  run: Orchestration.Run
  role: Orchestration.PolicyJudge
  request: ChoiceRequest
}) {
  return Effect.gen(function* () {
    if (input.role.provider === "jev") {
      const judge = yield* TypedJudge.Service
      return Option.getOrElse(yield* judge.choice(input.request, { authoritative: true }), () => unavailable())
    }
    if (input.role.provider !== "llm") return unavailable("experiment", "unknown", "unsupported_decider")
    const profile = input.run.policy?.routeProfiles.find((item) => item.name === input.role.routeProfile)
    if (!profile) return unavailable("llm", "unknown", "missing_route_profile")
    const routing = yield* OrchestrationRouting.Service
    const routed = yield* routing.resolveSnapshot(profile).pipe(Effect.exit)
    if (Exit.isFailure(routed) || routed.value.status !== "selected" || !routed.value.selected)
      return unavailable("llm", "unknown", "route_unavailable")
    const candidate = routed.value.selected
    const generated = yield* generateAnswers(candidate, [
      "Choose exactly one listed key and return confidence from 0 to 1. Use only the supplied evidence.",
      `Evidence:\n${JSON.stringify(input.request.state)}`,
      `Question:\n${JSON.stringify(input.request.question)}`,
      'Return the answer under the key "decision".',
    ].join("\n\n"), input.run.workspace?.integration.directory ?? input.run.source?.directory, ["decision"]).pipe(Effect.exit)
    if (Exit.isFailure(generated)) return unavailable("llm", candidate.modelID, "model_call_failed")
    const answer = generated.value.object.answers.decision
    const valid = answer && Object.hasOwn(input.request.question.criteria, answer.choice)
    return {
      status: valid ? "valid" : "invalid",
      provider: "llm",
      model: candidate.modelID,
      requestDigest: Hash.sha256(JSON.stringify({ provider: "llm", candidate, request: input.request })),
      cached: false,
      latencyMs: generated.value.latencyMs,
      answer: valid ? { choice: answer.choice, confidence: answer.confidence } : undefined,
      usage:
        generated.value.usage?.inputTokens !== undefined && generated.value.usage.outputTokens !== undefined
          ? {
              inputTokens: generated.value.usage.inputTokens,
              outputTokens: generated.value.usage.outputTokens,
            }
          : undefined,
      errorCode: valid ? undefined : "invalid_choice",
    } satisfies ChoiceResult
  })
}

function assessLlm(input: {
  run: Orchestration.Run
  task: Orchestration.Task
  state: ChoiceRequest["state"]
  gateFailures: string[]
}) {
  return Effect.gen(function* () {
    const criteriaRequests = input.task.acceptanceCriteria.map((criterion) => ({
      key: `criterion:${criterion.key}`,
      criterion: criterion.key,
      request: {
        purpose: "attempt_criterion",
        state: { evidence: input.state, criterion },
        question: {
          instructions: `Judge only acceptance criterion ${criterion.key} against the patch and checks.`,
          criteria: {
            met: "The patch and available checks support this criterion.",
            not_met: "The patch contradicts or fails this criterion.",
            unclear: "The available evidence cannot establish whether this criterion is met.",
          },
        },
        fallback: "unclear",
      } satisfies ChoiceRequest,
    }))
    const overallRequest: ChoiceRequest = {
      purpose: "attempt_verdict",
      state: input.state,
      question: {
        instructions:
          "Choose whether this coding attempt satisfies the task. Use the patch, acceptance criteria, and check evidence.",
        criteria: {
          accept: "The attempt meets the task and its acceptance criteria with sufficient evidence.",
          revise: "The attempt needs changes or more verification before acceptance.",
          needs_human: "A human decision or missing external information is required to proceed.",
        },
      },
      fallback: "revise",
    }
    const policy = input.run.policy!
    const profile = policy.routeProfiles.find((item) => item.name === policy.roles.judge.routeProfile)
    if (!profile) return llmFallback(criteriaRequests, overallRequest, input.gateFailures, "missing_route_profile")
    const routing = yield* OrchestrationRouting.Service
    const routed = yield* routing.resolveSnapshot(profile).pipe(Effect.exit)
    if (Exit.isFailure(routed)) return llmFallback(criteriaRequests, overallRequest, input.gateFailures, "route_failed")
    const candidate = routed.value.selected
    if (routed.value.status !== "selected" || !candidate)
      return llmFallback(criteriaRequests, overallRequest, input.gateFailures, "route_unavailable")

    const questions = [
      ...criteriaRequests.map((item) => ({
        key: item.key,
        instructions: item.request.question.instructions,
        choices: item.request.question.criteria,
      })),
      { key: "overall", instructions: overallRequest.question.instructions, choices: overallRequest.question.criteria },
    ]
    const prompt = [
      "Answer every question with exactly one listed choice key and confidence from 0 to 1. Evaluate the supplied evidence only.",
      `Evidence:\n${JSON.stringify(input.state)}`,
      `Questions:\n${JSON.stringify(questions)}`,
    ].join("\n\n")
    const generated = yield* generateAnswers(
      candidate,
      prompt,
      input.run.workspace?.integration.directory ?? input.run.source?.directory,
      [...criteriaRequests.map((item) => item.key), "overall"],
    ).pipe(Effect.exit)
    if (Exit.isFailure(generated))
      return llmFallback(criteriaRequests, overallRequest, input.gateFailures, "model_call_failed", candidate.modelID)
    const latencyMs = generated.value.latencyMs
    const result = (request: ChoiceRequest, key: string): ChoiceResult => {
      const answer = generated.value.object.answers[key]
      const valid = answer && Object.hasOwn(request.question.criteria, answer.choice)
      return {
        status: valid ? "valid" : "invalid",
        provider: "llm",
        model: candidate.modelID,
        requestDigest: Hash.sha256(JSON.stringify({ provider: "llm", candidate, request })),
        cached: false,
        latencyMs,
        answer: valid ? { choice: answer.choice, confidence: answer.confidence } : undefined,
        usage:
          key === "overall" &&
          generated.value.usage?.inputTokens !== undefined &&
          generated.value.usage.outputTokens !== undefined
            ? {
                inputTokens: generated.value.usage.inputTokens,
                outputTokens: generated.value.usage.outputTokens,
              }
            : undefined,
        errorCode: valid ? undefined : "invalid_choice",
      }
    }
    const criteria = criteriaRequests.map((item) => {
      const answer = result(item.request, item.key)
      return {
        key: item.criterion,
        decision:
          answer.status === "valid" && answer.answer
            ? (answer.answer.choice as "met" | "not_met" | "unclear")
            : ("unclear" as const),
        request: item.request,
        result: answer,
      }
    })
    const overall = result(overallRequest, "overall")
    const answer = overall.status === "valid" ? overall.answer : undefined
    return {
      decision:
        input.gateFailures.length ||
        !answer ||
        (answer.choice === "accept" &&
          (answer.confidence < policy.acceptance.minConfidence ||
            criteria.some((criterion) => criterion.decision !== "met")))
          ? "revise"
          : answer.choice === "needs_human"
            ? "needs_human"
            : answer.choice === "accept"
              ? "accept"
              : "revise",
      confidence: answer?.confidence ?? 0,
      gateFailures: input.gateFailures,
      criteria,
      overall: { request: overallRequest, result: overall },
    } satisfies Orchestration.AttemptVerdict
  })
}

const generateAnswers = Effect.fn("OrchestrationJudge.generateAnswers")(function* (
  candidate: Orchestration.Candidate,
  prompt: string,
  directory?: AbsolutePath,
  keys: string[] = ["decision"],
) {
  if (candidate.type === "harness") {
    if (candidate.harnessID !== "codex" || !directory) return yield* Effect.fail(new Error("Judge harness is unavailable"))
    const global = yield* Global.Service
    const schemaPath = AbsolutePath.make(path.join(global.tmp, `orchestration-judge-${Hash.sha256(JSON.stringify(keys)).slice(0, 12)}.json`))
    yield* Effect.tryPromise({ try: () => Bun.write(schemaPath, JSON.stringify(decisionSchema(keys))), catch: String })
    const generated = yield* CodexHarness.decide({
      process: yield* AppProcess.Service,
      candidate,
      directory,
      prompt,
      schemaPath,
    })
    return {
      object: yield* Schema.decodeUnknownEffect(LlmAnswers)(generated.object),
      usage: generated.usage,
      latencyMs: generated.latencyMs,
    }
  }
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const providerID = ProviderV2.ID.make(candidate.providerID)
  const modelID = ModelV2.ID.make(candidate.modelID)
  const selected = (yield* catalog.model.available()).find(
    (model) => model.providerID === providerID && model.id === modelID,
  )
  if (!selected) return yield* Effect.fail(new Error("Judge model is unavailable"))
  const provider = yield* catalog.provider.get(providerID)
  const connection = yield* integrations.connection.active(
    provider?.integrationID ?? Integration.ID.make(candidate.providerID),
  )
  const credential = connection ? yield* integrations.connection.resolve(connection) : undefined
  const model = yield* SessionRunnerModel.resolveRef(
    ModelV2.Ref.make({
      id: modelID,
      providerID,
      variant: candidate.variant ? ModelV2.VariantID.make(candidate.variant) : undefined,
    }),
    selected,
    credential,
  )
  const started = Date.now()
  const generated = yield* LLM.generateObject({ model, prompt, schema: LlmAnswers }).pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.fail(new Error("Judge call timed out")) }),
  )
  return {
    object: generated.object,
    usage: generated.usage,
    latencyMs: Date.now() - started,
  }
})

function llmFallback(
  criteriaRequests: ReadonlyArray<{ key: string; criterion: string; request: ChoiceRequest }>,
  overallRequest: ChoiceRequest,
  gateFailures: string[],
  errorCode: string,
  model = "unknown",
): Orchestration.AttemptVerdict {
  return {
    decision: "revise",
    confidence: 0,
    gateFailures,
    criteria: criteriaRequests.map((item) => ({
      key: item.criterion,
      decision: "unclear",
      request: item.request,
      result: unavailable("llm", model, errorCode),
    })),
    overall: { request: overallRequest, result: unavailable("llm", model, errorCode) },
  }
}

function unavailable(provider = "jev", model = "unknown", errorCode = "judge_unavailable"): ChoiceResult {
  return {
    status: "unavailable",
    provider,
    model,
    requestDigest: "",
    cached: false,
    latencyMs: 0,
    errorCode,
  }
}
