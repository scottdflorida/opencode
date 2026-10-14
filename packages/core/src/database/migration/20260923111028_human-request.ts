import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923111028_human-request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_human_request\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text,
          \`kind\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`choices\` text DEFAULT '[]' NOT NULL,
          \`status\` text NOT NULL,
          \`answer\` text,
          \`time_created\` integer NOT NULL,
          \`time_answered\` integer,
          CONSTRAINT \`fk_orchestration_human_request_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_human_request_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_human_request_run_status_idx\` ON \`orchestration_human_request\` (\`run_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
