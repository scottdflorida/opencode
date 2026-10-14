import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"

test("legacy tasks without a capability tier remain decodable", () => {
  const task = Schema.decodeUnknownSync(Orchestration.Task)({
    id: "task_legacy",
    runID: "run_legacy",
    title: "Existing task",
    checks: [],
    status: "ready",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  })

  expect(task.capabilityTier).toBeUndefined()
  expect(Schema.encodeSync(Orchestration.Task)(task)).not.toHaveProperty("capabilityTier")
  expect(DateTime.toEpochMillis(task.time.created)).toBe(1_700_000_000_000)
  expect(() => Schema.decodeUnknownSync(Orchestration.CapabilityTier)("")).toThrow()
  expect(() => Schema.decodeUnknownSync(Orchestration.CapabilityTier)("   ")).toThrow()
})

test("historical route decisions without snapshots remain decodable", () => {
  const resolution = Schema.decodeUnknownSync(Orchestration.RouteResolution)({
    status: "failed",
    profile: "frontier",
    rejected: [],
    capacityCapturedAt: 1_700_000_000_000,
  })

  expect(resolution.profileSnapshot).toBeUndefined()
  expect(resolution.capacitySnapshot).toBeUndefined()
})
