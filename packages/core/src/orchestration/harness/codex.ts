export * as CodexHarness from "./codex"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AppProcess } from "../../process"
import { AbsolutePath } from "../../schema"
import { HarnessEnvironment } from "./environment"

const maximumOutputBytes = 1024 * 1024
const maximumErrorBytes = 16 * 1024
const maximumFailureText = 2_048
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("thread.started"), thread_id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    usage: Schema.Struct({
      input_tokens: NonNegativeInt,
      cached_input_tokens: NonNegativeInt.pipe(Schema.optional),
      output_tokens: NonNegativeInt,
      reasoning_output_tokens: NonNegativeInt.pipe(Schema.optional),
    }),
  }),
])
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))
const FinalMessage = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({ type: Schema.Literal("agent_message"), text: Schema.String }),
})
const decodeFinalMessage = Schema.decodeUnknownOption(Schema.fromJsonString(FinalMessage))
const CommandMessage = Schema.Struct({
  type: Schema.Literal("item.completed"),
  item: Schema.Struct({
    type: Schema.Literal("command_execution"),
    command: Schema.String,
    aggregated_output: Schema.String,
    exit_code: Schema.Int,
  }),
})
const decodeCommandMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CommandMessage))
const FailedMessage = Schema.Struct({ type: Schema.Literal("error"), message: Schema.String })
const decodeFailedMessage = Schema.decodeUnknownOption(Schema.fromJsonString(FailedMessage))
const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(Orchestration.GeneratedPlanOutput))
export const SummaryOutput = Schema.Struct({ summary: Schema.String, commitMessage: Schema.String })
const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(SummaryOutput))
export const DecisionOutput = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ choice: Schema.String, confidence: Schema.Number })),
})
const decodeDecision = Schema.decodeUnknownOption(Schema.fromJsonString(DecisionOutput))

export function readEvents(stdout: string) {
  const events = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const decoded = decodeEvent(line)
      return Option.isSome(decoded) ? [decoded.value] : []
    })
  const usage = events.findLast((event) => event.type === "turn.completed")
  return {
    threadID: events.find((event) => event.type === "thread.started")?.thread_id,
    completed: usage?.type === "turn.completed",
    usage: usage?.type === "turn.completed" ? usage.usage : undefined,
  }
}

export const run = Effect.fn("CodexHarness.run")(function* (input: {
  readonly process: AppProcess.Interface
  readonly candidate: Orchestration.HarnessCandidate
  readonly directory: AbsolutePath
  readonly prompt: string
}) {
  const version = yield* input.process.run(
    ChildProcess.make("codex", ["--version"], {
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
    "codex",
    [
      "exec",
      "--json",
      "--ignore-user-config",
      "--approve-for-me",
      "-C",
      input.directory,
      "-m",
      input.candidate.modelID,
      ...(input.candidate.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(input.candidate.effort)}`] : []),
      "-",
    ],
    { cwd: input.directory, stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false },
  )
  const started = Date.now()
  const result = yield* input.process.run(command, {
    stdin: input.prompt,
    timeout: Duration.minutes(30),
    maxOutputBytes: maximumOutputBytes,
    maxErrorBytes: maximumErrorBytes,
  })
  const events = readEvents(result.stdout.toString("utf8"))
  const completed = result.exitCode === 0 && events.completed
  const transcript = result.stdout.toString("utf8").split(/\r?\n/).flatMap((line) => {
    const message = decodeFinalMessage(line)
    if (Option.isSome(message)) return [`Agent: ${message.value.item.text}`]
    const command = decodeCommandMessage(line)
    return Option.isSome(command)
      ? [`$ ${command.value.item.command}\nExit ${command.value.item.exit_code}\n${command.value.item.aggregated_output.slice(0, 4_000)}`]
      : []
  }).join("\n\n").slice(0, 24_000)
  return {
    kind: "harness:codex",
    status: completed ? "passed" : "failed",
    transcript,
    evidence: {
      harness: "codex",
      version: version.stdout.toString("utf8").trim(),
      model: input.candidate.modelID,
      effort: input.candidate.effort,
      sandbox: "workspace-write",
      approval: "auto-review",
      userConfig: "ignored",
      threadID: events.threadID,
      exitCode: result.exitCode,
      latencyMs: Date.now() - started,
      inputTokens: events.usage?.input_tokens,
      cachedInputTokens: events.usage?.cached_input_tokens,
      outputTokens: events.usage?.output_tokens,
      reasoningOutputTokens: events.usage?.reasoning_output_tokens,
      outputTruncated: result.stdoutTruncated,
      errorTruncated: result.stderrTruncated,
      error: completed
        ? undefined
        : result.stderr.toString("utf8").slice(0, maximumFailureText) || "Codex turn did not complete",
    },
  } as const
})

const structured = Effect.fn("CodexHarness.structured")(function* (input: {
  readonly process: AppProcess.Interface
  readonly candidate: Orchestration.HarnessCandidate
  readonly directory: AbsolutePath
  readonly prompt: string
  readonly schemaPath: AbsolutePath
}) {
  const started = Date.now()
  const result = yield* input.process.run(
    ChildProcess.make(
      "codex",
      [
        "exec",
        "--json",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "-C",
        input.directory,
        "-m",
        input.candidate.modelID,
        ...(input.candidate.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(input.candidate.effort)}`] : []),
        "--output-schema",
        input.schemaPath,
        "-",
      ],
      { cwd: input.directory, stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false },
    ),
    {
      stdin: input.prompt,
      timeout: Duration.minutes(5),
      maxOutputBytes: maximumOutputBytes,
      maxErrorBytes: maximumErrorBytes,
    },
  )
  const stdout = result.stdout.toString("utf8")
  const events = readEvents(stdout)
  const message = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const decoded = decodeFinalMessage(line)
      return Option.isSome(decoded) ? [decoded.value.item.text] : []
    })
    .at(-1)
  if (result.exitCode !== 0 || result.stdoutTruncated || !events.completed || !message) {
    const failure = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        const decoded = decodeFailedMessage(line)
        return Option.isSome(decoded) ? [decoded.value.message] : []
      })
      .at(-1)
    return yield* Effect.fail(
      new Error((failure ?? result.stderr.toString("utf8")).slice(0, 2_048) || "Codex did not return structured output"),
    )
  }
  return {
    message,
    usage: {
      inputTokens: events.usage?.input_tokens,
      outputTokens: events.usage?.output_tokens,
    },
    latencyMs: Date.now() - started,
    threadID: events.threadID,
  }
})

type StructuredInput = Parameters<typeof structured>[0]

export const plan = Effect.fn("CodexHarness.plan")(function* (input: StructuredInput) {
  const generated = yield* structured(input)
  const parsed = decodePlan(generated.message)
  if (Option.isNone(parsed)) return yield* Effect.fail(new Error("Codex did not return a valid structured plan"))
  return { ...generated, object: parsed.value }
})

export const summarize = Effect.fn("CodexHarness.summarize")(function* (input: StructuredInput) {
  const generated = yield* structured(input)
  const parsed = decodeSummary(generated.message)
  if (Option.isNone(parsed)) return yield* Effect.fail(new Error("Codex did not return a valid structured summary"))
  return { ...generated, object: parsed.value }
})

export const decide = Effect.fn("CodexHarness.decide")(function* (input: StructuredInput) {
  const generated = yield* structured(input)
  const parsed = decodeDecision(generated.message)
  if (Option.isNone(parsed)) return yield* Effect.fail(new Error("Codex did not return valid judge answers"))
  return { ...generated, object: parsed.value }
})
