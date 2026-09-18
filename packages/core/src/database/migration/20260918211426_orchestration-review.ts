import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918211426_orchestration-review",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_review\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`note\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_review_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_review_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_review_attempt_id_orchestration_attempt_id_fk\` FOREIGN KEY (\`attempt_id\`) REFERENCES \`orchestration_attempt\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`orchestration_task\` ADD \`checks\` text DEFAULT '[]' NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX \`orchestration_review_attempt_created_idx\` ON \`orchestration_review\` (\`attempt_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
