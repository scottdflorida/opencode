import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923023046_orchestration-plan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_plan\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`output\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_applied\` integer,
          CONSTRAINT \`fk_orchestration_plan_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`orchestration_plan_run_created_idx\` ON \`orchestration_plan\` (\`run_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`orchestration_plan_applied_run_idx\` ON \`orchestration_plan\` (\`run_id\`) WHERE "orchestration_plan"."status" = 'applied';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
