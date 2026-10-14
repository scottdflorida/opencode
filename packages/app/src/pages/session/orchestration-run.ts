import { Location } from "@opencode-ai/schema/location"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Option, Schema } from "effect"
import { createContext, createEffect, createResource, onCleanup, useContext, type Accessor } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

const decodeDetail = Schema.decodeUnknownPromise(Location.response(Orchestration.Detail))
const decodePreflight = Schema.decodeUnknownPromise(Location.response(Orchestration.IntegrationPreflight))
const decodeTargets = Schema.decodeUnknownPromise(Location.response(Orchestration.IntegrationTargets))
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  durable: Schema.Struct({ seq: Schema.Int }),
})))
export const OrchestrationRunContext = createContext<ReturnType<typeof createOrchestrationRun>>()

export function useOrchestrationRun(sessionID: Accessor<string | undefined>) {
  const shared = useContext(OrchestrationRunContext)
  if (shared) return shared
  return createOrchestrationRun(sessionID)
}

function createOrchestrationRun(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const runID = () => sessionID()?.startsWith("ses_orch_") ? sessionID()!.slice("ses_orch_".length) : undefined
  const query = () => new URLSearchParams({ "location[directory]": sdk().directory })
  const path = (id: string, suffix = "") => `/api/orchestration/${encodeURIComponent(id)}${suffix}?${query()}`
  const [detail, actions] = createResource(
    () => runID(),
    async (id) => {
      const response = await serverSDK().request(path(id))
      if (!response.ok) throw new Error(await response.text())
      return (await decodeDetail(await response.json())).data
    },
  )

  createEffect(() => {
    const id = runID()
    if (!id) return
    const abort = new AbortController()
    let cursor = 0
    let refresh: ReturnType<typeof setTimeout> | undefined
    const listen = async () => {
      while (!abort.signal.aborted) {
        const response = await serverSDK().request(path(id, "/event") + `&after=${cursor}`, {
          signal: abort.signal,
          headers: { Accept: "text/event-stream" },
        }).catch(() => undefined)
        if (!response?.ok || !response.body) {
          await new Promise((resolve) => setTimeout(resolve, 1_000))
          continue
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!abort.signal.aborted) {
          const next = await reader.read().catch(() => undefined)
          if (!next || next.done) break
          buffer += decoder.decode(next.value, { stream: true })
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          frames.forEach((frame) => {
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
            if (!data) return
            const decoded = decodeEvent(data)
            if (Option.isNone(decoded) || decoded.value.durable.seq <= cursor) return
            cursor = decoded.value.durable.seq
            if (refresh) return
            refresh = setTimeout(() => {
              refresh = undefined
              void actions.refetch()
            }, 100)
          })
        }
      }
    }
    void listen()
    onCleanup(() => {
      abort.abort()
      if (refresh) clearTimeout(refresh)
    })
  })

  const post = async (suffix: string, payload?: Record<string, unknown>) => {
    const id = runID()
    if (!id) throw new Error("No orchestration run is open")
    const response = await serverSDK().request(path(id, suffix), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    })
    if (!response.ok) throw new Error(await response.text())
    const result = (await decodeDetail(await response.json())).data
    actions.mutate(result)
    return result
  }

  const preflight = async (options: Orchestration.IntegrationOptions) => {
    const id = runID()
    if (!id) throw new Error("No orchestration run is open")
    const response = await serverSDK().request(path(id, "/integration/preflight"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    })
    if (!response.ok) throw new Error(await response.text())
    return (await decodePreflight(await response.json())).data
  }

  const targets = async () => {
    const id = runID()
    if (!id) throw new Error("No orchestration run is open")
    const response = await serverSDK().request(path(id, "/integration/targets"))
    if (!response.ok) throw new Error(await response.text())
    return (await decodeTargets(await response.json())).data
  }

  return { runID, detail, refresh: actions.refetch, post, preflight, targets }
}
