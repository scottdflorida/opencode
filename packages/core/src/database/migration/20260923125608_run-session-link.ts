import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923125608_run-session-link",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`session_id\` text REFERENCES session(id);`)
    })
  },
} satisfies DatabaseMigration.Migration
