import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923120820_delivery-file-count",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_delivery\` ADD \`changed_files\` integer NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
