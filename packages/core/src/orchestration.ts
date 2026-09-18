export * as Orchestration from "./orchestration"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { asc, desc, eq } from "drizzle-orm"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { ProjectV2 } from "./project"
import { OrchestrationProjector } from "./orchestration/projector"
import { WorkspaceV2 } from "./workspace"
import {
  OrchestrationAttemptTable,
  OrchestrationDependencyTable,
  OrchestrationEvaluationTable,
  OrchestrationRouteDecisionTable,
  OrchestrationRunTable,
  OrchestrationTaskTable,
} from "./orchestration/sql"

export const RunID = Orchestration.RunID
export type RunID = Orchestration.RunID
export const TaskID = Orchestration.TaskID
export type TaskID = Orchestration.TaskID
export const AttemptID = Orchestration.AttemptID
export type AttemptID = Orchestration.AttemptID

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Orchestration.NotFoundError", {
  resource: Schema.Literals(["run", "task", "attempt"]),
  id: Schema.String,
}) {}

export interface Interface {
  readonly list: (input?: { readonly projectID?: ProjectV2.ID }) => Effect.Effect<Orchestration.Run[]>
  readonly get: (runID: RunID) => Effect.Effect<Orchestration.Detail, NotFoundError>
  readonly create: (input: {
    readonly id?: RunID
    readonly projectID: ProjectV2.ID
    readonly objective: string
  }) => Effect.Effect<Orchestration.Run>
  readonly setRunStatus: (input: {
    readonly runID: RunID
    readonly status: Orchestration.RunStatus
    readonly retryAt?: DateTime.Utc
  }) => Effect.Effect<void, NotFoundError>
  readonly addTask: (input: {
    readonly id?: TaskID
    readonly runID: RunID
    readonly title: string
    readonly description?: string
    readonly routeProfile?: string
  }) => Effect.Effect<Orchestration.Task, NotFoundError>
  readonly setTaskStatus: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly status: Orchestration.TaskStatus
  }) => Effect.Effect<void, NotFoundError>
  readonly addDependency: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly dependsOnTaskID: TaskID
  }) => Effect.Effect<void, NotFoundError>
  readonly createAttempt: (input: {
    readonly id?: AttemptID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly candidate?: Orchestration.Candidate
    readonly sessionID?: (typeof Orchestration.Attempt.Type)["sessionID"]
    readonly location?: (typeof Orchestration.Attempt.Type)["location"]
  }) => Effect.Effect<Orchestration.Attempt, NotFoundError>
  readonly setAttemptStatus: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly status: Orchestration.AttemptStatus
    readonly completed?: DateTime.Utc
  }) => Effect.Effect<void, NotFoundError>
  readonly recordRouteDecision: (input: {
    readonly id?: Orchestration.RouteDecisionID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID?: AttemptID
    readonly resolution: Orchestration.RouteResolution
  }) => Effect.Effect<Orchestration.RouteDecision, NotFoundError>
  readonly recordEvaluation: (input: {
    readonly id?: Orchestration.EvaluationID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly kind: string
    readonly status: Orchestration.EvaluationStatus
    readonly evidence: Record<string, unknown>
  }) => Effect.Effect<Orchestration.Evaluation, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestration") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const getRun = Effect.fn("Orchestration.getRun")(function* (runID: RunID) {
      const row = yield* db
        .select()
        .from(OrchestrationRunTable)
        .where(eq(OrchestrationRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ resource: "run", id: runID })
      return row
    })

    const getTask = Effect.fn("Orchestration.getTask")(function* (runID: RunID, taskID: TaskID) {
      const row = yield* db
        .select()
        .from(OrchestrationTaskTable)
        .where(eq(OrchestrationTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      if (!row || row.run_id !== runID) return yield* new NotFoundError({ resource: "task", id: taskID })
      return row
    })

    const getAttempt = Effect.fn("Orchestration.getAttempt")(function* (runID: RunID, attemptID: AttemptID) {
      const row = yield* db
        .select()
        .from(OrchestrationAttemptTable)
        .where(eq(OrchestrationAttemptTable.id, attemptID))
        .get()
        .pipe(Effect.orDie)
      if (!row || row.run_id !== runID) return yield* new NotFoundError({ resource: "attempt", id: attemptID })
      return row
    })

    const get = Effect.fn("Orchestration.get")(function* (runID: RunID) {
      const run = runFromRow(yield* getRun(runID))
      const rows = yield* Effect.all({
        tasks: db
          .select()
          .from(OrchestrationTaskTable)
          .where(eq(OrchestrationTaskTable.run_id, runID))
          .orderBy(asc(OrchestrationTaskTable.time_created), asc(OrchestrationTaskTable.id))
          .all()
          .pipe(Effect.orDie),
        dependencies: db
          .select()
          .from(OrchestrationDependencyTable)
          .where(eq(OrchestrationDependencyTable.run_id, runID))
          .orderBy(asc(OrchestrationDependencyTable.task_id), asc(OrchestrationDependencyTable.depends_on_task_id))
          .all()
          .pipe(Effect.orDie),
        attempts: db
          .select()
          .from(OrchestrationAttemptTable)
          .where(eq(OrchestrationAttemptTable.run_id, runID))
          .orderBy(asc(OrchestrationAttemptTable.time_created), asc(OrchestrationAttemptTable.id))
          .all()
          .pipe(Effect.orDie),
        decisions: db
          .select()
          .from(OrchestrationRouteDecisionTable)
          .where(eq(OrchestrationRouteDecisionTable.run_id, runID))
          .orderBy(asc(OrchestrationRouteDecisionTable.time_created), asc(OrchestrationRouteDecisionTable.id))
          .all()
          .pipe(Effect.orDie),
        evaluations: db
          .select()
          .from(OrchestrationEvaluationTable)
          .where(eq(OrchestrationEvaluationTable.run_id, runID))
          .orderBy(asc(OrchestrationEvaluationTable.time_created), asc(OrchestrationEvaluationTable.id))
          .all()
          .pipe(Effect.orDie),
      })
      return {
        run,
        tasks: rows.tasks.map(taskFromRow),
        dependencies: rows.dependencies.map((row) => ({
          runID: row.run_id,
          taskID: row.task_id,
          dependsOnTaskID: row.depends_on_task_id,
        })),
        attempts: rows.attempts.map(attemptFromRow),
        routeDecisions: rows.decisions.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id ?? undefined,
          resolution: row.resolution,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        evaluations: rows.evaluations.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id,
          kind: row.kind,
          status: row.status,
          evidence: row.evidence,
          time: DateTime.makeUnsafe(row.time_created),
        })),
      } satisfies Orchestration.Detail
    })

    const result = Service.of({
      list: Effect.fn("Orchestration.list")(function* (input = {}) {
        const query = db.select().from(OrchestrationRunTable)
        const rows = yield* (
          input.projectID ? query.where(eq(OrchestrationRunTable.project_id, input.projectID)) : query
        )
          .orderBy(desc(OrchestrationRunTable.time_created), desc(OrchestrationRunTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(runFromRow)
      }),
      get,
      create: Effect.fn("Orchestration.create")(function* (input) {
        const runID = input.id ?? Orchestration.RunID.create()
        yield* events.publish(Orchestration.RunCreated, {
          runID,
          projectID: input.projectID,
          objective: input.objective,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(runID).pipe(Effect.orDie)).run
      }),
      setRunStatus: Effect.fn("Orchestration.setRunStatus")(function* (input) {
        yield* getRun(input.runID)
        yield* events.publish(Orchestration.RunStatusChanged, {
          runID: input.runID,
          status: input.status,
          retryAt: input.retryAt,
          timestamp: yield* DateTime.now,
        })
      }),
      addTask: Effect.fn("Orchestration.addTask")(function* (input) {
        yield* getRun(input.runID)
        const taskID = input.id ?? Orchestration.TaskID.create()
        yield* events.publish(Orchestration.TaskAdded, {
          runID: input.runID,
          taskID,
          title: input.title,
          description: input.description,
          routeProfile: input.routeProfile,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).tasks.find((task) => task.id === taskID)!
      }),
      setTaskStatus: Effect.fn("Orchestration.setTaskStatus")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        yield* events.publish(Orchestration.TaskStatusChanged, {
          runID: input.runID,
          taskID: input.taskID,
          status: input.status,
          timestamp: yield* DateTime.now,
        })
      }),
      addDependency: Effect.fn("Orchestration.addDependency")(function* (input) {
        yield* Effect.all([getTask(input.runID, input.taskID), getTask(input.runID, input.dependsOnTaskID)])
        yield* events.publish(Orchestration.DependencyAdded, {
          ...input,
          timestamp: yield* DateTime.now,
        })
      }),
      createAttempt: Effect.fn("Orchestration.createAttempt")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const attemptID = input.id ?? Orchestration.AttemptID.create()
        yield* events.publish(Orchestration.AttemptCreated, {
          runID: input.runID,
          taskID: input.taskID,
          attemptID,
          candidate: input.candidate,
          sessionID: input.sessionID,
          location: input.location,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).attempts.find((attempt) => attempt.id === attemptID)!
      }),
      setAttemptStatus: Effect.fn("Orchestration.setAttemptStatus")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        yield* events.publish(Orchestration.AttemptStatusChanged, {
          ...input,
          timestamp: yield* DateTime.now,
        })
      }),
      recordRouteDecision: Effect.fn("Orchestration.recordRouteDecision")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        if (input.attemptID) {
          const attempt = yield* getAttempt(input.runID, input.attemptID)
          if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        }
        const id = input.id ?? Orchestration.RouteDecisionID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.RouteDecided, {
          decisionID: id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          resolution: input.resolution,
          timestamp: time,
        })
        return {
          id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          resolution: input.resolution,
          time,
        }
      }),
      recordEvaluation: Effect.fn("Orchestration.recordEvaluation")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        const id = input.id ?? Orchestration.EvaluationID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.EvaluationRecorded, {
          evaluationID: id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          kind: input.kind,
          status: input.status,
          evidence: input.evidence,
          timestamp: time,
        })
        return {
          id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          kind: input.kind,
          status: input.status,
          evidence: input.evidence,
          time,
        }
      }),
    })

    return result
  }),
)

function runFromRow(row: typeof OrchestrationRunTable.$inferSelect): Orchestration.Run {
  return {
    id: row.id,
    projectID: row.project_id,
    objective: row.objective,
    status: row.status,
    retryAt: row.retry_at === null ? undefined : DateTime.makeUnsafe(row.retry_at),
    time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
  }
}

function taskFromRow(row: typeof OrchestrationTaskTable.$inferSelect): Orchestration.Task {
  return {
    id: row.id,
    runID: row.run_id,
    title: row.title,
    description: row.description ?? undefined,
    routeProfile: row.route_profile ?? undefined,
    status: row.status,
    time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
  }
}

function attemptFromRow(row: typeof OrchestrationAttemptTable.$inferSelect): Orchestration.Attempt {
  return {
    id: row.id,
    runID: row.run_id,
    taskID: row.task_id,
    status: row.status,
    candidate: row.candidate ?? undefined,
    sessionID: row.session_id ?? undefined,
    location: row.directory
      ? {
          directory: row.directory,
          workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
        }
      : undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, OrchestrationProjector.node],
})
