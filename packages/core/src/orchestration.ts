export * as Orchestration from "./orchestration"

import { Context, DateTime, Effect, Layer, Schema, Stream } from "effect"
import { asc, desc, eq } from "drizzle-orm"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { OrchestrationDurable } from "@opencode-ai/schema/durable-event-manifest"
import { makeGlobalNode } from "./effect/app-node"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Question } from "@opencode-ai/schema/question"
import { Location } from "@opencode-ai/schema/location"
import { ProjectV2 } from "./project"
import { ProjectDirectories } from "./project/directories"
import { ProjectTable } from "./project/sql"
import { OrchestrationProjector } from "./orchestration/projector"
import { OrchestrationPlanner } from "./orchestration/planner"
import { WorkspaceV2 } from "./workspace"
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
} from "./orchestration/sql"

export const RunID = Orchestration.RunID
export type RunID = Orchestration.RunID
export const TaskID = Orchestration.TaskID
export type TaskID = Orchestration.TaskID
export const AttemptID = Orchestration.AttemptID
export type AttemptID = Orchestration.AttemptID

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Orchestration.NotFoundError", {
  resource: Schema.Literals(["run", "task", "attempt", "request", "delivery", "integration", "queued follow-up"]),
  id: Schema.String,
}) {}

export class HumanRequestError extends Schema.TaggedErrorClass<HumanRequestError>()("Orchestration.HumanRequestError", {
  message: Schema.String,
}) {}

export class InvalidDependencyError extends Schema.TaggedErrorClass<InvalidDependencyError>()(
  "Orchestration.InvalidDependencyError",
  {
    reason: Schema.Literals(["self", "cycle"]),
  },
) {}

export class InvalidPlanError extends Schema.TaggedErrorClass<InvalidPlanError>()("Orchestration.InvalidPlanError", {
  message: Schema.String,
}) {}

export class TriageLabelError extends Schema.TaggedErrorClass<TriageLabelError>()("Orchestration.TriageLabelError", {
  reason: Schema.Literals(["not_ready", "already_labeled"]),
}) {}

export interface Interface {
  readonly list: (input?: { readonly projectID?: ProjectV2.ID }) => Effect.Effect<Orchestration.Run[]>
  readonly calibration: (input: {
    readonly projectID: ProjectV2.ID
  }) => Effect.Effect<Orchestration.JudgmentCalibration>
  readonly get: (runID: RunID) => Effect.Effect<Orchestration.Detail, NotFoundError>
  readonly events: (input: { runID: RunID; after?: number }) => Stream.Stream<Orchestration.Events, NotFoundError>
  readonly history: (input: {
    runID: RunID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<Orchestration.Events>; hasMore: boolean }, NotFoundError>
  readonly reviewPacket: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
  }) => Effect.Effect<Orchestration.ReviewPacket, NotFoundError>
  readonly create: (input: {
    readonly id?: RunID
    readonly projectID: ProjectV2.ID
    readonly project?: {
      readonly directory: (typeof ProjectTable.$inferInsert)["worktree"]
      readonly vcs?: ProjectV2.Vcs
    }
    readonly objective: string
    readonly context?: string
    readonly policy?: Orchestration.PolicySnapshot
  }) => Effect.Effect<Orchestration.Run>
  readonly proposePlan: (input: {
    readonly runID: RunID
    readonly output: Orchestration.PlanOutput
    readonly generation?: Orchestration.PlanGeneration
  }) => Effect.Effect<Orchestration.Plan, NotFoundError | InvalidPlanError>
  readonly applyPlan: (input: {
    readonly runID: RunID
    readonly planID: Orchestration.PlanID
  }) => Effect.Effect<Orchestration.Detail, NotFoundError | InvalidPlanError>
  readonly recordDeliveryReview: (input: {
    readonly runID: RunID
    readonly planID?: Orchestration.PlanID
    readonly baseHead: string
    readonly head: string
    readonly changedFiles: number
    readonly review: Orchestration.DeliveryReview
  }) => Effect.Effect<Orchestration.Delivery, NotFoundError>
  readonly summarizeDelivery: (input: {
    readonly runID: RunID
    readonly deliveryID: Orchestration.DeliveryID
    readonly summary: string
    readonly commitMessage: string
    readonly summaryGeneration?: Orchestration.PlanGeneration
  }) => Effect.Effect<Orchestration.Delivery, NotFoundError>
  readonly startIntegration: (input: {
    readonly runID: RunID
    readonly deliveryID: Orchestration.DeliveryID
    readonly options: Orchestration.IntegrationOptions
  }) => Effect.Effect<Orchestration.Integration, NotFoundError>
  readonly recordIntegrationStep: (input: {
    readonly runID: RunID
    readonly integrationID: Orchestration.IntegrationID
    readonly step: Orchestration.IntegrationStep
  }) => Effect.Effect<void, NotFoundError>
  readonly finishIntegration: (input: {
    readonly runID: RunID
    readonly integrationID: Orchestration.IntegrationID
    readonly status: "completed" | "failed"
  }) => Effect.Effect<void, NotFoundError>
  readonly resumeIntegration: (input: {
    readonly runID: RunID
    readonly integrationID: Orchestration.IntegrationID
  }) => Effect.Effect<void, NotFoundError>
  readonly startFollowUp: (input: {
    readonly runID: RunID
    readonly turnID?: Orchestration.TurnID
    readonly objective: string
    readonly context?: string
    readonly baseHead: string
  }) => Effect.Effect<Orchestration.FollowUp, NotFoundError>
  readonly queueFollowUp: (input: {
    readonly runID: RunID
    readonly objective: string
    readonly context?: string
  }) => Effect.Effect<Orchestration.QueuedFollowUp, NotFoundError>
  readonly dequeueFollowUp: (input: {
    readonly runID: RunID
    readonly turnID: Orchestration.TurnID
  }) => Effect.Effect<void, NotFoundError>
  readonly steerFollowUp: (input: {
    readonly runID: RunID
    readonly turnID: Orchestration.TurnID
  }) => Effect.Effect<void, NotFoundError | InvalidPlanError>
  readonly setRunStatus: (input: {
    readonly runID: RunID
    readonly status: Orchestration.RunStatus
    readonly retryAt?: DateTime.Utc
  }) => Effect.Effect<void, NotFoundError>
  readonly setRunSource: (input: {
    readonly runID: RunID
    readonly source: Location.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly setRunWorkspace: (input: {
    readonly runID: RunID
    readonly workspace: Orchestration.RunWorkspace
  }) => Effect.Effect<void, NotFoundError>
  readonly linkRunSession: (input: {
    readonly runID: RunID
    readonly sessionID: NonNullable<Orchestration.Run["sessionID"]>
  }) => Effect.Effect<void, NotFoundError>
  readonly openHumanRequest: (input: {
    readonly runID: RunID
    readonly taskID?: TaskID
    readonly kind: Orchestration.HumanRequest["kind"]
    readonly prompt: string
    readonly choices?: ReadonlyArray<string>
    readonly assumption?: string
  }) => Effect.Effect<Orchestration.HumanRequest, NotFoundError>
  readonly answerHumanRequest: (input: {
    readonly runID: RunID
    readonly requestID: Orchestration.HumanRequestID
    readonly answer: string
  }) => Effect.Effect<void, NotFoundError | HumanRequestError>
  readonly recordReassignment: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly afterAttemptID: AttemptID
    readonly options: ReadonlyArray<Orchestration.ReassignmentOption>
    readonly selected: Orchestration.ReassignmentOption
    readonly chooser: Orchestration.Reassignment["chooser"]
    readonly request?: Orchestration.Reassignment["request"]
    readonly result?: Orchestration.Reassignment["result"]
  }) => Effect.Effect<Orchestration.Reassignment, NotFoundError>
  readonly addTask: (input: {
    readonly id?: TaskID
    readonly runID: RunID
    readonly kind?: Orchestration.Task["kind"]
    readonly title: string
    readonly description?: string
    readonly routeProfile?: string
    readonly capabilityTier?: Orchestration.CapabilityTier
    readonly checks?: ReadonlyArray<Orchestration.Check>
    readonly acceptanceCriteria?: ReadonlyArray<Orchestration.AcceptanceCriterion>
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
  }) => Effect.Effect<void, NotFoundError | InvalidDependencyError>
  readonly createAttempt: (input: {
    readonly id?: AttemptID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly candidate?: Orchestration.Candidate
    readonly kind?: Orchestration.Attempt["kind"]
    readonly sessionID?: (typeof Orchestration.Attempt.Type)["sessionID"]
    readonly location?: (typeof Orchestration.Attempt.Type)["location"]
  }) => Effect.Effect<Orchestration.Attempt, NotFoundError>
  readonly recordAttemptVerdict: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly verdict: Orchestration.AttemptVerdict
  }) => Effect.Effect<void, NotFoundError>
  readonly recordAttemptFeedback: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly feedback: Orchestration.AttemptFeedback
  }) => Effect.Effect<void, NotFoundError>
  readonly setAttemptStatus: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly status: Orchestration.AttemptStatus
    readonly completed?: DateTime.Utc
  }) => Effect.Effect<void, NotFoundError>
  readonly prepareAttempt: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly sessionID?: (typeof Orchestration.Attempt.Type)["sessionID"]
    readonly location: NonNullable<(typeof Orchestration.Attempt.Type)["location"]>
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
  readonly recordReview: (input: {
    readonly id?: Orchestration.ReviewID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly decision: Orchestration.ReviewDecision
    readonly note?: string
  }) => Effect.Effect<Orchestration.Review, NotFoundError>
  readonly recordTriageLabel: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly decision: Orchestration.TriageDecision
    readonly note?: string
  }) => Effect.Effect<Orchestration.TriageLabel, NotFoundError | TriageLabelError>
  readonly recordJudgment: (input: {
    readonly id?: Orchestration.JudgmentID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly attemptID: AttemptID
    readonly mode: "shadow"
    readonly request: Orchestration.Judgment["request"]
    readonly result: Orchestration.Judgment["result"]
  }) => Effect.Effect<Orchestration.Judgment, NotFoundError>
  readonly recordTierRecommendation: (input: {
    readonly id?: Orchestration.TierRecommendationID
    readonly runID: RunID
    readonly taskID: TaskID
    readonly routeDecisionID: Orchestration.RouteDecisionID
    readonly explicitTier?: Orchestration.CapabilityTier
    readonly request: Orchestration.TierRecommendation["request"]
    readonly result: Orchestration.TierRecommendation["result"]
  }) => Effect.Effect<Orchestration.TierRecommendation, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Orchestration") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const projectDirectories = yield* ProjectDirectories.Service

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
        plans: db
          .select()
          .from(OrchestrationPlanTable)
          .where(eq(OrchestrationPlanTable.run_id, runID))
          .orderBy(asc(OrchestrationPlanTable.time_created), asc(OrchestrationPlanTable.id))
          .all()
          .pipe(Effect.orDie),
        deliveries: db
          .select()
          .from(OrchestrationDeliveryTable)
          .where(eq(OrchestrationDeliveryTable.run_id, runID))
          .orderBy(asc(OrchestrationDeliveryTable.time_created), asc(OrchestrationDeliveryTable.id))
          .all()
          .pipe(Effect.orDie),
        integrations: db
          .select()
          .from(OrchestrationIntegrationTable)
          .where(eq(OrchestrationIntegrationTable.run_id, runID))
          .orderBy(asc(OrchestrationIntegrationTable.time_created), asc(OrchestrationIntegrationTable.id))
          .all()
          .pipe(Effect.orDie),
        followUps: db
          .select()
          .from(OrchestrationFollowUpTable)
          .where(eq(OrchestrationFollowUpTable.run_id, runID))
          .orderBy(asc(OrchestrationFollowUpTable.time_created), asc(OrchestrationFollowUpTable.id))
          .all()
          .pipe(Effect.orDie),
        queuedFollowUps: db
          .select()
          .from(OrchestrationQueuedFollowUpTable)
          .where(eq(OrchestrationQueuedFollowUpTable.run_id, runID))
          .orderBy(asc(OrchestrationQueuedFollowUpTable.time_created), asc(OrchestrationQueuedFollowUpTable.id))
          .all()
          .pipe(Effect.orDie),
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
        judgments: db
          .select()
          .from(OrchestrationJudgmentTable)
          .where(eq(OrchestrationJudgmentTable.run_id, runID))
          .orderBy(asc(OrchestrationJudgmentTable.time_created), asc(OrchestrationJudgmentTable.id))
          .all()
          .pipe(Effect.orDie),
        tierRecommendations: db
          .select()
          .from(OrchestrationTierRecommendationTable)
          .where(eq(OrchestrationTierRecommendationTable.run_id, runID))
          .orderBy(asc(OrchestrationTierRecommendationTable.time_created), asc(OrchestrationTierRecommendationTable.id))
          .all()
          .pipe(Effect.orDie),
        reviews: db
          .select()
          .from(OrchestrationReviewTable)
          .where(eq(OrchestrationReviewTable.run_id, runID))
          .orderBy(asc(OrchestrationReviewTable.time_created), asc(OrchestrationReviewTable.id))
          .all()
          .pipe(Effect.orDie),
        triageLabels: db
          .select()
          .from(OrchestrationTriageLabelTable)
          .where(eq(OrchestrationTriageLabelTable.run_id, runID))
          .orderBy(asc(OrchestrationTriageLabelTable.time_created), asc(OrchestrationTriageLabelTable.id))
          .all()
          .pipe(Effect.orDie),
        humanRequests: db
          .select()
          .from(OrchestrationHumanRequestTable)
          .where(eq(OrchestrationHumanRequestTable.run_id, runID))
          .orderBy(asc(OrchestrationHumanRequestTable.time_created), asc(OrchestrationHumanRequestTable.id))
          .all()
          .pipe(Effect.orDie),
        reassignments: db
          .select()
          .from(OrchestrationReassignmentTable)
          .where(eq(OrchestrationReassignmentTable.run_id, runID))
          .orderBy(asc(OrchestrationReassignmentTable.time_created), asc(OrchestrationReassignmentTable.id))
          .all()
          .pipe(Effect.orDie),
      })
      return {
        run,
        plans: rows.plans.map((row) => ({
          id: row.id,
          runID: row.run_id,
          output: row.output,
          generation: row.generation
            ? Schema.decodeUnknownSync(Orchestration.PlanGeneration)(row.generation)
            : undefined,
          status: row.status,
          time: {
            created: DateTime.makeUnsafe(row.time_created),
            applied: row.time_applied === null ? undefined : DateTime.makeUnsafe(row.time_applied),
          },
        })),
        deliveries: rows.deliveries.map((row) => ({
          id: row.id,
          runID: row.run_id,
          planID: row.plan_id ?? undefined,
          baseHead: row.base_head,
          head: row.head,
          changedFiles: row.changed_files,
          review: row.review,
          summary: row.summary ?? undefined,
          commitMessage: row.commit_message ?? undefined,
          summaryGeneration: row.summary_generation
            ? Schema.decodeUnknownSync(Orchestration.PlanGeneration)(row.summary_generation)
            : undefined,
          time: {
            created: DateTime.makeUnsafe(row.time_created),
            delivered: row.time_delivered === null ? undefined : DateTime.makeUnsafe(row.time_delivered),
          },
        })),
        integrations: rows.integrations.map((row) => ({
          id: row.id,
          runID: row.run_id,
          deliveryID: row.delivery_id,
          options: row.options,
          status: row.status,
          steps: row.steps.map((step) => Schema.decodeUnknownSync(Orchestration.IntegrationStep)(step)),
          time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
        })),
        followUps: rows.followUps.map((row) => ({
          id: row.id,
          runID: row.run_id,
          objective: row.objective,
          context: row.context ?? undefined,
          baseHead: row.base_head,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        queuedFollowUps: rows.queuedFollowUps.map((row) => ({
          id: row.id,
          runID: row.run_id,
          objective: row.objective,
          context: row.context ?? undefined,
          status: row.status,
          time: DateTime.makeUnsafe(row.time_created),
          timeSteered: row.time_steered ? DateTime.makeUnsafe(row.time_steered) : undefined,
        })),
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
          resolution: decodeRouteResolution(row.resolution),
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
        judgments: rows.judgments.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id,
          mode: row.mode,
          request: row.request,
          result: row.result,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        tierRecommendations: rows.tierRecommendations.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          routeDecisionID: row.route_decision_id,
          explicitTier: row.explicit_tier ?? undefined,
          request: row.request,
          result: row.result,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        reviews: rows.reviews.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id,
          decision: row.decision,
          note: row.note ?? undefined,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        triageLabels: rows.triageLabels.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          attemptID: row.attempt_id,
          decision: row.decision,
          note: row.note ?? undefined,
          time: DateTime.makeUnsafe(row.time_created),
        })),
        humanRequests: rows.humanRequests.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id ?? undefined,
          kind: row.kind,
          prompt: row.prompt,
          choices: row.choices,
          assumption: row.assumption ?? undefined,
          status: row.status,
          answer: row.answer ?? undefined,
          time: {
            created: DateTime.makeUnsafe(row.time_created),
            answered: row.time_answered === null ? undefined : DateTime.makeUnsafe(row.time_answered),
          },
        })),
        reassignments: rows.reassignments.map((row) => ({
          id: row.id,
          runID: row.run_id,
          taskID: row.task_id,
          afterAttemptID: row.after_attempt_id,
          options: row.options,
          selected: row.selected,
          chooser: row.chooser,
          request: row.request ?? undefined,
          result: row.result ?? undefined,
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
      reviewPacket: Effect.fn("Orchestration.reviewPacket")(function* (input) {
        const detail = yield* get(input.runID)
        const task = detail.tasks.find((item) => item.id === input.taskID)
        if (!task) return yield* new NotFoundError({ resource: "task", id: input.taskID })
        const attempt = detail.attempts.findLast((item) => item.taskID === task.id)
        if (!attempt) return yield* new NotFoundError({ resource: "attempt", id: task.id })
        const { verdict: _verdict, feedback: _feedback, ...blindAttempt } = attempt
        return {
          run: detail.run,
          task,
          attempt: blindAttempt,
          routeDecision: detail.routeDecisions.findLast((item) => item.attemptID === attempt.id),
          evaluations: detail.evaluations.filter((item) => item.attemptID === attempt.id),
        }
      }),
      calibration: Effect.fn("Orchestration.calibration")(function* (input) {
        const rows = yield* Effect.all({
          judgments: db
            .select({
              request: OrchestrationJudgmentTable.request,
              result: OrchestrationJudgmentTable.result,
              attemptID: OrchestrationJudgmentTable.attempt_id,
            })
            .from(OrchestrationJudgmentTable)
            .innerJoin(OrchestrationRunTable, eq(OrchestrationJudgmentTable.run_id, OrchestrationRunTable.id))
            .where(eq(OrchestrationRunTable.project_id, input.projectID))
            .all()
            .pipe(Effect.orDie),
          triageLabels: db
            .select({
              attemptID: OrchestrationTriageLabelTable.attempt_id,
              decision: OrchestrationTriageLabelTable.decision,
            })
            .from(OrchestrationTriageLabelTable)
            .innerJoin(OrchestrationRunTable, eq(OrchestrationTriageLabelTable.run_id, OrchestrationRunTable.id))
            .where(eq(OrchestrationRunTable.project_id, input.projectID))
            .all()
            .pipe(Effect.orDie),
          tierRecommendations: db
            .select({
              explicitTier: OrchestrationTierRecommendationTable.explicit_tier,
              result: OrchestrationTierRecommendationTable.result,
            })
            .from(OrchestrationTierRecommendationTable)
            .innerJoin(OrchestrationRunTable, eq(OrchestrationTierRecommendationTable.run_id, OrchestrationRunTable.id))
            .where(eq(OrchestrationRunTable.project_id, input.projectID))
            .all()
            .pipe(Effect.orDie),
        })
        const judgments = rows.judgments.filter((row) => row.request.purpose === "attempt_review")
        const triageLabels = new Map(rows.triageLabels.map((row) => [row.attemptID, row.decision]))
        const labeled = judgments.filter(
          (row) =>
            row.result.status === "valid" &&
            (row.result.answer?.choice === "looks_ready" || row.result.answer?.choice === "needs_attention") &&
            triageLabels.has(row.attemptID),
        )
        const predictedReadyLabeledReady = labeled.filter(
          (row) => row.result.answer?.choice === "looks_ready" && triageLabels.get(row.attemptID) === "looks_ready",
        ).length
        const predictedReadyLabeledAttention = labeled.filter(
          (row) => row.result.answer?.choice === "looks_ready" && triageLabels.get(row.attemptID) === "needs_attention",
        ).length
        const predictedAttentionLabeledReady = labeled.filter(
          (row) => row.result.answer?.choice === "needs_attention" && triageLabels.get(row.attemptID) === "looks_ready",
        ).length
        const predictedAttentionLabeledAttention = labeled.filter(
          (row) =>
            row.result.answer?.choice === "needs_attention" && triageLabels.get(row.attemptID) === "needs_attention",
        ).length
        const latencies = judgments
          .filter((row) => !row.result.cached)
          .map((row) => row.result.latencyMs)
          .toSorted((a, b) => a - b)
        const measured = judgments.filter((row) => row.result.usage)
        const tierLabeled = rows.tierRecommendations.filter(
          (row) => row.explicitTier && row.result.status === "valid" && row.result.answer,
        )
        const tierLatencies = rows.tierRecommendations
          .filter((row) => !row.result.cached)
          .map((row) => row.result.latencyMs)
          .toSorted((a, b) => a - b)
        const tierMeasured = rows.tierRecommendations.filter((row) => row.result.usage)
        const reviewSamples = distinctPromotionSamples(
          judgments.map((row) => ({
            result: row.result,
            label: triageLabels.get(row.attemptID),
          })),
        )
        const tierSamples = distinctPromotionSamples(
          rows.tierRecommendations.map((row) => ({ result: row.result, label: row.explicitTier ?? undefined })),
        )
        const report = {
          total: judgments.length,
          valid: judgments.filter((row) => row.result.status === "valid").length,
          invalid: judgments.filter((row) => row.result.status === "invalid").length,
          unavailable: judgments.filter((row) => row.result.status === "unavailable").length,
          timedOut: judgments.filter((row) => row.result.status === "timed_out").length,
          labeled: labeled.length,
          agreement: predictedReadyLabeledReady + predictedAttentionLabeledAttention,
          confusion: {
            predictedReadyLabeledReady,
            predictedReadyLabeledAttention,
            predictedAttentionLabeledReady,
            predictedAttentionLabeledAttention,
          },
          latency: {
            calls: latencies.length,
            meanMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : undefined,
            p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
            p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
          },
          usage: {
            measuredCalls: measured.length,
            inputTokens: measured.reduce((sum, row) => sum + (row.result.usage?.inputTokens ?? 0), 0),
            outputTokens: measured.reduce((sum, row) => sum + (row.result.usage?.outputTokens ?? 0), 0),
            pricedCalls: measured.filter((row) => row.result.usage?.estimatedCostUsd !== undefined).length,
            estimatedCostUsd: measured.reduce((sum, row) => sum + (row.result.usage?.estimatedCostUsd ?? 0), 0),
          },
          tier: {
            total: rows.tierRecommendations.length,
            valid: rows.tierRecommendations.filter((row) => row.result.status === "valid").length,
            invalid: rows.tierRecommendations.filter((row) => row.result.status === "invalid").length,
            unavailable: rows.tierRecommendations.filter((row) => row.result.status === "unavailable").length,
            timedOut: rows.tierRecommendations.filter((row) => row.result.status === "timed_out").length,
            labeled: tierLabeled.length,
            agreement: tierLabeled.filter((row) => row.result.answer?.choice === row.explicitTier).length,
            latency: {
              calls: tierLatencies.length,
              meanMs: tierLatencies.length
                ? tierLatencies.reduce((sum, value) => sum + value, 0) / tierLatencies.length
                : undefined,
              p50Ms: tierLatencies[Math.ceil(tierLatencies.length * 0.5) - 1],
              p95Ms: tierLatencies[Math.ceil(tierLatencies.length * 0.95) - 1],
            },
            usage: {
              measuredCalls: tierMeasured.length,
              inputTokens: tierMeasured.reduce((sum, row) => sum + (row.result.usage?.inputTokens ?? 0), 0),
              outputTokens: tierMeasured.reduce((sum, row) => sum + (row.result.usage?.outputTokens ?? 0), 0),
              pricedCalls: tierMeasured.filter((row) => row.result.usage?.estimatedCostUsd !== undefined).length,
              estimatedCostUsd: tierMeasured.reduce((sum, row) => sum + (row.result.usage?.estimatedCostUsd ?? 0), 0),
            },
          },
        }
        return {
          ...report,
          promotion: {
            attemptReview: assessPromotion(reviewSamples, report.latency.p95Ms),
            tier: assessPromotion(tierSamples, report.tier.latency.p95Ms),
          },
        }
      }),
      get,
      events: (input) =>
        Stream.unwrap(
          getRun(input.runID).pipe(Effect.as(events.durable({ aggregateID: input.runID, after: input.after }))),
        ).pipe(Stream.filter(Schema.is(Orchestration.Events))),
      history: Effect.fn("Orchestration.history")(function* (input) {
        yield* getRun(input.runID)
        return yield* EventV2.readAggregate(db, {
          aggregateID: input.runID,
          after: input.after,
          limit: input.limit,
          manifest: OrchestrationDurable,
        })
      }),
      create: Effect.fn("Orchestration.create")(function* (input) {
        const runID = input.id ?? Orchestration.RunID.create()
        if (input.project) {
          yield* db
            .insert(ProjectTable)
            .values({
              id: input.projectID,
              worktree: input.project.directory,
              vcs: input.project.vcs?.type,
              sandboxes: [],
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          if (input.projectID !== ProjectV2.ID.global)
            yield* projectDirectories.create({ projectID: input.projectID, directory: input.project.directory })
        }
        yield* events.publish(Orchestration.RunCreated, {
          runID,
          projectID: input.projectID,
          objective: input.objective,
          context: input.context,
          policy: input.policy,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(runID).pipe(Effect.orDie)).run
      }),
      proposePlan: Effect.fn("Orchestration.proposePlan")(function* (input) {
        const detail = yield* get(input.runID)
        if (!canPlan(detail))
          return yield* new InvalidPlanError({ message: "This run is not ready for a plan proposal" })
        const error = OrchestrationPlanner.validate(input.output)
        if (error) return yield* new InvalidPlanError({ message: error })
        const cancellation = validatePlanCancellation(detail, input.output.cancelTaskIDs ?? [])
        if (cancellation) return yield* new InvalidPlanError({ message: cancellation })
        const existing = new Set(
          detail.plans.filter((plan) => plan.status === "applied").flatMap((plan) => plan.output.tasks.map((task) => task.key)),
        )
        if (input.output.tasks.some((task) => existing.has(task.key)))
          return yield* new InvalidPlanError({ message: "Supplemental task keys must be new" })
        const id = Orchestration.PlanID.create()
        yield* events.publish(Orchestration.PlanProposed, {
          runID: input.runID,
          planID: id,
          output: input.output,
          generation: input.generation,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).plans.find((plan) => plan.id === id)!
      }),
      applyPlan: Effect.fn("Orchestration.applyPlan")(function* (input) {
        const detail = yield* get(input.runID)
        if (!canPlan(detail))
          return yield* new InvalidPlanError({ message: "This run is not ready to apply a plan" })
        const plan = detail.plans.find((item) => item.id === input.planID)
        if (!plan || plan.status !== "proposed")
          return yield* new InvalidPlanError({ message: "Plan proposal was not found in this run" })
        const error = OrchestrationPlanner.validate(plan.output)
        if (error) return yield* new InvalidPlanError({ message: error })
        const cancellation = validatePlanCancellation(detail, plan.output.cancelTaskIDs ?? [])
        if (cancellation) return yield* new InvalidPlanError({ message: cancellation })
        const existing = new Set(
          detail.plans.filter((item) => item.status === "applied").flatMap((item) => item.output.tasks.map((task) => task.key)),
        )
        if (plan.output.tasks.some((task) => existing.has(task.key)))
          return yield* new InvalidPlanError({ message: "Supplemental task keys must be new" })
        yield* events.publish(Orchestration.PlanApplied, {
          runID: input.runID,
          planID: input.planID,
          cancelTaskIDs: plan.output.cancelTaskIDs ?? [],
          tasks: plan.output.tasks.map((task) => ({ key: task.key, taskID: Orchestration.TaskID.create() })),
          timestamp: yield* DateTime.now,
        })
        return yield* get(input.runID)
      }),
      recordDeliveryReview: Effect.fn("Orchestration.recordDeliveryReview")(function* (input) {
        yield* getRun(input.runID)
        const deliveryID = Orchestration.DeliveryID.create()
        yield* events.publish(Orchestration.DeliveryReviewed, {
          ...input,
          deliveryID,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).deliveries.find((delivery) => delivery.id === deliveryID)!
      }),
      summarizeDelivery: Effect.fn("Orchestration.summarizeDelivery")(function* (input) {
        const detail = yield* get(input.runID)
        if (!detail.deliveries.some((delivery) => delivery.id === input.deliveryID))
          return yield* new NotFoundError({ resource: "delivery", id: input.deliveryID })
        yield* events.publish(Orchestration.DeliverySummarized, {
          ...input,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).deliveries.find((delivery) => delivery.id === input.deliveryID)!
      }),
      startIntegration: Effect.fn("Orchestration.startIntegration")(function* (input) {
        const detail = yield* get(input.runID)
        if (!detail.deliveries.some((delivery) => delivery.id === input.deliveryID))
          return yield* new NotFoundError({ resource: "delivery", id: input.deliveryID })
        const integrationID = Orchestration.IntegrationID.create()
        yield* events.publish(Orchestration.IntegrationStarted, {
          ...input,
          integrationID,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).integrations.find((item) => item.id === integrationID)!
      }),
      recordIntegrationStep: Effect.fn("Orchestration.recordIntegrationStep")(function* (input) {
        const detail = yield* get(input.runID)
        if (!detail.integrations.some((item) => item.id === input.integrationID))
          return yield* new NotFoundError({ resource: "integration", id: input.integrationID })
        yield* events.publish(Orchestration.IntegrationStepRecorded, { ...input, timestamp: yield* DateTime.now })
      }),
      finishIntegration: Effect.fn("Orchestration.finishIntegration")(function* (input) {
        const detail = yield* get(input.runID)
        if (!detail.integrations.some((item) => item.id === input.integrationID))
          return yield* new NotFoundError({ resource: "integration", id: input.integrationID })
        yield* events.publish(Orchestration.IntegrationFinished, { ...input, timestamp: yield* DateTime.now })
      }),
      resumeIntegration: Effect.fn("Orchestration.resumeIntegration")(function* (input) {
        const detail = yield* get(input.runID)
        if (!detail.integrations.some((item) => item.id === input.integrationID))
          return yield* new NotFoundError({ resource: "integration", id: input.integrationID })
        yield* events.publish(Orchestration.IntegrationResumed, { ...input, timestamp: yield* DateTime.now })
      }),
      startFollowUp: Effect.fn("Orchestration.startFollowUp")(function* (input) {
        yield* getRun(input.runID)
        const turnID = input.turnID ?? Orchestration.TurnID.create()
        yield* events.publish(Orchestration.FollowUpStarted, { ...input, turnID, timestamp: yield* DateTime.now })
        return (yield* get(input.runID)).followUps.find((item) => item.id === turnID)!
      }),
      queueFollowUp: Effect.fn("Orchestration.queueFollowUp")(function* (input) {
        yield* getRun(input.runID)
        const turnID = Orchestration.TurnID.create()
        yield* events.publish(Orchestration.FollowUpQueued, { ...input, turnID, timestamp: yield* DateTime.now })
        return (yield* get(input.runID)).queuedFollowUps.find((item) => item.id === turnID)!
      }),
      dequeueFollowUp: Effect.fn("Orchestration.dequeueFollowUp")(function* (input) {
        yield* getRun(input.runID)
        yield* events.publish(Orchestration.FollowUpDequeued, { ...input, timestamp: yield* DateTime.now })
      }),
      steerFollowUp: Effect.fn("Orchestration.steerFollowUp")(function* (input) {
        const detail = yield* get(input.runID)
        const queued = detail.queuedFollowUps.find((item) => item.id === input.turnID)
        if (!queued) return yield* new NotFoundError({ resource: "queued follow-up", id: input.turnID })
        if (queued.status === "started") return yield* new InvalidPlanError({ message: "Follow-up already started" })
        if (queued.status === "steered") return
        yield* events.publish(Orchestration.FollowUpSteered, {
          runID: input.runID, turnID: input.turnID, timestamp: yield* DateTime.now,
        })
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
      setRunSource: Effect.fn("Orchestration.setRunSource")(function* (input) {
        yield* getRun(input.runID)
        yield* events.publish(Orchestration.RunSourceSet, {
          runID: input.runID,
          source: input.source,
          timestamp: yield* DateTime.now,
        })
      }),
      setRunWorkspace: Effect.fn("Orchestration.setRunWorkspace")(function* (input) {
        yield* getRun(input.runID)
        yield* events.publish(Orchestration.RunWorkspaceSet, {
          runID: input.runID,
          workspace: input.workspace,
          timestamp: yield* DateTime.now,
        })
      }),
      linkRunSession: Effect.fn("Orchestration.linkRunSession")(function* (input) {
        const run = yield* getRun(input.runID)
        if (run.session_id === input.sessionID) return
        if (run.session_id) return yield* Effect.die("Run is already linked to another Session")
        yield* events.publish(Orchestration.RunSessionLinked, { ...input, timestamp: yield* DateTime.now })
      }),
      openHumanRequest: Effect.fn("Orchestration.openHumanRequest")(function* (input) {
        yield* getRun(input.runID)
        if (input.taskID) yield* getTask(input.runID, input.taskID)
        const requestID = Orchestration.HumanRequestID.create()
        yield* events.publish(Orchestration.HumanRequested, {
          runID: input.runID,
          requestID,
          taskID: input.taskID,
          kind: input.kind,
          prompt: input.prompt,
          choices: input.choices ?? [],
          assumption: input.assumption,
          timestamp: yield* DateTime.now,
        })
        const detail = yield* get(input.runID)
        if (detail.run.sessionID)
          yield* events.publish(Question.Event.Asked, {
            id: Question.ID.make(`que_orch_${requestID}`),
            sessionID: detail.run.sessionID,
            tool: input.kind === "clarification" ? undefined : {
              messageID: detail.run.sessionID,
              callID: `orch-human-${input.kind}`,
            },
            questions: [{
              header: "Run question",
              question: input.prompt,
              options: (input.choices ?? []).map((choice) => ({ label: choice, description: choice })),
              custom: true,
            }],
          }, { location: detail.run.source })
        return detail.humanRequests.find((request) => request.id === requestID)!
      }),
      answerHumanRequest: Effect.fn("Orchestration.answerHumanRequest")(function* (input) {
        const request = yield* db
          .select()
          .from(OrchestrationHumanRequestTable)
          .where(eq(OrchestrationHumanRequestTable.id, input.requestID))
          .get()
          .pipe(Effect.orDie)
        if (!request || request.run_id !== input.runID)
          return yield* new NotFoundError({ resource: "request", id: input.requestID })
        if (request.status !== "open") return yield* new HumanRequestError({ message: "Request was already answered" })
        yield* events.publish(Orchestration.HumanRequestAnswered, {
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
          timestamp: yield* DateTime.now,
        })
        const run = (yield* get(input.runID)).run
        if (run.sessionID)
          yield* events.publish(Question.Event.Replied, {
            sessionID: run.sessionID,
            requestID: Question.ID.make(`que_orch_${input.requestID}`),
            answers: [[input.answer]],
          }, { location: run.source })
      }),
      recordReassignment: Effect.fn("Orchestration.recordReassignment")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.afterAttemptID)
        if (attempt.task_id !== input.taskID)
          return yield* new NotFoundError({ resource: "attempt", id: input.afterAttemptID })
        const reassignmentID = Orchestration.ReassignmentID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.ReassignmentRecorded, {
          ...input,
          reassignmentID,
          timestamp: time,
        })
        return {
          id: reassignmentID,
          ...input,
          time,
        }
      }),
      addTask: Effect.fn("Orchestration.addTask")(function* (input) {
        yield* getRun(input.runID)
        const taskID = input.id ?? Orchestration.TaskID.create()
        yield* events.publish(Orchestration.TaskAdded, {
          runID: input.runID,
          taskID,
          kind: input.kind,
          title: input.title,
          description: input.description,
          routeProfile: input.routeProfile,
          capabilityTier: input.capabilityTier,
          checks: input.checks,
          acceptanceCriteria: input.acceptanceCriteria,
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
        if (input.taskID === input.dependsOnTaskID) yield* new InvalidDependencyError({ reason: "self" })
        if (createsDependencyCycle((yield* get(input.runID)).dependencies, input.taskID, input.dependsOnTaskID))
          yield* new InvalidDependencyError({ reason: "cycle" })
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
          kind: input.kind,
          sessionID: input.sessionID,
          location: input.location,
          timestamp: yield* DateTime.now,
        })
        return (yield* get(input.runID)).attempts.find((attempt) => attempt.id === attemptID)!
      }),
      recordAttemptVerdict: Effect.fn("Orchestration.recordAttemptVerdict")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID)
          return yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        yield* events.publish(Orchestration.AttemptVerdictRecorded, {
          ...input,
          timestamp: yield* DateTime.now,
        })
      }),
      recordAttemptFeedback: Effect.fn("Orchestration.recordAttemptFeedback")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID)
          return yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        yield* events.publish(Orchestration.AttemptFeedbackRecorded, {
          ...input,
          timestamp: yield* DateTime.now,
        })
      }),
      setAttemptStatus: Effect.fn("Orchestration.setAttemptStatus")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        yield* events.publish(Orchestration.AttemptStatusChanged, {
          ...input,
          timestamp: yield* DateTime.now,
        })
      }),
      prepareAttempt: Effect.fn("Orchestration.prepareAttempt")(function* (input) {
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        yield* events.publish(Orchestration.AttemptPrepared, {
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
      recordReview: Effect.fn("Orchestration.recordReview")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        const id = input.id ?? Orchestration.ReviewID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.ReviewRecorded, {
          reviewID: id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          decision: input.decision,
          note: input.note,
          timestamp: time,
        })
        return { ...input, id, time }
      }),
      recordTriageLabel: Effect.fn("Orchestration.recordTriageLabel")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        if (!["succeeded", "failed", "interrupted", "abandoned"].includes(attempt.status))
          return yield* new TriageLabelError({ reason: "not_ready" })
        const existing = yield* db
          .select({ id: OrchestrationTriageLabelTable.id })
          .from(OrchestrationTriageLabelTable)
          .where(eq(OrchestrationTriageLabelTable.attempt_id, input.attemptID))
          .get()
          .pipe(Effect.orDie)
        if (existing) return yield* new TriageLabelError({ reason: "already_labeled" })
        const id = Orchestration.TriageLabelID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.TriageLabeled, {
          labelID: id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          decision: input.decision,
          note: input.note,
          timestamp: time,
        })
        return { ...input, id, time }
      }),
      recordJudgment: Effect.fn("Orchestration.recordJudgment")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const attempt = yield* getAttempt(input.runID, input.attemptID)
        if (attempt.task_id !== input.taskID) yield* new NotFoundError({ resource: "attempt", id: input.attemptID })
        const id = input.id ?? Orchestration.JudgmentID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.JudgmentRecorded, {
          judgmentID: id,
          runID: input.runID,
          taskID: input.taskID,
          attemptID: input.attemptID,
          mode: input.mode,
          request: input.request,
          result: input.result,
          timestamp: time,
        })
        return { ...input, id, time }
      }),
      recordTierRecommendation: Effect.fn("Orchestration.recordTierRecommendation")(function* (input) {
        yield* getTask(input.runID, input.taskID)
        const decision = yield* db
          .select()
          .from(OrchestrationRouteDecisionTable)
          .where(eq(OrchestrationRouteDecisionTable.id, input.routeDecisionID))
          .get()
          .pipe(Effect.orDie)
        if (!decision || decision.run_id !== input.runID || decision.task_id !== input.taskID)
          return yield* new NotFoundError({ resource: "task", id: input.taskID })
        const id = input.id ?? Orchestration.TierRecommendationID.create()
        const time = yield* DateTime.now
        yield* events.publish(Orchestration.TierRecommendationRecorded, {
          recommendationID: id,
          runID: input.runID,
          taskID: input.taskID,
          routeDecisionID: input.routeDecisionID,
          explicitTier: input.explicitTier,
          request: input.request,
          result: input.result,
          timestamp: time,
        })
        return { ...input, id, time }
      }),
    })

    return result
  }),
)

function canPlan(detail: Orchestration.Detail) {
  if (!detail.tasks.length) return ["draft", "clarifying"].includes(detail.run.status)
  const followUp = detail.followUps.at(-1)
  if (
    followUp &&
    ["draft", "clarifying"].includes(detail.run.status) &&
    !detail.plans.some(
      (plan) => plan.status === "applied" && DateTime.toEpochMillis(plan.time.created) > DateTime.toEpochMillis(followUp.time),
    )
  ) return true
  return (
    (["reviewing_delivery", "clarifying"].includes(detail.run.status) &&
      detail.deliveries.some((delivery) => delivery.review.decision === "gaps")) ||
    (["active", "clarifying"].includes(detail.run.status) && (
      detail.humanRequests.some((request) =>
        request.status === "answered" && request.time.answered &&
        (["replan", "grant-replan"].includes(request.answer ?? "") || request.answer?.startsWith("cannot:")) &&
        !detail.plans.some((plan) => plan.status === "applied" && plan.time.applied &&
          DateTime.toEpochMillis(plan.time.applied) > DateTime.toEpochMillis(request.time.answered!))) ||
      detail.queuedFollowUps.some((item) => item.status === "steered" && item.timeSteered &&
        !detail.plans.some((plan) => plan.status === "applied" && plan.time.applied &&
          DateTime.toEpochMillis(plan.time.applied) > DateTime.toEpochMillis(item.timeSteered!)))))
  )
}

function validatePlanCancellation(detail: Orchestration.Detail, ids: ReadonlyArray<Orchestration.TaskID>) {
  if (ids.length > 16 || new Set(ids).size !== ids.length) return "Cancellation list must contain at most 16 unique tasks"
  const selected = new Set(ids)
  const invalid = ids.find((id) => {
    const task = detail.tasks.find((item) => item.id === id)
    return !task || !["draft", "blocked", "ready", "suspended", "failed"].includes(task.status)
  })
  if (invalid) return `Task ${invalid} cannot be cancelled by a replan`
  if (detail.dependencies.some((dependency) => selected.has(dependency.dependsOnTaskID) && !selected.has(dependency.taskID)))
    return "A replan must also cancel every dependent of a cancelled task"
  if (detail.run.status === "active" && detail.tasks.some((task) => task.status === "failed" && !selected.has(task.id)))
    return "A replan must replace or cancel failed tasks"
}

function runFromRow(row: typeof OrchestrationRunTable.$inferSelect): Orchestration.Run {
  return {
    id: row.id,
    sessionID: row.session_id ?? undefined,
    projectID: row.project_id,
    objective: row.objective,
    context: row.context ?? undefined,
    status: row.status,
    policy: row.policy ?? undefined,
    workspace: row.workspace ?? undefined,
    retryAt: row.retry_at === null ? undefined : DateTime.makeUnsafe(row.retry_at),
    source: row.source_directory
      ? {
          directory: row.source_directory,
          workspaceID: row.source_workspace_id ? WorkspaceV2.ID.make(row.source_workspace_id) : undefined,
        }
      : undefined,
    time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
  }
}

function taskFromRow(row: typeof OrchestrationTaskTable.$inferSelect): Orchestration.Task {
  return {
    id: row.id,
    runID: row.run_id,
    kind: row.kind,
    title: row.title,
    description: row.description ?? undefined,
    routeProfile: row.route_profile ?? undefined,
    capabilityTier: row.capability_tier ?? undefined,
    checks: row.checks,
    acceptanceCriteria: row.acceptance_criteria,
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
    kind: row.kind,
    candidate: row.candidate ?? undefined,
    verdict: row.verdict ?? undefined,
    feedback: row.feedback ?? undefined,
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

function decodeRouteResolution(input: unknown) {
  const dateFields = new Set(["capacityCapturedAt", "capturedAt", "observedAt", "resetsAt", "retryAt"])
  const restore = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => restore(item))
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, restore(item, field)]))
    if (typeof value !== "string" || !key || !dateFields.has(key)) return value
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : value
  }
  return Schema.decodeUnknownSync(Orchestration.RouteResolution)(restore(input))
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, OrchestrationProjector.node, ProjectDirectories.node],
})

function createsDependencyCycle(
  dependencies: ReadonlyArray<Orchestration.Dependency>,
  taskID: TaskID,
  dependsOnTaskID: TaskID,
) {
  return reachesTask(dependencies, taskID, dependsOnTaskID, new Set())
}

function reachesTask(
  dependencies: ReadonlyArray<Orchestration.Dependency>,
  taskID: TaskID,
  current: TaskID,
  visited: ReadonlySet<TaskID>,
): boolean {
  if (current === taskID) return true
  if (visited.has(current)) return false
  const next = new Set(visited).add(current)
  return dependencies
    .filter((dependency) => dependency.taskID === current)
    .some((dependency) => reachesTask(dependencies, taskID, dependency.dependsOnTaskID, next))
}

function distinctPromotionSamples(rows: ReadonlyArray<{ result: Orchestration.Judgment["result"]; label?: string }>) {
  const groups = new Map<string, { results: Orchestration.Judgment["result"][]; labels: Set<string> }>()
  rows.forEach((row) => {
    const key = JSON.stringify([row.result.requestDigest, row.result.model])
    const group = groups.get(key) ?? { results: [], labels: new Set<string>() }
    group.results.push(row.result)
    if (row.label) group.labels.add(row.label)
    groups.set(key, group)
  })
  const samples = [...groups.values()].map((group) => {
    const answer = group.results[0]?.answer?.choice
    return {
      answer,
      labels: [...group.labels],
      valid:
        answer !== undefined &&
        group.results.every((result) => result.status === "valid" && result.answer?.choice === answer),
    }
  })
  const labeled = samples.filter((sample) => sample.valid && sample.labels.length === 1)
  return {
    total: samples.length,
    valid: samples.filter((sample) => sample.valid).length,
    labeled: labeled.length,
    agreement: labeled.filter((sample) => sample.answer === sample.labels[0]).length,
    labelConflicts: samples.filter((sample) => sample.labels.length > 1).length,
  }
}

function assessPromotion(samples: ReturnType<typeof distinctPromotionSamples>, p95Ms?: number) {
  const minimumLabeled = 100
  const minimumValidityPercent = 98
  const minimumAgreementPercent = 90
  const maximumP95Ms = 3_000
  const unmet: Orchestration.CalibrationGate["unmet"] = [
    ...(samples.labeled < minimumLabeled ? (["sample_size"] as const) : []),
    ...(samples.total === 0 || (samples.valid / samples.total) * 100 < minimumValidityPercent
      ? (["validity"] as const)
      : []),
    ...(samples.labeled === 0 || (samples.agreement / samples.labeled) * 100 < minimumAgreementPercent
      ? (["agreement"] as const)
      : []),
    ...(p95Ms === undefined || p95Ms > maximumP95Ms ? (["latency"] as const) : []),
    ...(samples.labelConflicts > 0 ? (["label_conflicts"] as const) : []),
  ]
  return {
    eligibleForPolicyReview: unmet.length === 0,
    unmet,
    uniqueRequests: samples.total,
    uniqueLabeled: samples.labeled,
    labelConflicts: samples.labelConflicts,
    minimumLabeled,
    minimumValidityPercent,
    minimumAgreementPercent,
    maximumP95Ms,
  }
}
