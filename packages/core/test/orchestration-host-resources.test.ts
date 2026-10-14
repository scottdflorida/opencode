import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { OrchestrationHostResources } from "@opencode-ai/core/orchestration/host-resources"

test("captures a versioned host observation with physical units", async () => {
  const observed = await Effect.runPromise(OrchestrationHostResources.observe)
  expect(observed.schema).toBe(1)
  expect(observed.source).toBe("host")
  expect(observed.totalMemoryBytes).toBeGreaterThan(0)
  expect(observed.freeMemoryBytes).toBeGreaterThanOrEqual(0)
  expect(observed.freeMemoryBytes).toBeLessThanOrEqual(observed.totalMemoryBytes)
  expect(observed.cpuCount).toBeGreaterThan(0)
  expect(
    Schema.decodeSync(Orchestration.HostResourceSnapshot)(
      Schema.encodeSync(Orchestration.HostResourceSnapshot)(observed),
    ),
  ).toEqual(observed)
})
