export * as OrchestrationDelivery from "./delivery"

import path from "path"
import { DateTime, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { TypedJudge } from "../typed-judge"
import { Hash } from "../util/hash"
import type { ChoiceRequest, ChoiceResult } from "@opencode-ai/schema/typed-judge"
import { CodexHarness } from "./harness/codex"
import { OrchestrationRouting } from "./routing"

const maximumPatchBytes = 256 * 1024
const maximumPatchCharacters = 60_000

export class ReviewError extends Schema.TaggedErrorClass<ReviewError>()("Orchestration.DeliveryReviewError", {
  message: Schema.String,
}) {}

export class SummaryError extends Schema.TaggedErrorClass<SummaryError>()("Orchestration.DeliverySummaryError", {
  message: Schema.String,
}) {}

const summarySchema = {
  type: "object",
  properties: { summary: { type: "string" }, commitMessage: { type: "string" } },
  required: ["summary", "commitMessage"],
  additionalProperties: false,
} as const

export const review = Effect.fn("OrchestrationDelivery.review")(function* (detail: Orchestration.Detail) {
  const workspace = detail.run.workspace
  if (!workspace) return yield* new ReviewError({ message: "Run workspace is unavailable" })
  const baseHead = detail.followUps.at(-1)?.baseHead ?? workspace.sourceHead
  const tasks = turnTasks(detail)
  const process = yield* AppProcess.Service
  const head = yield* process
    .run(ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: workspace.integration.directory, stdin: "ignore" }), {
      timeout: "10 seconds",
      maxOutputBytes: 128,
      maxErrorBytes: 1_024,
    })
    .pipe(Effect.mapError((error) => new ReviewError({ message: error.message })))
  if (head.exitCode !== 0) return yield* new ReviewError({ message: "Run branch head is unavailable" })
  const diff = yield* process
    .run(
      ChildProcess.make("git", ["diff", "--no-ext-diff", "--binary", baseHead, "HEAD"], {
        cwd: workspace.integration.directory,
        stdin: "ignore",
      }),
      { timeout: "15 seconds", maxOutputBytes: maximumPatchBytes, maxErrorBytes: 2_048 },
    )
    .pipe(Effect.mapError((error) => new ReviewError({ message: error.message })))
  if (diff.exitCode !== 0) return yield* new ReviewError({ message: "Run branch diff is unavailable" })

  const patch = diff.stdout.toString("utf8")
  const clauses = detail.plans.find((plan) => plan.status === "applied" && plan.output.clauses?.length && isCurrentTurn(detail, plan.time.created))?.output.clauses ?? [
    { key: "objective", description: detail.run.objective },
  ]
  const gateFailures = [
    ...(diff.stdoutTruncated || patch.length > maximumPatchCharacters ? ["patch_truncated"] : []),
    ...(!patch && tasks.some((task) => task.kind === "agent") ? ["empty_run_patch"] : []),
    ...tasks.filter((task) => task.status !== "succeeded").map((task) => `task_not_accepted:${task.id}`),
  ]
  const state = {
    objective: detail.run.objective.slice(0, 8_000),
    context: detail.run.context?.slice(0, 6_000) ?? null,
    clauses,
    tasks: tasks.map((task) => ({
      title: task.title,
      kind: task.kind,
      status: task.status,
      acceptanceCriteria: task.acceptanceCriteria,
    })),
    humanAnswers: detail.humanRequests
      .filter((request) => request.status === "answered")
      .map((request) => ({ prompt: request.prompt.slice(0, 500), answer: request.answer?.slice(0, 500) ?? null })),
    patch: patch.slice(0, maximumPatchCharacters),
    patchTruncated: diff.stdoutTruncated || patch.length > maximumPatchCharacters,
    checks: detail.evaluations
      .filter((evaluation) => evaluation.kind.startsWith("check:"))
      .map((evaluation) => ({ kind: evaluation.kind, status: evaluation.status })),
  }
  const judge = yield* TypedJudge.Service
  const judged = yield* Effect.forEach(
    clauses,
    (clause) => {
      const request: ChoiceRequest = {
        purpose: "delivery_clause",
        state: { ...state, clause },
        question: {
          instructions: `Judge whether delivery clause ${clause.key} is satisfied by the complete run.`,
          criteria: {
            met: "The combined change and checks support this clause.",
            not_met: "The combined change contradicts or fails this clause.",
            unclear: "The available evidence cannot establish whether this clause is met.",
          },
        },
        fallback: "unclear",
      }
      return judge.choice(request, { authoritative: true }).pipe(
        Effect.map((option) => {
          const result = Option.getOrElse(option, unavailable)
          return {
            key: clause.key,
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
    purpose: "delivery_verdict",
    state,
    question: {
      instructions: "Decide whether the complete run delivers the user's assignment, has gaps, or needs a human decision.",
      criteria: {
        delivered: "All assignment clauses are met with sufficient evidence.",
        gaps: "One or more assignment clauses need additional work.",
        needs_human: "A human decision or missing external information is required.",
      },
    },
    fallback: "gaps",
  }
  const result = Option.getOrElse(yield* judge.choice(request, { authoritative: true }), unavailable)
  const answer = result.status === "valid" ? result.answer : undefined
  const decision =
    !gateFailures.length &&
    judged.every((clause) => clause.decision === "met") &&
    answer?.choice === "delivered" &&
    answer.confidence >= (detail.run.policy?.acceptance.minConfidence ?? 0.8)
      ? "delivered"
      : answer?.choice === "needs_human"
        ? "needs_human"
        : "gaps"
  return {
    baseHead,
    head: head.stdout.toString("utf8").trim(),
    changedFiles: patch.split(/\r?\n/).filter((line) => line.startsWith("diff --git ")).length,
    patch,
    review: {
      decision,
      confidence: answer?.confidence ?? 0,
      gateFailures,
      clauses: judged,
      overall: { request, result },
    } satisfies Orchestration.DeliveryReview,
  }
})

function unavailable(): ChoiceResult {
  return {
    status: "unavailable",
    provider: "jev",
    model: "",
    requestDigest: "",
    cached: false,
    latencyMs: 0,
    errorCode: "unavailable",
  }
}

export function summarize(detail: Orchestration.Detail, changedFiles: number) {
  const summary = [
    `Completed: ${detail.run.objective}`,
    "",
    ...turnTasks(detail).map((task) => `- ${task.title}${task.kind === "human" ? " (human step)" : ""}`),
    "",
    `Combined change: ${changedFiles} ${changedFiles === 1 ? "file" : "files"}.`,
  ].join("\n")
  const subject = detail.run.objective.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "")
  return { summary, commitMessage: `feat: ${subject.slice(0, 67) || "complete assignment"}` }
}

export const generateSummary = Effect.fn("OrchestrationDelivery.generateSummary")(function* (input: {
  readonly detail: Orchestration.Detail
  readonly process: AppProcess.Interface
  readonly temporaryDirectory: AbsolutePath
}) {
  const policy = input.detail.run.policy
  const workspace = input.detail.run.workspace
  if (!policy || !workspace) return yield* new SummaryError({ message: "Run policy or workspace is unavailable" })
  const baseHead = input.detail.followUps.at(-1)?.baseHead ?? workspace.sourceHead
  const profile = policy.routeProfiles.find((item) => item.name === policy.roles.summarizer)
  if (!profile) return yield* new SummaryError({ message: "Summarizer route profile is unavailable" })
  const route = yield* OrchestrationRouting.Service.use((routing) => routing.resolveSnapshot(profile))
  const candidate = route.selected
  if (route.status !== "selected" || candidate?.type !== "harness" || candidate.harnessID !== "codex")
    return yield* new SummaryError({ message: "Summarizer needs an eligible Codex harness route" })
  const diff = yield* input.process
    .run(
      ChildProcess.make("git", ["diff", "--no-ext-diff", "--binary", baseHead, "HEAD"], {
        cwd: workspace.integration.directory,
        stdin: "ignore",
      }),
      { timeout: "15 seconds", maxOutputBytes: maximumPatchBytes, maxErrorBytes: 2_048 },
    )
    .pipe(Effect.mapError((error) => new SummaryError({ message: error.message })))
  if (diff.exitCode !== 0 || diff.stdoutTruncated)
    return yield* new SummaryError({ message: "Complete run diff is unavailable for summarization" })
  const prompt = [
    "You are the delivery summarizer. Write a concise, factual user-facing Markdown summary of what was delivered, including material limits and any human steps. Draft one conventional commit message. Do not edit files. Base every claim on the assignment, task outcomes, and combined diff.",
    `Assignment: ${input.detail.run.objective}`,
    input.detail.run.context ? `Context: ${input.detail.run.context}` : "",
    `Tasks: ${JSON.stringify(turnTasks(input.detail).map((task) => ({ title: task.title, kind: task.kind, status: task.status })))}`,
    `Delivery review: ${JSON.stringify(input.detail.deliveries.at(-1)?.review ? {
      decision: input.detail.deliveries.at(-1)?.review.decision,
      clauses: input.detail.deliveries.at(-1)?.review.clauses.map((clause) => ({ key: clause.key, decision: clause.decision })),
      gateFailures: input.detail.deliveries.at(-1)?.review.gateFailures,
    } : null)}`,
    `Combined diff:\n${diff.stdout.toString("utf8").slice(0, maximumPatchCharacters)}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  const schemaPath = AbsolutePath.make(path.join(input.temporaryDirectory, "orchestration-summary-schema.json"))
  yield* Effect.tryPromise({
    try: () => Bun.write(schemaPath, JSON.stringify(summarySchema)),
    catch: (error) => new SummaryError({ message: String(error) }),
  })
  const generated = yield* CodexHarness.summarize({
    process: input.process,
    candidate,
    directory: workspace.integration.directory,
    prompt,
    schemaPath,
  }).pipe(Effect.mapError((error) => new SummaryError({ message: error.message })))
  const summary = generated.object.summary.trim()
  const proposed = generated.object.commitMessage.trim().split(/\r?\n/)[0]?.replace(/^[-*]\s*/, "") ?? ""
  const commitMessage = /^(feat|fix|docs|chore|refactor|test)(\([a-z0-9-]+\))?: .+/.test(proposed)
    ? proposed.slice(0, 200)
    : `feat: ${(proposed || input.detail.run.objective).replace(/^\w+(\([^)]+\))?:\s*/, "").slice(0, 67)}`
  if (!summary || summary.length > 8_000 || commitMessage.length > 200)
    return yield* new SummaryError({ message: "Summarizer returned an invalid summary or commit message" })
  return {
    summary,
    commitMessage,
    summaryGeneration: {
      route,
      prompt,
      requestDigest: Hash.sha256(JSON.stringify({ candidate, prompt })),
      latencyMs: generated.latencyMs,
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens,
    },
  }
})

function isCurrentTurn(detail: Orchestration.Detail, created: DateTime.Utc) {
  const followUp = detail.followUps.at(-1)
  return !followUp || DateTime.toEpochMillis(created) >= DateTime.toEpochMillis(followUp.time)
}

function turnTasks(detail: Orchestration.Detail) {
  return detail.tasks.filter((task) => isCurrentTurn(detail, task.time.created))
}
