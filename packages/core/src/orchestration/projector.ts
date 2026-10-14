export * as OrchestrationProjector from "./projector"

import { DateTime, Effect, Layer, Schema } from "effect"
import { desc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { OrchestrationPlanner } from "./planner"
import {
  OrchestrationAttemptTable,
  OrchestrationDeliveryTable,
  OrchestrationDependencyTable,
  OrchestrationEvaluationTable,
  OrchestrationFollowUpTable,
  OrchestrationQueuedFollowUpTable,
  OrchestrationHumanRequestTable,
  OrchestrationIntegrationTable,
  OrchestrationJudgmentTable,
  OrchestrationPlanTable,
  OrchestrationReassignmentTable,
  OrchestrationRouteDecisionTable,
  OrchestrationReviewTable,
  OrchestrationTriageLabelTable,
  OrchestrationRunTable,
  OrchestrationTaskTable,
  OrchestrationTierRecommendationTable,
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
          context: event.data.context,
          status: "draft",
          policy: event.data.policy,
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

    yield* events.project(Orchestration.RunSourceSet, (event) =>
      db
        .update(OrchestrationRunTable)
        .set({
          source_directory: event.data.source.directory,
          source_workspace_id: event.data.source.workspaceID,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationRunTable.id, event.data.runID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.RunWorkspaceSet, (event) =>
      db
        .update(OrchestrationRunTable)
        .set({
          workspace: event.data.workspace,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationRunTable.id, event.data.runID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.RunSessionLinked, (event) =>
      db
        .update(OrchestrationRunTable)
        .set({ session_id: event.data.sessionID, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
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
          kind: event.data.kind ?? "agent",
          run_id: event.data.runID,
          title: event.data.title,
          description: event.data.description,
          route_profile: event.data.routeProfile,
          capability_tier: event.data.capabilityTier,
          checks: event.data.checks ?? [],
          acceptance_criteria: event.data.acceptanceCriteria ?? [],
          status: "draft",
          time_created: timestamp,
          time_updated: timestamp,
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })

    yield* events.project(Orchestration.PlanProposed, (event) =>
      db
        .insert(OrchestrationPlanTable)
        .values({
          id: event.data.planID,
          run_id: event.data.runID,
          output: event.data.output,
          generation: event.data.generation
            ? Schema.encodeUnknownSync(Orchestration.PlanGeneration)(event.data.generation)
            : undefined,
          status: "proposed",
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.PlanApplied, (event) =>
      Effect.gen(function* () {
        const timestamp = DateTime.toEpochMillis(event.data.timestamp)
        const plan = yield* db
          .select()
          .from(OrchestrationPlanTable)
          .where(eq(OrchestrationPlanTable.id, event.data.planID))
          .get()
          .pipe(Effect.orDie)
        const run = yield* db
          .select({ status: OrchestrationRunTable.status })
          .from(OrchestrationRunTable)
          .where(eq(OrchestrationRunTable.id, event.data.runID))
          .get()
          .pipe(Effect.orDie)
        const existing = yield* db
          .select({ id: OrchestrationTaskTable.id })
          .from(OrchestrationTaskTable)
          .where(eq(OrchestrationTaskTable.run_id, event.data.runID))
          .limit(1)
          .all()
          .pipe(Effect.orDie)
        const deliveries = yield* db
          .select({ review: OrchestrationDeliveryTable.review })
          .from(OrchestrationDeliveryTable)
          .where(eq(OrchestrationDeliveryTable.run_id, event.data.runID))
          .all()
          .pipe(Effect.orDie)
        const followUp = yield* db
          .select({ time_created: OrchestrationFollowUpTable.time_created })
          .from(OrchestrationFollowUpTable)
          .where(eq(OrchestrationFollowUpTable.run_id, event.data.runID))
          .orderBy(desc(OrchestrationFollowUpTable.time_created))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const steered = yield* db
          .select({ status: OrchestrationQueuedFollowUpTable.status, time_steered: OrchestrationQueuedFollowUpTable.time_steered })
          .from(OrchestrationQueuedFollowUpTable)
          .where(eq(OrchestrationQueuedFollowUpTable.run_id, event.data.runID))
          .all()
          .pipe(Effect.orDie)
        const applied = yield* db
          .select({ time_applied: OrchestrationPlanTable.time_applied })
          .from(OrchestrationPlanTable)
          .where(eq(OrchestrationPlanTable.run_id, event.data.runID))
          .all()
          .pipe(Effect.orDie)
        const eligible =
          (run?.status === "draft" && existing.length === 0) ||
          (followUp &&
            ["draft", "clarifying"].includes(run?.status ?? "") &&
            (plan?.time_created ?? 0) > followUp.time_created &&
            !applied.some((item) => (item.time_applied ?? 0) > followUp.time_created)) ||
          (["reviewing_delivery", "clarifying"].includes(run?.status ?? "") &&
            existing.length > 0 &&
            deliveries.some((delivery) => delivery.review.decision === "gaps")) ||
          (run?.status === "active" && (
            (plan?.output.cancelTaskIDs?.length ?? 0) > 0 ||
            steered.some((item) => item.status === "steered" && item.time_steered &&
              (plan?.time_created ?? 0) >= item.time_steered &&
              !applied.some((prior) => (prior.time_applied ?? 0) > item.time_steered!))))
        if (
          plan?.run_id !== event.data.runID ||
          plan.status !== "proposed" ||
          !eligible
        )
          return yield* Effect.die(new Error("Run is not ready for this plan"))
        const ids = new Map(event.data.tasks.map((item) => [item.key, item.taskID]))
        if (
          OrchestrationPlanner.validate(plan.output) ||
          (event.data.cancelTaskIDs ?? []).length !== (plan.output.cancelTaskIDs ?? []).length ||
          (event.data.cancelTaskIDs ?? []).some((id) => !plan.output.cancelTaskIDs?.includes(id)) ||
          ids.size !== plan.output.tasks.length ||
          plan.output.tasks.some((task) => !ids.has(task.key)) ||
          new Set(ids.values()).size !== ids.size
        )
          return yield* Effect.die(new Error("Applied plan does not match its validated proposal"))
        const cancellation = new Set(event.data.cancelTaskIDs ?? [])
        if (cancellation.size) {
          const tasks = yield* db.select({ id: OrchestrationTaskTable.id, status: OrchestrationTaskTable.status })
            .from(OrchestrationTaskTable).where(eq(OrchestrationTaskTable.run_id, event.data.runID)).all().pipe(Effect.orDie)
          const dependencies = yield* db.select({
            taskID: OrchestrationDependencyTable.task_id,
            dependsOnTaskID: OrchestrationDependencyTable.depends_on_task_id,
          }).from(OrchestrationDependencyTable).where(eq(OrchestrationDependencyTable.run_id, event.data.runID)).all().pipe(Effect.orDie)
          if (
            tasks.filter((task) => cancellation.has(task.id)).length !== cancellation.size ||
            tasks.some((task) => cancellation.has(task.id) && !["draft", "blocked", "ready", "suspended", "failed"].includes(task.status)) ||
            dependencies.some((dependency) => cancellation.has(dependency.dependsOnTaskID) && !cancellation.has(dependency.taskID))
          ) return yield* Effect.die(new Error("Applied plan cancels ineligible or dependent tasks"))
        }
        yield* db
          .update(OrchestrationPlanTable)
          .set({ status: "applied", time_applied: timestamp })
          .where(eq(OrchestrationPlanTable.id, event.data.planID))
          .run()
          .pipe(Effect.orDie)
        yield* Effect.forEach(event.data.cancelTaskIDs ?? [], (taskID) =>
          db.update(OrchestrationTaskTable)
            .set({ status: "cancelled", time_updated: timestamp })
            .where(eq(OrchestrationTaskTable.id, taskID))
            .run()
            .pipe(Effect.orDie),
          { discard: true },
        )
        yield* db
          .insert(OrchestrationTaskTable)
          .values(
            plan.output.tasks.map((task) => ({
              id: ids.get(task.key)!,
              kind: task.kind ?? "agent",
              run_id: event.data.runID,
              title: task.title,
              description: task.description,
              route_profile: task.routeProfile,
              capability_tier: task.capabilityTier,
              checks: task.checks,
              acceptance_criteria: task.acceptanceCriteria ?? [],
              status: "draft" as const,
              time_created: timestamp,
              time_updated: timestamp,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        const dependencies = plan.output.tasks.flatMap((task) =>
          task.dependsOn.map((key) => ({
            run_id: event.data.runID,
            task_id: ids.get(task.key)!,
            depends_on_task_id: ids.get(key)!,
          })),
        )
        if (dependencies.length)
          yield* db.insert(OrchestrationDependencyTable).values(dependencies).run().pipe(Effect.orDie)
      }),
    )

    yield* events.project(Orchestration.DeliveryReviewed, (event) =>
      db
        .insert(OrchestrationDeliveryTable)
        .values({
          id: event.data.deliveryID,
          run_id: event.data.runID,
          plan_id: event.data.planID,
          base_head: event.data.baseHead,
          head: event.data.head,
          changed_files: event.data.changedFiles,
          review: event.data.review,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.DeliverySummarized, (event) =>
      db
        .update(OrchestrationDeliveryTable)
        .set({
          summary: event.data.summary,
          commit_message: event.data.commitMessage,
          summary_generation: event.data.summaryGeneration
            ? Schema.encodeUnknownSync(Orchestration.PlanGeneration)(event.data.summaryGeneration)
            : undefined,
          time_delivered: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationDeliveryTable.id, event.data.deliveryID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.IntegrationStarted, (event) => {
      const timestamp = DateTime.toEpochMillis(event.data.timestamp)
      return db
        .insert(OrchestrationIntegrationTable)
        .values({
          id: event.data.integrationID,
          run_id: event.data.runID,
          delivery_id: event.data.deliveryID,
          options: event.data.options,
          status: "running",
          steps: [],
          time_created: timestamp,
          time_updated: timestamp,
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid)
    })

    yield* events.project(Orchestration.IntegrationStepRecorded, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(OrchestrationIntegrationTable)
          .where(eq(OrchestrationIntegrationTable.id, event.data.integrationID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return
        yield* db
          .update(OrchestrationIntegrationTable)
          .set({
            steps: [...row.steps, Schema.encodeUnknownSync(Orchestration.IntegrationStep)(event.data.step)],
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(OrchestrationIntegrationTable.id, event.data.integrationID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Orchestration.IntegrationFinished, (event) =>
      db
        .update(OrchestrationIntegrationTable)
        .set({ status: event.data.status, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(OrchestrationIntegrationTable.id, event.data.integrationID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.IntegrationResumed, (event) =>
      db
        .update(OrchestrationIntegrationTable)
        .set({ status: "running", time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(OrchestrationIntegrationTable.id, event.data.integrationID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.FollowUpStarted, (event) =>
      Effect.gen(function* () {
        const timestamp = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(OrchestrationFollowUpTable)
          .values({
            id: event.data.turnID,
            run_id: event.data.runID,
            objective: event.data.objective,
            context: event.data.context,
            base_head: event.data.baseHead,
            time_created: timestamp,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(OrchestrationRunTable)
          .set({
            objective: event.data.objective,
            context: event.data.context,
            status: "draft",
            time_updated: timestamp,
          })
          .where(eq(OrchestrationRunTable.id, event.data.runID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Orchestration.FollowUpQueued, (event) =>
      db.insert(OrchestrationQueuedFollowUpTable).values({
        id: event.data.turnID,
        run_id: event.data.runID,
        objective: event.data.objective,
        context: event.data.context,
        status: "queued",
        time_created: DateTime.toEpochMillis(event.data.timestamp),
      }).run().pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.FollowUpDequeued, (event) =>
      db.update(OrchestrationQueuedFollowUpTable).set({ status: "started" })
        .where(eq(OrchestrationQueuedFollowUpTable.id, event.data.turnID))
        .run().pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.FollowUpSteered, (event) =>
      db.update(OrchestrationQueuedFollowUpTable)
        .set({ status: "steered", time_steered: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(OrchestrationQueuedFollowUpTable.id, event.data.turnID))
        .run().pipe(Effect.orDie, Effect.asVoid),
    )

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
          kind: event.data.kind ?? "initial",
          candidate: event.data.candidate,
          session_id: event.data.sessionID ?? null,
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

    yield* events.project(Orchestration.AttemptVerdictRecorded, (event) =>
      db
        .update(OrchestrationAttemptTable)
        .set({
          verdict: event.data.verdict,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationAttemptTable.id, event.data.attemptID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.AttemptFeedbackRecorded, (event) =>
      db
        .update(OrchestrationAttemptTable)
        .set({
          feedback: event.data.feedback,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationAttemptTable.id, event.data.attemptID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.HumanRequested, (event) =>
      db
        .insert(OrchestrationHumanRequestTable)
        .values({
          id: event.data.requestID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          kind: event.data.kind,
          prompt: event.data.prompt,
          choices: event.data.choices,
          assumption: event.data.assumption,
          status: "open",
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.HumanRequestAnswered, (event) =>
      db
        .update(OrchestrationHumanRequestTable)
        .set({
          status: "answered",
          answer: event.data.answer,
          time_answered: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(OrchestrationHumanRequestTable.id, event.data.requestID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    yield* events.project(Orchestration.ReassignmentRecorded, (event) =>
      db
        .insert(OrchestrationReassignmentTable)
        .values({
          id: event.data.reassignmentID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          after_attempt_id: event.data.afterAttemptID,
          options: event.data.options,
          selected: event.data.selected,
          chooser: event.data.chooser,
          request: event.data.request,
          result: event.data.result,
          time_created: DateTime.toEpochMillis(event.data.timestamp),
        })
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
          resolution: Schema.encodeUnknownSync(Orchestration.RouteResolution)(event.data.resolution),
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

    yield* events.project(Orchestration.TriageLabeled, (event) =>
      db
        .insert(OrchestrationTriageLabelTable)
        .values({
          id: event.data.labelID,
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

    yield* events.project(Orchestration.TierRecommendationRecorded, (event) =>
      db
        .insert(OrchestrationTierRecommendationTable)
        .values({
          id: event.data.recommendationID,
          run_id: event.data.runID,
          task_id: event.data.taskID,
          route_decision_id: event.data.routeDecisionID,
          explicit_tier: event.data.explicitTier,
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
