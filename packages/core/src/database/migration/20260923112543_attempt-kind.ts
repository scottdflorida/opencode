import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923112543_attempt-kind",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_attempt\` ADD \`kind\` text DEFAULT 'initial' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
