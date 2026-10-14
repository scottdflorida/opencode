import { Button } from "@opencode-ai/ui/button"
import { DateTime, Schema } from "effect"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SplitButtonV2, SplitButtonV2Action, SplitButtonV2MenuTrigger } from "@opencode-ai/ui/v2/split-button-v2"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createSignal, For, Show, untrack, type Accessor } from "solid-js"
import { SessionTodoDock } from "./session-todo-dock"
import { useOrchestrationRun } from "../orchestration-run"
import { DialogRunIntegration } from "../dialog-run-integration"

export function SessionOrchestrationDock(props: {
  sessionID: Accessor<string | undefined>
  onReview: () => void
}) {
  const run = useOrchestrationRun(props.sessionID)
  const dialog = useDialog()
  const [collapsed, setCollapsed] = createSignal(true)
  const [answer, setAnswer] = createSignal("")
  const [cannot, setCannot] = createSignal(false)
  const [editingPlan, setEditingPlan] = createSignal(false)
  const [planText, setPlanText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [queueError, setQueueError] = createSignal("")
  const [integrationMenu, setIntegrationMenu] = createSignal(false)
  const [dismissedDelivery, setDismissedDelivery] = createSignal<string>()
  const detail = () => run.detail()
  const request = createMemo(() => detail()?.humanRequests.find((item) => item.status === "open" && item.kind !== "clarification"))
  const proposedPlan = createMemo(() => detail()?.plans.findLast((plan) => plan.status === "proposed"))
  const proposedPlanID = createMemo(() => proposedPlan()?.id)
  const delivery = createMemo(() => detail()?.deliveries.at(-1))
  const defaultAction = createMemo(() => detail()?.run.policy?.integrationDefault ?? "commit")
  const actionLabels: Record<Orchestration.IntegrationAction, string> = {
    apply: "Apply to working tree", commit: "Commit…", merge: "Merge into branch…",
    push: "Push…", pull_request: "Create pull request…", discard: "Discard run…",
  }
  const requestAttempt = createMemo(() => detail()?.attempts.findLast((attempt) => attempt.taskID === request()?.taskID))
  const pendingQueue = createMemo(() => detail()?.queuedFollowUps.filter((item) =>
    item.status === "queued" || (item.status === "steered" && !detail()?.plans.some((plan) =>
      plan.time.applied && item.timeSteered &&
      DateTime.toEpochMillis(plan.time.applied) >= DateTime.toEpochMillis(item.timeSteered)))) ?? [])
  const openIntegration = (action: Orchestration.IntegrationAction) => void dialog.show(() => <DialogRunIntegration run={run} initialAction={action} />)
  const tasks = createMemo(() => detail()?.tasks.filter((task) => task.status !== "cancelled").map((task) => ({
    content: `${task.status === "waiting_on_human" ? "⚑ " : task.status === "suspended" ? "◷ " : ""}${task.title}`,
    status: task.status === "succeeded" ? "completed" : task.status === "running" ? "in_progress" : "pending",
    priority: "medium",
  })) ?? [])

  createEffect(() => {
    request()?.id
    setAnswer("")
    setCannot(false)
    setEditingPlan(false)
    setError("")
  })
  createEffect(() => {
    proposedPlanID()
    setPlanText(JSON.stringify(untrack(() => proposedPlan()?.output ?? {}), null, 2))
  })

  const respond = async (value: string) => {
    const current = request()
    if (!current || !value.trim()) return
    setBusy(true)
    setError("")
    try {
      await run.post(`/request/${encodeURIComponent(current.id)}/answer`, { answer: value.trim() })
      setAnswer("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const steer = async (turnID: string) => {
    setBusy(true)
    setQueueError("")
    try {
      await run.post(`/follow-up/${encodeURIComponent(turnID)}/steer`)
    } catch (cause) {
      setQueueError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const savePlan = async () => {
    setBusy(true)
    setError("")
    try {
      const output = await Schema.decodeUnknownPromise(Orchestration.PlanOutput)(JSON.parse(planText()) as unknown)
      await run.post("/plan", output)
      setEditingPlan(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={run.runID()}>
      <div class="pointer-events-auto flex flex-col gap-2 pb-2">
        <Show when={tasks().length > 0}>
          <SessionTodoDock
            todos={tasks()}
            collapsed={collapsed()}
            onToggle={() => setCollapsed(!collapsed())}
            collapseLabel="Collapse plan"
            expandLabel="Expand plan"
            dockProgress={1}
          />
        </Show>
        <Show when={pendingQueue().length}>
          <div class="rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-13-regular">
            <div class="text-13-medium">Follow-ups and guidance</div>
            <For each={pendingQueue()}>
              {(item, index) => <div class="mt-1 flex items-center gap-2 text-text-weak">
                <span class="min-w-0 flex-1 truncate">{index() + 1}. {item.objective}</span>
                <Show when={item.status === "queued" && detail()?.run.status === "active"}>
                  <Button variant="secondary" size="normal" disabled={busy()} onClick={() => void steer(item.id)}>Send to planner now</Button>
                </Show>
                <Show when={item.status === "steered"}>
                  <span>{detail()?.plans.some((plan) => plan.time.applied && item.timeSteered &&
                    DateTime.toEpochMillis(plan.time.applied) >= DateTime.toEpochMillis(item.timeSteered))
                    ? "Included in this turn"
                    : detail()?.plans.some((plan) => item.timeSteered &&
                      DateTime.toEpochMillis(plan.time.created) >= DateTime.toEpochMillis(item.timeSteered))
                      ? "Planner update pending"
                      : "Sent to planner"}</span>
                  <Show when={!detail()?.plans.some((plan) => item.timeSteered &&
                    DateTime.toEpochMillis(plan.time.created) >= DateTime.toEpochMillis(item.timeSteered)) && detail()?.run.status === "active"}>
                    <Button variant="secondary" size="normal" disabled={busy()} onClick={() => void steer(item.id)}>Retry planning</Button>
                  </Show>
                </Show>
              </div>}
            </For>
            <Show when={queueError()}><div class="mt-2 text-red-500">{queueError()}</div></Show>
          </div>
        </Show>
        <Show when={request()}>
          {(current) => (
            <DockPrompt
              kind="permission"
              header={<div class="text-14-medium">{
                current().kind === "human_step" ? "Your step" :
                current().kind === "plan_approval" ? "Review the plan" :
                current().kind === "budget_exhausted" ? "Decision needed" :
                current().kind === "recovery" ? "Recovery needed" : "Question"
              }</div>}
              footer={
                <div class="flex flex-wrap gap-2 justify-end">
                  <For each={current().choices}>
                    {(choice) => <Button variant={choice === "done" || choice === "approve" ? "primary" : "secondary"}
                      size="normal" disabled={busy()} onClick={() => void respond(choice)}>{({
                        done: "Done", skip: "Skip task", cancel: "Cancel run", approve: "Approve", reject: "Reject",
                        retry: current().kind === "budget_exhausted" ? "Grant +1 attempt" : "Retry",
                        accept: "Accept as is", replan: "Replan", "grant-replan": "Grant one replan",
                      } as Record<string, string>)[choice] ?? choice}</Button>}
                  </For>
                  <Show when={current().kind === "human_step"}>
                    <Button variant="secondary" size="normal" disabled={busy()} onClick={() => setCannot(true)}>I can't do this…</Button>
                    <Show when={cannot() && answer().trim()}>
                      <Button variant="primary" size="normal" disabled={busy()} onClick={() => void respond(`cannot:${answer().trim()}`)}>Send feedback and replan</Button>
                    </Show>
                  </Show>
                  <Show when={current().kind === "plan_approval" && proposedPlan()}>
                    <Button variant="secondary" size="normal" disabled={busy()} onClick={() => setEditingPlan(!editingPlan())}>{editingPlan() ? "Close editor" : "Edit plan"}</Button>
                    <Show when={editingPlan()}><Button variant="primary" size="normal" disabled={busy()} onClick={() => void savePlan()}>Save edited plan</Button></Show>
                  </Show>
                  <Show when={answer().trim() && current().kind !== "plan_approval" && current().kind !== "human_step"}>
                    <Button variant="primary" size="normal" disabled={busy()} onClick={() => void respond(answer())}>
                      {current().kind === "budget_exhausted" ? "Grant +1 with guidance" : "Send answer"}
                    </Button>
                  </Show>
                </div>
              }
            >
              <div class="flex flex-col gap-2 p-2 text-14-regular">
                <div class="whitespace-pre-wrap">{current().prompt}</div>
                <Show when={current().kind === "budget_exhausted" && requestAttempt()?.verdict}>
                  <div class="rounded-md border border-border-weak-base p-2 text-text-weak">
                    Latest verdict: {requestAttempt()?.verdict?.decision} · {Math.round((requestAttempt()?.verdict?.confidence ?? 0) * 100)}% confidence
                    <Show when={requestAttempt()?.feedback?.text}><div class="mt-1">{requestAttempt()?.feedback?.text}</div></Show>
                  </div>
                </Show>
                <Show when={current().assumption}>
                  <button type="button" class="text-left text-text-weak underline" onClick={() => setAnswer(current().assumption ?? "")}>Use assumption: {current().assumption}</button>
                </Show>
                <Show when={current().kind === "plan_approval" && proposedPlan()}>
                  <div class="rounded-md border border-border-weak-base p-2">
                    <div class="text-13-medium">{proposedPlan()?.output.tasks.length} proposed tasks</div>
                    <For each={proposedPlan()?.output.tasks}>{(task) => <div class="mt-1 text-text-weak">
                      {task.title} · {task.capabilityTier ?? "default tier"}
                      <Show when={task.acceptanceCriteria?.length}><div class="pl-3">{task.acceptanceCriteria?.map((criterion) => criterion.description).join(" · ")}</div></Show>
                    </div>}</For>
                  </div>
                  <Show when={editingPlan()}><textarea class="w-full min-h-48 rounded-md border border-border-weak-base bg-background-base p-2 font-mono text-12-regular" value={planText()} onInput={(event) => setPlanText(event.currentTarget.value)} /></Show>
                </Show>
                <Show when={current().kind !== "plan_approval" && (current().kind !== "human_step" || cannot())}>
                  <textarea class="w-full rounded-md border border-border-weak-base bg-background-base p-2" rows={2}
                    placeholder={current().kind === "human_step" ? "What blocks this step?" : current().kind === "budget_exhausted" ? "Guidance for the next attempt" : "Add guidance or a custom answer"}
                    value={answer()} onInput={(event) => setAnswer(event.currentTarget.value)} />
                </Show>
                <Show when={error()}><div class="text-red-500">{error()}</div></Show>
              </div>
            </DockPrompt>
          )}
        </Show>
        <Show when={detail()?.run.status === "delivered" && delivery()}>
          <Show when={dismissedDelivery() !== delivery()?.id} fallback={<Button variant="secondary" size="normal" onClick={() => setDismissedDelivery(undefined)}>Show delivered changes</Button>}>
            <div class="flex items-center gap-2 rounded-xl border border-border-weak-base bg-background-base px-3 py-2 text-14-regular">
              <span class="min-w-0 flex-1 truncate">Delivered · {delivery()?.changedFiles ?? 0} files</span>
              <Button variant="secondary" size="normal" onClick={props.onReview}>Review changes</Button>
              <SplitButtonV2>
                <SplitButtonV2Action onClick={() => openIntegration(defaultAction())}>{actionLabels[defaultAction()]}</SplitButtonV2Action>
                <MenuV2 open={integrationMenu()} onOpenChange={setIntegrationMenu} placement="top-end" modal={false}>
                  <MenuV2.Trigger as={SplitButtonV2MenuTrigger} aria-label="Other integration actions"><Icon name="chevron-down" size="small" /></MenuV2.Trigger>
                  <MenuV2.Portal><MenuV2.Content>
                    <For each={(["apply", "commit", "merge", "push", "pull_request", "discard"] as const).filter((action) => action !== defaultAction())}>
                      {(action) => <MenuV2.Item onSelect={() => { setIntegrationMenu(false); openIntegration(action) }}>{actionLabels[action]}</MenuV2.Item>}
                    </For>
                  </MenuV2.Content></MenuV2.Portal>
                </MenuV2>
              </SplitButtonV2>
              <Button variant="secondary" size="normal" onClick={() => setDismissedDelivery(delivery()?.id)}>Dismiss</Button>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  )
}
