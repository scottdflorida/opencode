import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { OrchestrationCapacity } from "@opencode-ai/core/orchestration/capacity"

describe("OrchestrationCapacity", () => {
  test("parses the stable UsagePool snapshot contract", () => {
    const snapshot = OrchestrationCapacity.parseUsagePoolSnapshot(
      [
        "snapshot_schema=1",
        "provider_claude_state=live",
        "provider_claude_coverage=complete",
        "provider_claude_observed_at=1700000000",
        "provider_claude_meter_count=2",
        "meter_claude_2e_session_state=live",
        "meter_claude_2e_session_usage_remaining=72",
        "meter_claude_2e_session_resets_at=1700003600",
        "meter_claude_2e_weekly_2e_all_2d_models_state=live",
        "meter_claude_2e_weekly_2e_all_2d_models_usage_remaining=81",
        "meter_claude_2e_weekly_2e_all_2d_models_resets_at=1700604800",
      ].join("\n"),
      DateTime.makeUnsafe(1_700_000_100_000),
    )

    expect(snapshot).toMatchObject({
      schema: 1,
      source: "usagepool",
      status: "live",
      providers: [{ id: "claude", state: "live", coverage: "complete" }],
      meters: [
        { id: "claude.session", state: "live", remaining: 72 },
        { id: "claude.weekly.all-models", state: "live", remaining: 81 },
      ],
    })
    expect(DateTime.toEpochMillis(snapshot.providers[0].observedAt!)).toBe(1_700_000_000_000)
    expect(DateTime.toEpochMillis(snapshot.meters[0].resetsAt!)).toBe(1_700_003_600_000)
  })

  test("keeps partial provider failures while retaining live meters", () => {
    const snapshot = OrchestrationCapacity.parseUsagePoolSnapshot(
      [
        "snapshot_schema=1",
        "provider_claude_state=failed_transient",
        "provider_claude_retry_after_seconds=120",
        "provider_codex_state=live",
        "provider_codex_observed_at=1700000000",
        "meter_codex_2e_account_2e_weekly_state=live",
        "meter_codex_2e_account_2e_weekly_usage_remaining=65",
      ].join("\n"),
      DateTime.makeUnsafe(1_700_000_100_000),
    )

    expect(snapshot.status).toBe("partial")
    expect(snapshot.providers).toContainEqual({
      id: "claude",
      state: "failed_transient",
      coverage: undefined,
      observedAt: undefined,
      retryAfterSeconds: 120,
      diagnosticCode: undefined,
    })
    expect(snapshot.meters).toContainEqual({
      id: "codex.account.weekly",
      state: "live",
      remaining: 65,
      timeRemaining: undefined,
      resetsAt: undefined,
    })
  })

  test("returns a safe unavailable snapshot for an unsupported schema", () => {
    const snapshot = OrchestrationCapacity.parseUsagePoolSnapshot(
      "snapshot_schema=2\nprovider_claude_state=live",
      DateTime.makeUnsafe(1_700_000_000_000),
    )

    expect(snapshot).toMatchObject({
      schema: 1,
      source: "usagepool",
      status: "unavailable",
      diagnostic: "unsupported_schema",
      providers: [],
      meters: [],
    })
  })

  test("does not start background polling until capacity is read", async () => {
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const snapshot: Orchestration.CapacitySnapshot = {
      schema: 1,
      source: "test",
      status: "live",
      capturedAt: DateTime.makeUnsafe(1_700_000_000_000),
      providers: [],
      meters: [],
    }

    await Effect.gen(function* () {
      const capacity = yield* OrchestrationCapacity.Service
      expect(yield* Deferred.isDone(started)).toBe(false)
      expect(yield* capacity.latest).toMatchObject({ status: "unavailable", diagnostic: "not_observed" })
      yield* Deferred.await(started)
      yield* Deferred.succeed(release, undefined)
    }).pipe(
      Effect.provide(
        OrchestrationCapacity.layerWith({
          load: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(snapshot)),
          refreshInterval: "1 hour",
        }),
      ),
      Effect.scoped,
      Effect.runPromise,
    )
  })
})
