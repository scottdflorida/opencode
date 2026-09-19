export * as OrchestrationProjector from "./projector"

import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import {
  OrchestrationAttemptTable,
  OrchestrationDependencyTable,
  OrchestrationEvaluationTable,
  OrchestrationJudgmentTable,
  OrchestrationRouteDecisionTable,
  OrchestrationReviewTable,
  OrchestrationRunTable,
  OrchestrationTaskTable,
} from "./sql"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    yield* events.project(Orchestration.RunCreated, (event) => {
      const timestamp = DateTime.toEpochMillis(event.data.timestamp)
      return db
        .insert(OrchestrationRunTable)
        .values({
          id: event.data.runID,
          project_id: event.data.projectID,
          objective: event.data.objective,
          status: "draft",
          time_created: timestamp,
          time_updated: timestamp,
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })

    yield* events.project(Orchestration.RunStatusChanged, (event) =>
      db
        .update(OrchestrationRunTable)
        .set({
          status: event.data.status,
          retry_at: event.data.retryAt ? DateTime.toEpochMillis(event.data.retryAt) : null,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationRunTable.id, event.data.runID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.TaskAdded, (event) => {
      const timestamp = DateTime.toEpochMillis(event.data.timestamp)
      return db
        .insert(OrchestrationTaskTable)
        .values({
          id: event.data.taskID,
          run_id: event.data.runID,
          title: event.data.title,
          description: event.data.description,
          route_profile: event.data.routeProfile,
          checks: event.data.checks ?? [],
          status: "draft",
          time_created: timestamp,
          time_updated: timestamp,
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })

    yield* events.project(Orchestration.TaskStatusChanged, (event) =>
      db
        .update(OrchestrationTaskTable)
        .set({ status: event.data.status, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(OrchestrationTaskTable.id, event.data.taskID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.DependencyAdded, (event) =>
      db
        .insert(OrchestrationDependencyTable)
        .values({
          run_id: event.data.runID,
          task_id: event.data.taskID,
          depends_on_task_id: event.data.dependsOnTaskID,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.AttemptCreated, (event) => {
      const timestamp = DateTime.toEpochMillis(event.data.timestamp)
      return db
        .insert(OrchestrationAttemptTable)
        .values({
          id: event.data.attemptID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          status: "pending",
          candidate: event.data.candidate,
          session_id: event.data.sessionID,
          directory: event.data.location?.directory,
          workspace_id: event.data.location?.workspaceID,
          time_created: timestamp,
          time_updated: timestamp,
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })

    yield* events.project(Orchestration.AttemptPrepared, (event) =>
      db
        .update(OrchestrationAttemptTable)
        .set({
          session_id: event.data.sessionID,
          directory: event.data.location.directory,
          workspace_id: event.data.location.workspaceID,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationAttemptTable.id, event.data.attemptID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.AttemptStatusChanged, (event) =>
      db
        .update(OrchestrationAttemptTable)
        .set({
          status: event.data.status,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
          time_completed: event.data.completed ? DateTime.toEpochMillis(event.data.completed) : null,
        })
        .where(eq(OrchestrationAttemptTable.id, event.data.attemptID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.RouteDecided, (event) =>
      db
        .insert(OrchestrationRouteDecisionTable)
        .values({
          id: event.data.decisionID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          attempt_id: event.data.attemptID,
          resolution: event.data.resolution,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.EvaluationRecorded, (event) =>
      db
        .insert(OrchestrationEvaluationTable)
        .values({
          id: event.data.evaluationID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          attempt_id: event.data.attemptID,
          kind: event.data.kind,
          status: event.data.status,
          evidence: event.data.evidence,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.ReviewRecorded, (event) =>
      db
        .insert(OrchestrationReviewTable)
        .values({
          id: event.data.reviewID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          attempt_id: event.data.attemptID,
          decision: event.data.decision,
          note: event.data.note,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.JudgmentRecorded, (event) =>
      db
        .insert(OrchestrationJudgmentTable)
        .values({
          id: event.data.judgmentID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          attempt_id: event.data.attemptID,
          mode: event.data.mode,
          request: event.data.request,
          result: event.data.result,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
  }),
)

export const node = makeGlobalNode({
  name: "orchestration-projector",
  layer,
  deps: [EventV2.node, Database.node],
})
