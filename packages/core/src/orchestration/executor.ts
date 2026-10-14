export * as OrchestrationExecutor from "./executor"

import path from "path"
import { randomUUID } from "crypto"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "../schema"
import { AppProcess } from "../process"
import { Config } from "../config"
import { Git } from "../git"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Global } from "../global"
import { Location } from "../location"
import { LocationServiceMap } from "../location-service-map"
import { ProjectCopy } from "../project/copy"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { makeGlobalNode } from "../effect/app-node"
import { CodexHarness } from "./harness/codex"
import { ClaudeHarness } from "./harness/claude"
import { CursorHarness } from "./harness/cursor"
import { CopilotHarness } from "./harness/copilot"
import { HarnessEnvironment } from "./harness/environment"
import { OrchestrationCheck } from "./check"
import { OrchestrationWorker } from "./worker"

const maximumEvidenceBytes = 128 * 1024
const maximumPatchBytes = 512 * 1024

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("Orchestration.ExecutionError", {
  stage: Schema.Literals(["prepare", "model", "harness", "check", "workspace"]),
  message: Schema.String,
}) {}

export type Prepared =
  | {
      readonly candidate: Orchestration.DirectCandidate
      readonly sessionID: SessionV2.ID
      readonly location: Location.Ref
    }
  | {
      readonly candidate: Orchestration.HarnessCandidate
      readonly sessionID: SessionV2.ID
      readonly location: Location.Ref
    }

export interface Evaluation {
  readonly kind: string
  readonly status: Orchestration.EvaluationStatus
  readonly evidence: Record<string, unknown>
}

type CheckCommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

export interface Interface {
  readonly verifyPreset: (input: {
    readonly source: Location.Ref
    readonly checks: ReadonlyArray<Orchestration.Check>
  }) => Effect.Effect<ReadonlyArray<{ name: string; exitCode: number; stdout: string; stderr: string; truncated: boolean }>, ExecutionError>
  readonly prepareRun: (input: {
    readonly run: Orchestration.Run
    readonly source: Location.Ref
  }) => Effect.Effect<Orchestration.RunWorkspace, ExecutionError>
  readonly prepare: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly attemptID: Orchestration.AttemptID
    readonly candidate: Orchestration.Candidate
    readonly source: Location.Ref
    readonly revision?: string
  }) => Effect.Effect<Prepared, ExecutionError>
  readonly execute: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly prepared: Prepared
    readonly source: Location.Ref
    readonly feedback?: string
  }) => Effect.Effect<ReadonlyArray<Evaluation>, ExecutionError>
  readonly commitAttempt: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly attemptID: Orchestration.AttemptID
    readonly location: Location.Ref
    readonly mirrorSessionID?: SessionV2.ID
  }) => Effect.Effect<Evaluation, ExecutionError>
  readonly mergeAttempt: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
    readonly attemptID: Orchestration.AttemptID
  }) => Effect.Effect<string, ExecutionError>
  readonly revertAccepted: (input: {
    readonly run: Orchestration.Run
    readonly mergeHead: string
  }) => Effect.Effect<string, ExecutionError>
  readonly verifyHuman: (input: {
    readonly run: Orchestration.Run
    readonly task: Orchestration.Task
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
    const integrationLocks = KeyedMutex.makeUnsafe<string>()

    const executionSettings = Effect.fn("OrchestrationExecutor.executionSettings")((source: Location.Ref) =>
      Config.Service.use((config) =>
        config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration"))),
      ).pipe(
        Effect.provide(locations.get(source)),
        Effect.flatMap((settings) => settings?.execution_trust === "untrusted"
          ? new ExecutionError({ stage: "prepare", message: "Untrusted orchestration requires an isolated worker, which is not configured on this host" })
          : Effect.succeed(settings?.check_runtime ?? "host")),
      ))

    const verifyPreset = Effect.fn("OrchestrationExecutor.verifyPreset")(function* (input: {
      source: Location.Ref
      checks: ReadonlyArray<Orchestration.Check>
    }) {
      const checkRuntime = yield* executionSettings(input.source)
      return yield* Effect.gen(function* () {
        const location = yield* Location.Service
        const copies = yield* ProjectCopy.Service
        const repository = yield* git.repo.discover(location.project.directory)
        if (!repository) return yield* new ExecutionError({ stage: "prepare", message: "Source Git repository not found" })
        const revision = yield* git.history.head(repository)
        if (!revision) return yield* new ExecutionError({ stage: "prepare", message: "Source has no Git commit" })
        const created = yield* copies.create({
          projectID: location.project.id,
          strategy: ProjectCopy.StrategyID.make("git_worktree"),
          sourceDirectory: location.project.directory,
          directory: AbsolutePath.make(path.join(global.data, "orchestration", "check-presets")),
          name: randomUUID(),
          revision,
        })
        return yield* Effect.forEach(input.checks, (check) => runCommand(process, check, created.directory, checkRuntime).pipe(
          Effect.map((result) => ({ name: check.name, ...result })),
        ), { concurrency: 1 }).pipe(Effect.ensuring(copies.remove({
          projectID: location.project.id,
          directory: created.directory,
          force: true,
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Unable to remove check preset worktree", cause)))))
      }).pipe(
        Effect.provide(locations.get(input.source)),
        Effect.mapError((error) => new ExecutionError({ stage: "check", message: error instanceof Error ? error.message : String(error) })),
      )
    })

    const prepareRun = Effect.fn("OrchestrationExecutor.prepareRun")(function* (input) {
      return yield* Effect.gen(function* () {
        const location = yield* Location.Service
        const copies = yield* ProjectCopy.Service
        const repository = yield* git.repo.discover(input.source.directory)
        if (!repository)
          return yield* new ExecutionError({ stage: "prepare", message: "Source Git repository not found" })
        const sourceHead = yield* git.history.head(repository)
        if (!sourceHead) return yield* new ExecutionError({ stage: "prepare", message: "Source has no Git commit" })
        const sourceBranch = yield* git.history.branch(repository)
        const runBranch = `jewel/${input.run.id}`
        const directory = AbsolutePath.make(path.join(global.data, "orchestration", input.run.id, "integration"))
        const existing = yield* git.repo.discover(directory)
        if (existing?.worktree === directory) {
          const branch = yield* git.history.branch(existing)
          if (branch !== runBranch)
            return yield* new ExecutionError({
              stage: "prepare",
              message: "Run integration worktree has a different branch",
            })
          yield* copies.refresh({ projectID: input.run.projectID })
          return { sourceBranch, sourceHead, runBranch, integration: Location.Ref.make({ directory }) }
        }
        const created = yield* copies.create({
          projectID: input.run.projectID,
          strategy: ProjectCopy.StrategyID.make("git_worktree"),
          sourceDirectory: location.project.directory,
          directory: AbsolutePath.make(path.join(global.data, "orchestration", input.run.id)),
          name: "integration",
          revision: sourceHead,
          branch: runBranch,
        })
        return {
          sourceBranch,
          sourceHead,
          runBranch,
          integration: Location.Ref.make({ directory: created.directory }),
        }
      }).pipe(
        Effect.provide(locations.get(input.source)),
        Effect.mapError(
          (error) =>
            new ExecutionError({
              stage: "prepare",
              message: error instanceof Error ? error.message || error.name : String(error),
            }),
        ),
      )
    })

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
          revision: input.revision ?? input.run.workspace?.runBranch,
          branch: input.run.workspace ? `jewel/attempt/${input.run.id}/${input.task.id}/${input.attemptID}` : undefined,
        })
        const relative = path.relative(location.project.directory, location.directory)
        return Location.Ref.make({ directory: AbsolutePath.make(path.join(created.directory, relative)) })
      }).pipe(
        Effect.provide(locations.get(input.source)),
        Effect.mapError(
          (error) =>
            new ExecutionError({
              stage: "prepare",
              message: error instanceof Error ? error.message || error.name : String(error),
            }),
        ),
      )
      if (input.candidate.type === "harness") {
        const session = yield* sessions.create({
          id: SessionV2.ID.make(`ses_mirror_${input.attemptID}`),
          parentID: input.run.sessionID,
          kind: "attempt_mirror",
          title: `${input.task.title} · ${input.attemptID}`,
          location: copy,
        })
        return { candidate: input.candidate, sessionID: session.id, location: copy } satisfies Prepared
      }
      const session = yield* sessions.create({
        parentID: input.run.sessionID,
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({
          id: Model.ID.make(input.candidate.modelID),
          providerID: Provider.ID.make(input.candidate.providerID),
          variant: input.candidate.variant ? Model.VariantID.make(input.candidate.variant) : undefined,
        }),
        location: copy,
      })
      return { candidate: input.candidate, sessionID: session.id, location: copy } satisfies Prepared
    })

    const execute = Effect.fn("OrchestrationExecutor.execute")(function* (input) {
      const checkRuntime = yield* executionSettings(input.source)
      const configuredChecks = yield* Schema.decodeUnknownEffect(Schema.Array(Orchestration.Check))(
        input.task.checks,
      ).pipe(Effect.mapError((error) => new ExecutionError({ stage: "check", message: error.message })))
      const baselines = yield* Effect.forEach(configuredChecks, (check) =>
        check.baseline === false
          ? Effect.succeed(undefined)
          : runCommand(process, check, input.prepared.location.directory, checkRuntime),
      )
      const baselineStatus = yield* runGit(process, input.prepared.location.directory, ["status", "--porcelain=v1"])
      if (baselineStatus.exitCode !== 0)
        return yield* new ExecutionError({
          stage: "check",
          message: baselineStatus.stderr || "Baseline Git status failed",
        })
      if (baselineStatus.stdout)
        return yield* new ExecutionError({ stage: "check", message: "Baseline check changed the worktree" })
      if (input.prepared.candidate.type === "direct") {
        yield* sessions
          .prompt({
            sessionID: input.prepared.sessionID,
            prompt: PromptInput.Prompt.make({
              text: taskPrompt(input.run, input.task, input.feedback),
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
      }

      const candidate = input.prepared.candidate
      if (candidate.type === "harness" && !["codex", "claude", "cursor", "copilot"].includes(candidate.harnessID))
        return yield* new ExecutionError({ stage: "harness", message: `Unsupported harness ${candidate.harnessID}` })
      const harness =
        candidate.type === "harness"
          ? [
              candidate.harnessID === "codex"
                ? yield* CodexHarness.run({
                    process,
                    candidate,
                    directory: input.prepared.location.directory,
                    prompt: taskPrompt(input.run, input.task, input.feedback),
                  }).pipe(Effect.mapError((error) => new ExecutionError({ stage: "harness", message: error.message })))
                : candidate.harnessID === "claude"
                ? yield* ClaudeHarness.run({
                    process,
                    candidate,
                    directory: input.prepared.location.directory,
                    prompt: taskPrompt(input.run, input.task, input.feedback),
                  }).pipe(Effect.mapError((error) => new ExecutionError({ stage: "harness", message: error.message })))
                : candidate.harnessID === "cursor"
                ? yield* CursorHarness.run({
                    process,
                    candidate,
                    directory: input.prepared.location.directory,
                    prompt: taskPrompt(input.run, input.task, input.feedback),
                  }).pipe(Effect.mapError((error) => new ExecutionError({ stage: "harness", message: error.message })))
                : yield* CopilotHarness.run({
                    process,
                    candidate,
                    directory: input.prepared.location.directory,
                    prompt: taskPrompt(input.run, input.task, input.feedback),
                  }).pipe(Effect.mapError((error) => new ExecutionError({ stage: "harness", message: error.message }))),
            ]
          : []

      if (candidate.type === "harness" && harness[0])
        yield* sessions.appendControllerText({
          sessionID: input.prepared.sessionID,
          id: SessionMessage.ID.make(`msg_${input.prepared.sessionID}`),
          kind: "transcript",
          text: [
            `Harness: ${candidate.harnessID} · ${candidate.modelID}`,
            `Result: ${harness[0].status}`,
            harness[0].transcript || "No assistant transcript was returned by the harness.",
          ].join("\n\n"),
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Unable to mirror harness transcript", cause)))

      const checks = harness.some((evaluation) => evaluation.status === "failed")
        ? []
        : yield* Effect.forEach(configuredChecks, (check, index) =>
            evaluateCheck(process, check, baselines[index], input.prepared.location.directory, checkRuntime),
          )
      const workspace = yield* workspaceEvidence(git, process, input.prepared.location.directory)
      return [...harness.map((item) => ({ kind: item.kind, status: item.status, evidence: item.evidence })), ...checks, workspace]
    })

    const commitAttempt = Effect.fn("OrchestrationExecutor.commitAttempt")(function* (input) {
      const status = yield* runGit(process, input.location.directory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
      if (status.exitCode !== 0)
        return yield* new ExecutionError({ stage: "workspace", message: status.stderr || "Git status failed" })
      if (status.stdout) {
        const staged = yield* runGit(process, input.location.directory, ["add", "--all"])
        if (staged.exitCode !== 0)
          return yield* new ExecutionError({ stage: "workspace", message: staged.stderr || "Git add failed" })
        const committed = yield* runGit(process, input.location.directory, [
          "-c",
          "user.name=JewelCode",
          "-c",
          "user.email=jewelcode@local",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          `chore(orchestration): complete ${input.task.id}`,
        ])
        if (committed.exitCode !== 0)
          return yield* new ExecutionError({ stage: "workspace", message: committed.stderr || "Git commit failed" })
      }
      const head = yield* runGit(process, input.location.directory, ["rev-parse", "HEAD"])
      if (head.exitCode !== 0)
          return yield* new ExecutionError({ stage: "workspace", message: head.stderr || "Git revision lookup failed" })
      if (input.mirrorSessionID && status.stdout) {
        const diff = yield* runGit(process, input.location.directory, ["show", "--format=", "--binary", "HEAD"])
        if (diff.exitCode === 0)
          yield* sessions.appendControllerText({
            sessionID: input.mirrorSessionID,
            id: SessionMessage.ID.make(`msg_diff_${input.attemptID}`),
            kind: "transcript",
            text: `Final committed diff${diff.stdout.length >= maximumEvidenceBytes ? " (truncated)" : ""}:\n\n\`\`\`diff\n${diff.stdout.slice(0, maximumEvidenceBytes)}\n\`\`\``,
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("Unable to mirror committed diff", cause)))
      }
      return {
        kind: "git:commit",
        status: status.stdout ? "passed" : "indeterminate",
        evidence: {
          branch: `jewel/attempt/${input.run.id}/${input.task.id}/${input.attemptID}`,
          head: head.stdout.trim(),
          created: !!status.stdout,
        },
      } satisfies Evaluation
    })

    const mergeAttempt = Effect.fn("OrchestrationExecutor.mergeAttempt")(
      (input: { run: Orchestration.Run; task: Orchestration.Task; attemptID: Orchestration.AttemptID }) =>
        integrationLocks.withLock(input.run.id)(
          Effect.gen(function* () {
            const directory = input.run.workspace?.integration.directory
            if (!directory)
              return yield* new ExecutionError({ stage: "workspace", message: "Run integration worktree is missing" })
            const merged = yield* runGit(process, directory, [
              "-c",
              "user.name=JewelCode",
              "-c",
              "user.email=jewelcode@local",
              "-c",
              "commit.gpgsign=false",
              "merge",
              "--no-ff",
              "--no-edit",
              `jewel/attempt/${input.run.id}/${input.task.id}/${input.attemptID}`,
            ])
            if (merged.exitCode !== 0) {
              yield* runGit(process, directory, ["merge", "--abort"])
              return yield* new ExecutionError({ stage: "workspace", message: merged.stderr || "Git merge failed" })
            }
            const head = yield* runGit(process, directory, ["rev-parse", "HEAD"])
            if (head.exitCode !== 0)
              return yield* new ExecutionError({
                stage: "workspace",
                message: head.stderr || "Git revision lookup failed",
              })
            return head.stdout.trim()
          }),
        ),
    )

    const revertAccepted = Effect.fn("OrchestrationExecutor.revertAccepted")(
      (input: Parameters<Interface["revertAccepted"]>[0]) =>
        integrationLocks.withLock(input.run.id)(Effect.gen(function* () {
          const directory = input.run.workspace?.integration.directory
          if (!directory)
            return yield* new ExecutionError({ stage: "workspace", message: "Run integration worktree is missing" })
          if (!/^[0-9a-f]{40}$/.test(input.mergeHead))
            return yield* new ExecutionError({ stage: "workspace", message: "Merge revision is invalid" })
          const branch = yield* runGit(process, directory, ["branch", "--show-current"])
          if (branch.exitCode !== 0 || branch.stdout.trim() !== input.run.workspace?.runBranch)
            return yield* new ExecutionError({ stage: "workspace", message: "Run worktree is on a different branch" })
          const status = yield* runGit(process, directory, ["status", "--porcelain=v1"])
          if (status.exitCode !== 0 || status.stdout.trim())
            return yield* new ExecutionError({ stage: "workspace", message: "Run worktree has uncommitted changes" })
          const reverted = yield* runGit(process, directory, [
            "-c", "user.name=JewelCode", "-c", "user.email=jewelcode@local", "-c", "commit.gpgsign=false",
            "revert", "-m", "1", "--no-edit", input.mergeHead,
          ])
          if (reverted.exitCode !== 0) {
            yield* runGit(process, directory, ["revert", "--abort"])
            return yield* new ExecutionError({ stage: "workspace", message: reverted.stderr || "Git revert failed" })
          }
          const head = yield* runGit(process, directory, ["rev-parse", "HEAD"])
          if (head.exitCode !== 0)
            return yield* new ExecutionError({ stage: "workspace", message: head.stderr || "Git revision lookup failed" })
          return head.stdout.trim()
        })),
    )

    const verifyHuman = Effect.fn("OrchestrationExecutor.verifyHuman")(function* (
      input: Parameters<Interface["verifyHuman"]>[0],
    ) {
      const checkRuntime = yield* executionSettings(input.source)
      const directory = input.run.workspace?.integration.directory ?? input.source.directory
      return yield* Effect.forEach(input.task.checks, (check) =>
        runCommand(process, check, directory, checkRuntime).pipe(
          Effect.map(
            (result) =>
              ({
                kind: `check:${check.name}`,
                status: result.exitCode === 0 ? "passed" : "failed",
                evidence: {
                  command: check.command,
                  runtime: checkRuntime,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  truncated: result.truncated,
                },
              }) satisfies Evaluation,
          ),
        ),
      )
    })

    return Service.of({ verifyPreset, prepareRun, prepare, execute, commitAttempt, mergeAttempt, revertAccepted, verifyHuman })
  }),
)

function taskPrompt(run: Orchestration.Run, task: Orchestration.Task, feedback?: string) {
  return [
    `Objective: ${run.objective}`,
    `Task: ${task.title}`,
    task.description ?? "",
    task.acceptanceCriteria.length
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion.key}: ${criterion.description}`).join("\n")}`
      : "",
    feedback ? `Revision feedback:\n${feedback}` : "",
    "Work only on this task in the current isolated worktree. Do not commit, merge, push, publish, open pull requests, or modify remote repositories. Leave the worktree ready for review.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function runGit(process: AppProcess.Interface, directory: AbsolutePath, args: string[]) {
  return process
    .run(
      ChildProcess.make("git", args, {
        cwd: directory,
        stdin: "ignore",
        env: HarnessEnvironment.make(),
        extendEnv: false,
      }),
      { timeout: Duration.seconds(60), maxOutputBytes: maximumEvidenceBytes, maxErrorBytes: maximumEvidenceBytes },
    )
    .pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      })),
      Effect.mapError((error) => new ExecutionError({ stage: "workspace", message: error.message })),
    )
}

function evaluateCheck(
  process: AppProcess.Interface,
  check: Orchestration.Check,
  baseline: CheckCommandResult | undefined,
  attempt: AbsolutePath,
  runtime: "host" | "colima",
) {
  return Effect.gen(function* () {
    const result = yield* runCommand(process, check, attempt, runtime)
    const status = result.exitCode === 0 ? "passed" : baseline?.exitCode === 0 ? "failed" : "indeterminate"
    return {
      kind: `check:${check.name}`,
      status,
      evidence: {
        command: check.command,
        runtime,
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

function runCommand(process: AppProcess.Interface, check: Orchestration.Check, directory: AbsolutePath, runtime: "host" | "colima") {
  if (runtime === "colima") return OrchestrationWorker.runCheck(process, check, directory).pipe(
    Effect.mapError((error) => new ExecutionError({ stage: "check", message: error.message })),
  )
  const shell = globalThis.process.platform === "win32" ? (globalThis.process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
  return Effect.try({
    try: () => OrchestrationCheck.directory(directory, check),
    catch: (error) => new ExecutionError({ stage: "check", message: error instanceof Error ? error.message : String(error) }),
  }).pipe(Effect.flatMap((cwd) => process
    .run(
      ChildProcess.make(check.command, [], {
        cwd,
        shell,
        stdin: "ignore",
        env: HarnessEnvironment.make(),
        extendEnv: false,
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
    )))
}

function workspaceEvidence(git: Git.Interface, process: AppProcess.Interface, directory: AbsolutePath) {
  return Effect.gen(function* () {
    const repository = yield* git.repo.discover(directory)
    if (!repository) return yield* new ExecutionError({ stage: "workspace", message: "Git repository not found" })
    const status = yield* process
      .run(
        ChildProcess.make("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: repository.worktree,
          stdin: "ignore",
        }),
        { timeout: "10 seconds", maxOutputBytes: maximumEvidenceBytes, maxErrorBytes: 1_024 },
      )
      .pipe(Effect.mapError((error) => new ExecutionError({ stage: "workspace", message: error.message })))
    if (status.exitCode !== 0) return yield* new ExecutionError({ stage: "workspace", message: "Git status failed" })
    const remotes = yield* process
      .run(ChildProcess.make("git", ["remote"], { cwd: repository.worktree, stdin: "ignore" }), {
        timeout: "10 seconds",
        maxOutputBytes: 4_096,
        maxErrorBytes: 1_024,
      })
      .pipe(Effect.mapError((error) => new ExecutionError({ stage: "workspace", message: error.message })))
    if (remotes.exitCode !== 0)
      return yield* new ExecutionError({ stage: "workspace", message: "Git remote discovery failed" })
    const [branch, head] = yield* Effect.all([git.history.branch(repository), git.history.head(repository)])
    const patch = yield* git.change
      .capture({ repository, path: directory })
      .pipe(Effect.mapError((error) => new ExecutionError({ stage: "workspace", message: error.message })))
    const truncated = patch.length > maximumPatchBytes
    return {
      kind: "workspace",
      status: patch.length > 0 ? "passed" : "indeterminate",
      evidence: {
        directory,
        git: {
          worktree: repository.worktree,
          branch,
          head,
          remoteNames: remotes.stdout.toString("utf8").split(/\r?\n/).filter(Boolean).slice(0, 32),
          status: summarizeGitStatus(status.stdout.toString("utf8")),
          statusTruncated: status.stdoutTruncated,
          remotesTruncated: remotes.stdoutTruncated,
        },
        patch: truncated ? patch.slice(0, maximumPatchBytes) : patch,
        truncated,
      },
    } satisfies Evaluation
  })
}

export function summarizeGitStatus(input: string) {
  const lines = input.split(/\r?\n/).filter(Boolean)
  return {
    changed: lines.length,
    staged: lines.filter((line) => line[0] !== " " && line[0] !== "?").length,
    unstaged: lines.filter((line) => line[1] !== " " && line[1] !== "?").length,
    untracked: lines.filter((line) => line.startsWith("??")).length,
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, Git.node, LocationServiceMap.node, AppProcess.node, SessionV2.node],
})
