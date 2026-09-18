export * as OrchestrationExecutor from "./executor"

import path from "path"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "../schema"
import { AppProcess } from "../process"
import { Git } from "../git"
import { Global } from "../global"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ProjectCopy } from "../project/copy"
import { SessionV2 } from "../session"
import { makeGlobalNode } from "../effect/app-node"

const maximumEvidenceBytes = 128 * 1024
const maximumPatchBytes = 512 * 1024

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("Orchestration.ExecutionError", {
  stage: Schema.Literals(["prepare", "model", "check", "workspace"]),
  message: Schema.String,
}) {}

export interface Prepared {
  readonly sessionID: SessionV2.ID
  readonly location: Location.Ref
}

export interface Evaluation {
  readonly kind: string
  readonly status: Orchestration.EvaluationStatus
  readonly evidence: Record<string, unknown>
}

export interface Interface {
  readonly prepare: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly attemptID: Orchestration.AttemptID
    readonly candidate: Orchestration.DirectCandidate
    readonly source: Location.Ref
  }) => Effect.Effect<Prepared, ExecutionError>
  readonly execute: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly prepared: Prepared
    readonly source: Location.Ref
  }) => Effect.Effect<ReadonlyArray<Evaluation>, ExecutionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationExecutor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const git = yield* Git.Service
    const locations = yield* LocationServiceMap.Service
    const process = yield* AppProcess.Service
    const sessions = yield* SessionV2.Service

    const prepare = Effect.fn("OrchestrationExecutor.prepare")(function* (input) {
      const copy = yield* Effect.gen(function* () {
        const location = yield* Location.Service
        const copies = yield* ProjectCopy.Service
        const created = yield* copies.create({
          projectID: input.run.projectID,
          strategy: ProjectCopy.StrategyID.make("git_worktree"),
          sourceDirectory: location.project.directory,
          directory: AbsolutePath.make(path.join(global.data, "orchestration", input.run.id)),
          name: input.attemptID,
        })
        const relative = path.relative(location.project.directory, location.directory)
        return Location.Ref.make({ directory: AbsolutePath.make(path.join(created.directory, relative)) })
      }).pipe(
        Effect.provide(locations.get(input.source)),
        Effect.mapError(
          (error) =>
            new ExecutionError({
              stage: "prepare",
              message: error instanceof Error ? error.message : String(error),
            }),
        ),
      )
      const session = yield* sessions.create({
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({
          id: Model.ID.make(input.candidate.modelID),
          providerID: Provider.ID.make(input.candidate.providerID),
          variant: input.candidate.variant ? Model.VariantID.make(input.candidate.variant) : undefined,
        }),
        location: copy,
      })
      return { sessionID: session.id, location: copy }
    })

    const execute = Effect.fn("OrchestrationExecutor.execute")(function* (input) {
      yield* sessions
        .prompt({
          sessionID: input.prepared.sessionID,
          prompt: PromptInput.Prompt.make({
            text: taskPrompt(input.run, input.task),
          }),
          resume: false,
        })
        .pipe(Effect.mapError((error) => new ExecutionError({ stage: "model", message: error.message })))
      yield* sessions
        .resume(input.prepared.sessionID)
        .pipe(
          Effect.mapError(
            (error) =>
              new ExecutionError({ stage: "model", message: error instanceof Error ? error.message : String(error) }),
          ),
        )

      const configuredChecks = yield* Schema.decodeUnknownEffect(Schema.Array(Orchestration.Check))(
        input.task.checks,
      ).pipe(Effect.mapError((error) => new ExecutionError({ stage: "check", message: error.message })))
      const checks = yield* Effect.forEach(configuredChecks, (check) =>
        evaluateCheck(process, check, input.source.directory, input.prepared.location.directory),
      )
      const workspace = yield* workspaceEvidence(git, input.prepared.location.directory)
      return [...checks, workspace]
    })

    return Service.of({ prepare, execute })
  }),
)

function taskPrompt(run: Orchestration.Run, task: Orchestration.Task) {
  return [
    `Objective: ${run.objective}`,
    `Task: ${task.title}`,
    task.description ?? "",
    "Work only on this task in the current isolated worktree. Do not commit or merge changes. Leave the worktree ready for review.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function evaluateCheck(
  process: AppProcess.Interface,
  check: Orchestration.Check,
  source: AbsolutePath,
  attempt: AbsolutePath,
) {
  return Effect.gen(function* () {
    const baseline = check.baseline === false ? undefined : yield* runCommand(process, check, source)
    const result = yield* runCommand(process, check, attempt)
    const status = result.exitCode === 0 ? "passed" : baseline?.exitCode === 0 ? "failed" : "indeterminate"
    return {
      kind: `check:${check.name}`,
      status,
      evidence: {
        command: check.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        baseline: baseline
          ? {
              exitCode: baseline.exitCode,
              stdout: baseline.stdout,
              stderr: baseline.stderr,
              truncated: baseline.truncated,
            }
          : undefined,
      },
    } satisfies Evaluation
  })
}

function runCommand(process: AppProcess.Interface, check: Orchestration.Check, directory: AbsolutePath) {
  const shell = globalThis.process.platform === "win32" ? (globalThis.process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
  return process
    .run(
      ChildProcess.make(check.command, [], {
        cwd: directory,
        shell,
        stdin: "ignore",
      }),
      {
        maxOutputBytes: maximumEvidenceBytes,
        maxErrorBytes: maximumEvidenceBytes,
        timeout: Duration.seconds(check.timeoutSeconds ?? 300),
      },
    )
    .pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated,
      })),
      Effect.catchTag("AppProcessError", (error) =>
        Effect.succeed({
          exitCode: error.exitCode ?? -1,
          stdout: "",
          stderr: error.message,
          truncated: false,
        }),
      ),
    )
}

function workspaceEvidence(git: Git.Interface, directory: AbsolutePath) {
  return Effect.gen(function* () {
    const repository = yield* git.repo.discover(directory)
    if (!repository) return yield* new ExecutionError({ stage: "workspace", message: "Git repository not found" })
    const patch = yield* git.change
      .capture({ repository, path: directory })
      .pipe(Effect.mapError((error) => new ExecutionError({ stage: "workspace", message: error.message })))
    const truncated = patch.length > maximumPatchBytes
    return {
      kind: "workspace",
      status: patch.length > 0 ? "passed" : "indeterminate",
      evidence: {
        directory,
        patch: truncated ? patch.slice(0, maximumPatchBytes) : patch,
        truncated,
      },
    } satisfies Evaluation
  })
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, Git.node, LocationServiceMap.node, AppProcess.node, SessionV2.node],
})
