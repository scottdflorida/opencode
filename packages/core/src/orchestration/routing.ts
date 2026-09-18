export * as OrchestrationRouting from "./routing"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Config } from "../config"
import { ConfigOrchestration } from "../config/orchestration"
import { makeLocationNode } from "../effect/app-node"
import { OrchestrationCapacity } from "./capacity"

export class ProfileNotFoundError extends Schema.TaggedErrorClass<ProfileNotFoundError>()(
  "OrchestrationRouting.ProfileNotFoundError",
  { profile: Schema.String },
) {}

export interface Interface {
  readonly profiles: Effect.Effect<Orchestration.RouteProfile[]>
  readonly capacity: Effect.Effect<Orchestration.CapacitySnapshot>
  readonly resolve: (profile?: string) => Effect.Effect<Orchestration.RouteResolution, ProfileNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationRouting") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const capacity = yield* OrchestrationCapacity.Service

    const configured = Effect.gen(function* () {
      const entries = yield* config.entries()
      const orchestration = Config.latest(entries, "orchestration")
      return {
        defaultProfile: orchestration?.default_route_profile,
        profiles: Object.entries(orchestration?.route_profiles ?? {}).map(([name, profile]) =>
          normalizeProfile(name, profile),
        ),
      }
    })

    const profiles = configured.pipe(Effect.map((value) => value.profiles))
    const resolve = Effect.fn("OrchestrationRouting.resolve")(function* (requested?: string) {
      const policy = yield* configured
      const name = requested ?? policy.defaultProfile
      const profile = policy.profiles.find((item) => item.name === name)
      if (!name || !profile) return yield* new ProfileNotFoundError({ profile: name ?? "" })
      return resolveRoute(profile, yield* capacity.latest, yield* DateTime.now)
    })

    return Service.of({ profiles, capacity: capacity.latest, resolve })
  }),
)

export function normalizeProfile(name: string, input: ConfigOrchestration.RouteProfile): Orchestration.RouteProfile {
  return {
    name,
    unknownCapacity: input.unknown_capacity ?? "wait",
    exhausted: input.exhausted ?? "wait_until_soonest_reset",
    maxCapacityAgeSeconds: input.max_capacity_age_seconds ?? 300,
    candidates: input.candidates.map((candidate) => ({
      candidate:
        candidate.type === "direct"
          ? {
              id: candidate.id,
              type: "direct",
              providerID: candidate.provider,
              modelID: candidate.model,
              variant: candidate.variant,
            }
          : {
              id: candidate.id,
              type: "harness",
              harnessID: candidate.harness,
              modelID: candidate.model,
              effort: candidate.effort,
            },
      disabled: candidate.disabled ?? false,
      requirements: (candidate.requires ?? []).map((requirement) => ({
        meter: requirement.meter,
        remainingAtLeast: requirement.remaining_at_least,
      })),
    })),
  }
}

export function resolveRoute(
  profile: Orchestration.RouteProfile,
  snapshot: Orchestration.CapacitySnapshot,
  now: DateTime.Utc,
): Orchestration.RouteResolution {
  const visit = (index: number, rejected: Orchestration.RouteRejection[]): Orchestration.RouteResolution => {
    const candidate = profile.candidates[index]
    if (!candidate) {
      const retryAt = earliestReset(rejected)
      return {
        status: profile.exhausted === "fail" ? "failed" : "waiting",
        profile: profile.name,
        rejected,
        capacityCapturedAt: snapshot.capturedAt,
        retryAt,
      }
    }
    const reasons = rejectCandidate(profile, candidate, snapshot, now)
    if (reasons.length > 0) return visit(index + 1, [...rejected, ...reasons])
    return {
      status: "selected",
      profile: profile.name,
      selected: candidate.candidate,
      rejected,
      capacityCapturedAt: snapshot.capturedAt,
    }
  }
  return visit(0, [])
}

function rejectCandidate(
  profile: Orchestration.RouteProfile,
  candidate: Orchestration.RouteCandidate,
  snapshot: Orchestration.CapacitySnapshot,
  now: DateTime.Utc,
): Orchestration.RouteRejection[] {
  if (candidate.disabled) {
    return [
      {
        candidateID: candidate.candidate.id,
        code: "disabled",
        message: "Candidate is disabled by policy",
      } satisfies Orchestration.RouteRejection,
    ]
  }
  return candidate.requirements.flatMap((requirement) => {
    const providerID = requirement.meter.slice(0, requirement.meter.indexOf("."))
    const provider = snapshot.providers.find((item) => item.id === providerID)
    if (providerUnavailable(provider)) {
      return [
        {
          candidateID: candidate.candidate.id,
          code: "provider_unavailable",
          message: `Provider ${providerID} is ${provider?.state ?? "unknown"}`,
          meter: requirement.meter,
          retryAt: providerRetryAt(provider, snapshot.capturedAt),
        } satisfies Orchestration.RouteRejection,
      ]
    }
    if (!provider?.observedAt)
      return unknown(
        profile,
        candidate,
        requirement,
        "Capacity has not been observed",
        "capacity_unknown",
        providerRetryAt(provider, snapshot.capturedAt),
      )
    if (
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(provider.observedAt) >
      profile.maxCapacityAgeSeconds * 1000
    ) {
      return unknown(profile, candidate, requirement, "Capacity observation is stale", "capacity_stale")
    }
    const meter = snapshot.meters.find((item) => item.id === requirement.meter)
    if (!meter || meter.state !== "live" || meter.remaining === undefined)
      return unknown(profile, candidate, requirement, "Capacity meter is unavailable")
    if (meter.remaining >= requirement.remainingAtLeast) return []
    return [
      {
        candidateID: candidate.candidate.id,
        code: "capacity_below_threshold",
        message: `${requirement.meter} has ${meter.remaining}% remaining; policy requires ${requirement.remainingAtLeast}%`,
        meter: requirement.meter,
        remaining: meter.remaining,
        required: requirement.remainingAtLeast,
        retryAt: meter.resetsAt,
      } satisfies Orchestration.RouteRejection,
    ]
  })
}

function unknown(
  profile: Orchestration.RouteProfile,
  candidate: Orchestration.RouteCandidate,
  requirement: Orchestration.CapacityRequirement,
  message: string,
  code: "capacity_unknown" | "capacity_stale" = "capacity_unknown",
  retryAt?: DateTime.Utc,
): Orchestration.RouteRejection[] {
  if (profile.unknownCapacity === "allow") return []
  return [
    {
      candidateID: candidate.candidate.id,
      code,
      message,
      meter: requirement.meter,
      required: requirement.remainingAtLeast,
      retryAt,
    } satisfies Orchestration.RouteRejection,
  ]
}

function providerUnavailable(provider: Orchestration.CapacityProvider | undefined) {
  return (
    provider?.state === "not_installed" ||
    provider?.state === "unavailable" ||
    provider?.state === "failed_permanent" ||
    provider?.state === "invalid_report"
  )
}

function providerRetryAt(
  provider: Orchestration.CapacityProvider | undefined,
  capturedAt: DateTime.Utc,
): DateTime.Utc | undefined {
  if (!provider?.retryAfterSeconds) return undefined
  return DateTime.makeUnsafe(DateTime.toEpochMillis(capturedAt) + provider.retryAfterSeconds * 1000)
}

function earliestReset(rejected: Orchestration.RouteRejection[]) {
  const times = rejected
    .flatMap((reason) => (reason.retryAt ? [DateTime.toEpochMillis(reason.retryAt)] : []))
    .toSorted((a, b) => a - b)
  return times[0] === undefined ? undefined : DateTime.makeUnsafe(times[0])
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, OrchestrationCapacity.node],
})
