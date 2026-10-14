export * as OrchestrationHostResources from "./host-resources"

import os from "os"
import { Context, DateTime, Effect, Layer, Ref } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { makeGlobalNode } from "../effect/app-node"

export interface Interface {
  readonly latest: Effect.Effect<Orchestration.HostResourceSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationHostResources") {}

export const observe = Effect.gen(function* () {
  const load = os.loadavg()
  return {
    schema: 1,
    source: "host",
    capturedAt: yield* DateTime.now,
    platform: os.platform(),
    architecture: os.arch(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    cpuCount: os.availableParallelism(),
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
  } satisfies Orchestration.HostResourceSnapshot
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* Ref.make(yield* observe)
    yield* Effect.sleep("15 seconds").pipe(
      Effect.andThen(observe),
      Effect.flatMap((snapshot) => Ref.set(state, snapshot)),
      Effect.forever,
      Effect.forkScoped,
    )
    return Service.of({ latest: Ref.get(state) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
