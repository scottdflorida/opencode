export * as ClaudeHarness from "./claude"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AppProcess } from "../../process"
import { AbsolutePath } from "../../schema"
import { HarnessEnvironment } from "./environment"

const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  result: Schema.String.pipe(Schema.optional),
  session_id: Schema.String.pipe(Schema.optional),
  duration_ms: Schema.Int.pipe(Schema.optional),
  total_cost_usd: Schema.Number.pipe(Schema.optional),
  usage: Schema.Struct({
    input_tokens: Schema.Int.pipe(Schema.optional),
    output_tokens: Schema.Int.pipe(Schema.optional),
    cache_read_input_tokens: Schema.Int.pipe(Schema.optional),
  }).pipe(Schema.optional),
})
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

export function readResult(stdout: string) {
  const parsed = decodeResult(stdout)
  return Option.isSome(parsed) ? parsed.value : undefined
}

export const run = Effect.fn("ClaudeHarness.run")(function* (input: {
  readonly process: AppProcess.Interface
  readonly candidate: Orchestration.HarnessCandidate
  readonly directory: AbsolutePath
  readonly prompt: string
}) {
  const version = yield* input.process.run(
    ChildProcess.make("claude", ["--version"], {
      stdin: "ignore",
      env: HarnessEnvironment.make(),
      extendEnv: false,
    }),
    {
      timeout: "10 seconds",
      maxOutputBytes: 256,
      maxErrorBytes: 256,
    },
  )
  const command = ChildProcess.make(
    "claude",
    [
      "--print",
      "--output-format",
      "json",
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--model",
      input.candidate.modelID,
      ...(input.candidate.effort ? ["--effort", input.candidate.effort] : []),
    ],
    { cwd: input.directory, stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false },
  )
  const started = Date.now()
  const result = yield* input.process.run(command, {
    stdin: input.prompt,
    timeout: Duration.minutes(30),
    maxOutputBytes: 1024 * 1024,
    maxErrorBytes: 16 * 1024,
  })
  const parsed = readResult(result.stdout.toString("utf8"))
  const completed =
    result.exitCode === 0 && parsed?.type === "result" && parsed.subtype === "success" && !parsed.is_error
  return {
    kind: "harness:claude",
    status: completed ? "passed" : "failed",
    transcript: parsed?.result?.slice(0, 24_000) ?? "",
    evidence: {
      harness: "claude",
      version: version.stdout.toString("utf8").trim(),
      model: input.candidate.modelID,
      effort: input.candidate.effort,
      mode: "restricted",
      mcpServers: "disabled",
      permissionMode: "acceptEdits",
      sessionID: parsed?.session_id,
      exitCode: result.exitCode,
      latencyMs: Date.now() - started,
      providerDurationMs: parsed?.duration_ms,
      inputTokens: parsed?.usage?.input_tokens,
      cachedInputTokens: parsed?.usage?.cache_read_input_tokens,
      outputTokens: parsed?.usage?.output_tokens,
      reportedCostUsd: parsed?.total_cost_usd,
      outputTruncated: result.stdoutTruncated,
      errorTruncated: result.stderrTruncated,
      error: completed ? undefined : result.stderr.toString("utf8").slice(0, 2_048) || "Claude turn did not complete",
    },
  } as const
})
