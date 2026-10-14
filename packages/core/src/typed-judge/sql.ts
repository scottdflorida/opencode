import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { TypedJudge } from "@opencode-ai/schema/typed-judge"

export const TypedJudgeCacheTable = sqliteTable("typed_judge_cache", {
  request_digest: text().primaryKey(),
  result: text({ mode: "json" }).$type<TypedJudge.ChoiceResult>().notNull(),
  time_created: integer().notNull(),
  expires_at: integer().notNull(),
})
