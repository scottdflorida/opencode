import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923104252_run-policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`policy\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
