import { DateTime } from "effect"
import { createMemo, For, Show, type Accessor } from "solid-js"
import { useOrchestrationRun } from "./orchestration-run"

export function SessionRunUsage(props: { sessionID: Accessor<string | undefined> }) {
  const run = useOrchestrationRun(props.sessionID)
  const detail = () => run.detail()
  const results = createMemo(() => [
    ...(detail()?.attempts.flatMap((attempt) => [
      ...(attempt.verdict?.criteria.map((criterion) => criterion.result) ?? []),
      ...(attempt.verdict?.overall ? [attempt.verdict.overall.result] : []),
    ]) ?? []),
    ...(detail()?.deliveries.flatMap((delivery) => [
      ...delivery.review.clauses.map((clause) => clause.result),
      ...(delivery.review.overall ? [delivery.review.overall.result] : []),
    ]) ?? []),
    ...(detail()?.reassignments.flatMap((decision) => decision.result ? [decision.result] : []) ?? []),
    ...(detail()?.tierRecommendations.map((recommendation) => recommendation.result) ?? []),
  ])
  const generations = createMemo(() => [
    ...(detail()?.plans.flatMap((plan) => plan.generation ? [{ role: "Planner", ...plan.generation }] : []) ?? []),
    ...(detail()?.deliveries.flatMap((delivery) => delivery.summaryGeneration ? [{ role: "Summarizer", ...delivery.summaryGeneration }] : []) ?? []),
  ])
  const executions = createMemo(() => detail()?.evaluations.filter((evaluation) => evaluation.kind.startsWith("harness:")) ?? [])
  const executionUsage = createMemo(() => executions().reduce((total, evaluation) => ({
    input: total.input + (typeof evaluation.evidence.inputTokens === "number" ? evaluation.evidence.inputTokens : 0),
    output: total.output + (typeof evaluation.evidence.outputTokens === "number" ? evaluation.evidence.outputTokens : 0),
    cost: total.cost + (typeof evaluation.evidence.reportedCostUsd === "number" ? evaluation.evidence.reportedCostUsd : 0),
    measured: total.measured + (typeof evaluation.evidence.inputTokens === "number" || typeof evaluation.evidence.outputTokens === "number" ? 1 : 0),
  }), { input: 0, output: 0, cost: 0, measured: 0 }))
  const measured = createMemo(() => results().filter((result) => result.usage))
  const total = createMemo(() => ({
    input: measured().reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
    output: measured().reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    cost: measured().reduce((sum, item) => sum + (item.usage?.estimatedCostUsd ?? 0), 0),
  }))
  const accepted = createMemo(() => detail()?.tasks.filter((task) => task.status === "succeeded").length ?? 0)
  const elapsed = createMemo(() => {
    const current = detail()
    if (!current) return 0
    const end = current.deliveries.at(-1)?.time.delivered ?? current.run.time.updated
    return Math.max(0, DateTime.toEpochMillis(end) - DateTime.toEpochMillis(current.run.time.created))
  })

  return <div class="h-full overflow-y-auto bg-v2-background-bg-base p-4 text-13-regular text-v2-text-text-base">
    <Show when={detail()} fallback={<div class="text-v2-text-text-muted">Loading usage…</div>}>
      {(current) => <div class="flex flex-col gap-4">
        <h2 class="text-14-medium">Run usage</h2>
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-lg bg-v2-background-bg-layer-01 p-3"><div class="text-v2-text-text-muted">Attempts</div><div class="text-18-medium">{current().attempts.length}</div></div>
          <div class="rounded-lg bg-v2-background-bg-layer-01 p-3"><div class="text-v2-text-text-muted">Per accepted task</div><div class="text-18-medium">{accepted() ? (current().attempts.length / accepted()).toFixed(1) : "–"}</div></div>
          <div class="rounded-lg bg-v2-background-bg-layer-01 p-3"><div class="text-v2-text-text-muted">Elapsed</div><div class="text-18-medium">{Math.round(elapsed() / 60_000)} min</div></div>
          <div class="rounded-lg bg-v2-background-bg-layer-01 p-3"><div class="text-v2-text-text-muted">Judge calls</div><div class="text-18-medium">{results().length}</div></div>
        </div>
        <div class="rounded-lg border border-v2-border-border-base p-3">
          <div class="text-13-medium">Measured judge usage</div>
          <div class="mt-1">{total().input.toLocaleString()} input · {total().output.toLocaleString()} output tokens</div>
          <div>${total().cost.toFixed(3)} estimated cost · {measured().length}/{results().length} calls measured</div>
        </div>
        <div class="rounded-lg border border-v2-border-border-base p-3">
          <div class="text-13-medium">Usage by role</div>
          <For each={generations()}>{(generation) => <div class="mt-1 flex justify-between gap-2">
            <span>{generation.role}</span><span>{generation.inputTokens ?? "–"} input · {generation.outputTokens ?? "–"} output · {Math.round(generation.latencyMs / 1000)} s</span>
          </div>}</For>
          <div class="mt-1 flex justify-between gap-2"><span>Harness executors</span><span>{executionUsage().input.toLocaleString()} input · {executionUsage().output.toLocaleString()} output · {executionUsage().measured}/{executions().length} measured</span></div>
          <div class="mt-1 flex justify-between gap-2"><span>Judges and deciders</span><span>{total().input.toLocaleString()} input · {total().output.toLocaleString()} output · {measured().length}/{results().length} measured</span></div>
          <div class="mt-2 text-v2-text-text-muted">Harness reported cost: ${executionUsage().cost.toFixed(3)}. Direct executor usage and unreported harness usage are not included.</div>
        </div>
        <div class="rounded-lg border border-v2-border-border-base p-3">
          <div class="text-13-medium">Attempts by route</div>
          <For each={Object.entries(current().attempts.reduce<Record<string, number>>((counts, attempt) => {
            const route = attempt.candidate?.id ?? "unrouted"
            counts[route] = (counts[route] ?? 0) + 1
            return counts
          }, {}))}>{([route, count]) => <div class="mt-1 flex justify-between"><span>{route}</span><span>{count}</span></div>}</For>
        </div>
      </div>}
    </Show>
  </div>
}
