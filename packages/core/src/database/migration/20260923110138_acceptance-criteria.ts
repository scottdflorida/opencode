import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923110138_acceptance-criteria",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_task\` ADD \`acceptance_criteria\` text DEFAULT '[]' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
