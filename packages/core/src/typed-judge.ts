export * as TypedJudge from "./typed-judge"

import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { TypedJudge as TypedJudgeSchema } from "@opencode-ai/schema/typed-judge"
import { eq } from "drizzle-orm"
import { Config } from "./config"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { collectBoundedResponseBody } from "./tool/http-body"
import { Hash } from "./util/hash"
import { TypedJudgeCacheTable } from "./typed-judge/sql"

const DEFAULT_BASE_URL = "https://api.typesafe.ai"
const DEFAULT_MODEL = "jev-latest"
const QUESTION_ID = "decision"
const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_CACHE_TTL_SECONDS = 86_400

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Entry = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.Json),
  Schema.Null,
])

const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Struct({
    [QUESTION_ID]: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.String,
      confidence: Probability,
      probabilities: Schema.Record(Schema.String, Probability),
    }),
  }),
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response))

const Request = Schema.Struct({
  model: Schema.String,
  state: Entry,
  questions: Schema.Struct({
    [QUESTION_ID]: Schema.Struct({
      type: Schema.Literal("choice"),
      instructions: Entry,
      criteria: Schema.Record(Schema.String, Entry),
    }),
  }),
})

export interface Interface {
  readonly choice: (
    input: TypedJudgeSchema.ChoiceRequest,
    options?: { readonly authoritative?: boolean },
  ) => Effect.Effect<Option.Option<TypedJudgeSchema.ChoiceResult>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TypedJudge") {}

export interface Options {
  readonly apiKey?: string | null
}

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const http = yield* HttpClient.HttpClient
      const { db } = yield* Database.Service

      const choice = Effect.fn("TypedJudge.choice")(function* (
        input: TypedJudgeSchema.ChoiceRequest,
        callOptions?: { readonly authoritative?: boolean },
      ) {
        const orchestration = Config.latest(yield* config.entries(), "orchestration")
        const settings = orchestration?.judge
        if (settings?.mode !== "shadow" && !callOptions?.authoritative) return Option.none()

        const model = settings?.model ?? DEFAULT_MODEL
        const baseURL = (settings?.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "")
        const requestDigest = digest(baseURL, model, input)
        const cached = yield* db
          .select()
          .from(TypedJudgeCacheTable)
          .where(eq(TypedJudgeCacheTable.request_digest, requestDigest))
          .get()
          .pipe(Effect.orDie)
        if (cached && cached.expires_at > Date.now())
          return Option.some({
            ...cached.result,
            cached: true,
            latencyMs: 0,
            usage: undefined,
          })

        const invalid = validateRequest(input, model, requestDigest)
        if (invalid) return Option.some(invalid)

        const apiKey =
          options.apiKey === undefined ? globalThis.process.env.TYPESAFE_API_KEY : (options.apiKey ?? undefined)
        if (!apiKey) return Option.some(failure("unavailable", model, requestDigest, 0, "missing_api_key"))

        const request = yield* HttpClientRequest.post(`${baseURL}/v1/systemone`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.schemaBodyJson(Request)({
            model,
            state: input.state,
            questions: {
              [QUESTION_ID]: {
                type: "choice",
                instructions: input.question.instructions,
                criteria: input.question.criteria,
              },
            },
          }),
          Effect.orDie,
        )
        const started = Date.now()
        const response = yield* HttpClient.filterStatusOk(http)
          .execute(request)
          .pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(settings?.timeout_ms ?? 10_000),
              orElse: () => Effect.fail("timed_out" as const),
            }),
            Effect.exit,
          )
        const latencyMs = Date.now() - started
        if (Exit.isFailure(response)) {
          const timedOut = response.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error === "timed_out",
          )
          return Option.some(
            failure(
              timedOut ? "timed_out" : "unavailable",
              model,
              requestDigest,
              latencyMs,
              timedOut ? "request_timeout" : "request_failed",
            ),
          )
        }

        const parsed = yield* collectBoundedResponseBody(
          response.value,
          MAX_RESPONSE_BYTES,
          () => new Error(`Jev response exceeded ${MAX_RESPONSE_BYTES} bytes`),
        ).pipe(
          Effect.flatMap((body) => decodeResponse(body.toString("utf8"))),
          Effect.exit,
        )
        if (Exit.isFailure(parsed))
          return Option.some(failure("invalid", model, requestDigest, latencyMs, "invalid_response"))

        const answer = parsed.value.answers[QUESTION_ID]
        if (!validAnswer(input, answer))
          return Option.some(failure("invalid", parsed.value.model, requestDigest, latencyMs, "invalid_choice"))

        const result: TypedJudgeSchema.ChoiceResult = {
          status: "valid",
          provider: "jev",
          model: parsed.value.model,
          requestDigest,
          cached: false,
          latencyMs,
          answer: {
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities: answer.probabilities,
          },
          usage: {
            inputTokens: parsed.value.usage.input_tokens,
            outputTokens: parsed.value.usage.output_tokens,
            estimatedCostUsd:
              settings?.input_cost_per_million_usd !== undefined && settings.output_cost_per_million_usd !== undefined
                ? (parsed.value.usage.input_tokens * settings.input_cost_per_million_usd +
                    parsed.value.usage.output_tokens * settings.output_cost_per_million_usd) /
                  1_000_000
                : undefined,
          },
        }
        const created = Date.now()
        yield* db
          .insert(TypedJudgeCacheTable)
          .values({
            request_digest: requestDigest,
            result,
            time_created: created,
            expires_at: created + (settings?.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1_000,
          })
          .onConflictDoUpdate({
            target: TypedJudgeCacheTable.request_digest,
            set: {
              result,
              time_created: created,
              expires_at: created + (settings?.cache_ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1_000,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return Option.some(result)
      })

      return Service.of({ choice })
    }),
  )

const layer = layerWith()

function digest(baseURL: string, model: string, input: TypedJudgeSchema.ChoiceRequest) {
  return Hash.sha256(JSON.stringify({ provider: "jev", baseURL, model, input }))
}

function validateRequest(input: TypedJudgeSchema.ChoiceRequest, model: string, requestDigest: string) {
  const choices = Object.keys(input.question.criteria)
  if (choices.length < 2) return failure("invalid", model, requestDigest, 0, "insufficient_choices")
  if (!choices.includes(input.fallback)) return failure("invalid", model, requestDigest, 0, "invalid_fallback")
  return undefined
}

function validAnswer(
  input: TypedJudgeSchema.ChoiceRequest,
  answer: { choice: string; probabilities: Record<string, number> },
) {
  const choices = Object.keys(input.question.criteria).toSorted()
  if (!choices.includes(answer.choice)) return false
  return choices.join("\n") === Object.keys(answer.probabilities).toSorted().join("\n")
}

function failure(
  status: "invalid" | "unavailable" | "timed_out",
  model: string,
  requestDigest: string,
  latencyMs: number,
  errorCode: string,
): TypedJudgeSchema.ChoiceResult {
  return {
    status,
    provider: "jev",
    model,
    requestDigest,
    cached: false,
    latencyMs,
    errorCode,
  }
}

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, Database.node, httpClient] })
