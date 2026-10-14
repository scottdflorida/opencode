import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923121356_delivery-summary-provenance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_delivery\` ADD \`summary_generation\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
