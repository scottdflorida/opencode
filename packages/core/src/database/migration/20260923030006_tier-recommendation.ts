import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923030006_tier-recommendation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`orchestration_tier_recommendation\` (
          \`id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`route_decision_id\` text NOT NULL,
          \`explicit_tier\` text,
          \`request\` text NOT NULL,
          \`result\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_orchestration_tier_recommendation_run_id_orchestration_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`orchestration_run\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_tier_recommendation_task_id_orchestration_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`orchestration_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_orchestration_tier_recommendation_route_decision_id_orchestration_route_decision_id_fk\` FOREIGN KEY (\`route_decision_id\`) REFERENCES \`orchestration_route_decision\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`orchestration_tier_recommendation_decision_idx\` ON \`orchestration_tier_recommendation\` (\`route_decision_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`orchestration_tier_recommendation_task_created_idx\` ON \`orchestration_tier_recommendation\` (\`task_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
