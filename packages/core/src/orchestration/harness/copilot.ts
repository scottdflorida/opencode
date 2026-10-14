export * as CopilotHarness from "./copilot"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AppProcess } from "../../process"
import { AbsolutePath } from "../../schema"
import { HarnessEnvironment } from "./environment"

const Event = Schema.Struct({
  type: Schema.String,
  data: Schema.Struct({
    content: Schema.String.pipe(Schema.optional),
    summary: Schema.String.pipe(Schema.optional),
    sessionId: Schema.String.pipe(Schema.optional),
    inputTokens: Schema.Int.pipe(Schema.optional),
    outputTokens: Schema.Int.pipe(Schema.optional),
  }).pipe(Schema.optional),
})
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

export const run = Effect.fn("CopilotHarness.run")(function* (input: {
  readonly process: AppProcess.Interface
  readonly candidate: Orchestration.HarnessCandidate
  readonly directory: AbsolutePath
  readonly prompt: string
}) {
  const version = yield* input.process.run(
    ChildProcess.make("copilot", ["--version"], {
      stdin: "ignore",
      env: HarnessEnvironment.make(),
      extendEnv: false,
    }),
    { timeout: "10 seconds", maxOutputBytes: 256, maxErrorBytes: 256 },
  )
  const started = Date.now()
  const result = yield* input.process.run(
    ChildProcess.make(
      "copilot",
      [
        "--experimental",
        "--sandbox",
        "--no-auto-update",
        "--no-ask-user",
        "--disable-builtin-mcps",
        "--no-remote",
        "--no-remote-export",
        "--allow-tool=write,shell,read",
        "--output-format=json",
        "--model", input.candidate.modelID,
        ...(input.candidate.effort ? ["--reasoning-effort", input.candidate.effort] : []),
        "-C", input.directory,
        "-p", input.prompt,
      ],
      { cwd: input.directory, stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false },
    ),
    { timeout: Duration.minutes(30), maxOutputBytes: 1024 * 1024, maxErrorBytes: 16 * 1024 },
  )
  const events = result.stdout.toString("utf8").split(/\r?\n/).flatMap((line) => {
    const decoded = decodeEvent(line)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
  const messages = events.filter((event) => event.type === "assistant.message" && event.data?.content)
  const terminal = events.findLast((event) => event.type === "session.idle" || event.type === "session.task_complete")
  const failed = events.some((event) => event.type === "session.error" || event.type === "error")
  const completed = result.exitCode === 0 && !result.stdoutTruncated && !failed && !!terminal
  return {
    kind: "harness:copilot",
    status: completed ? "passed" : "failed",
    transcript: messages.map((event) => event.data?.content).filter(Boolean).join("\n\n").slice(0, 24_000),
    evidence: {
      harness: "copilot",
      version: version.stdout.toString("utf8").trim(),
      model: input.candidate.modelID,
      effort: input.candidate.effort,
      sandbox: "enabled",
      toolPermissions: "write,shell,read",
      mcpServers: "builtin-disabled",
      sessionID: events.find((event) => event.type === "session.start")?.data?.sessionId,
      exitCode: result.exitCode,
      latencyMs: Date.now() - started,
      outputTruncated: result.stdoutTruncated,
      errorTruncated: result.stderrTruncated,
      error: completed ? undefined : result.stderr.toString("utf8").slice(0, 2_048) || "Copilot turn did not complete",
    },
  } as const
})
