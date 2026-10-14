import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923025541_typed-judge-cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`typed_judge_cache\` (
          \`request_digest\` text PRIMARY KEY,
          \`result\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`expires_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
