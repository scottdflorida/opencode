import { useNavigate, useParams } from "@solidjs/router"
import { DateTime } from "effect"
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { getSessionKey } from "./helpers"
import { useOrchestrationRun } from "./orchestration-run"

export function SessionRunPanel(props: { sessionID: Accessor<string | undefined> }) {
  const run = useOrchestrationRun(props.sessionID)
  const navigate = useNavigate()
  const params = useParams()
  const sdk = useSDK()
  const layout = useLayout()
  const detail = () => run.detail()
  const [busyTask, setBusyTask] = createSignal("")
  const [actionError, setActionError] = createSignal("")
  const tasks = createMemo(() => [...(detail()?.tasks ?? [])].sort((a, b) => {
    const order = ["waiting_on_human", "running", "evaluating", "ready", "blocked", "suspended", "succeeded", "failed", "cancelled"]
    return order.indexOf(a.status) - order.indexOf(b.status)
  }))
  const open = (sessionID: string, review = false) => {
    if (review) {
      const key = getSessionKey(sdk().directory, sessionID)
      layout.view(key).reviewPanel.open()
      layout.tabs(key).setActive("review")
    }
    navigate(params.serverKey
      ? sessionHref(requireServerKey(params.serverKey), sessionID)
      : legacySessionHref(sdk().directory, sessionID))
  }

  return (
    <div class="h-full overflow-y-auto bg-v2-background-bg-base p-4 text-v2-text-text-base text-13-regular">
      <Show when={detail()} fallback={<div class="text-v2-text-text-muted">Loading run…</div>}>
        {(item) => <div class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <div class="text-14-medium">Run · {item().run.status.replaceAll("_", " ")}</div>
            <div class="text-v2-text-text-muted">{item().run.policy?.name ?? "Manual"} · {item().tasks.filter((task) => task.status === "succeeded").length}/{item().tasks.filter((task) => task.status !== "cancelled").length} tasks
              <Show when={item().tasks.some((task) => task.status === "cancelled")}> · {item().tasks.filter((task) => task.status === "cancelled").length} cancelled</Show>
            </div>
          </div>
          <Show when={actionError()}><div class="text-red-500">{actionError()}</div></Show>
          <For each={tasks()}>
            {(task) => {
              const attempts = () => item().attempts.filter((attempt) => attempt.taskID === task.id)
              const dependencies = () => item().dependencies.filter((dependency) => dependency.taskID === task.id)
                .flatMap((dependency) => item().tasks.find((candidate) => candidate.id === dependency.dependsOnTaskID) ?? [])
              return <details class={`rounded-lg border border-v2-border-border-base p-3 ${dependencies().some((dependency) => dependency.status !== "succeeded") ? "ml-4" : ""}`} open={task.status === "running" || task.status === "waiting_on_human"}>
                <summary class="cursor-pointer text-13-medium">
                  {task.status === "succeeded" ? "✓" : task.status === "cancelled" ? "⊘" : task.status === "running" ? "◐" : task.status === "waiting_on_human" ? "⚑" : "○"} {task.title}
                  <span class="ml-2 text-v2-text-text-muted">{task.capabilityTier ?? ""} · {task.status.replaceAll("_", " ")}</span>
                </summary>
                <div class="mt-3 flex flex-col gap-3">
                  <Show when={dependencies().length}><div class="text-v2-text-text-muted">After: {dependencies().map((dependency) => dependency.title).join(" · ")}</div></Show>
                  <Show when={task.description}><p class="whitespace-pre-wrap">{task.description}</p></Show>
                  <For each={task.acceptanceCriteria}>{(criterion) => <div class="text-v2-text-text-muted">• {criterion.description}</div>}</For>
                  <For each={attempts()}>
                    {(attempt, index) => {
                      const [feedback, setFeedback] = createSignal("")
                      const route = () => item().routeDecisions.find((decision) => decision.attemptID === attempt.id)
                      const evaluations = () => item().evaluations.filter((evaluation) => evaluation.attemptID === attempt.id)
                      const harness = () => evaluations().find((evaluation) => evaluation.kind.startsWith("harness:"))
                      const reassignment = () => item().reassignments.find((value) => value.afterAttemptID === attempt.id)
                      return <details class="rounded-md bg-v2-background-bg-layer-01 p-2">
                        <summary class="cursor-pointer">Attempt {index() + 1} · {attempt.candidate?.id ?? "unrouted"} · {attempt.verdict?.decision ?? attempt.status}</summary>
                        <div class="mt-2 flex flex-col gap-2 text-v2-text-text-muted">
                          <div>{attempt.kind} · {Math.max(0, Math.round((DateTime.toEpochMillis(attempt.time.completed ?? attempt.time.updated) - DateTime.toEpochMillis(attempt.time.created)) / 1000))} s</div>
                          <Show when={route()}>{(decision) => <div>Route: {decision().resolution.profile} → {decision().resolution.selected?.id ?? decision().resolution.status}
                            <Show when={decision().resolution.rejected.length}><div class="pl-3">Other routes: {decision().resolution.rejected.map((reason) => `${reason.candidateID}: ${reason.message}`).join("; ")}</div></Show>
                          </div>}</Show>
                          <For each={evaluations()}>{(evaluation) => <details>
                            <summary>{evaluation.status === "passed" ? "✓" : evaluation.status === "indeterminate" ? "?" : "✕"} {evaluation.kind}
                              <Show when={evaluation.kind.startsWith("check:") && typeof evaluation.evidence.exitCode === "number"}> · exit {evaluation.evidence.exitCode as number}</Show>
                            </summary>
                            <Show when={evaluation.kind.startsWith("check:")}>
                              <div class="pl-3">{evaluation.evidence.baseline && typeof evaluation.evidence.baseline === "object" && "exitCode" in evaluation.evidence.baseline
                                ? `Baseline exit ${String(evaluation.evidence.baseline.exitCode)} · ` : ""}Current exit {String(evaluation.evidence.exitCode ?? "unknown")}</div>
                            </Show>
                            <Show when={typeof evaluation.evidence.stderr === "string" && evaluation.evidence.stderr}>
                              <pre class="max-h-32 overflow-auto whitespace-pre-wrap pl-3">{String(evaluation.evidence.stderr).slice(0, 2_000)}</pre>
                            </Show>
                          </details>}</For>
                          <Show when={attempt.verdict}><div class={Math.abs((attempt.verdict?.confidence ?? 0) - (item().run.policy?.acceptance.minConfidence ?? 0.8)) < 0.1 ? "text-amber-600" : ""}>
                            Judge: {attempt.verdict?.decision} · {Math.round((attempt.verdict?.confidence ?? 0) * 100)}% confidence · threshold {Math.round((item().run.policy?.acceptance.minConfidence ?? 0.8) * 100)}%
                          </div></Show>
                          <For each={attempt.verdict?.criteria ?? []}>{(criterion) => <div class="pl-3">{criterion.key}: {criterion.decision} · {Math.round((criterion.result.answer?.confidence ?? 0) * 100)}%</div>}</For>
                          <Show when={attempt.verdict?.experiment}>{(experiment) => <div>Judge experiment: {experiment().assignment} · {experiment().authoritativeArm} authoritative · {experiment().arms.map((arm) => `${arm.arm} ${arm.verdict.decision}`).join(", ")}</div>}</Show>
                          <Show when={attempt.feedback}><div>Feedback: {attempt.feedback?.text}</div></Show>
                          <Show when={reassignment()}>{(decision) => <div>Next: {decision().selected.action} · {decision().chooser}{decision().selected.candidateID ? ` · ${decision().selected.candidateID}` : ""}</div>}</Show>
                          <Show when={harness()}>{(evaluation) => <div>Harness usage: {typeof evaluation().evidence.inputTokens === "number" ? evaluation().evidence.inputTokens as number : "–"} input · {typeof evaluation().evidence.outputTokens === "number" ? evaluation().evidence.outputTokens as number : "–"} output tokens</div>}</Show>
                          <Show when={attempt.sessionID}>
                            {(id) => <div class="flex gap-3">
                              <button type="button" class="underline" onClick={() => open(id())}>Open session</button>
                              <button type="button" class="underline" onClick={() => open(id(), true)}>View diff</button>
                            </div>}
                          </Show>
                          <Show when={index() === attempts().length - 1 && ["failed", "waiting_on_human"].includes(task.status) && item().evaluations.some((evaluation) => evaluation.attemptID === attempt.id && evaluation.kind === "git:commit" && evaluation.status === "passed")}>
                            <button type="button" class="self-start underline" disabled={!!busyTask()} onClick={() => {
                              setBusyTask(task.id)
                              setActionError("")
                              void run.post(`/task/${encodeURIComponent(task.id)}/accept`, { note: "Human override from Run panel" })
                                .catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                                .finally(() => setBusyTask(""))
                            }}>Accept this attempt</button>
                          </Show>
                          <Show when={index() === attempts().length - 1 && task.status === "succeeded" && ["active", "suspended"].includes(item().run.status)}>
                            <div class="flex flex-col gap-2">
                              <textarea class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2 text-v2-text-text-base" rows={2}
                                placeholder="Feedback for a revision" value={feedback()} onInput={(event) => setFeedback(event.currentTarget.value)} />
                              <button type="button" class="self-start underline" disabled={!!busyTask() || !feedback().trim()} onClick={() => {
                                setBusyTask(task.id)
                                setActionError("")
                                void run.post(`/task/${encodeURIComponent(task.id)}/reopen`, { feedback: feedback().trim() })
                                  .then(() => setFeedback(""))
                                  .catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                                  .finally(() => setBusyTask(""))
                              }}>Reopen with feedback</button>
                            </div>
                          </Show>
                        </div>
                      </details>
                    }}
                  </For>
                </div>
              </details>
            }}
          </For>
        </div>}
      </Show>
    </div>
  )
}
