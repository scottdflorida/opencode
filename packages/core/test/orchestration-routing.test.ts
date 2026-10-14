import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { OrchestrationRouting } from "@opencode-ai/core/orchestration/routing"
import { ConfigOrchestration } from "@opencode-ai/core/config/orchestration"

const now = DateTime.makeUnsafe(1_700_000_000_000)

function candidate(
  id: string,
  harnessID: string,
  meter: string,
  remainingAtLeast: number,
): Orchestration.RouteCandidate {
  return {
    candidate: { id, type: "harness", harnessID, modelID: "opus-5" },
    disabled: false,
    requirements: [{ meter, remainingAtLeast }],
  }
}

function snapshot(input: {
  providers: Orchestration.CapacityProvider[]
  meters: Orchestration.CapacityMeter[]
}): Orchestration.CapacitySnapshot {
  return {
    schema: 1,
    source: "test",
    status: "live",
    capturedAt: now,
    providers: input.providers,
    meters: input.meters,
  }
}

describe("OrchestrationRouting", () => {
  test("uses measured host bytes separately from subscription percentages", () => {
    const quota = snapshot({ providers: [], meters: [] })
    const profile: Orchestration.RouteProfile = {
      name: "local",
      unknownCapacity: "wait",
      exhausted: "wait_until_soonest_reset",
      maxCapacityAgeSeconds: 300,
      candidates: [
        {
          candidate: { id: "local", type: "direct", providerID: "local", modelID: "small" },
          disabled: false,
          requirements: [],
          hostFreeMemoryAtLeastBytes: 16_000,
        },
      ],
    }
    const host: Orchestration.HostResourceSnapshot = {
      schema: 1,
      source: "host",
      capturedAt: now,
      platform: "darwin",
      architecture: "arm64",
      totalMemoryBytes: 64_000,
      freeMemoryBytes: 8_000,
      cpuCount: 12,
      load1: 1,
      load5: 1,
      load15: 1,
    }
    const observed = { schema: 1, capturedAt: now, quota, host } as const
    expect(OrchestrationRouting.resolveRoute(profile, quota, now, undefined, undefined, observed)).toMatchObject({
      status: "waiting",
      rejected: [{ code: "host_memory_below_threshold", availableBytes: 8_000, requiredBytes: 16_000 }],
      retryAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 30_000),
    })
    expect(
      OrchestrationRouting.resolveRoute(profile, quota, now, undefined, undefined, {
        ...observed,
        host: { ...host, freeMemoryBytes: 32_000 },
      }),
    ).toMatchObject({ status: "selected", selected: { id: "local" } })
  })

  test("rejects unsupported and unauthenticated harnesses before capacity checks", () => {
    const profile: Orchestration.RouteProfile = {
      name: "harnesses",
      unknownCapacity: "allow",
      exhausted: "fail",
      maxCapacityAgeSeconds: 300,
      candidates: [
        {
          candidate: { id: "cursor", type: "harness", harnessID: "cursor", modelID: "model" },
          disabled: false,
          requirements: [],
        },
        {
          candidate: { id: "codex", type: "harness", harnessID: "codex", modelID: "model" },
          disabled: false,
          requirements: [],
        },
      ],
    }
    const capacity = snapshot({ providers: [], meters: [] })
    expect(
      OrchestrationRouting.resolveRoute(profile, capacity, now, undefined, {
        schema: 1,
        source: "host",
        capturedAt: now,
        harnesses: [
          { id: "cursor", state: "unsupported" },
          { id: "codex", state: "unauthenticated" },
        ],
      }),
    ).toMatchObject({
      status: "failed",
      rejected: [{ code: "harness_unsupported" }, { code: "harness_unavailable" }],
    })
    expect(
      OrchestrationRouting.resolveRoute(profile, capacity, now, undefined, {
        schema: 1,
        source: "host",
        capturedAt: now,
        harnesses: [
          { id: "cursor", state: "unsupported" },
          { id: "codex", state: "available" },
        ],
      }),
    ).toMatchObject({
      status: "selected",
      selected: { id: "codex" },
      rejected: [{ code: "harness_unsupported" }],
    })
  })

  test("normalizes editable snake-case configuration", () => {
    const profile = Schema.decodeUnknownSync(ConfigOrchestration.RouteProfile)({
      unknown_capacity: "wait",
      exhausted: "wait_until_soonest_reset",
      max_capacity_age_seconds: 120,
      candidates: [
        {
          id: "cursor-grok",
          type: "harness",
          harness: "cursor",
          model: "grok-4.6",
          capability_tier: "frontier-high",
          effort: "xhigh",
          requires: [{ meter: "cursor.models", remaining_at_least: 20 }],
        },
      ],
    })

    expect(OrchestrationRouting.normalizeProfile("frontier", profile)).toEqual({
      name: "frontier",
      unknownCapacity: "wait",
      exhausted: "wait_until_soonest_reset",
      maxCapacityAgeSeconds: 120,
      candidates: [
        {
          capabilityTier: "frontier-high",
          candidate: {
            id: "cursor-grok",
            type: "harness",
            harnessID: "cursor",
            modelID: "grok-4.6",
            effort: "xhigh",
          },
          disabled: false,
          requirements: [{ meter: "cursor.models", remainingAtLeast: 20 }],
        },
      ],
    })
  })

  test("selects the first candidate that satisfies every capacity requirement", () => {
    const profile: Orchestration.RouteProfile = {
      name: "frontier",
      unknownCapacity: "wait",
      exhausted: "wait_until_soonest_reset",
      maxCapacityAgeSeconds: 300,
      candidates: [
        candidate("copilot-opus", "copilot", "copilot.monthly.plan-credits", 20),
        candidate("cursor-opus", "cursor", "cursor.api", 20),
        candidate("codex-sol", "codex", "codex.account.weekly", 10),
      ],
    }
    const capacity = snapshot({
      providers: ["copilot", "cursor", "codex"].map((id) => ({ id, state: "live", observedAt: now })),
      meters: [
        {
          id: "copilot.monthly.plan-credits",
          state: "live",
          remaining: 5,
          resetsAt: DateTime.makeUnsafe(1_700_100_000_000),
        },
        { id: "cursor.api", state: "live", remaining: 42 },
        { id: "codex.account.weekly", state: "live", remaining: 90 },
      ],
    })

    expect(OrchestrationRouting.resolveRoute(profile, capacity, now)).toMatchObject({
      status: "selected",
      selected: { id: "cursor-opus", type: "harness", harnessID: "cursor" },
      rejected: [
        {
          candidateID: "copilot-opus",
          code: "capacity_below_threshold",
          meter: "copilot.monthly.plan-credits",
          remaining: 5,
          required: 20,
        },
      ],
    })
  })

  test("selects only candidates assigned to the requested capability tier", () => {
    const profile: Orchestration.RouteProfile = {
      name: "general",
      unknownCapacity: "wait",
      exhausted: "wait_until_soonest_reset",
      maxCapacityAgeSeconds: 300,
      candidates: [
        { ...candidate("local-small", "mac", "mac.memory", 10), capabilityTier: "local-9b" },
        { ...candidate("frontier", "codex", "codex.account.weekly", 10), capabilityTier: "frontier-high" },
      ],
    }
    const capacity = snapshot({
      providers: [{ id: "codex", state: "live", observedAt: now }],
      meters: [{ id: "codex.account.weekly", state: "live", remaining: 80 }],
    })

    expect(OrchestrationRouting.resolveRoute(profile, capacity, now, "frontier-high")).toMatchObject({
      status: "selected",
      profileSnapshot: profile,
      capacitySnapshot: capacity,
      requestedTier: "frontier-high",
      selected: { id: "frontier" },
      rejected: [{ candidateID: "local-small", code: "tier_mismatch" }],
    })
    expect(OrchestrationRouting.resolveRoute(profile, capacity, now, "dense-30b")).toMatchObject({
      status: "failed",
      requestedTier: "dense-30b",
      rejected: [{ code: "tier_mismatch" }, { code: "tier_mismatch" }],
    })
  })

  test("waits until the earliest known reset when every candidate is exhausted", () => {
    const firstReset = DateTime.makeUnsafe(1_700_010_000_000)
    const profile: Orchestration.RouteProfile = {
      name: "frontier",
      unknownCapacity: "wait",
      exhausted: "wait_until_soonest_reset",
      maxCapacityAgeSeconds: 300,
      candidates: [
        candidate("claude-opus", "claude", "claude.weekly.all-models", 20),
        candidate("codex-sol", "codex", "codex.account.weekly", 10),
      ],
    }
    const capacity = snapshot({
      providers: ["claude", "codex"].map((id) => ({ id, state: "live", observedAt: now })),
      meters: [
        {
          id: "claude.weekly.all-models",
          state: "live",
          remaining: 2,
          resetsAt: DateTime.makeUnsafe(1_700_020_000_000),
        },
        { id: "codex.account.weekly", state: "live", remaining: 1, resetsAt: firstReset },
      ],
    })

    const resolved = OrchestrationRouting.resolveRoute(profile, capacity, now)
    expect(resolved.status).toBe("waiting")
    expect(DateTime.toEpochMillis(resolved.retryAt!)).toBe(DateTime.toEpochMillis(firstReset))
  })

  test("rejects stale capacity by default and can explicitly allow it", () => {
    const base: Orchestration.RouteProfile = {
      name: "frontier",
      unknownCapacity: "wait",
      exhausted: "fail",
      maxCapacityAgeSeconds: 60,
      candidates: [candidate("claude-opus", "claude", "claude.session", 20)],
    }
    const capacity = snapshot({
      providers: [
        { id: "claude", state: "live", observedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 61_000) },
      ],
      meters: [{ id: "claude.session", state: "live", remaining: 90 }],
    })

    expect(OrchestrationRouting.resolveRoute(base, capacity, now)).toMatchObject({
      status: "failed",
      rejected: [{ code: "capacity_stale" }],
    })
    expect(OrchestrationRouting.resolveRoute({ ...base, unknownCapacity: "allow" }, capacity, now)).toMatchObject({
      status: "selected",
      selected: { id: "claude-opus" },
    })
  })

  test("never allows a provider reported as unavailable", () => {
    const profile: Orchestration.RouteProfile = {
      name: "frontier",
      unknownCapacity: "allow",
      exhausted: "fail",
      maxCapacityAgeSeconds: 60,
      candidates: [candidate("copilot-opus", "copilot", "copilot.monthly.plan-credits", 20)],
    }
    const capacity = snapshot({
      providers: [{ id: "copilot", state: "not_installed" }],
      meters: [],
    })

    expect(OrchestrationRouting.resolveRoute(profile, capacity, now)).toMatchObject({
      status: "failed",
      rejected: [{ code: "provider_unavailable" }],
    })
  })
})
