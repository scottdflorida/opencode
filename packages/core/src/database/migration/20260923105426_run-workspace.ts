import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923105426_run-workspace",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`workspace\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
