import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923115212_run-context-question-assumption",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_human_request\` ADD \`assumption\` text;`)
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`context\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
