export * as OrchestrationFeedback from "./feedback"

import { Orchestration } from "@opencode-ai/schema/orchestration"
import { OrchestrationExecutor } from "./executor"

export function compose(
  task: Orchestration.Task,
  verdict: Orchestration.AttemptVerdict,
  evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>,
): Orchestration.AttemptFeedback {
  const criteria = verdict.criteria.filter((item) => item.decision !== "met")
  const failedChecks = evaluations.filter(
    (evaluation) => evaluation.kind.startsWith("check:") && evaluation.status === "failed",
  )
  const lines = [
    ...verdict.gateFailures.map((failure) => `Gate: ${failure}`),
    ...criteria.map((item) => {
      const description = task.acceptanceCriteria.find((criterion) => criterion.key === item.key)?.description
      return `Criterion ${item.key} is ${item.decision}: ${description ?? "Review this requirement"}`
    }),
    ...failedChecks.map((evaluation) => {
      const output = [evaluation.evidence.stderr, evaluation.evidence.stdout]
        .filter((value): value is string => typeof value === "string" && !!value)
        .join("\n")
        .slice(0, 1_000)
      return `Check ${evaluation.kind.slice(6)} failed${output ? `: ${output}` : ""}`
    }),
    ...(verdict.overall && verdict.overall.result.status !== "valid"
      ? [`Judge response was ${verdict.overall.result.status}; verify the task before acceptance.`]
      : []),
    ...(verdict.decision === "needs_human" ? ["Human guidance is required before another attempt."] : []),
  ]
  return {
    source: "deterministic",
    text: (lines.length ? lines : ["Revise the attempt against the acceptance criteria and check results."])
      .join("\n")
      .slice(0, 6_000),
    criterionKeys: criteria.map((item) => item.key),
    failedChecks: failedChecks.map((evaluation) => evaluation.kind.slice(6)),
  }
}
