import { Schema } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Button } from "@opencode-ai/ui/button"
import { SessionReviewFilePreviewV2 } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { parsePatch } from "diff"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { legacySessionHref } from "@/utils/session-route"

export default function Lab(props: { directory: string }) {
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const [tab, setTab] = createSignal("judges")
  const [days, setDays] = createSignal<"all" | "7" | "30">("all")
  const [judgeRole, setJudgeRole] = createSignal<"attempt" | "delivery">("attempt")
  const [selected, setSelected] = createSignal(0)
  const [selectedFile, setSelectedFile] = createSignal("")
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [manualObjective, setManualObjective] = createSignal("")
  const [manualTitle, setManualTitle] = createSignal("")
  const [manualDescription, setManualDescription] = createSignal("")
  const [manualProfile, setManualProfile] = createSignal("")
  const [manualCriterion, setManualCriterion] = createSignal("")
  const [manualRun, setManualRun] = createSignal<Orchestration.Detail>()
  const query = () => new URLSearchParams({ "location[directory]": props.directory })
  const request = async (path: string, init?: RequestInit, since?: string, role?: string) => {
    const params = query()
    if (since) params.set("since", since)
    if (role) params.set("role", role)
    const response = await serverSDK().request(`${path}?${params}`, init)
    if (!response.ok) throw new Error(await response.text())
    return response.json()
  }
  const since = (value: "all" | "7" | "30") => value === "all" ? undefined : new Date(Date.now() - Number(value) * 86_400_000).toISOString()
  const [judges, judgeActions] = createResource(() => ({ days: days(), role: judgeRole() }), async (value) => (await Schema.decodeUnknownPromise(Location.response(Orchestration.JudgeComparison))(
    await request("/api/orchestration/judges/compare", undefined, since(value.days), value.role))).data)
  const [policies] = createResource(days, async (value) => (await Schema.decodeUnknownPromise(Location.response(Orchestration.PolicyComparison))(
    await request("/api/orchestration/policies/compare", undefined, since(value)))).data)
  const [labels, labelActions] = createResource(async () => (await Schema.decodeUnknownPromise(Location.response(Schema.Array(Orchestration.ReviewPacket)))(
    await request("/api/orchestration/labels"))).data)
  const packet = createMemo(() => labels()?.[selected()])
  const manualAction = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true)
    setError("")
    try {
      const response = await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })
      return (await Schema.decodeUnknownPromise(Location.response(Orchestration.Detail))(response)).data
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const patch = createMemo(() => {
    const value = packet()?.evaluations.find((item) => item.kind === "workspace")?.evidence.patch
    return typeof value === "string" ? value : ""
  })
  const files = createMemo(() => patch().split(/(?=^diff --git )/m).filter(Boolean).flatMap((text) => {
    try {
      const parsed = parsePatch(text)[0]
      const file = (parsed?.newFileName === "/dev/null" ? parsed.oldFileName : parsed?.newFileName)?.replace(/^[ab]\//, "")
      if (!parsed || !file) return []
      const lines = parsed.hunks.flatMap((hunk) => hunk.lines)
      return [{
        file,
        patch: text,
        additions: lines.filter((line) => line.startsWith("+")).length,
        deletions: lines.filter((line) => line.startsWith("-")).length,
        status: parsed.oldFileName === "/dev/null" ? "added" as const : parsed.newFileName === "/dev/null" ? "deleted" as const : "modified" as const,
      }]
    } catch {
      return []
    }
  }))
  const activeFile = createMemo(() => files().find((file) => file.file === selectedFile()) ?? files()[0])
  const label = async (decision: "looks_ready" | "needs_attention") => {
    const current = packet()
    if (!current) return
    setBusy(true)
    setError("")
    try {
      await request(`/api/orchestration/${encodeURIComponent(current.run.id)}/task/${encodeURIComponent(current.task.id)}/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note().trim() || undefined }),
      })
      setNote("")
      await labelActions.refetch()
      await judgeActions.refetch()
      setSelected((value) => Math.min(value, (labels()?.length ?? 1) - 1))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="h-full overflow-y-auto bg-v2-background-bg-deep p-6 text-v2-text-text-base" onKeyDown={(event) => {
      if (tab() !== "labels" || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
      if (event.key === "1") { event.preventDefault(); void label("looks_ready") }
      if (event.key === "2") { event.preventDefault(); void label("needs_attention") }
      if (event.key === "ArrowLeft") { event.preventDefault(); setSelected(Math.max(0, selected() - 1)); setNote("") }
      if (event.key === "ArrowRight") { event.preventDefault(); setSelected(Math.min((labels()?.length ?? 1) - 1, selected() + 1)); setNote("") }
    }}>
      <div class="mx-auto flex max-w-5xl flex-col gap-5">
        <header class="flex items-center justify-between">
          <div><h1 class="text-24-medium">Lab</h1><p class="text-13-regular text-v2-text-text-muted">Compare judges and policies, then label blind review packets.</p></div>
          <Button variant="secondary" onClick={() => navigate(-1)}>Back</Button>
        </header>
        <div class="flex items-center gap-2 text-13-regular">
          <span class="min-w-0 truncate text-v2-text-text-muted" title={props.directory}>Project: {props.directory}</span>
          <Show when={tab() === "judges"}><label class="shrink-0">Role
            <select class="ml-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-1" value={judgeRole()}
              onChange={(event) => setJudgeRole(event.currentTarget.value as "attempt" | "delivery")}>
              <option value="attempt">Attempt judge</option><option value="delivery">Delivery reviewer</option>
            </select>
          </label></Show>
          <label class="ml-auto shrink-0">Time window
            <select class="ml-2 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-1" value={days()}
              onChange={(event) => setDays(event.currentTarget.value as "all" | "7" | "30")}>
              <option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
            </select>
          </label>
        </div>
        <details class="rounded-xl bg-v2-background-bg-base p-4 text-13-regular">
          <summary class="cursor-pointer text-14-medium">New manual run · developer tool</summary>
          <div class="mt-4 flex flex-col gap-3">
            <Show when={!manualRun()} fallback={<div class="text-v2-text-text-muted">{manualRun()?.run.objective}</div>}>
              <label class="flex flex-col gap-1">Assignment
                <textarea class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" rows={2}
                  value={manualObjective()} onInput={(event) => setManualObjective(event.currentTarget.value)} />
              </label>
              <Button variant="secondary" disabled={busy() || !manualObjective().trim()} onClick={() => void manualAction("/api/orchestration", { objective: manualObjective().trim() }).then((value) => { if (value) setManualRun(value) })}>Create draft</Button>
            </Show>
            <Show when={manualRun()}>
              {(current) => <>
                <div>{current().tasks.length} tasks added</div>
                <label class="flex flex-col gap-1">Task title
                  <input class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" value={manualTitle()} onInput={(event) => setManualTitle(event.currentTarget.value)} />
                </label>
                <label class="flex flex-col gap-1">Description
                  <textarea class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" rows={2} value={manualDescription()} onInput={(event) => setManualDescription(event.currentTarget.value)} />
                </label>
                <label class="flex flex-col gap-1">Route profile
                  <input class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" value={manualProfile()} onInput={(event) => setManualProfile(event.currentTarget.value)} />
                </label>
                <label class="flex flex-col gap-1">Acceptance criterion
                  <input class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" value={manualCriterion()} onInput={(event) => setManualCriterion(event.currentTarget.value)} />
                </label>
                <div class="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={busy() || !manualTitle().trim()} onClick={() => void manualAction(`/api/orchestration/${encodeURIComponent(current().run.id)}/task`, {
                    title: manualTitle().trim(), description: manualDescription().trim() || undefined,
                    routeProfile: manualProfile().trim() || undefined,
                    acceptanceCriteria: manualCriterion().trim() ? [{ key: "criterion", description: manualCriterion().trim() }] : undefined,
                  }).then((value) => { if (!value) return; setManualRun(value); setManualTitle(""); setManualDescription(""); setManualCriterion("") })}>Add task</Button>
                  <Button variant="primary" disabled={busy() || current().tasks.length === 0} onClick={() => void manualAction(`/api/orchestration/${encodeURIComponent(current().run.id)}/start`).then((value) => {
                    if (value?.run.sessionID) navigate(legacySessionHref(props.directory, value.run.sessionID))
                  })}>Start run</Button>
                </div>
              </>}
            </Show>
            <Show when={error()}><div class="text-red-500">{error()}</div></Show>
          </div>
        </details>
        <TabsV2 value={tab()} onChange={setTab} class="rounded-xl bg-v2-background-bg-base p-4">
          <TabsV2.List class="mb-4">
            <TabsV2.Trigger value="judges">Judges</TabsV2.Trigger>
            <TabsV2.Trigger value="policies">Policies</TabsV2.Trigger>
            <TabsV2.Trigger value="labels" subtext={labels()?.length ?? 0}>Labels</TabsV2.Trigger>
          </TabsV2.List>
          <TabsV2.Content value="judges">
            <Show when={judges()} fallback={<p>Loading judge comparison…</p>}>
              {(report) => <div class="flex flex-col gap-4">
                <div class="overflow-x-auto"><table class="w-full text-left text-13-regular">
                  <thead><tr class="text-v2-text-text-muted"><th>Arm</th><th>Valid</th><th>Fallbacks</th><th>p50 / p95</th><th>Tokens</th><th>Cost</th><th>Labels</th><th>Overrides</th><th>Delivery gaps</th></tr></thead>
                  <tbody><For each={report().arms}>{(arm) => <tr class="border-t border-v2-border-border-base">
                    <td class="py-2">{arm.name} · {arm.provider}</td><td>{arm.valid}/{arm.calls}</td><td>{arm.fallbacks}</td>
                    <td>{arm.latencyP50Ms ?? "–"} / {arm.latencyP95Ms ?? "–"} ms</td>
                    <td>{arm.inputTokens + arm.outputTokens}</td><td>${arm.estimatedCostUsd.toFixed(3)}</td>
                    <td>{judgeRole() === "delivery" ? "–" : `${arm.labelAgreement}/${arm.labeled}`}</td><td>{judgeRole() === "delivery" ? "–" : arm.humanOverrides}</td><td>{arm.downstreamGaps}</td>
                  </tr>}</For></tbody>
                </table></div>
                <For each={report().pairs}>{(pair) => <div class="rounded-lg border border-v2-border-border-base p-3 text-13-regular">
                  {pair.first} ↔ {pair.second}: {pair.agreed}/{pair.compared} agreement
                  <div class="text-v2-text-text-muted">{Object.entries(pair.confusion).map(([key, count]) => `${key} ${count}`).join(" · ")}</div>
                </div>}</For>
                <Show when={report().disagreements.length}><div class="flex flex-col gap-2">
                  <h2 class="text-14-medium">Disagreements</h2>
                  <For each={report().disagreements}>{(item) => <button type="button" class="text-left underline text-13-regular" onClick={() => navigate(legacySessionHref(props.directory, `ses_orch_${item.runID}`))}>
                    {item.first} {item.firstDecision} ↔ {item.second} {item.secondDecision} · {item.attemptID}
                  </button>}</For>
                </div></Show>
              </div>}
            </Show>
          </TabsV2.Content>
          <TabsV2.Content value="policies">
            <Show when={policies()} fallback={<p>Loading policy comparison…</p>}>
              {(report) => <div class="flex flex-col gap-3">
                <For each={report().policies}>{(policy) => <div class="rounded-lg border border-v2-border-border-base p-4 text-13-regular">
                  <div class="text-14-medium">{policy.name}</div>
                  <div class="text-v2-text-text-muted">{policy.delivered}/{policy.runs} delivered · {policy.attempts} attempts · {policy.reassignments} reassignments · {policy.humanRequests} human requests · {policy.integrations} integrations</div>
                  <div class="text-v2-text-text-muted">Per accepted task: {policy.attemptsPerAcceptedTask?.toFixed(1) ?? "–"} attempts · {policy.reassignmentsPerAcceptedTask?.toFixed(1) ?? "–"} reassignments · {policy.humanRequestsPerDelivery?.toFixed(1) ?? "–"} human requests per delivery</div>
                  <div class="text-v2-text-text-muted">Measured usage: {(policy.inputTokens + policy.outputTokens).toLocaleString()} tokens · ${policy.estimatedCostUsd.toFixed(3)} reported or estimated cost · {policy.measuredCalls} measured calls</div>
                  <Show when={policy.timeToDeliveryMs}><div>Median delivery: {Math.round((policy.timeToDeliveryMs ?? 0) / 60_000)} min</div></Show>
                  <div class="mt-2 flex flex-wrap gap-2"><For each={policy.examples}>{(id) => <button type="button" class="underline" onClick={() => navigate(legacySessionHref(props.directory, `ses_orch_${id}`))}>Open {id}</button>}</For></div>
                </div>}</For>
              </div>}
            </Show>
          </TabsV2.Content>
          <TabsV2.Content value="labels">
            <Show when={packet()} fallback={<p class="text-13-regular">No blind packets are waiting for a label.</p>}>
              {(current) => <div class="flex flex-col gap-4 text-13-regular">
                <div class="flex items-center justify-between"><span>{selected() + 1}/{labels()?.length ?? 0} · {current().task.title}</span>
                  <div class="flex gap-2"><Button variant="secondary" disabled={selected() === 0} onClick={() => { setSelected(selected() - 1); setNote("") }}>Previous</Button>
                    <Button variant="secondary" disabled={selected() + 1 >= (labels()?.length ?? 0)} onClick={() => { setSelected(selected() + 1); setNote("") }}>Next</Button></div>
                </div>
                <div class="whitespace-pre-wrap">{current().run.objective}</div>
                <For each={current().task.acceptanceCriteria}>{(criterion) => <div>• {criterion.description}</div>}</For>
                <div class="rounded-lg border border-v2-border-border-base p-3">
                  <For each={current().evaluations}>{(evaluation) => <div>{evaluation.kind}: {evaluation.status}</div>}</For>
                </div>
                <Show when={files().length} fallback={<pre class="max-h-[50vh] overflow-auto rounded-lg bg-v2-background-bg-layer-01 p-3 text-12-regular whitespace-pre-wrap">{patch() || "No patch captured"}</pre>}>
                  <div class="overflow-hidden rounded-lg border border-v2-border-border-base">
                    <div class="flex gap-1 overflow-x-auto border-b border-v2-border-border-base p-2">
                      <For each={files()}>{(file) => <Button variant={activeFile()?.file === file.file ? "primary" : "secondary"} size="normal" onClick={() => setSelectedFile(file.file)}>{file.file}</Button>}</For>
                    </div>
                    <div class="max-h-[50vh] overflow-auto"><Show when={activeFile()}>{(file) => <SessionReviewFilePreviewV2 file={file().file} diff={file()} diffStyle="unified" />}</Show></div>
                  </div>
                </Show>
                <textarea class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" rows={2} value={note()}
                  placeholder="Optional note" onInput={(event) => setNote(event.currentTarget.value)} />
                <Show when={error()}><div class="text-red-500">{error()}</div></Show>
                <div class="flex gap-2"><Button variant="primary" disabled={busy()} onClick={() => void label("looks_ready")}>Looks ready · 1</Button>
                  <Button variant="secondary" disabled={busy()} onClick={() => void label("needs_attention")}>Needs attention · 2</Button></div>
              </div>}
            </Show>
          </TabsV2.Content>
        </TabsV2>
      </div>
    </div>
  )
}
