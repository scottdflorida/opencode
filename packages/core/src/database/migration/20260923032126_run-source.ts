import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923032126_run-source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`source_directory\` text;`)
      yield* tx.run(`ALTER TABLE \`orchestration_run\` ADD \`source_workspace_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
