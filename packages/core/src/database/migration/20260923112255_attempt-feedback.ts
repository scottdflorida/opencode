import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923112255_attempt-feedback",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_attempt\` ADD \`feedback\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
