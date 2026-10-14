import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { showToast } from "@/utils/toast"
import type { useOrchestrationRun } from "./orchestration-run"

export function DialogRunIntegration(props: { run: ReturnType<typeof useOrchestrationRun>; initialAction?: Orchestration.IntegrationAction }) {
  const dialog = useDialog()
  const delivery = () => props.run.detail()?.deliveries.at(-1)
  const [action, setAction] = createSignal<Orchestration.IntegrationAction>(props.initialAction ?? "commit")
  const [branch, setBranch] = createSignal("")
  const [targetBranch, setTargetBranch] = createSignal("")
  const [remote, setRemote] = createSignal("origin")
  const [history, setHistory] = createSignal<"squash" | "per_task">("squash")
  const [mergeStrategy, setMergeStrategy] = createSignal<"ff" | "merge" | "squash">("merge")
  const [message, setMessage] = createSignal(delivery()?.commitMessage ?? "")
  const [draft, setDraft] = createSignal(true)
  const [confirmPush, setConfirmPush] = createSignal(false)
  const [confirmDiscard, setConfirmDiscard] = createSignal(false)
  const [preview, setPreview] = createSignal<Orchestration.IntegrationPreflight>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [targets] = createResource(() => props.run.runID(), () => props.run.targets())
  const failedIntegration = () => props.run.detail()?.integrations.findLast((item) =>
    item.deliveryID === delivery()?.id && item.status === "failed")
  const options = createMemo<Orchestration.IntegrationOptions>(() => ({
    action: action(),
    expectedHead: delivery()?.head ?? "",
    branch: branch().trim() || undefined,
    targetBranch: targetBranch().trim() || undefined,
    remote: remote().trim() || undefined,
    history: history(),
    mergeStrategy: mergeStrategy(),
    commitMessage: message().trim() || undefined,
    draft: draft(),
    confirmDefaultPush: confirmPush(),
    confirmDiscard: confirmDiscard(),
    expectedTargetHead: preview()?.targetHead,
  }))
  const resetPreview = () => {
    setPreview(undefined)
    setError("")
  }
  const inspect = async () => {
    setBusy(true)
    setError("")
    try {
      setPreview(await props.run.preflight(options()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const integrate = async () => {
    if (!preview() || preview()!.blockers.length > 0) return
    setBusy(true)
    setError("")
    try {
      const result = await props.run.post("/integration", options())
      const latest = result.integrations.at(-1)
      if (latest?.status === "failed") {
        setError(latest.steps.findLast((step) => step.status === "failed")?.message ?? "Integration failed")
        return
      }
      showToast({ title: "Run integrated", description: latest?.steps.map((step) => step.name).join(" · ") ?? "Completed" })
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      void props.run.refresh()
    } finally {
      setBusy(false)
    }
  }
  const retry = async () => {
    const failed = failedIntegration()
    if (!failed) return
    setBusy(true)
    setError("")
    try {
      const result = await props.run.post(`/integration/${encodeURIComponent(failed.id)}/retry`)
      const latest = result.integrations.find((item) => item.id === failed.id)
      if (latest?.status === "failed") {
        setError(latest.steps.findLast((step) => step.status === "failed")?.message ?? "Integration retry failed")
        return
      }
      showToast({ title: "Integration completed", description: latest?.steps.map((step) => step.name).join(" · ") ?? "Completed" })
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      void props.run.refresh()
    } finally {
      setBusy(false)
    }
  }
  const resolveConflict = async () => {
    const current = preview()
    const target = current?.targetBranch
    if (!current?.targetHead || !target) return
    setBusy(true)
    setError("")
    try {
      await props.run.post("/follow-up", {
        objective: `Resolve the delivery conflicts with local branch ${target}. Merge ${target} into the run branch, preserve the delivered changes, resolve conflicts, and run the configured checks.`,
        context: `The delivered run head is ${current.head}. The target branch ${target} was at ${current.targetHead} during integration preflight. The prior integration was deferred because the branches conflict.`,
      })
      showToast({ title: "Conflict resolution started", description: `The run will resolve changes against ${target}.` })
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogV2 fit containerClass="!h-auto max-h-[calc(100vh_-_16px)] !w-[min(calc(100vw_-_16px),640px)]">
      <DialogHeader closeLabel="Close"><DialogTitle>Integrate run</DialogTitle></DialogHeader>
      <DialogBody class="max-h-[calc(100vh_-_68px)] overflow-y-auto gap-4 px-5 pb-5">
        <div class="grid grid-cols-2 gap-3 text-13-regular">
          <label class="flex flex-col gap-1">Action
            <select class="rounded-md border border-border-weak-base bg-background-base p-2" value={action()}
              onChange={(event) => { setAction(event.currentTarget.value as Orchestration.IntegrationAction); resetPreview() }}>
              <option value="apply">Apply to working tree</option>
              <option value="commit">Commit</option>
              <option value="merge">Merge</option>
              <option value="push">Push</option>
              <option value="pull_request">Create pull request</option>
              <option value="discard">Discard run</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">History
            <select class="rounded-md border border-border-weak-base bg-background-base p-2" value={history()}
              onChange={(event) => { setHistory(event.currentTarget.value as "squash" | "per_task"); resetPreview() }}>
              <option value="squash">Squash</option>
              <option value="per_task">Per task</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">Branch
            <input class="rounded-md border border-border-weak-base bg-background-base p-2" value={branch()} placeholder={`jewel/${props.run.runID()?.slice(4).toLowerCase() ?? "run"}`}
              onInput={(event) => { setBranch(event.currentTarget.value); resetPreview() }} />
          </label>
          <label class="flex flex-col gap-1">Target branch
            <input class="rounded-md border border-border-weak-base bg-background-base p-2" value={targetBranch()} list="run-integration-target-branches"
              placeholder={props.run.detail()?.run.workspace?.sourceBranch ?? "Choose a local branch"}
              onInput={(event) => { setTargetBranch(event.currentTarget.value); resetPreview() }} />
            <datalist id="run-integration-target-branches"><For each={targets()?.branches ?? []}>{(name) => <option value={name} />}</For></datalist>
          </label>
          <label class="flex flex-col gap-1">Remote
            <input class="rounded-md border border-border-weak-base bg-background-base p-2" value={remote()}
              onInput={(event) => { setRemote(event.currentTarget.value); resetPreview() }} />
          </label>
          <label class="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={draft()}
            onChange={(event) => { setDraft(event.currentTarget.checked); resetPreview() }} />Draft pull request</label>
          <Show when={action() === "merge" || action() === "push"}>
            <label class="flex flex-col gap-1">Merge strategy
              <select class="rounded-md border border-border-weak-base bg-background-base p-2" value={mergeStrategy()}
                onChange={(event) => { setMergeStrategy(event.currentTarget.value as "ff" | "merge" | "squash"); resetPreview() }}>
                <option value="merge">Merge commit</option><option value="squash">Squash</option><option value="ff">Fast forward</option>
              </select>
            </label>
          </Show>
        </div>
        <Show when={targets()?.worktrees.length}><div class="text-13-regular text-text-weak">Open worktrees: {targets()?.worktrees.map((item) => item.branch).join(" · ")}</div></Show>
        <label class="flex flex-col gap-1 text-13-regular">Commit message
          <textarea class="rounded-md border border-border-weak-base bg-background-base p-2" rows={3} value={message()}
            onInput={(event) => { setMessage(event.currentTarget.value); resetPreview() }} />
        </label>
        <Show when={action() === "push"}>
          <label class="flex items-center gap-2 text-13-regular"><input type="checkbox" checked={confirmPush()}
            onChange={(event) => { setConfirmPush(event.currentTarget.checked); resetPreview() }} />Confirm push to default branch if required</label>
        </Show>
        <Show when={action() === "discard"}>
          <label class="flex items-center gap-2 text-13-regular"><input type="checkbox" checked={confirmDiscard()}
            onChange={(event) => { setConfirmDiscard(event.currentTarget.checked); resetPreview() }} />Discard this run</label>
        </Show>
        <Show when={preview()}>
          {(item) => <div class="flex flex-col gap-2 rounded-lg border border-border-weak-base p-3 text-13-regular">
            <For each={item().blockers}>{(blocker) => <div class="text-red-500">{blocker}</div>}</For>
            <For each={item().warnings}>{(warning) => <div class="text-text-weak">{warning}</div>}</For>
            <details><summary>Commands to run</summary>
              <pre class="mt-2 overflow-x-auto whitespace-pre-wrap text-12-regular">{item().commands.join("\n")}</pre>
            </details>
          </div>}
        </Show>
        <Show when={preview()?.targetHead && preview()?.cleanMerge === false && action() !== "discard" && action() !== "apply"}>
          <div class="flex gap-2">
            <Button variant="secondary" size="normal" disabled={busy()} onClick={() => void resolveConflict()}>Resolve with an agent</Button>
            <Show when={action() !== "pull_request"}>
              <Button variant="secondary" size="normal" disabled={busy()} onClick={() => { setAction("pull_request"); resetPreview() }}>Open PR instead</Button>
            </Show>
          </div>
        </Show>
        <Show when={error()}><div class="text-red-500 text-13-regular whitespace-pre-wrap">{error()}</div></Show>
        <Show when={failedIntegration()}>{(failed) => <div class="flex items-center gap-2 text-13-regular">
          <span class="text-text-weak">Previous {failed().options.action} action stopped after {failed().steps.filter((step) => step.status === "succeeded").length} completed steps.</span>
          <Button variant="secondary" size="normal" disabled={busy()} onClick={() => void retry()}>Retry remaining steps</Button>
          <Show when={action() !== "pull_request"}><Button variant="secondary" size="normal" disabled={busy()} onClick={() => { setAction("pull_request"); resetPreview() }}>Open PR instead</Button></Show>
        </div>}</Show>
        <div class="flex justify-end gap-2">
          <Button variant="secondary" size="normal" disabled={busy()} onClick={() => void inspect()}>Preview</Button>
          <Button variant="primary" size="normal" disabled={busy() || !preview() || !!preview()?.blockers.length}
            onClick={() => void integrate()}>Run action</Button>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
