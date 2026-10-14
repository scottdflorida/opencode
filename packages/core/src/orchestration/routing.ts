export * as OrchestrationRouting from "./routing"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Config } from "../config"
import { ConfigOrchestration } from "../config/orchestration"
import { makeLocationNode } from "../effect/app-node"
import { OrchestrationCapacity } from "./capacity"
import { OrchestrationHarnessRegistry } from "./harness/registry"
import { OrchestrationHostResources } from "./host-resources"

export class ProfileNotFoundError extends Schema.TaggedErrorClass<ProfileNotFoundError>()(
  "OrchestrationRouting.ProfileNotFoundError",
  { profile: Schema.String },
) {}

export interface Interface {
  readonly profiles: Effect.Effect<Orchestration.RouteProfile[]>
  readonly capacity: Effect.Effect<Orchestration.CapacitySnapshot>
  readonly resources: Effect.Effect<Orchestration.ResourceObservation>
  readonly resolve: (
    profile?: string,
    capabilityTier?: Orchestration.CapabilityTier,
  ) => Effect.Effect<Orchestration.RouteResolution, ProfileNotFoundError>
  readonly resolveSnapshot: (
    profile: Orchestration.RouteProfile,
    capabilityTier?: Orchestration.CapabilityTier,
  ) => Effect.Effect<Orchestration.RouteResolution>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationRouting") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const capacity = yield* OrchestrationCapacity.Service
    const harnesses = yield* OrchestrationHarnessRegistry.Service
    const hostResources = yield* OrchestrationHostResources.Service

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
    const resolveSnapshot = Effect.fn("OrchestrationRouting.resolveSnapshot")(function* (
      profile: Orchestration.RouteProfile,
      capabilityTier?: Orchestration.CapabilityTier,
    ) {
      const quota = yield* capacity.latest
      const now = yield* DateTime.now
      const observedHarnesses = yield* harnesses.latest
      return resolveRoute(profile, quota, now, capabilityTier, observedHarnesses, {
        schema: 1,
        capturedAt: now,
        quota,
        host: yield* hostResources.latest,
        harnesses: observedHarnesses,
      })
    })
    const resolve = Effect.fn("OrchestrationRouting.resolve")(function* (
      requested?: string,
      capabilityTier?: Orchestration.CapabilityTier,
    ) {
      const policy = yield* configured
      const name = requested ?? policy.defaultProfile
      const profile = policy.profiles.find((item) => item.name === name)
      if (!name || !profile) return yield* new ProfileNotFoundError({ profile: name ?? "" })
      return yield* resolveSnapshot(profile, capabilityTier)
    })

    const resources = Effect.gen(function* () {
      return {
        schema: 1 as const,
        capturedAt: yield* DateTime.now,
        quota: yield* capacity.latest,
        host: yield* hostResources.latest,
        harnesses: yield* harnesses.latest,
      }
    })
    return Service.of({ profiles, capacity: capacity.latest, resources, resolve, resolveSnapshot })
  }),
)

export function normalizeProfile(name: string, input: ConfigOrchestration.RouteProfile): Orchestration.RouteProfile {
  return {
    name,
    unknownCapacity: input.unknown_capacity ?? "wait",
    exhausted: input.exhausted ?? "wait_until_soonest_reset",
    maxCapacityAgeSeconds: input.max_capacity_age_seconds ?? 300,
    quotaReserves: input.quota_reserves,
    privacy: input.privacy,
    candidates: input.candidates.map((candidate) => ({
      capabilityTier: candidate.capability_tier,
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
      hostFreeMemoryAtLeastBytes: candidate.host_free_memory_at_least_bytes,
    })),
  }
}

export function resolveRoute(
  profile: Orchestration.RouteProfile,
  snapshot: Orchestration.CapacitySnapshot,
  now: DateTime.Utc,
  requestedTier?: Orchestration.CapabilityTier,
  harnessSnapshot?: Orchestration.HarnessSnapshot,
  resourceObservation?: Orchestration.ResourceObservation,
): Orchestration.RouteResolution {
  const visit = (index: number, rejected: Orchestration.RouteRejection[]): Orchestration.RouteResolution => {
    const candidate = profile.candidates[index]
    if (!candidate) {
      const retryAt = earliestReset(rejected)
      return {
        status:
          profile.exhausted === "fail" ||
          rejected.every((reason) =>
            ["disabled", "privacy_disallowed", "tier_mismatch", "harness_unavailable", "harness_unsupported"].includes(reason.code),
          )
            ? "failed"
            : "waiting",
        profile: profile.name,
        profileSnapshot: profile,
        capacitySnapshot: snapshot,
        harnessSnapshot,
        resourceObservation,
        requestedTier,
        rejected,
        capacityCapturedAt: snapshot.capturedAt,
        retryAt,
      }
    }
    const reasons = rejectCandidate(
      profile,
      candidate,
      snapshot,
      now,
      requestedTier,
      harnessSnapshot,
      resourceObservation,
    )
    if (reasons.length > 0) return visit(index + 1, [...rejected, ...reasons])
    return {
      status: "selected",
      profile: profile.name,
      profileSnapshot: profile,
      capacitySnapshot: snapshot,
      harnessSnapshot,
      resourceObservation,
      requestedTier,
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
  requestedTier?: Orchestration.CapabilityTier,
  harnessSnapshot?: Orchestration.HarnessSnapshot,
  resourceObservation?: Orchestration.ResourceObservation,
): Orchestration.RouteRejection[] {
  if (requestedTier && candidate.capabilityTier !== requestedTier)
    return [
      {
        candidateID: candidate.candidate.id,
        code: "tier_mismatch",
        message: `Candidate does not serve ${requestedTier}`,
      },
    ]
  if (candidate.disabled) {
    return [
      {
        candidateID: candidate.candidate.id,
        code: "disabled",
        message: "Candidate is disabled by policy",
      } satisfies Orchestration.RouteRejection,
    ]
  }
  const selected = candidate.candidate
  if (
    (selected.type === "direct" && profile.privacy?.providers && !profile.privacy.providers.includes(selected.providerID)) ||
    (selected.type === "harness" && profile.privacy?.harnesses && !profile.privacy.harnesses.includes(selected.harnessID)) ||
    (profile.privacy?.models && !profile.privacy.models.includes(selected.modelID))
  )
    return [{ candidateID: selected.id, code: "privacy_disallowed", message: "Candidate is outside the route privacy allowlist" }]
  if (candidate.candidate.type === "harness" && harnessSnapshot) {
    const selected = candidate.candidate
    const observed = harnessSnapshot.harnesses.find((item) => item.id === selected.harnessID)
    if (observed?.state !== "available")
      return [
        {
          candidateID: selected.id,
          code: observed?.state === "unsupported" || !observed ? "harness_unsupported" : "harness_unavailable",
          message: observed
            ? `Harness ${selected.harnessID} is ${observed.state}`
            : `Harness ${selected.harnessID} has no execution adapter`,
        } satisfies Orchestration.RouteRejection,
      ]
    if (observed.models && !observed.models.includes(selected.modelID))
      return [{
        candidateID: selected.id,
        code: "harness_unsupported",
        message: `Model ${selected.modelID} is absent from ${selected.harnessID}'s observed catalog`,
      }]
    if (selected.effort && observed.modelEfforts?.[selected.modelID] &&
      !observed.modelEfforts[selected.modelID].includes(selected.effort))
      return [{
        candidateID: selected.id,
        code: "harness_unsupported",
        message: `${selected.harnessID} model ${selected.modelID} does not offer effort ${selected.effort}`,
      }]
    if (selected.effort && observed.efforts && !observed.efforts.includes(selected.effort))
      return [{
        candidateID: selected.id,
        code: "harness_unsupported",
        message: `${selected.harnessID} CLI does not offer effort ${selected.effort}`,
      }]
    if (
      selected.harnessID === "codex" &&
      selected.effort &&
      !["low", "medium", "high", "xhigh", "max", "ultra"].includes(selected.effort)
    )
      return [
        {
          candidateID: selected.id,
          code: "harness_unsupported",
          message: `Codex effort ${selected.effort} is not supported by this adapter`,
        } satisfies Orchestration.RouteRejection,
      ]
    if (
      selected.harnessID === "claude" &&
      selected.effort &&
      !["low", "medium", "high", "xhigh", "max"].includes(selected.effort)
    )
      return [
        {
          candidateID: selected.id,
          code: "harness_unsupported",
          message: `Claude effort ${selected.effort} is not supported by this adapter`,
        } satisfies Orchestration.RouteRejection,
      ]
    if (selected.harnessID === "cursor" && selected.effort)
      return [
        {
          candidateID: selected.id,
          code: "harness_unsupported",
          message: "Cursor CLI does not expose an effort option",
        } satisfies Orchestration.RouteRejection,
      ]
    if (
      selected.harnessID === "copilot" &&
      selected.effort &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(selected.effort)
    )
      return [
        {
          candidateID: selected.id,
          code: "harness_unsupported",
          message: `Copilot effort ${selected.effort} is not supported by this adapter`,
        } satisfies Orchestration.RouteRejection,
      ]
  }
  if (candidate.hostFreeMemoryAtLeastBytes !== undefined) {
    const host = resourceObservation?.host
    const retryAt = DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 30_000)
    if (!host || DateTime.toEpochMillis(now) - DateTime.toEpochMillis(host.capturedAt) > 30_000)
      return [
        {
          candidateID: candidate.candidate.id,
          code: "host_memory_unknown",
          message: "Host memory observation is missing or stale",
          requiredBytes: candidate.hostFreeMemoryAtLeastBytes,
          retryAt,
        } satisfies Orchestration.RouteRejection,
      ]
    if (host.freeMemoryBytes < candidate.hostFreeMemoryAtLeastBytes)
      return [
        {
          candidateID: candidate.candidate.id,
          code: "host_memory_below_threshold",
          message: "Host free memory is below the candidate requirement",
          availableBytes: host.freeMemoryBytes,
          requiredBytes: candidate.hostFreeMemoryAtLeastBytes,
          retryAt,
        } satisfies Orchestration.RouteRejection,
      ]
  }
  return candidate.requirements.flatMap((requirement) => {
    const required = Math.max(requirement.remainingAtLeast, profile.quotaReserves?.[requirement.meter] ?? 0)
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
        { ...requirement, remainingAtLeast: required },
        "Capacity has not been observed",
        "capacity_unknown",
        providerRetryAt(provider, snapshot.capturedAt),
      )
    if (
      DateTime.toEpochMillis(now) - DateTime.toEpochMillis(provider.observedAt) >
      profile.maxCapacityAgeSeconds * 1000
    ) {
      return unknown(profile, candidate, { ...requirement, remainingAtLeast: required }, "Capacity observation is stale", "capacity_stale")
    }
    const meter = snapshot.meters.find((item) => item.id === requirement.meter)
    if (!meter || meter.state !== "live" || meter.remaining === undefined)
      return unknown(profile, candidate, { ...requirement, remainingAtLeast: required }, "Capacity meter is unavailable")
    if (meter.remaining >= required) return []
    return [
      {
        candidateID: candidate.candidate.id,
        code: "capacity_below_threshold",
        message: `${requirement.meter} has ${meter.remaining}% remaining; policy requires ${required}%`,
        meter: requirement.meter,
        remaining: meter.remaining,
        required,
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
  deps: [Config.node, OrchestrationCapacity.node, OrchestrationHarnessRegistry.node, OrchestrationHostResources.node],
})
