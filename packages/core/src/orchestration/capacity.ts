export * as OrchestrationCapacity from "./capacity"

import { Context, DateTime, Deferred, Duration, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { makeGlobalNode } from "../effect/app-node"
import { Orchestration } from "@opencode-ai/schema/orchestration"

export interface Interface {
  readonly latest: Effect.Effect<Orchestration.CapacitySnapshot>
  readonly refresh: Effect.Effect<Orchestration.CapacitySnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationCapacity") {}

export interface Options {
  readonly load: Effect.Effect<Orchestration.CapacitySnapshot>
  readonly refreshInterval?: Duration.Input | false
}

export const layerWith = (options: Options) => Layer.effect(Service, make(options))

const make = (options: Options) =>
  Effect.gen(function* () {
    const initial = unavailable(yield* DateTime.now, "not_observed")
    const state = yield* Ref.make(initial)
    const lock = Semaphore.makeUnsafe(1)
    const refresh = lock.withPermit(
      options.load.pipe(
        Effect.catchCause(() => DateTime.now.pipe(Effect.map((time) => unavailable(time, "source_failed")))),
        Effect.tap((snapshot) => Ref.set(state, snapshot)),
      ),
    )
    if (options.refreshInterval !== false) {
      const start = yield* Deferred.make<void>()
      yield* Deferred.await(start).pipe(
        Effect.andThen(
          refresh.pipe(Effect.andThen(Effect.sleep(options.refreshInterval ?? "1 minute")), Effect.forever),
        ),
        Effect.forkScoped,
      )
      return Service.of({
        latest: Deferred.succeed(start, undefined).pipe(Effect.andThen(Ref.get(state))),
        refresh,
      })
    }
    return Service.of({ latest: Ref.get(state), refresh })
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const executable =
      globalThis.process.env.USAGEPOOL_EXECUTABLE ??
      (globalThis.process.platform === "darwin" ? "/Applications/UsagePool.app/Contents/MacOS/UsagePool" : "usagepool")
    const load = Effect.gen(function* () {
      const capturedAt = yield* DateTime.now
      const result = yield* process
        .run(ChildProcess.make(executable, ["--snapshot"], { extendEnv: true, stdin: "ignore" }), {
          timeout: "50 seconds",
          maxOutputBytes: 1024 * 1024,
          maxErrorBytes: 64 * 1024,
        })
        .pipe(Effect.option)
      if (result._tag === "None") return unavailable(capturedAt, "command_failed")
      return parseUsagePoolSnapshot(result.value.stdout.toString("utf8"), capturedAt)
    })
    return yield* make({ load })
  }),
)

export function parseUsagePoolSnapshot(input: string, capturedAt: DateTime.Utc): Orchestration.CapacitySnapshot {
  const values = new Map(
    input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
  )
  const schema = numeric(values.get("snapshot_schema"))
  if (schema !== 1) return unavailable(capturedAt, "unsupported_schema")

  const providers = Array.from(values.entries())
    .filter(([key]) => key.startsWith("provider_") && key.endsWith("_state"))
    .map(([key, value]) => {
      const id = key.slice("provider_".length, -"_state".length)
      const prefix = `provider_${id}`
      const observedAt = numeric(values.get(`${prefix}_observed_at`))
      return {
        id,
        state: providerState(value),
        coverage: values.get(`${prefix}_coverage`),
        observedAt: observedAt === undefined ? undefined : DateTime.makeUnsafe(observedAt * 1000),
        retryAfterSeconds: numeric(values.get(`${prefix}_retry_after_seconds`)),
        diagnosticCode: values.get(`${prefix}_diagnostic_code`),
      } satisfies Orchestration.CapacityProvider
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))

  const meters = Array.from(values.entries())
    .filter(([key]) => key.startsWith("meter_") && key.endsWith("_state"))
    .map(([key, state]) => {
      const encoded = key.slice("meter_".length, -"_state".length)
      const prefix = `meter_${encoded}`
      const resetsAt = numeric(values.get(`${prefix}_resets_at`))
      return {
        id: decodeSnapshotKey(encoded),
        state,
        remaining: numeric(values.get(`${prefix}_usage_remaining`)),
        timeRemaining: numeric(values.get(`${prefix}_time_remaining`)),
        resetsAt: resetsAt === undefined ? undefined : DateTime.makeUnsafe(resetsAt * 1000),
      } satisfies Orchestration.CapacityMeter
    })
    .toSorted((a, b) => a.id.localeCompare(b.id))

  const incomplete = providers.some((provider) => provider.state !== "live")
  return {
    schema,
    source: "usagepool",
    status: meters.length === 0 ? "unavailable" : incomplete ? "partial" : "live",
    capturedAt,
    providers,
    meters,
    diagnostic: meters.length === 0 ? "no_meters" : undefined,
  }
}

function unavailable(capturedAt: DateTime.Utc, diagnostic: string): Orchestration.CapacitySnapshot {
  return {
    schema: 1,
    source: "usagepool",
    status: "unavailable",
    capturedAt,
    providers: [],
    meters: [],
    diagnostic,
  }
}

function providerState(input: string): Orchestration.CapacityProviderState {
  return Schema.is(Orchestration.CapacityProviderState)(input) ? input : "unknown"
}

function numeric(input: string | undefined) {
  if (input === undefined || input.trim() === "") return undefined
  const value = Number(input)
  if (!Number.isFinite(value)) return undefined
  return value
}

function decodeSnapshotKey(input: string) {
  return input.replaceAll(/_([0-9a-f]+)_/g, (_, hex: string) => {
    const value = Number.parseInt(hex, 16)
    return Number.isFinite(value) ? String.fromCodePoint(value) : ""
  })
}

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
