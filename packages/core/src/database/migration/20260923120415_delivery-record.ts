import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923120415_delivery-record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_delivery\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`plan_id\` text,
          \`base_head\` text NOT NULL,
          \`head\` text NOT NULL,
          \`review\` text NOT NULL,
          \`summary\` text,
          \`commit_message\` text,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer,
          CONSTRAINT \`fk_orchestration_delivery_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_delivery_plan_id_orchestration_plan_id_fk\` FOREIGN KEY (\`plan_id\`) REFERENCES \`orchestration_plan\`(\`id\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_delivery_run_created_idx\` ON \`orchestration_delivery\` (\`run_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
