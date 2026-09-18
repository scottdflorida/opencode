import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918190046_orchestration-control-plane",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_attempt\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`candidate\` text,
          \`session_id\` text,
          \`directory\` text,
          \`workspace_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_orchestration_attempt_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_attempt_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_attempt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orchestration_dependency\` (
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`depends_on_task_id\` text NOT NULL,
          CONSTRAINT \`orchestration_dependency_pk\` PRIMARY KEY(\`run_id\`, \`task_id\`, \`depends_on_task_id\`),
          CONSTRAINT \`fk_orchestration_dependency_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_dependency_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_dependency_depends_on_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`depends_on_task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orchestration_evaluation\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`evidence\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_evaluation_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_evaluation_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_evaluation_attempt_id_orchestration_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`orchestration_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orchestration_route_decision\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text,
          \`resolution\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_route_decision_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_route_decision_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_route_decision_attempt_id_orchestration_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`orchestration_attempt\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orchestration_run\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`retry_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_run_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orchestration_task\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`description\` text,
          \`route_profile\` text,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_task_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_attempt_task_created_idx\` ON \`orchestration_attempt\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_attempt_run_status_idx\` ON \`orchestration_attempt\` (\`run_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_dependency_ready_idx\` ON \`orchestration_dependency\` (\`run_id\`,\`depends_on_task_id\`,\`task_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_evaluation_attempt_created_idx\` ON \`orchestration_evaluation\` (\`attempt_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_route_decision_task_created_idx\` ON \`orchestration_route_decision\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_run_project_created_idx\` ON \`orchestration_run\` (\`project_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_run_status_retry_idx\` ON \`orchestration_run\` (\`status\`,\`retry_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_task_run_status_idx\` ON \`orchestration_task\` (\`run_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
