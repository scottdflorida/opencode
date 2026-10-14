import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923122705_integration-record",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_integration\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`delivery_id\` text NOT NULL,
          \`options\` text NOT NULL,
          \`status\` text NOT NULL,
          \`steps\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_integration_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_integration_delivery_id_orchestration_delivery_id_fk\` FOREIGN KEY (\`delivery_id\`) REFERENCES \`orchestration_delivery\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_integration_run_created_idx\` ON \`orchestration_integration\` (\`run_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
