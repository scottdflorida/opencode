export * as OrchestrationScheduler from "./scheduler"

import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { AttemptID, Detail, ReviewDecision, Run, RunID, Task, TaskID } from "@opencode-ai/schema/orchestration"
import { Config } from "../config"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { SessionV2 } from "../session"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { Orchestration } from "../orchestration"
import { OrchestrationExecutor } from "./executor"
import { OrchestrationRouting } from "./routing"

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("Orchestration.OperationError", {
  operation: Schema.Literals(["start", "cancel", "accept", "reject", "retry"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly start: (input: {
    readonly runID: RunID
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly cancel: (runID: RunID) => Effect.Effect<void, Orchestration.NotFoundError>
  readonly review: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly decision: ReviewDecision
    readonly note?: string
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly retry: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationScheduler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const orchestration = yield* Orchestration.Service
    const executor = yield* OrchestrationExecutor.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* SessionV2.Service
    const sources = new Map<RunID, Location.Ref>()

    const executeTask = Effect.fn("OrchestrationScheduler.executeTask")(function* (
      run: Run,
      task: Task,
      source: Location.Ref,
    ) {
      const routed = yield* OrchestrationRouting.Service.use((routing) => routing.resolve(task.routeProfile)).pipe(
        Effect.provide(locations.get(source)),
        Effect.exit,
      )
      if (Exit.isFailure(routed)) {
        yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "failed" })
        return
      }
      const resolution = routed.value
      if (resolution.status !== "selected" || !resolution.selected) {
        yield* orchestration.recordRouteDecision({ runID: run.id, taskID: task.id, resolution })
        yield* orchestration.setTaskStatus({
          runID: run.id,
          taskID: task.id,
          status: resolution.status === "waiting" ? "suspended" : "failed",
        })
        return
      }

      const attempt = yield* orchestration.createAttempt({
        runID: run.id,
        taskID: task.id,
        candidate: resolution.selected,
      })
      yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        resolution,
      })
      if (resolution.selected.type !== "direct") {
        yield* finishFailure(
          orchestration,
          run.id,
          task.id,
          attempt.id,
          "Harness execution is not available in Phase 2",
        )
        return
      }

      const prepared = yield* executor
        .prepare({ run, task, attemptID: attempt.id, candidate: resolution.selected, source })
        .pipe(Effect.exit)
      if (Exit.isFailure(prepared)) {
        yield* finishFailure(orchestration, run.id, task.id, attempt.id, errorMessage(prepared.cause))
        return
      }
      yield* orchestration.prepareAttempt({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        sessionID: prepared.value.sessionID,
        location: prepared.value.location,
      })
      yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "running" })
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        status: "running",
      })

      const evaluated = yield* executor.execute({ run, task, prepared: prepared.value, source }).pipe(Effect.exit)
      if (Exit.isFailure(evaluated)) {
        yield* orchestration.recordEvaluation({
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          kind: "execution",
          status: "failed",
          evidence: { message: errorMessage(evaluated.cause) },
        })
        yield* completeAttempt(orchestration, run.id, task.id, attempt.id, "failed")
        return
      }

      yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "evaluating" })
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        status: "evaluating",
      })
      yield* Effect.forEach(
        evaluated.value,
        (evaluation) =>
          orchestration.recordEvaluation({
            runID: run.id,
            taskID: task.id,
            attemptID: attempt.id,
            ...evaluation,
          }),
        { discard: true },
      )
      yield* completeAttempt(
        orchestration,
        run.id,
        task.id,
        attempt.id,
        evaluated.value.some((evaluation) => evaluation.status === "failed") ? "failed" : "succeeded",
      )
    })

    const drain = Effect.fn("OrchestrationScheduler.drain")(function* (runID: RunID) {
      const source = sources.get(runID)
      if (!source) return yield* Effect.die(`Missing source Location for orchestration run ${runID}`)
      yield* recoverInterrupted(orchestration, runID)
      while (true) {
        const detail = yield* orchestration.get(runID)
        if (detail.run.status === "cancelled" || detail.run.status === "completed") return yield* Effect.void
        yield* refreshReadiness(orchestration, detail)
        const current = yield* orchestration.get(runID)
        const ready = current.tasks.filter((task) => task.status === "ready")
        if (ready.length === 0) {
          yield* settleRun(orchestration, current)
          return yield* Effect.void
        }
        const concurrency = yield* Config.Service.use((config) =>
          config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration")?.max_concurrency ?? 2)),
        ).pipe(Effect.provide(locations.get(source)))
        yield* executeReadyTasks(ready, concurrency, (task) => executeTask(current.run, task, source))
      }
    })

    const coordinator = yield* SessionRunCoordinator.make<RunID, never>({
      drain: (runID) =>
        drain(runID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Orchestration run failed", cause).pipe(Effect.annotateLogs({ runID })),
          ),
        ),
    })

    const launch = (runID: RunID, source: Location.Ref) =>
      Effect.sync(() => sources.set(runID, source)).pipe(Effect.andThen(coordinator.wake(runID)))

    const start = Effect.fn("OrchestrationScheduler.start")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      if (detail.run.status === "cancelled" || detail.run.status === "completed")
        return yield* new OperationError({ operation: "start", message: `Run is ${detail.run.status}` })
      if (detail.tasks.length === 0)
        return yield* new OperationError({ operation: "start", message: "Add at least one task before starting" })
      if (detail.run.status !== "active") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      yield* Effect.forEach(
        detail.tasks.filter((task) => task.status === "suspended"),
        (task) => orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "ready" }),
        { discard: true },
      )
      return yield* launch(input.runID, input.source)
    })

    const cancel = Effect.fn("OrchestrationScheduler.cancel")(function* (runID: RunID) {
      const detail = yield* orchestration.get(runID)
      yield* Effect.forEach(
        detail.attempts.flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : [])),
        sessions.interrupt,
        { concurrency: "unbounded", discard: true },
      )
      yield* coordinator.interrupt(runID)
      const completed = yield* DateTime.now
      yield* Effect.forEach(
        detail.attempts.filter((attempt) => ["pending", "running", "evaluating"].includes(attempt.status)),
        (attempt) =>
          orchestration.setAttemptStatus({
            runID,
            taskID: attempt.taskID,
            attemptID: attempt.id,
            status: "interrupted",
            completed,
          }),
        { discard: true },
      )
      yield* Effect.forEach(
        detail.tasks.filter((task) => !["succeeded", "failed", "cancelled"].includes(task.status)),
        (task) => orchestration.setTaskStatus({ runID, taskID: task.id, status: "cancelled" }),
        { discard: true },
      )
      yield* orchestration.setRunStatus({ runID, status: "cancelled" })
    })

    const review = Effect.fn("OrchestrationScheduler.review")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const task = detail.tasks.find((item) => item.id === input.taskID)
      if (!task) return yield* new Orchestration.NotFoundError({ resource: "task", id: input.taskID })
      if (task.status !== "awaiting_review")
        return yield* new OperationError({
          operation: input.decision === "accepted" ? "accept" : "reject",
          message: `Task is ${task.status}`,
        })
      const attempt = detail.attempts.findLast((item) => item.taskID === task.id)
      if (!attempt) return yield* new Orchestration.NotFoundError({ resource: "attempt", id: task.id })
      yield* orchestration.recordReview({
        runID: input.runID,
        taskID: task.id,
        attemptID: attempt.id,
        decision: input.decision,
        note: input.note,
      })
      yield* orchestration.setTaskStatus({
        runID: input.runID,
        taskID: task.id,
        status: input.decision === "accepted" ? "succeeded" : "failed",
      })
      return yield* launch(input.runID, input.source)
    })

    const retry = Effect.fn("OrchestrationScheduler.retry")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const task = detail.tasks.find((item) => item.id === input.taskID)
      if (!task) return yield* new Orchestration.NotFoundError({ resource: "task", id: input.taskID })
      if (!["awaiting_review", "failed", "suspended"].includes(task.status))
        return yield* new OperationError({ operation: "retry", message: `Task is ${task.status}` })
      if (detail.run.status !== "active") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      yield* orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "ready" })
      return yield* launch(input.runID, input.source)
    })

    return Service.of({ start, cancel, review, retry })
  }),
)

export function readyTaskIDs(detail: Detail) {
  const status = new Map(detail.tasks.map((task) => [task.id, task.status] as const))
  return detail.tasks
    .filter((task) => ["draft", "blocked"].includes(task.status))
    .filter((task) =>
      detail.dependencies
        .filter((dependency) => dependency.taskID === task.id)
        .every((dependency) => status.get(dependency.dependsOnTaskID) === "succeeded"),
    )
    .map((task) => task.id)
}

export function executeReadyTasks<A, E, R>(
  tasks: ReadonlyArray<A>,
  concurrency: number,
  execute: (task: A) => Effect.Effect<void, E, R>,
) {
  return Effect.forEach(tasks.slice(0, concurrency), execute, { concurrency: "unbounded", discard: true })
}

function refreshReadiness(orchestration: Orchestration.Interface, detail: Detail) {
  const ready = new Set(readyTaskIDs(detail))
  return Effect.forEach(
    detail.tasks.filter((task) => ["draft", "blocked"].includes(task.status)),
    (task) =>
      orchestration.setTaskStatus({
        runID: detail.run.id,
        taskID: task.id,
        status: ready.has(task.id) ? "ready" : "blocked",
      }),
    { discard: true },
  )
}

function recoverInterrupted(orchestration: Orchestration.Interface, runID: RunID) {
  return Effect.gen(function* () {
    const detail = yield* orchestration.get(runID)
    const completed = yield* DateTime.now
    yield* Effect.forEach(
      detail.attempts.filter((attempt) => ["running", "evaluating"].includes(attempt.status)),
      (attempt) =>
        orchestration.setAttemptStatus({
          runID,
          taskID: attempt.taskID,
          attemptID: attempt.id,
          status: "interrupted",
          completed,
        }),
      { discard: true },
    )
    yield* Effect.forEach(
      detail.tasks.filter((task) => ["running", "evaluating"].includes(task.status)),
      (task) => orchestration.setTaskStatus({ runID, taskID: task.id, status: "awaiting_review" }),
      { discard: true },
    )
  })
}

function settleRun(orchestration: Orchestration.Interface, detail: Detail) {
  if (detail.tasks.every((task) => ["succeeded", "failed", "cancelled", "blocked"].includes(task.status)))
    return orchestration.setRunStatus({ runID: detail.run.id, status: "completed" })
  const retryAt = detail.routeDecisions
    .flatMap((decision) => (decision.resolution.retryAt ? [decision.resolution.retryAt] : []))
    .toSorted((a, b) => DateTime.toEpochMillis(a) - DateTime.toEpochMillis(b))[0]
  if (detail.tasks.some((task) => task.status === "suspended"))
    return orchestration.setRunStatus({ runID: detail.run.id, status: "suspended", retryAt })
  return Effect.void
}

function completeAttempt(
  orchestration: Orchestration.Interface,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  status: "succeeded" | "failed",
) {
  return Effect.gen(function* () {
    yield* orchestration.setAttemptStatus({
      runID,
      taskID,
      attemptID,
      status,
      completed: yield* DateTime.now,
    })
    yield* orchestration.setTaskStatus({ runID, taskID, status: "awaiting_review" })
  })
}

function finishFailure(
  orchestration: Orchestration.Interface,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  message: string,
) {
  return Effect.gen(function* () {
    yield* orchestration.recordEvaluation({
      runID,
      taskID,
      attemptID,
      kind: "execution",
      status: "failed",
      evidence: { message },
    })
    yield* completeAttempt(orchestration, runID, taskID, attemptID, "failed")
  })
}

function errorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Orchestration.node, OrchestrationExecutor.node, LocationServiceMap.node, SessionV2.node],
})
