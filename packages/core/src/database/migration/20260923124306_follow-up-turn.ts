import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923124306_follow-up-turn",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_follow_up\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`context\` text,
          \`base_head\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_follow_up_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_follow_up_run_created_idx\` ON \`orchestration_follow_up\` (\`run_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
