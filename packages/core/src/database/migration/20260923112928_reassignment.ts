import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923112928_reassignment",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_reassignment\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`after_attempt_id\` text NOT NULL,
          \`options\` text NOT NULL,
          \`selected\` text NOT NULL,
          \`chooser\` text NOT NULL,
          \`request\` text,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_reassignment_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_reassignment_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_reassignment_after_attempt_id_orchestration_attempt_id_fk\` FOREIGN KEY (\`after_attempt_id\`) REFERENCES \`orchestration_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_reassignment_task_created_idx\` ON \`orchestration_reassignment\` (\`task_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
