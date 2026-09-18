import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AbsolutePath } from "../schema"

export const OrchestrationRunTable = sqliteTable(
  "orchestration_run",
  {
    id: text().$type<Orchestration.RunID>().primaryKey(),
    project_id: text()
      .$type<(typeof ProjectTable.$inferSelect)["id"]>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    status: text().$type<Orchestration.RunStatus>().notNull(),
    retry_at: integer(),
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
    run_id: text()
      .$type<Orchestration.RunID>()
      .notNull()
      .references(() => OrchestrationRunTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    route_profile: text(),
    checks: text({ mode: "json" }).$type<ReadonlyArray<Orchestration.Check>>().notNull().default([]),
    status: text().$type<Orchestration.TaskStatus>().notNull(),
    ...Timestamps,
  },
  (table) => [index("orchestration_task_run_status_idx").on(table.run_id, table.status)],
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
    candidate: text({ mode: "json" }).$type<Orchestration.Candidate>(),
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
    resolution: text({ mode: "json" }).$type<Orchestration.RouteResolution>().notNull(),
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
