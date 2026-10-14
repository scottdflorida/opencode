export * as CursorHarness from "./cursor"

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
  result: Schema.String,
  session_id: Schema.String.pipe(Schema.optional),
  duration_ms: Schema.Int.pipe(Schema.optional),
  request_id: Schema.String.pipe(Schema.optional),
})
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

export const run = Effect.fn("CursorHarness.run")(function* (input: {
  readonly process: AppProcess.Interface
  readonly candidate: Orchestration.HarnessCandidate
  readonly directory: AbsolutePath
  readonly prompt: string
}) {
  const version = yield* input.process.run(
    ChildProcess.make("cursor-agent", ["--version"], {
      stdin: "ignore",
      env: HarnessEnvironment.make(),
      extendEnv: false,
    }),
    { timeout: "10 seconds", maxOutputBytes: 256, maxErrorBytes: 256 },
  )
  const started = Date.now()
  const result = yield* input.process.run(
    ChildProcess.make(
      "cursor-agent",
      ["--print", "--force", "--sandbox", "enabled", "--output-format", "json", "--model", input.candidate.modelID, input.prompt],
      { cwd: input.directory, stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false },
    ),
    { timeout: Duration.minutes(30), maxOutputBytes: 1024 * 1024, maxErrorBytes: 16 * 1024 },
  )
  const decoded = decodeResult(result.stdout.toString("utf8"))
  const parsed = Option.getOrUndefined(decoded)
  const completed = result.exitCode === 0 && !result.stdoutTruncated && parsed?.subtype === "success" && !parsed.is_error
  return {
    kind: "harness:cursor",
    status: completed ? "passed" : "failed",
    transcript: parsed?.result.slice(0, 24_000) ?? "",
    evidence: {
      harness: "cursor",
      version: version.stdout.toString("utf8").trim(),
      model: input.candidate.modelID,
      effort: input.candidate.effort,
      sandbox: "enabled",
      sessionID: parsed?.session_id,
      requestID: parsed?.request_id,
      exitCode: result.exitCode,
      latencyMs: Date.now() - started,
      providerDurationMs: parsed?.duration_ms,
      outputTruncated: result.stdoutTruncated,
      errorTruncated: result.stderrTruncated,
      error: completed ? undefined : result.stderr.toString("utf8").slice(0, 2_048) || "Cursor turn did not complete",
    },
  } as const
})
