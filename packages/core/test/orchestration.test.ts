import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Orchestration.node, Database.node, EventV2.node])))
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
  it.effect("projects a durable run graph and its evidence", () =>
    Effect.gen(function* () {
      const orchestration = yield* setup()
      const run = yield* orchestration.create({ projectID, objective: "Implement quota-aware routing" })
      const inspect = yield* orchestration.addTask({ runID: run.id, title: "Inspect capacity" })
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

      const detail = yield* orchestration.get(run.id)
      expect(detail.run).toMatchObject({ id: run.id, projectID, status: "active" })
      expect(detail.tasks).toMatchObject([
        { id: inspect.id, status: "running" },
        { id: route.id, status: "draft", routeProfile: "frontier" },
      ])
      expect(detail.dependencies).toEqual([{ runID: run.id, taskID: route.id, dependsOnTaskID: inspect.id }])
      expect(detail.attempts).toMatchObject([{ id: attempt.id, status: "evaluating" }])
      expect(detail.routeDecisions).toMatchObject([{ resolution: { status: "selected", profile: "frontier" } }])
      expect(detail.evaluations).toMatchObject([
        { attemptID: attempt.id, kind: "typecheck", status: "passed", evidence: { exitCode: 0 } },
      ])
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
