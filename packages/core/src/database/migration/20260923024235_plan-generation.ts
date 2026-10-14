import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923024235_plan-generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_plan\` ADD \`generation\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
