import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923155939_steered-follow-up",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_queued_follow_up\` ADD \`time_steered\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
