import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Schema } from "effect"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AbsolutePath } from "../schema"

export const OrchestrationRunTable = sqliteTable(
  "orchestration_run",
  {
    id: text().$type<Orchestration.RunID>().primaryKey(),
    session_id: text().$type<NonNullable<Orchestration.Run["sessionID"]>>().references(() => SessionTable.id, { onDelete: "set null" }),
    project_id: text()
      .$type<(typeof ProjectTable.$inferSelect)["id"]>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    context: text(),
    status: text().$type<Orchestration.RunStatus>().notNull(),
    policy: text({ mode: "json" }).$type<Orchestration.PolicySnapshot>(),
    workspace: text({ mode: "json" }).$type<Orchestration.RunWorkspace>(),
    retry_at: integer(),
    source_directory: text().$type<AbsolutePath>(),
    source_workspace_id: text(),
    ...Timestamps,
  },
  (table) => [
    index("orchestration_run_project_created_idx").on(table.project_id, table.time_created),
    index("orchestration_run_status_retry_idx").on(table.status, table.retry_at),
  ],
)

export const OrchestrationTaskTable = sqliteTable(
  "orchestration_task",
  {
    id: text().$type<Orchestration.TaskID>().primaryKey(),
    kind: text().$type<Orchestration.Task["kind"]>().notNull().default("agent"),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    route_profile: text(),
    capability_tier: text().$type<Orchestration.CapabilityTier>(),
    checks: text({ mode: "json" }).$type<ReadonlyArray<Orchestration.Check>>().notNull().default([]),
    acceptance_criteria: text({ mode: "json" })
      .$type<ReadonlyArray<Orchestration.AcceptanceCriterion>>()
      .notNull()
      .default([]),
    status: text().$type<Orchestration.TaskStatus>().notNull(),
    ...Timestamps,
  },
  (table) => [index("orchestration_task_run_status_idx").on(table.run_id, table.status)],
)

export const OrchestrationPlanTable = sqliteTable(
  "orchestration_plan",
  {
    id: text().$type<Orchestration.PlanID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    output: text({ mode: "json" }).$type<Orchestration.PlanOutput>().notNull(),
    generation: text({ mode: "json" }).$type<Schema.Codec.Encoded<typeof Orchestration.PlanGeneration>>(),
    status: text().$type<Orchestration.Plan["status"]>().notNull(),
    time_created: integer().notNull(),
    time_applied: integer(),
  },
  (table) => [index("orchestration_plan_run_created_idx").on(table.run_id, table.time_created)],
)

export const OrchestrationDeliveryTable = sqliteTable(
  "orchestration_delivery",
  {
    id: text().$type<Orchestration.DeliveryID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    plan_id: text().$type<Orchestration.PlanID>().references(() => OrchestrationPlanTable.id),
    base_head: text().notNull(),
    head: text().notNull(),
    changed_files: integer().notNull(),
    review: text({ mode: "json" }).$type<Orchestration.DeliveryReview>().notNull(),
    summary: text(),
    commit_message: text(),
    summary_generation: text({ mode: "json" }).$type<Schema.Codec.Encoded<typeof Orchestration.PlanGeneration>>(),
    time_created: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [index("orchestration_delivery_run_created_idx").on(table.run_id, table.time_created)],
)

export const OrchestrationIntegrationTable = sqliteTable(
  "orchestration_integration",
  {
    id: text().$type<Orchestration.IntegrationID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    delivery_id: text()
      .$type<Orchestration.DeliveryID>()
      .notNull()
      .references(() => OrchestrationDeliveryTable.id, { onDelete: "cascade" }),
    options: text({ mode: "json" }).$type<Orchestration.IntegrationOptions>().notNull(),
    status: text().$type<Orchestration.Integration["status"]>().notNull(),
    steps: text({ mode: "json" }).$type<ReadonlyArray<Schema.Codec.Encoded<typeof Orchestration.IntegrationStep>>>()
      .notNull()
      .default([]),
    ...Timestamps,
  },
  (table) => [index("orchestration_integration_run_created_idx").on(table.run_id, table.time_created)],
)

export const OrchestrationFollowUpTable = sqliteTable(
  "orchestration_follow_up",
  {
    id: text().$type<Orchestration.TurnID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    context: text(),
    base_head: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_follow_up_run_created_idx").on(table.run_id, table.time_created)],
)

export const OrchestrationQueuedFollowUpTable = sqliteTable(
  "orchestration_queued_follow_up",
  {
    id: text().$type<Orchestration.TurnID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    context: text(),
    status: text().$type<"queued" | "steered" | "started">().notNull(),
    time_created: integer().notNull(),
    time_steered: integer(),
  },
  (table) => [index("orchestration_queued_follow_up_run_created_idx").on(table.run_id, table.time_created)],
)

export const OrchestrationDependencyTable = sqliteTable(
  "orchestration_dependency",
  {
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    depends_on_task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.run_id, table.task_id, table.depends_on_task_id] }),
    index("orchestration_dependency_ready_idx").on(table.run_id, table.depends_on_task_id, table.task_id),
  ],
)

export const OrchestrationAttemptTable = sqliteTable(
  "orchestration_attempt",
  {
    id: text().$type<Orchestration.AttemptID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    status: text().$type<Orchestration.AttemptStatus>().notNull(),
    kind: text().$type<Orchestration.Attempt["kind"]>().notNull().default("initial"),
    candidate: text({ mode: "json" }).$type<Orchestration.Candidate>(),
    verdict: text({ mode: "json" }).$type<Orchestration.AttemptVerdict>(),
    feedback: text({ mode: "json" }).$type<Orchestration.AttemptFeedback>(),
    session_id: text()
      .$type<(typeof SessionTable.$inferSelect)["id"]>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    directory: text().$type<AbsolutePath>(),
    workspace_id: text(),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [
    index("orchestration_attempt_task_created_idx").on(table.task_id, table.time_created),
    index("orchestration_attempt_run_status_idx").on(table.run_id, table.status),
  ],
)

export const OrchestrationHumanRequestTable = sqliteTable(
  "orchestration_human_request",
  {
    id: text().$type<Orchestration.HumanRequestID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    kind: text().$type<Orchestration.HumanRequest["kind"]>().notNull(),
    prompt: text().notNull(),
    choices: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull().default([]),
    assumption: text(),
    status: text().$type<Orchestration.HumanRequest["status"]>().notNull(),
    answer: text(),
    time_created: integer().notNull(),
    time_answered: integer(),
  },
  (table) => [index("orchestration_human_request_run_status_idx").on(table.run_id, table.status)],
)

export const OrchestrationReassignmentTable = sqliteTable(
  "orchestration_reassignment",
  {
    id: text().$type<Orchestration.ReassignmentID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    after_attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .notNull()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "cascade" }),
    options: text({ mode: "json" }).$type<ReadonlyArray<Orchestration.ReassignmentOption>>().notNull(),
    selected: text({ mode: "json" }).$type<Orchestration.ReassignmentOption>().notNull(),
    chooser: text().$type<Orchestration.Reassignment["chooser"]>().notNull(),
    request: text({ mode: "json" }).$type<import("@opencode-ai/schema/typed-judge").ChoiceRequest>(),
    result: text({ mode: "json" }).$type<import("@opencode-ai/schema/typed-judge").ChoiceResult>(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_reassignment_task_created_idx").on(table.task_id, table.time_created)],
)

export const OrchestrationRouteDecisionTable = sqliteTable(
  "orchestration_route_decision",
  {
    id: text().$type<Orchestration.RouteDecisionID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "set null" }),
    resolution: text({ mode: "json" }).$type<Schema.Codec.Encoded<typeof Orchestration.RouteResolution>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_route_decision_task_created_idx").on(table.task_id, table.time_created)],
)

export const OrchestrationEvaluationTable = sqliteTable(
  "orchestration_evaluation",
  {
    id: text().$type<Orchestration.EvaluationID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .notNull()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    status: text().$type<Orchestration.EvaluationStatus>().notNull(),
    evidence: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_evaluation_attempt_created_idx").on(table.attempt_id, table.time_created)],
)

export const OrchestrationReviewTable = sqliteTable(
  "orchestration_review",
  {
    id: text().$type<Orchestration.ReviewID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .notNull()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "cascade" }),
    decision: text().$type<Orchestration.ReviewDecision>().notNull(),
    note: text(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_review_attempt_created_idx").on(table.attempt_id, table.time_created)],
)

export const OrchestrationTriageLabelTable = sqliteTable(
  "orchestration_triage_label",
  {
    id: text().$type<Orchestration.TriageLabelID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .notNull()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "cascade" }),
    decision: text().$type<Orchestration.TriageDecision>().notNull(),
    note: text(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("orchestration_triage_label_attempt_idx").on(table.attempt_id)],
)

export const OrchestrationJudgmentTable = sqliteTable(
  "orchestration_judgment",
  {
    id: text().$type<Orchestration.JudgmentID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Orchestration.AttemptID>()
      .notNull()
      .references(() => OrchestrationAttemptTable.id, { onDelete: "cascade" }),
    mode: text().$type<"shadow">().notNull(),
    request: text({ mode: "json" }).$type<Orchestration.Judgment["request"]>().notNull(),
    result: text({ mode: "json" }).$type<Orchestration.Judgment["result"]>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("orchestration_judgment_attempt_created_idx").on(table.attempt_id, table.time_created)],
)

export const OrchestrationTierRecommendationTable = sqliteTable(
  "orchestration_tier_recommendation",
  {
    id: text().$type<Orchestration.TierRecommendationID>().primaryKey(),
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Orchestration.TaskID>()
      .notNull()
      .references(() => OrchestrationTaskTable.id, { onDelete: "cascade" }),
    route_decision_id: text()
      .$type<Orchestration.RouteDecisionID>()
      .notNull()
      .references(() => OrchestrationRouteDecisionTable.id, { onDelete: "cascade" }),
    explicit_tier: text().$type<Orchestration.CapabilityTier>(),
    request: text({ mode: "json" }).$type<Orchestration.TierRecommendation["request"]>().notNull(),
    result: text({ mode: "json" }).$type<Orchestration.TierRecommendation["result"]>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("orchestration_tier_recommendation_decision_idx").on(table.route_decision_id),
    index("orchestration_tier_recommendation_task_created_idx").on(table.task_id, table.time_created),
  ],
)
