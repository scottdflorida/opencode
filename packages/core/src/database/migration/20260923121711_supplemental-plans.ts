import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923121711_supplemental-plans",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`orchestration_plan_applied_run_idx\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
