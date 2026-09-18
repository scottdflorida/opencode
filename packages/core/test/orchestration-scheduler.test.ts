import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Ref } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Project } from "@opencode-ai/schema/project"
import { OrchestrationScheduler } from "@opencode-ai/core/orchestration/scheduler"

const now = DateTime.makeUnsafe(1_700_000_000_000)
const runID = Orchestration.RunID.make("run_scheduler")
const firstID = Orchestration.TaskID.make("task_first")
const secondID = Orchestration.TaskID.make("task_second")

function task(id: Orchestration.TaskID, status: Orchestration.TaskStatus): Orchestration.Task {
  return {
    id,
    runID,
    title: id,
    checks: [],
    status,
    time: { created: now, updated: now },
  }
}

describe("OrchestrationScheduler", () => {
  test("finds independent tasks that are ready together", () => {
    const detail: Orchestration.Detail = {
      run: {
        id: runID,
        projectID: Project.ID.make("project_scheduler"),
        objective: "Run independent tasks",
        status: "active",
        time: { created: now, updated: now },
      },
      tasks: [task(firstID, "draft"), task(secondID, "draft")],
      dependencies: [],
      attempts: [],
      routeDecisions: [],
      evaluations: [],
      reviews: [],
    }

    expect(OrchestrationScheduler.readyTaskIDs(detail)).toEqual([firstID, secondID])
  })

  test("executes independent tasks concurrently up to the configured limit", async () => {
    const maximum = await Effect.runPromise(
      Effect.gen(function* () {
        const activity = yield* Ref.make({ active: 0, maximum: 0 })
        yield* OrchestrationScheduler.executeReadyTasks([firstID, secondID], 2, () =>
          Ref.update(activity, (state) => ({
            active: state.active + 1,
            maximum: Math.max(state.maximum, state.active + 1),
          })).pipe(
            Effect.andThen(Effect.sleep("10 millis")),
            Effect.andThen(Ref.update(activity, (state) => ({ ...state, active: state.active - 1 }))),
          ),
        )
        return (yield* Ref.get(activity)).maximum
      }),
    )

    expect(maximum).toBe(2)
  })

  test("waits for dependency acceptance", () => {
    const detail: Orchestration.Detail = {
      run: {
        id: runID,
        projectID: Project.ID.make("project_scheduler"),
        objective: "Run dependent tasks",
        status: "active",
        time: { created: now, updated: now },
      },
      tasks: [task(firstID, "awaiting_review"), task(secondID, "blocked")],
      dependencies: [{ runID, taskID: secondID, dependsOnTaskID: firstID }],
      attempts: [],
      routeDecisions: [],
      evaluations: [],
      reviews: [],
    }

    expect(OrchestrationScheduler.readyTaskIDs(detail)).toEqual([])
    expect(
      OrchestrationScheduler.readyTaskIDs({
        ...detail,
        tasks: [task(firstID, "succeeded"), task(secondID, "blocked")],
      }),
    ).toEqual([secondID])
  })
})
