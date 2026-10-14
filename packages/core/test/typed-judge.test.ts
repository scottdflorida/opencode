import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { TypedJudge } from "@opencode-ai/core/typed-judge"
import { TypedJudge as TypedJudgeSchema } from "@opencode-ai/schema/typed-judge"

const request: TypedJudgeSchema.ChoiceRequest = {
  purpose: "attempt_review",
  state: { task: "Add typed judgment", evaluations: [{ kind: "typecheck", status: "passed" }] },
  question: {
    instructions: "Does this attempt look ready for review?",
    criteria: {
      looks_ready: "The evidence supports routine review.",
      needs_attention: "The evidence needs closer inspection.",
    },
  },
  fallback: "needs_attention",
}

const json = (body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    ),
  )

const response = {
  model: "jev-1.13.0",
  answers: {
    decision: {
      type: "choice",
      choice: "looks_ready",
      confidence: 0.82,
      probabilities: { looks_ready: 0.91, needs_attention: 0.09 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 8 },
}

function config(mode: "off" | "shadow", priced = false) {
  return Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({
            orchestration: {
              judge: {
                mode,
                provider: "jev",
                timeout_ms: 1_000,
                input_cost_per_million_usd: priced ? 2 : undefined,
                output_cost_per_million_usd: priced ? 5 : undefined,
              },
            },
          }),
        }),
      ]),
  })
}

function provide(
  client: HttpClient.HttpClient,
  mode: "off" | "shadow" = "shadow",
  apiKey: string | null = "test",
  priced = false,
  dbPath = ":memory:",
) {
  return TypedJudge.layerWith({ apiKey }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Config.Service, config(mode, priced)),
        Layer.succeed(HttpClient.HttpClient, client),
        Database.layerFromPath(dbPath),
      ),
    ),
  )
}

describe("TypedJudge", () => {
  test("keeps network access disabled until shadow mode is explicit", async () => {
    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(
      Effect.provide(
        provide(
          HttpClient.make(() => Effect.die("unexpected request")),
          "off",
        ),
      ),
      Effect.runPromise,
    )

    expect(Option.isNone(result)).toBe(true)
  })

  test("sends a bounded Choice request and validates the typed response", async () => {
    const seen: Array<{ url: string; authorization?: string; body: unknown }> = []
    const client = HttpClient.make((incoming) => {
      if (incoming.body._tag !== "Uint8Array") return Effect.die("unexpected request body")
      seen.push({
        url: incoming.url,
        authorization: incoming.headers.authorization,
        body: JSON.parse(new TextDecoder().decode(incoming.body.body)),
      })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          incoming,
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    })

    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(Effect.provide(provide(client)), Effect.runPromise)

    expect(seen).toEqual([
      {
        url: "https://api.typesafe.ai/v1/systemone",
        authorization: "Bearer test",
        body: {
          model: "jev-latest",
          state: request.state,
          questions: {
            decision: {
              type: "choice",
              instructions: request.question.instructions,
              criteria: request.question.criteria,
            },
          },
        },
      },
    ])
    expect(Option.getOrThrow(result)).toMatchObject({
      status: "valid",
      provider: "jev",
      model: "jev-1.13.0",
      cached: false,
      answer: { choice: "looks_ready", confidence: 0.82 },
      usage: { inputTokens: 120, outputTokens: 8 },
    })
  })

  test("rejects a choice outside the controller supplied options", async () => {
    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(
      Effect.provide(
        provide(
          json({
            ...response,
            answers: {
              decision: {
                ...response.answers.decision,
                choice: "auto_merge",
                probabilities: { looks_ready: 0.1, needs_attention: 0.1, auto_merge: 0.8 },
              },
            },
          }),
        ),
      ),
      Effect.runPromise,
    )

    expect(Option.getOrThrow(result)).toMatchObject({ status: "invalid", errorCode: "invalid_choice" })
  })

  test("records an estimated cost when both token prices are configured", async () => {
    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(Effect.provide(provide(json(response), "shadow", "test", true)), Effect.runPromise)

    expect(Option.getOrThrow(result).usage?.estimatedCostUsd).toBe((120 * 2 + 8 * 5) / 1_000_000)
  })

  test("rejects an oversized provider response", async () => {
    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(Effect.provide(provide(json({ ...response, padding: "x".repeat(300 * 1024) }))), Effect.runPromise)

    expect(Option.getOrThrow(result)).toMatchObject({ status: "invalid", errorCode: "invalid_response" })
  })

  test("returns an auditable unavailable result when the key is missing", async () => {
    const result = await Effect.gen(function* () {
      return yield* (yield* TypedJudge.Service).choice(request)
    }).pipe(
      Effect.provide(
        provide(
          HttpClient.make(() => Effect.die("unexpected request")),
          "shadow",
          null,
        ),
      ),
      Effect.runPromise,
    )

    expect(Option.getOrThrow(result)).toMatchObject({ status: "unavailable", errorCode: "missing_api_key" })
  })

  test("reuses an identical valid judgment without another provider call", async () => {
    let calls = 0
    const client = HttpClient.make((incoming) => {
      calls++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          incoming,
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    })
    const results = await Effect.gen(function* () {
      const judge = yield* TypedJudge.Service
      return [yield* judge.choice(request), yield* judge.choice(request)]
    }).pipe(Effect.provide(provide(client)), Effect.runPromise)

    expect(calls).toBe(1)
    expect(Option.getOrThrow(results[0])).toMatchObject({ cached: false, usage: { inputTokens: 120 } })
    expect(Option.getOrThrow(results[1])).toMatchObject({ cached: true, latencyMs: 0, usage: undefined })
  })

  test("reuses a valid judgment after the judge service is recreated", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "typed-judge-cache-"))
    const database = path.join(directory, "judge.db")
    try {
      const first = await Effect.gen(function* () {
        return yield* (yield* TypedJudge.Service).choice(request)
      }).pipe(Effect.provide(provide(json(response), "shadow", "test", false, database)), Effect.runPromise)
      const second = await Effect.gen(function* () {
        return yield* (yield* TypedJudge.Service).choice(request)
      }).pipe(
        Effect.provide(
          provide(
            HttpClient.make(() => Effect.die("unexpected provider request")),
            "shadow",
            "test",
            false,
            database,
          ),
        ),
        Effect.runPromise,
      )
      expect(Option.getOrThrow(first)).toMatchObject({ cached: false, usage: { inputTokens: 120 } })
      expect(Option.getOrThrow(second)).toMatchObject({ cached: true, latencyMs: 0, usage: undefined })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
