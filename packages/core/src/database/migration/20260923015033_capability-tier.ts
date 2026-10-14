import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923015033_capability-tier",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_task\` ADD \`capability_tier\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
