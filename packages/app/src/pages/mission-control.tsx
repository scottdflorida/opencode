import { Schema } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Button } from "@opencode-ai/ui/button"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { sessionHref } from "@/utils/session-route"
import { missionControlCopy } from "./mission-control-copy"

type Detail = Orchestration.Detail
type Task = Detail["tasks"][number]

function candidateLabel(candidate: Orchestration.Candidate) {
  if (candidate.type === "direct")
    return [candidate.providerID, candidate.modelID, candidate.variant].filter(Boolean).join(" / ")
  return [candidate.harnessID, candidate.modelID, candidate.effort].filter(Boolean).join(" / ")
}

export default function MissionControl(props: { directory: string }) {
  const server = useServer()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const [state, setState] = createStore({
    tick: 0,
    selected: undefined as string | undefined,
    objective: "",
    title: "",
    description: "",
    routeProfile: "",
    checks: "",
    dependsOn: "",
    busy: false,
    error: "",
  })
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const query = new URLSearchParams({ "location[directory]": props.directory })
    const response = await serverSDK().request(`${path}?${query}`, init)
    if (!response.ok) {
      const body = await response.text()
      throw new Error(body || `${response.status} ${response.statusText}`)
    }
    const body: unknown = await response.json()
    return body
  }
  const decodeDetail = Schema.decodeUnknownPromise(Location.response(Orchestration.Detail))
  const decodeRuns = Schema.decodeUnknownPromise(Location.response(Schema.Array(Orchestration.Run)))
  const detailRequest = async (path: string, body?: Record<string, unknown>) =>
    decodeDetail(
      await request(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
    )
  const api = {
    list: async () => decodeRuns(await request("/api/orchestration")),
    get: async (runID: string) => decodeDetail(await request(`/api/orchestration/${encodeURIComponent(runID)}`)),
    create: (objective: string) => detailRequest("/api/orchestration", { objective }),
    addTask: (runID: string, input: Record<string, unknown>) =>
      detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/task`, input),
    addDependency: (runID: string, taskID: string, dependsOnTaskID: string) =>
      detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/dependency`, { taskID, dependsOnTaskID }),
    start: (runID: string) => detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/start`),
    cancel: (runID: string) => detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/cancel`),
    accept: (runID: string, taskID: string) =>
      detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/task/${encodeURIComponent(taskID)}/accept`, {}),
    reject: (runID: string, taskID: string) =>
      detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/task/${encodeURIComponent(taskID)}/reject`, {}),
    retry: (runID: string, taskID: string) =>
      detailRequest(`/api/orchestration/${encodeURIComponent(runID)}/task/${encodeURIComponent(taskID)}/retry`),
  }
  const [runs, runsActions] = createResource(
    () => state.tick,
    () => api.list(),
  )
  const [detail, detailActions] = createResource(
    () => (state.selected ? ([state.selected, state.tick] as const) : undefined),
    ([runID]) => api.get(runID),
  )
  const selected = createMemo(() => detail()?.data)

  onMount(() => {
    const timer = setInterval(() => setState("tick", (value) => value + 1), 2_000)
    onCleanup(() => clearInterval(timer))
  })

  async function mutate(action: () => Promise<{ data: Detail }>) {
    setState({ busy: true, error: "" })
    try {
      const result = await action()
      setState({ selected: result.data.run.id, tick: state.tick + 1 })
      await Promise.all([runsActions.refetch(), detailActions.refetch()])
      return true
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setState("busy", false)
    }
  }

  async function createRun(event: SubmitEvent) {
    event.preventDefault()
    const objective = state.objective.trim()
    if (!objective) return
    const success = await mutate(() => api.create(objective))
    if (!success) return
    setState("objective", "")
  }

  async function addTask(event: SubmitEvent) {
    event.preventDefault()
    const run = selected()
    const title = state.title.trim()
    if (!run || !title) return
    const before = new Set(run.tasks.map((task) => task.id))
    const success = await mutate(async () => {
      const result = await api.addTask(run.run.id, {
        title,
        description: state.description.trim() || undefined,
        routeProfile: state.routeProfile.trim() || undefined,
        checks: state.checks
          .split("\n")
          .map((command) => command.trim())
          .filter(Boolean)
          .map((command, index) => ({ name: `check-${index + 1}`, command, baseline: true })),
      })
      if (!state.dependsOn) return result
      const added = result.data.tasks.find((task) => !before.has(task.id))
      if (!added) return result
      return api.addDependency(run.run.id, added.id, state.dependsOn)
    })
    if (!success) return
    setState({ title: "", description: "", checks: "", dependsOn: "" })
  }

  const evidence = (task: Task) => {
    const attemptIDs = new Set(
      selected()
        ?.attempts.filter((attempt) => attempt.taskID === task.id)
        .map((attempt) => attempt.id),
    )
    return selected()?.evaluations.filter((evaluation) => attemptIDs.has(evaluation.attemptID)) ?? []
  }

  return (
    <div class="h-full w-full overflow-auto bg-background-base text-text-base">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
        <header class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="text-12-medium uppercase tracking-wide text-text-weak">{missionControlCopy.eyebrow}</div>
            <h1 class="mt-1 text-24-medium text-text-strong">{missionControlCopy.title}</h1>
            <p class="mt-2 max-w-2xl text-14-regular text-text-weak">{missionControlCopy.description}</p>
          </div>
          <Button variant="ghost" onClick={() => navigate(-1)}>
            {missionControlCopy.back}
          </Button>
        </header>

        <Show when={state.error}>
          <div
            role="alert"
            class="rounded-md border border-border-critical-base bg-surface-raised-base p-3 text-13-regular"
          >
            {state.error}
          </div>
        </Show>

        <div class="grid min-h-0 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside class="flex flex-col gap-4 rounded-lg border border-border-base bg-surface-base p-4">
            <form class="flex flex-col gap-3" onSubmit={createRun}>
              <label class="text-12-medium text-text-strong" for="mission-objective">
                {missionControlCopy.newObjective}
              </label>
              <textarea
                id="mission-objective"
                class="min-h-24 resize-y rounded-md border border-border-base bg-background-base p-3 text-13-regular outline-none focus:border-border-focus"
                value={state.objective}
                onInput={(event) => setState("objective", event.currentTarget.value)}
                placeholder={missionControlCopy.objectivePlaceholder}
              />
              <Button type="submit" disabled={state.busy || !state.objective.trim()}>
                {missionControlCopy.createRun}
              </Button>
            </form>

            <div class="h-px bg-border-base" />
            <div class="text-12-medium text-text-strong">{missionControlCopy.runs}</div>
            <div class="flex flex-col gap-2">
              <For
                each={runs()?.data ?? []}
                fallback={<p class="text-12-regular text-text-weak">{missionControlCopy.noRuns}</p>}
              >
                {(run) => (
                  <button
                    type="button"
                    class="rounded-md border border-border-base px-3 py-2 text-left hover:bg-surface-raised-base"
                    classList={{ "bg-surface-raised-base": state.selected === run.id }}
                    onClick={() => setState("selected", run.id)}
                  >
                    <div class="truncate text-13-medium text-text-strong">{run.objective}</div>
                    <div class="mt-1 text-11-regular uppercase text-text-weak">{run.status}</div>
                  </button>
                )}
              </For>
            </div>
          </aside>

          <main class="min-w-0">
            <Show
              when={selected()}
              fallback={
                <div class="rounded-lg border border-border-base bg-surface-base p-8 text-center text-14-regular text-text-weak">
                  {missionControlCopy.selectRun}
                </div>
              }
            >
              {(run) => (
                <div class="flex flex-col gap-5">
                  <section class="rounded-lg border border-border-base bg-surface-base p-5">
                    <div class="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div class="text-11-regular uppercase text-text-weak">{run().run.status}</div>
                        <h2 class="mt-1 text-18-medium text-text-strong">{run().run.objective}</h2>
                      </div>
                      <div class="flex gap-2">
                        <Button
                          disabled={
                            state.busy ||
                            run().tasks.length === 0 ||
                            ["cancelled", "completed"].includes(run().run.status)
                          }
                          onClick={() => mutate(() => api.start(run().run.id))}
                        >
                          {missionControlCopy.start}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={state.busy || ["cancelled", "completed"].includes(run().run.status)}
                          onClick={() => mutate(() => api.cancel(run().run.id))}
                        >
                          {missionControlCopy.cancel}
                        </Button>
                      </div>
                    </div>
                  </section>

                  <form class="grid gap-3 rounded-lg border border-border-base bg-surface-base p-5" onSubmit={addTask}>
                    <h3 class="text-14-medium text-text-strong">{missionControlCopy.addTask}</h3>
                    <div class="grid gap-3 md:grid-cols-2">
                      <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                        {missionControlCopy.taskTitle}
                        <input
                          class="rounded-md border border-border-base bg-background-base px-3 py-2 text-13-regular text-text-base outline-none focus:border-border-focus"
                          value={state.title}
                          onInput={(event) => setState("title", event.currentTarget.value)}
                        />
                      </label>
                      <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                        {missionControlCopy.routeProfile}
                        <input
                          class="rounded-md border border-border-base bg-background-base px-3 py-2 text-13-regular text-text-base outline-none focus:border-border-focus"
                          value={state.routeProfile}
                          onInput={(event) => setState("routeProfile", event.currentTarget.value)}
                          placeholder={missionControlCopy.routePlaceholder}
                        />
                      </label>
                    </div>
                    <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                      {missionControlCopy.taskInstructions}
                      <textarea
                        class="min-h-24 resize-y rounded-md border border-border-base bg-background-base p-3 text-13-regular text-text-base outline-none focus:border-border-focus"
                        value={state.description}
                        onInput={(event) => setState("description", event.currentTarget.value)}
                      />
                    </label>
                    <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                      {missionControlCopy.checks}
                      <textarea
                        class="min-h-20 resize-y rounded-md border border-border-base bg-background-base p-3 font-mono text-12-regular text-text-base outline-none focus:border-border-focus"
                        value={state.checks}
                        onInput={(event) => setState("checks", event.currentTarget.value)}
                        placeholder={missionControlCopy.checksPlaceholder}
                      />
                    </label>
                    <Show when={run().tasks.length > 0}>
                      <label class="flex flex-col gap-1 text-12-regular text-text-weak">
                        {missionControlCopy.dependsOn}
                        <select
                          class="rounded-md border border-border-base bg-background-base px-3 py-2 text-13-regular text-text-base"
                          value={state.dependsOn}
                          onChange={(event) => setState("dependsOn", event.currentTarget.value)}
                        >
                          <option value="">{missionControlCopy.independent}</option>
                          <For each={run().tasks}>{(task) => <option value={task.id}>{task.title}</option>}</For>
                        </select>
                      </label>
                    </Show>
                    <Button type="submit" disabled={state.busy || !state.title.trim()}>
                      {missionControlCopy.addTask}
                    </Button>
                  </form>

                  <section class="flex flex-col gap-3">
                    <For
                      each={run().tasks}
                      fallback={
                        <div class="rounded-lg border border-border-base p-5 text-13-regular text-text-weak">
                          {missionControlCopy.noTasks}
                        </div>
                      }
                    >
                      {(task) => {
                        const attempts = () => run().attempts.filter((attempt) => attempt.taskID === task.id)
                        const latest = () => attempts().at(-1)
                        return (
                          <article class="rounded-lg border border-border-base bg-surface-base p-5">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div class="text-11-regular uppercase text-text-weak">{task.status}</div>
                                <h3 class="mt-1 text-15-medium text-text-strong">{task.title}</h3>
                                <Show when={task.description}>
                                  <p class="mt-2 whitespace-pre-wrap text-13-regular text-text-weak">
                                    {task.description}
                                  </p>
                                </Show>
                              </div>
                              <div class="flex flex-wrap gap-2">
                                <Show when={latest()?.sessionID}>
                                  {(sessionID) => (
                                    <Button
                                      variant="ghost"
                                      onClick={() => navigate(sessionHref(server.key, sessionID()))}
                                    >
                                      {missionControlCopy.inspectSession}
                                    </Button>
                                  )}
                                </Show>
                                <Show when={task.status === "awaiting_review"}>
                                  <Button
                                    disabled={state.busy}
                                    onClick={() => mutate(() => api.accept(run().run.id, task.id))}
                                  >
                                    {missionControlCopy.accept}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={state.busy}
                                    onClick={() => mutate(() => api.reject(run().run.id, task.id))}
                                  >
                                    {missionControlCopy.reject}
                                  </Button>
                                </Show>
                                <Show when={["awaiting_review", "failed", "suspended"].includes(task.status)}>
                                  <Button
                                    variant="ghost"
                                    disabled={state.busy}
                                    onClick={() => mutate(() => api.retry(run().run.id, task.id))}
                                  >
                                    {missionControlCopy.retry}
                                  </Button>
                                </Show>
                              </div>
                            </div>
                            <Show when={latest()?.location?.directory}>
                              <div class="mt-3 break-all font-mono text-11-regular text-text-weak">
                                {latest()?.location?.directory}
                              </div>
                            </Show>
                            <Show when={latest()?.candidate}>
                              {(candidate) => (
                                <div class="mt-2 text-12-regular text-text-weak">
                                  <span class="text-text-strong">{missionControlCopy.route}:</span>{" "}
                                  {candidateLabel(candidate())}
                                </div>
                              )}
                            </Show>
                            <Show when={evidence(task).length > 0}>
                              <div class="mt-4 flex flex-col gap-2">
                                <For each={evidence(task)}>
                                  {(evaluation) => (
                                    <details class="rounded-md border border-border-base bg-background-base p-3">
                                      <summary class="cursor-pointer text-12-medium text-text-strong">
                                        {evaluation.kind} · {evaluation.status}
                                      </summary>
                                      <pre class="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-11-regular text-text-weak">
                                        {JSON.stringify(evaluation.evidence, null, 2)}
                                      </pre>
                                    </details>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </article>
                        )
                      }}
                    </For>
                  </section>
                </div>
              )}
            </Show>
          </main>
        </div>
      </div>
    </div>
  )
}
