import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923101757_triage-label",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_triage_label\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`note\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_triage_label_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_triage_label_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_triage_label_attempt_id_orchestration_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`orchestration_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`orchestration_triage_label_attempt_idx\` ON \`orchestration_triage_label\` (\`attempt_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
