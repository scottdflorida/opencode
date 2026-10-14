import { Schema } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Button } from "@opencode-ai/ui/button"
import { createResource, createSignal, For, Show, type Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

export function SettingsOrchestrationV2(props: { directory: Accessor<string | undefined> }) {
  const server = useServerSDK()
  const [busy, setBusy] = createSignal("")
  const [error, setError] = createSignal("")
  const [jevTest, setJevTest] = createSignal<{ status: string; model: string; latencyMs: number }>()
  const [checkResults, setCheckResults] = createSignal<Record<string, ReadonlyArray<{ name: string; exitCode: number; stdout: string; stderr: string; truncated: boolean }>>>({})
  const [config, configActions] = createResource(async () => (await server().client.global.config.get()).data)
  const [catalog, catalogActions] = createResource(
    () => props.directory(),
    async (directory) => {
      const query = new URLSearchParams({ "location[directory]": directory })
      const response = await server().request(`/api/orchestration/policy?${query}`)
      if (!response.ok) throw new Error(await response.text())
      return (await Schema.decodeUnknownPromise(Location.response(Orchestration.PolicyCatalog))(await response.json())).data
    },
  )
  const policies = () => catalog()?.policies ?? []
  const [jevStatus] = createResource(() => props.directory(), async (directory) => {
    const query = new URLSearchParams({ "location[directory]": directory })
    const response = await server().request(`/api/orchestration/judges/jev?${query}`)
    if (!response.ok) throw new Error(await response.text())
    return (await Schema.decodeUnknownPromise(Location.response(Schema.Struct({ keyPresent: Schema.Boolean, model: Schema.String })))(await response.json())).data
  })
  const testJev = async () => {
    const directory = props.directory()
    if (!directory) return
    setBusy("jev")
    setError("")
    try {
      const query = new URLSearchParams({ "location[directory]": directory })
      const response = await server().request(`/api/orchestration/judges/jev/test?${query}`, { method: "POST" })
      if (!response.ok) throw new Error(await response.text())
      setJevTest((await Schema.decodeUnknownPromise(Location.response(Schema.Struct({ status: Schema.String, model: Schema.String, latencyMs: Schema.Number })))(await response.json())).data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }
  const verifyPreset = async (name: string) => {
    const directory = props.directory()
    if (!directory) return
    setBusy(`check:${name}`)
    setError("")
    try {
      const query = new URLSearchParams({ "location[directory]": directory })
      const response = await server().request(`/api/orchestration/check-presets/${encodeURIComponent(name)}/run?${query}`, { method: "POST" })
      if (!response.ok) throw new Error(await response.text())
      const result = (await Schema.decodeUnknownPromise(Location.response(Schema.Array(Schema.Struct({
        name: Schema.String, exitCode: Schema.Int, stdout: Schema.String, stderr: Schema.String, truncated: Schema.Boolean,
      }))))(await response.json())).data
      setCheckResults((current) => ({ ...current, [name]: result }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }
  const update = async (name: string, orchestration: NonNullable<NonNullable<ReturnType<typeof config>>["orchestration"]>) => {
    setBusy(name)
    setError("")
    try {
      await server().client.global.config.update({ config: { orchestration } })
      await Promise.all([configActions.refetch(), catalogActions.refetch()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy("")
    }
  }
  const editPolicy = (name: string, patch: Record<string, unknown>) => {
    const current = config()?.orchestration
    const policy = current?.policies?.[name]
    if (!policy) return
    void update(name, { ...current, policies: { ...current?.policies, [name]: { ...policy, ...patch } } })
  }
  const duplicate = (name: string) => {
    const current = config()?.orchestration
    const policy = current?.policies?.[name]
    if (!policy) return
    const names = new Set(Object.keys(current?.policies ?? {}))
    const base = `${name}-copy`
    const copy = names.has(base) ? Array.from({ length: 99 }, (_, index) => `${base}-${index + 2}`).find((value) => !names.has(value)) : base
    if (!copy) return
    void update(copy, { ...current, policies: { ...current?.policies, [copy]: policy } })
  }

  return <>
    <div class="settings-v2-tab-header"><h2 class="settings-v2-tab-title">Orchestration</h2></div>
    <div class="settings-v2-tab-body flex flex-col gap-6">
      <Show when={error()}><div class="text-red-500 text-13-regular">{error()}</div></Show>
      <section class="settings-v2-section">
        <h3 class="settings-v2-section-title">Policies</h3>
        <SettingsListV2>
          <Show when={policies().length} fallback={<div class="p-3 text-13-regular text-v2-text-text-muted">Open a project with orchestration policies to edit them.</div>}>
            <For each={policies()}>{(policy) => {
              const editable = () => !!config()?.orchestration?.policies?.[policy.name]
              return <div class="border-b border-v2-border-border-base p-3 text-13-regular">
                <div class="flex items-center justify-between gap-2"><strong>{policy.name}{catalog()?.defaultPolicy === policy.name ? " · default" : ""}</strong>
                  <div class="flex gap-2"><Button variant="secondary" size="normal" disabled={!!busy()} onClick={() => void update(policy.name, { ...config()?.orchestration, default_policy: policy.name })}>Set default</Button>
                    <Button variant="secondary" size="normal" disabled={!!busy() || !editable()} onClick={() => duplicate(policy.name)}>Duplicate</Button></div>
                </div>
                <div class="mt-1 text-v2-text-text-muted">Planner {policy.roles.planner} · executor {policy.roles.executor} · judge {policy.roles.judge.provider}</div>
                <div class="mt-1 text-v2-text-text-muted">Escalation {policy.escalationChain.join(" → ") || "none"} · approval {policy.planApproval}</div>
                <div class="mt-3 grid grid-cols-2 gap-3">
                  <label class="flex flex-col gap-1">Minimum confidence (%)
                    <input type="number" min="0" max="100" step="1" class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2"
                      value={Math.round(policy.acceptance.minConfidence * 100)} disabled={!editable() || !!busy()}
                      onChange={(event) => editPolicy(policy.name, { acceptance: {
                        ...config()?.orchestration?.policies?.[policy.name]?.acceptance,
                        min_confidence: Math.max(0, Math.min(100, Number(event.currentTarget.value))) / 100,
                      } })} />
                  </label>
                  <label class="flex flex-col gap-1">Max revisions per route
                    <input type="number" min="0" step="1" class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2"
                      value={policy.budgets.maxRevisionsPerRoute} disabled={!editable() || !!busy()}
                      onChange={(event) => editPolicy(policy.name, { budgets: {
                        ...config()?.orchestration?.policies?.[policy.name]?.budgets,
                        max_revisions_per_route: Math.max(0, Math.floor(Number(event.currentTarget.value))),
                      } })} />
                  </label>
                  <label class="flex flex-col gap-1">Max escalations
                    <input type="number" min="0" step="1" class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2"
                      value={policy.budgets.maxEscalations} disabled={!editable() || !!busy()}
                      onChange={(event) => editPolicy(policy.name, { budgets: {
                        ...config()?.orchestration?.policies?.[policy.name]?.budgets,
                        max_escalations: Math.max(0, Math.floor(Number(event.currentTarget.value))),
                      } })} />
                  </label>
                  <label class="flex flex-col gap-1">Plan approval
                    <select class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2" value={policy.planApproval}
                      disabled={!editable() || !!busy()} onChange={(event) => editPolicy(policy.name, { plan_approval: event.currentTarget.value })}>
                      <option value="auto">Automatic</option><option value="human">Ask me</option>
                    </select>
                  </label>
                </div>
                <Show when={!editable()}><div class="mt-2 text-v2-text-text-muted">This policy is defined in project config. Edit that file to change its settings.</div></Show>
              </div>
            }}</For>
          </Show>
        </SettingsListV2>
      </section>
      <section class="settings-v2-section"><h3 class="settings-v2-section-title">Judges</h3>
        <SettingsListV2>
          <SettingsRowV2 title="Jev connection" description={`${jevStatus()?.model ?? "jev-latest"} · ${jevStatus()?.keyPresent ? "API key present" : "API key missing"}`}>
            <div class="flex items-center gap-2"><Show when={jevTest()}>{(result) => <span class="text-13-regular">{result().status} · {result().latencyMs} ms</span>}</Show>
              <Button variant="secondary" size="normal" disabled={!!busy() || !jevStatus()?.keyPresent} onClick={() => void testJev()}>Test call</Button></div>
          </SettingsRowV2>
          <For each={policies()}>{(policy) => {
            const configured = () => config()?.orchestration?.policies?.[policy.name]
            const judge = () => configured()?.roles?.judge
            return <SettingsRowV2 title={`${policy.name} judge`} description={`${policy.roles.judge.provider}${policy.roles.judge.provider === "llm" ? ` · ${policy.roles.judge.routeProfile ?? "route unset"}` : ""}${policy.roles.judge.experiment ? ` · ${policy.roles.judge.experiment.assignment} experiment` : ""}`}>
              <label class="flex items-center gap-2 text-13-regular">Label sample (%)
                <input type="number" min="0" max="100" step="1" class="w-16 rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-1"
                  value={Math.round((policy.roles.judge.labelSampleRate ?? 0) * 100)} disabled={!judge() || !!busy()}
                  onChange={(event) => {
                    const current = configured()
                    if (!current?.roles?.judge) return
                    editPolicy(policy.name, { roles: { ...current.roles, judge: { ...current.roles.judge,
                      label_sample_rate: Math.max(0, Math.min(100, Number(event.currentTarget.value))) / 100 } } })
                  }} />
              </label>
            </SettingsRowV2>
          }}</For>
        </SettingsListV2>
      </section>
      <section class="settings-v2-section"><h3 class="settings-v2-section-title">Check presets</h3>
        <SettingsListV2><For each={Object.entries(config()?.orchestration?.check_presets ?? {})}>{([name, preset]) =>
          <SettingsRowV2 title={name} description={preset.description ?? preset.checks.map((check) => check.name).join(", ")}>
            <div class="text-13-regular text-right">
              <For each={preset.checks}>{(check) => <div><code>{check.command}</code> · {check.workingDirectory || "project root"}</div>}</For>
              <Button variant="secondary" size="normal" class="mt-2" disabled={!!busy()} onClick={() => void verifyPreset(name)}>
                {busy() === `check:${name}` ? "Running…" : "Run once"}
              </Button>
              <Show when={checkResults()[name]}>{(results) => <div class="mt-2 text-left">
                <For each={results()}>{(result) => <details class="mt-1 rounded-md border border-v2-border-border-base p-2">
                  <summary>{result.name}: {result.exitCode === 0 ? "passed" : `failed (${result.exitCode})`}{result.truncated ? " · output truncated" : ""}</summary>
                  <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{result.stdout || result.stderr || "No output"}</pre>
                </details>}</For>
              </div>}</Show>
            </div>
          </SettingsRowV2>
        }</For></SettingsListV2>
      </section>
    </div>
  </>
}
