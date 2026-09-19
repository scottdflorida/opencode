export * as TypedJudge from "./typed-judge"

import { Schema } from "effect"
import { optional } from "./schema"

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Entry = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.Json),
  Schema.Null,
])

export const ChoiceQuestion = Schema.Struct({
  instructions: Entry,
  criteria: Schema.Record(Schema.String, Entry),
}).annotate({ identifier: "TypedJudge.ChoiceQuestion" })
export interface ChoiceQuestion extends Schema.Schema.Type<typeof ChoiceQuestion> {}

export const ChoiceRequest = Schema.Struct({
  purpose: Schema.String,
  state: Entry,
  question: ChoiceQuestion,
  fallback: Schema.String,
}).annotate({ identifier: "TypedJudge.ChoiceRequest" })
export interface ChoiceRequest extends Schema.Schema.Type<typeof ChoiceRequest> {}

export const ChoiceAnswer = Schema.Struct({
  choice: Schema.String,
  confidence: Probability,
  probabilities: Schema.Record(Schema.String, Probability),
}).annotate({ identifier: "TypedJudge.ChoiceAnswer" })
export interface ChoiceAnswer extends Schema.Schema.Type<typeof ChoiceAnswer> {}

export const Usage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
}).annotate({ identifier: "TypedJudge.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const ResultStatus = Schema.Literals(["valid", "invalid", "unavailable", "timed_out"])
export type ResultStatus = typeof ResultStatus.Type

export const ChoiceResult = Schema.Struct({
  status: ResultStatus,
  provider: Schema.String,
  model: Schema.String,
  requestDigest: Schema.String,
  cached: Schema.Boolean,
  latencyMs: NonNegativeInt,
  answer: ChoiceAnswer.pipe(optional),
  usage: Usage.pipe(optional),
  errorCode: Schema.String.pipe(optional),
}).annotate({ identifier: "TypedJudge.ChoiceResult" })
export interface ChoiceResult extends Schema.Schema.Type<typeof ChoiceResult> {}
