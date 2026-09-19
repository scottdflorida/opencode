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
      judgments: [],
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
      judgments: [],
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

  test("limits shadow judgment input to the controller summary", () => {
    const input = OrchestrationScheduler.attemptReviewRequest(
      {
        id: runID,
        projectID: Project.ID.make("project_scheduler"),
        objective: "Review the bounded evidence",
        status: "active",
        time: { created: now, updated: now },
      },
      {
        ...task(firstID, "running"),
        title: "Keep private evidence local",
        description: "Send only the summary",
      },
      { id: "local", type: "direct", providerID: "local", modelID: "qwen" },
      [
        {
          kind: "check:test",
          status: "passed",
          evidence: {
            exitCode: 0,
            stdout: "private stdout",
            stderr: "private stderr",
            command: "private command",
            baseline: { exitCode: 1, stdout: "private baseline" },
            truncated: true,
          },
        },
        {
          kind: "workspace",
          status: "passed",
          evidence: {
            patch: "private patch",
            directory: "/private/worktree",
            credential: "private secret",
          },
        },
      ],
    )

    const serialized = JSON.stringify(input)
    expect(serialized).not.toContain("private stdout")
    expect(serialized).not.toContain("private stderr")
    expect(serialized).not.toContain("private command")
    expect(serialized).not.toContain("private baseline")
    expect(serialized).not.toContain("private patch")
    expect(serialized).not.toContain("/private/worktree")
    expect(serialized).not.toContain("private secret")
    expect(input.state.inputTruncated).toBe(false)
    expect(input.state.evaluations).toEqual([
      {
        kind: "check:test",
        status: "passed",
        exitCode: 0,
        baselineExitCode: 1,
        changed: null,
        truncated: true,
      },
      {
        kind: "workspace",
        status: "passed",
        exitCode: null,
        baselineExitCode: null,
        changed: true,
        truncated: false,
      },
    ])
  })

  test("caps shadow judgment text and evaluation count", () => {
    const input = OrchestrationScheduler.attemptReviewRequest(
      {
        id: runID,
        projectID: Project.ID.make("project_scheduler"),
        objective: "x".repeat(8_001),
        status: "active",
        time: { created: now, updated: now },
      },
      task(firstID, "running"),
      { id: "local", type: "direct", providerID: "local", modelID: "qwen" },
      Array.from({ length: 65 }, (_, index) => ({
        kind: `check:${index}`,
        status: "passed" as const,
        evidence: { exitCode: 0 },
      })),
    )

    expect(input.state.objective).toHaveLength(8_000)
    expect(input.state.evaluations).toHaveLength(64)
    expect(input.state.inputTruncated).toBe(true)
  })
})
