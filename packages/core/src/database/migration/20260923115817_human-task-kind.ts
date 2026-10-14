import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923115817_human-task-kind",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_task\` ADD \`kind\` text DEFAULT 'agent' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
