import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { eq } from "drizzle-orm"
import { CapabilityTier, Detail } from "@opencode-ai/schema/orchestration"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { OrchestrationRouteDecisionTable } from "@opencode-ai/core/orchestration/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Orchestration.node, ProjectDirectories.node, Database.node, EventV2.node])),
)
const projectID = ProjectV2.ID.make("orchestration-project")

function setup() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    return yield* Orchestration.Service
  })
}

describe("Orchestration", () => {
  it.effect("registers a new run's project root for isolated worktrees", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      yield* orchestration.create({
        projectID,
        project: {
          directory: AbsolutePath.make("/project"),
          vcs: { type: "git", store: AbsolutePath.make("/project/.git") },
        },
        objective: "Exercise a fresh project",
      })
      expect(
        yield* ProjectDirectories.Service.use((directories) =>
          directories.contains({ projectID, directory: AbsolutePath.make("/project") }),
        ),
      ).toBe(true)
    }),
  )

  it.effect("stores a bounded plan and applies its graph atomically", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Plan a small change" })
      const output = {
        rationale: "Inspect before editing",
        tasks: [
          { key: "inspect", title: "Inspect the code", checks: [], dependsOn: [] },
          {
            key: "edit",
            title: "Edit the code",
            checks: [{ name: "types", command: "bun typecheck" }],
            dependsOn: ["inspect"],
          },
        ],
      }
      const proposal = yield* orchestration.proposePlan({ runID: run.id, output })
      expect((yield* orchestration.get(run.id)).tasks).toEqual([])
      expect(proposal).toMatchObject({ status: "proposed", output })

      const applied = yield* orchestration.applyPlan({ runID: run.id, planID: proposal.id })
      expect(applied.plans).toMatchObject([{ id: proposal.id, status: "applied" }])
      expect(applied.tasks).toMatchObject([
        { title: "Inspect the code" },
        { title: "Edit the code", checks: [{ name: "types", command: "bun typecheck" }] },
      ])
      expect(applied.dependencies).toEqual([
        { runID: run.id, taskID: applied.tasks[1]!.id, dependsOnTaskID: applied.tasks[0]!.id },
      ])
      expect(yield* orchestration.applyPlan({ runID: run.id, planID: proposal.id }).pipe(Effect.flip)).toBeInstanceOf(
        Orchestration.InvalidPlanError,
      )
    }),
  )

  it.effect("rejects invalid plan graphs without storing them", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Reject a cycle" })
      const error = yield* orchestration
        .proposePlan({
          runID: run.id,
          output: {
            tasks: [
              { key: "first", title: "First", checks: [], dependsOn: ["second"] },
              { key: "second", title: "Second", checks: [], dependsOn: ["first"] },
            ],
          },
        })
        .pipe(Effect.flip)
      expect(error).toMatchObject({ message: "Task dependencies must be acyclic" })
      expect((yield* orchestration.get(run.id)).plans).toEqual([])
    }),
  )

  it.effect("preserves generated plan provenance", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Document a boundary" })
      const proposal = yield* orchestration.proposePlan({
        runID: run.id,
        output: { tasks: [{ key: "document", title: "Document it", checks: [], dependsOn: [] }] },
        generation: {
          route: {
            status: "selected",
            profile: "planner",
            selected: { id: "luna", type: "direct", providerID: "openai", modelID: "luna" },
            rejected: [],
            capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
          },
          prompt: "Objective: Document a boundary",
          requestDigest: "digest",
          latencyMs: 250,
          inputTokens: 100,
          outputTokens: 30,
        },
      })

      expect(proposal.generation).toMatchObject({
        route: { profile: "planner", selected: { modelID: "luna" } },
        prompt: "Objective: Document a boundary",
        requestDigest: "digest",
        latencyMs: 250,
        inputTokens: 100,
        outputTokens: 30,
      })
      const detail = yield* orchestration.get(run.id)
      expect(detail.plans[0]?.generation).toEqual(proposal.generation)
      const encoded = yield* Schema.encodeUnknownEffect(Detail)(detail).pipe(Effect.exit)
      if (Exit.isFailure(encoded)) throw new Error(String(encoded.cause))
    }),
  )

  it.effect("calibrates shadow choices against blind triage labels and priced token usage", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Measure judge outcomes" })
      const task = yield* orchestration.addTask({ runID: run.id, title: "Review an attempt" })
      const attempt = yield* orchestration.createAttempt({ runID: run.id, taskID: task.id })
      yield* orchestration.recordJudgment({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        mode: "shadow",
        request: {
          purpose: "attempt_review",
          state: "synthetic",
          question: { instructions: "Ready?", criteria: { looks_ready: null, needs_attention: null } },
          fallback: "needs_attention",
        },
        result: {
          status: "valid",
          provider: "jev",
          model: "jev-test",
          requestDigest: "synthetic",
          cached: false,
          latencyMs: 200,
          answer: {
            choice: "looks_ready",
            confidence: 0.8,
            probabilities: { looks_ready: 0.8, needs_attention: 0.2 },
          },
          usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.001 },
        },
      })
      yield* orchestration.recordReview({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        decision: "accepted",
      })
      expect((yield* orchestration.calibration({ projectID })).labeled).toBe(0)
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        status: "succeeded",
      })
      yield* orchestration.recordTriageLabel({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        decision: "looks_ready",
      })
      const packet = yield* orchestration.reviewPacket({ runID: run.id, taskID: task.id })
      expect(packet.attempt.id).toBe(attempt.id)
      expect(packet).not.toHaveProperty("judgments")
      expect(
        yield* orchestration
          .recordTriageLabel({
            runID: run.id,
            taskID: task.id,
            attemptID: attempt.id,
            decision: "needs_attention",
          })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Orchestration.TriageLabelError)

      expect(yield* orchestration.calibration({ projectID })).toMatchObject({
        total: 1,
        valid: 1,
        labeled: 1,
        agreement: 1,
        confusion: { predictedReadyLabeledReady: 1, predictedReadyLabeledAttention: 0 },
        latency: { calls: 1, meanMs: 200, p50Ms: 200, p95Ms: 200 },
        usage: { measuredCalls: 1, inputTokens: 100, outputTokens: 20, pricedCalls: 1, estimatedCostUsd: 0.001 },
        promotion: { attemptReview: { eligibleForPolicyReview: false, unmet: ["sample_size"] } },
      })
    }),
  )

  it.effect("persists shadow tier recommendations beside their route decisions", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Classify task tier" })
      const task = yield* orchestration.addTask({
        runID: run.id,
        title: "Small code edit",
        capabilityTier: CapabilityTier.make("small"),
      })
      const decision = yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: task.id,
        resolution: {
          status: "waiting",
          profile: "frontier",
          rejected: [],
          capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
        },
      })
      const recorded = yield* orchestration.recordTierRecommendation({
        runID: run.id,
        taskID: task.id,
        routeDecisionID: decision.id,
        explicitTier: task.capabilityTier,
        request: {
          purpose: "capability_tier",
          state: "synthetic",
          question: { instructions: "Tier?", criteria: { small: "Routine", large: "Complex" } },
          fallback: "large",
        },
        result: {
          status: "valid",
          provider: "jev",
          model: "jev-test",
          requestDigest: "tier-synthetic",
          cached: false,
          latencyMs: 90,
          answer: { choice: "small", confidence: 0.8, probabilities: { small: 0.8, large: 0.2 } },
          usage: { inputTokens: 40, outputTokens: 5 },
        },
      })
      const repeatedDecision = yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: task.id,
        resolution: decision.resolution,
      })
      yield* orchestration.recordTierRecommendation({
        runID: run.id,
        taskID: task.id,
        routeDecisionID: repeatedDecision.id,
        explicitTier: task.capabilityTier,
        request: recorded.request,
        result: { ...recorded.result, cached: true, latencyMs: 0, usage: undefined },
      })
      const detail = yield* orchestration.get(run.id)
      expect(detail.tierRecommendations[0]).toEqual(recorded)
      expect(Schema.encodeSync(Detail)(detail)).toBeDefined()
      expect(yield* orchestration.calibration({ projectID })).toMatchObject({
        tier: {
          total: 2,
          valid: 2,
          labeled: 2,
          agreement: 2,
          latency: { calls: 1, p50Ms: 90 },
          usage: { measuredCalls: 1, inputTokens: 40, outputTokens: 5 },
        },
        promotion: { tier: { uniqueRequests: 1, uniqueLabeled: 1 } },
      })
    }),
  )

  it.effect("reads route decisions stored before date codecs were applied", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Preserve historical routing" })
      const task = yield* orchestration.addTask({ runID: run.id, title: "Wait for quota" })
      const decision = yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: task.id,
        resolution: {
          status: "waiting",
          profile: "frontier",
          rejected: [],
          capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
          retryAt: DateTime.makeUnsafe(1_700_000_100_000),
          resourceObservation: {
            schema: 1,
            capturedAt: DateTime.makeUnsafe(1_700_000_000_000),
            quota: {
              schema: 1,
              source: "test",
              status: "live",
              capturedAt: DateTime.makeUnsafe(1_700_000_000_000),
              providers: [],
              meters: [],
            },
            host: {
              schema: 1,
              source: "host",
              capturedAt: DateTime.makeUnsafe(1_700_000_000_000),
              platform: "darwin",
              architecture: "arm64",
              totalMemoryBytes: 64_000,
              freeMemoryBytes: 8_000,
              cpuCount: 12,
              load1: 1,
              load5: 1,
              load15: 1,
            },
          },
        },
      })
      expect((yield* orchestration.get(run.id)).routeDecisions[0]?.resolution.resourceObservation).toEqual(
        decision.resolution.resourceObservation,
      )
      const { db } = yield* Database.Service
      yield* db
        .update(OrchestrationRouteDecisionTable)
        .set({
          resolution: {
            status: "waiting",
            profile: "frontier",
            rejected: [],
            capacityCapturedAt: "2023-11-14T22:13:20.000Z",
            retryAt: "2023-11-14T22:15:00.000Z",
          } as unknown as typeof OrchestrationRouteDecisionTable.$inferInsert.resolution,
        })
        .where(eq(OrchestrationRouteDecisionTable.id, decision.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* orchestration.get(run.id)).routeDecisions[0]?.resolution).toMatchObject({
        capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
        retryAt: DateTime.makeUnsafe(1_700_000_100_000),
      })
    }),
  )

  it.effect("persists the run source needed to restore a quota wake", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Resume after quota reset" })
      const source = { directory: AbsolutePath.make("/project/subdirectory") }
      yield* orchestration.setRunSource({ runID: run.id, source })
      expect((yield* orchestration.get(run.id)).run.source).toEqual(source)
      expect((yield* orchestration.list({ projectID }))[0]?.source).toEqual(source)
    }),
  )

  it.effect("projects a durable run graph and its evidence", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Implement quota-aware routing" })
      const inspect = yield* orchestration.addTask({
        runID: run.id,
        title: "Inspect capacity",
        checks: [{ name: "typecheck", command: "bun typecheck", baseline: true }],
      })
      const route = yield* orchestration.addTask({
        runID: run.id,
        title: "Resolve route",
        routeProfile: "frontier",
      })
      yield* orchestration.addDependency({ runID: run.id, taskID: route.id, dependsOnTaskID: inspect.id })
      yield* orchestration.setRunStatus({ runID: run.id, status: "active" })
      yield* orchestration.setTaskStatus({ runID: run.id, taskID: inspect.id, status: "running" })
      const attempt = yield* orchestration.createAttempt({
        runID: run.id,
        taskID: inspect.id,
        candidate: { id: "local", type: "direct", providerID: "local", modelID: "qwen" },
      })
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: inspect.id,
        attemptID: attempt.id,
        status: "evaluating",
      })
      const resolution = {
        status: "selected",
        profile: "frontier",
        selected: { id: "local", type: "direct", providerID: "local", modelID: "qwen" },
        rejected: [],
        capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
      } as const
      yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: inspect.id,
        attemptID: attempt.id,
        resolution,
      })
      yield* orchestration.recordEvaluation({
        runID: run.id,
        taskID: inspect.id,
        attemptID: attempt.id,
        kind: "typecheck",
        status: "passed",
        evidence: { command: "bun typecheck", exitCode: 0 },
      })
      yield* orchestration.recordJudgment({
        runID: run.id,
        taskID: inspect.id,
        attemptID: attempt.id,
        mode: "shadow",
        request: {
          purpose: "attempt_review",
          state: { task: "Inspect capacity", check: "passed" },
          question: {
            instructions: "Does this attempt look ready for review?",
            criteria: { looks_ready: null, needs_attention: null },
          },
          fallback: "needs_attention",
        },
        result: {
          status: "valid",
          provider: "jev",
          model: "jev-1.13.0",
          requestDigest: "abc123",
          cached: false,
          latencyMs: 110,
          answer: {
            choice: "looks_ready",
            confidence: 0.8,
            probabilities: { looks_ready: 0.9, needs_attention: 0.1 },
          },
          usage: { inputTokens: 100, outputTokens: 8 },
        },
      })
      yield* orchestration.recordReview({
        runID: run.id,
        taskID: inspect.id,
        attemptID: attempt.id,
        decision: "accepted",
        note: "Checks passed",
      })

      const detail = yield* orchestration.get(run.id)
      expect(detail.run).toMatchObject({ id: run.id, projectID, status: "active" })
      expect(detail.tasks).toMatchObject([
        { id: inspect.id, status: "running", checks: [{ name: "typecheck", command: "bun typecheck" }] },
        { id: route.id, status: "draft", routeProfile: "frontier" },
      ])
      expect(detail.dependencies).toEqual([{ runID: run.id, taskID: route.id, dependsOnTaskID: inspect.id }])
      expect(detail.attempts).toMatchObject([{ id: attempt.id, status: "evaluating" }])
      expect(detail.routeDecisions).toMatchObject([{ resolution: { status: "selected", profile: "frontier" } }])
      expect(detail.evaluations).toMatchObject([
        { attemptID: attempt.id, kind: "typecheck", status: "passed", evidence: { exitCode: 0 } },
      ])
      expect(detail.judgments).toMatchObject([
        {
          attemptID: attempt.id,
          mode: "shadow",
          request: { purpose: "attempt_review", fallback: "needs_attention" },
          result: { status: "valid", provider: "jev", answer: { choice: "looks_ready" } },
        },
      ])
      expect(detail.reviews).toMatchObject([{ attemptID: attempt.id, decision: "accepted", note: "Checks passed" }])
      expect(yield* orchestration.list({ projectID })).toHaveLength(1)
    }),
  )

  it.effect("rejects task operations outside the owning run", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const first = yield* orchestration.create({ projectID, objective: "First" })
      const second = yield* orchestration.create({ projectID, objective: "Second" })
      const task = yield* orchestration.addTask({ runID: first.id, title: "First task" })

      const error = yield* orchestration
        .setTaskStatus({ runID: second.id, taskID: task.id, status: "ready" })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Orchestration.NotFoundError)
      expect(error).toMatchObject({ resource: "task", id: task.id })
    }),
  )

  it.effect("rejects self-referential and cyclic dependencies", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Keep the task graph acyclic" })
      const first = yield* orchestration.addTask({ runID: run.id, title: "First task" })
      const second = yield* orchestration.addTask({ runID: run.id, title: "Second task" })

      const self = yield* orchestration
        .addDependency({ runID: run.id, taskID: first.id, dependsOnTaskID: first.id })
        .pipe(Effect.flip)
      expect(self).toMatchObject({ reason: "self" })

      yield* orchestration.addDependency({ runID: run.id, taskID: second.id, dependsOnTaskID: first.id })
      const cycle = yield* orchestration
        .addDependency({ runID: run.id, taskID: first.id, dependsOnTaskID: second.id })
        .pipe(Effect.flip)
      expect(cycle).toMatchObject({ reason: "cycle" })
    }),
  )

  it.effect("rejects route decisions that attach another task's attempt", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Keep attempt ownership consistent" })
      const first = yield* orchestration.addTask({ runID: run.id, title: "First task" })
      const second = yield* orchestration.addTask({ runID: run.id, title: "Second task" })
      const attempt = yield* orchestration.createAttempt({ runID: run.id, taskID: first.id })

      const error = yield* orchestration
        .recordRouteDecision({
          runID: run.id,
          taskID: second.id,
          attemptID: attempt.id,
          resolution: {
            status: "selected",
            profile: "local",
            selected: { id: "local", type: "direct", providerID: "local", modelID: "qwen" },
            rejected: [],
            capacityCapturedAt: DateTime.makeUnsafe(1_700_000_000_000),
          },
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Orchestration.NotFoundError)
      expect(error).toMatchObject({ resource: "attempt", id: attempt.id })
    }),
  )
})
