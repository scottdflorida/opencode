export * as OrchestrationIntegration from "./integration"

import path from "path"
import { createHash } from "crypto"
import { DateTime, Effect, Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { HarnessEnvironment } from "./harness/environment"
import { OrchestrationCheck } from "./check"
import { Orchestration as Store } from "../orchestration"

const outputLimit = 8_000

export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("Orchestration.IntegrationError", {
  message: Schema.String,
}) {}

type Command = { program: string; directory: string; args: string[]; input?: string; timeoutMs?: number }
type Result = { exitCode: number; stdout: string; stderr: string }

export const preflight = Effect.fn("OrchestrationIntegration.preflight")(function* (
  detail: Orchestration.Detail,
  options: Orchestration.IntegrationOptions,
) {
  return yield* Effect.tryPromise({
    try: () => inspect(detail, options),
    catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
  })
})

export const verifyDeliveredHead = Effect.fn("OrchestrationIntegration.verifyDeliveredHead")(function* (
  detail: Orchestration.Detail,
) {
  const delivery = detail.deliveries.at(-1)
  const workspace = detail.run.workspace
  const source = detail.run.source?.directory
  if (!delivery?.summary || !workspace || !source || detail.run.status !== "delivered")
    return yield* new IntegrationError({ message: "Run has no delivered turn" })
  const head = yield* Effect.tryPromise({
    try: () => command({ program: "git", directory: source, args: ["rev-parse", workspace.runBranch] }),
    catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
  })
  if (head.exitCode !== 0 || head.stdout.trim() !== delivery.head)
    return yield* new IntegrationError({ message: "Run branch changed since delivery" })
  return delivery.head
})

export const targets = Effect.fn("OrchestrationIntegration.targets")(function* (detail: Orchestration.Detail) {
  const source = detail.run.source?.directory
  if (!source) return yield* new IntegrationError({ message: "Run has no source Git repository" })
  return yield* Effect.tryPromise({
    try: async () => {
      const [refs, worktrees] = await Promise.all([
        command({ program: "git", directory: source, args: ["for-each-ref", "--format=%(refname:short)", "refs/heads/"] }),
        command({ program: "git", directory: source, args: ["worktree", "list", "--porcelain"] }),
      ])
      requireSuccess(refs, "List local branches")
      requireSuccess(worktrees, "List local worktrees")
      return {
        branches: refs.stdout.split("\n").filter((branch) => branch && !branch.startsWith("jewel/")).slice(0, 200),
        worktrees: worktrees.stdout.split("\n\n").flatMap((item) => {
          const directory = item.match(/^worktree (.+)$/m)?.[1]
          const branch = item.match(/^branch refs\/heads\/(.+)$/m)?.[1]
          return directory && branch && !branch.startsWith("jewel/") ? [{ branch, directory }] : []
        }).slice(0, 200),
      }
    },
    catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
  })
})

export const execute = Effect.fn("OrchestrationIntegration.execute")(function* (
  detail: Orchestration.Detail,
  options: Orchestration.IntegrationOptions,
  existing?: Orchestration.Integration,
) {
  const store = yield* Store.Service
  const preview = existing ? undefined : yield* preflight(detail, options)
  if (preview?.blockers.length) return yield* new IntegrationError({ message: preview.blockers.join("; ") })
  const delivery = detail.deliveries.at(-1)!
  const baseHead = integrationBase(detail)
  if (existing && (existing.status !== "failed" || existing.deliveryID !== delivery.id))
    return yield* new IntegrationError({ message: "Integration is not a failed action for this delivery" })
  if (existing && options.action === "apply")
    return yield* new IntegrationError({ message: "This action cannot be resumed automatically" })
  const record = existing ?? (yield* store.startIntegration({ runID: detail.run.id, deliveryID: delivery.id, options }))
  const source = detail.run.source!.directory
  const workspace = detail.run.workspace!
  const targetBranch = options.targetBranch ?? workspace.sourceBranch!
  const remote = options.remote ?? "origin"
  const branch = options.branch ?? `jewel/${detail.run.id.slice(4).toLowerCase()}`
  const directory = deliveryDirectory(workspace, delivery.id, branch)
  const completed = new Map(
    record.steps.filter((item) => item.status === "succeeded").map((item) => [item.name, item]),
  )
  const reuse = existing ? undefined : reusedCommit(detail, delivery.id, branch)
  if (existing && options.action !== "discard") {
    if (!completed.has("commit"))
      return yield* new IntegrationError({ message: "Commit did not complete; inspect the delivery worktree and choose a new branch" })
    const head = yield* Effect.tryPromise({
      try: () => command({ program: "git", directory: source, args: ["rev-parse", `refs/heads/${branch}`] }),
      catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
    })
    if (head.exitCode !== 0 || head.stdout.trim() !== completed.get("commit")?.commit)
      return yield* new IntegrationError({ message: "Delivery branch changed since the completed commit step" })
    if (completed.has("merge")) {
      const merged = yield* Effect.tryPromise({
        try: () => command({ program: "git", directory: source, args: ["rev-parse", `refs/heads/${targetBranch}`] }),
        catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
      })
      if (merged.exitCode !== 0 || merged.stdout.trim() !== completed.get("merge")?.commit)
        return yield* new IntegrationError({ message: "Target branch changed since the completed merge step" })
    }
    yield* store.resumeIntegration({ runID: detail.run.id, integrationID: record.id })
  }
  if (existing && options.action === "discard")
    yield* store.resumeIntegration({ runID: detail.run.id, integrationID: record.id })

  const step = Effect.fn("OrchestrationIntegration.step")(function* (
    name: Orchestration.IntegrationStep["name"],
    operation: () => Promise<Partial<Orchestration.IntegrationStep>>,
  ) {
    const result = yield* Effect.tryPromise({
      try: operation,
      catch: (error) => new IntegrationError({ message: error instanceof Error ? error.message : String(error) }),
    }).pipe(Effect.exit)
    if (result._tag === "Success") {
      const completedStep = { name, status: "succeeded" as const, ...result.value, time: yield* DateTime.now }
      yield* store.recordIntegrationStep({
        runID: detail.run.id,
        integrationID: record.id,
        step: completedStep,
      })
      completed.set(name, completedStep)
      return result.value
    }
    yield* store.recordIntegrationStep({
      runID: detail.run.id,
      integrationID: record.id,
      step: { name, status: "failed", message: redactRemote(result.cause.toString()).slice(0, outputLimit), time: yield* DateTime.now },
    })
    yield* store.finishIntegration({ runID: detail.run.id, integrationID: record.id, status: "failed" })
    return yield* new IntegrationError({ message: redactRemote(result.cause.toString()).slice(0, outputLimit) })
  })

  if (options.action === "discard") {
    yield* step("discard", () => discard(source, workspace, detail.run.id))
    yield* store.finishIntegration({ runID: detail.run.id, integrationID: record.id, status: "completed" })
    return record.id
  }
  if (options.action === "apply") {
    yield* step("apply", async () => {
      const patch = await command({ program: "git", directory: source, args: ["diff", "--binary", baseHead, delivery.head] })
      requireSuccess(patch, "Generate delivery patch")
      requireSuccess(await command({ program: "git", directory: source, args: ["apply", "--binary", "-"], input: patch.stdout }), "Apply delivery patch")
      return { branch: targetBranch }
    })
    yield* store.finishIntegration({ runID: detail.run.id, integrationID: record.id, status: "completed" })
    return record.id
  }

  if (!completed.has("commit") && reuse) yield* step("commit", async () => {
    const current = await command({ program: "git", directory: source, args: ["rev-parse", `refs/heads/${branch}`] })
    if (current.exitCode !== 0 || current.stdout.trim() !== reuse.commit)
      throw new Error("Delivery branch changed since its recorded commit")
    if (options.action === "pull_request") {
      const worktrees = await command({ program: "git", directory: source, args: ["worktree", "list", "--porcelain"] })
      requireSuccess(worktrees, "List worktrees")
      if (!findWorktree(worktrees.stdout, branch))
        requireSuccess(await command({ program: "git", directory: source, args: ["worktree", "add", directory, branch] }), "Open delivery worktree")
    }
    return { commit: reuse.commit, branch, message: "Reused prior delivery commit" }
  })

  if (!completed.has("commit") && !reuse) yield* step("commit", async () => {
    const targetHead = await command({ program: "git", directory: source, args: ["rev-parse", `refs/heads/${targetBranch}`] })
    if (targetHead.exitCode !== 0 || targetHead.stdout.trim() !== preview?.targetHead)
      throw new Error("Target branch moved after preflight")
    const conflictPullRequest = options.action === "pull_request" && preview?.cleanMerge === false
    requireSuccess(
      await command({
        program: "git",
        directory: source,
        args: ["worktree", "add", "-b", branch, directory, conflictPullRequest ? delivery.head : preview?.targetHead ?? delivery.baseHead],
      }),
      "Create delivery worktree",
    )
    // Keep the delivered history when a moved target cannot accept its patch; the PR can resolve that conflict.
    if (!conflictPullRequest && (options.history ?? "squash") === "per_task") {
      requireSuccess(await command({ program: "git", directory, args: ["merge", "--ff-only", delivery.head] }), "Fast-forward delivery branch")
    } else if (!conflictPullRequest) {
      const patch = await command({ program: "git", directory: source, args: ["diff", "--binary", baseHead, delivery.head] })
      requireSuccess(patch, "Generate delivery patch")
      if (!patch.stdout) throw new Error("Delivery has no changes since its last integration")
      requireSuccess(await command({ program: "git", directory, args: ["apply", "--binary", "-"], input: patch.stdout }), "Apply delivery patch")
      requireSuccess(await command({ program: "git", directory, args: ["add", "--all"] }), "Stage delivery")
      requireSuccess(
        await command({ program: "git", directory, args: ["commit", "-m", options.commitMessage ?? delivery.commitMessage ?? "feat: deliver run"] }),
        "Commit delivery",
      )
    }
    const head = await command({ program: "git", directory, args: ["rev-parse", "HEAD"] })
    requireSuccess(head, "Read delivery commit")
    return { commit: head.stdout.trim(), branch }
  })

  if ((preview?.targetMoved ?? options.expectedTargetHead !== baseHead) && !completed.has("checks"))
    yield* step("checks", async () => {
      const checks = [...new Map(detail.tasks.flatMap((task) => task.checks).map((check) => [`${check.name}:${check.command}:${check.workingDirectory ?? "."}`, check])).values()]
      for (const check of checks) {
        const shell = globalThis.process.platform === "win32" ? (globalThis.process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
        const result = await command({
          program: shell,
          directory: OrchestrationCheck.directory(directory, check),
          args: globalThis.process.platform === "win32" ? ["/c", check.command] : ["-c", check.command],
          timeoutMs: (check.timeoutSeconds ?? 300) * 1_000,
        })
        requireSuccess(result, `Run-level check ${check.name}`)
      }
      return { message: `${checks.length} configured checks passed` }
    })

  if (["merge", "push"].includes(options.action) && !completed.has("merge")) {
    yield* step("merge", async () => {
      const worktrees = await command({ program: "git", directory: source, args: ["worktree", "list", "--porcelain"] })
      requireSuccess(worktrees, "List worktrees")
      const existingTarget = findWorktree(worktrees.stdout, targetBranch)
      const targetDirectory = existingTarget ?? path.join(path.dirname(workspace.integration.directory), `target-${delivery.id}`)
      if (!existingTarget)
        requireSuccess(await command({ program: "git", directory: source, args: ["worktree", "add", targetDirectory, targetBranch] }), "Open target worktree")
      const targetStatus = await command({ program: "git", directory: targetDirectory, args: ["status", "--porcelain=v1"] })
      requireSuccess(targetStatus, "Inspect target worktree")
      if (targetStatus.stdout) throw new Error("Target worktree has uncommitted changes")
      const targetHead = await command({ program: "git", directory: targetDirectory, args: ["rev-parse", "HEAD"] })
      if (targetHead.exitCode !== 0 || targetHead.stdout.trim() !== (preview?.targetHead ?? options.expectedTargetHead))
        throw new Error("Target branch moved after preflight")
      const strategy = options.mergeStrategy ?? "merge"
      const args =
        strategy === "ff"
          ? ["merge", "--ff-only", branch]
          : strategy === "squash"
            ? ["merge", "--squash", branch]
            : ["merge", "--no-ff", "--no-edit", branch]
      const merged = await command({ program: "git", directory: targetDirectory, args })
      if (merged.exitCode !== 0) {
        await command({ program: "git", directory: targetDirectory, args: strategy === "squash" ? ["reset", "--merge"] : ["merge", "--abort"] })
        requireSuccess(merged, "Merge delivery")
      }
      if (strategy === "squash")
        requireSuccess(
          await command({ program: "git", directory: targetDirectory, args: ["commit", "-m", options.commitMessage ?? delivery.commitMessage ?? "feat: deliver run"] }),
          "Commit squash merge",
        )
      const head = await command({ program: "git", directory: targetDirectory, args: ["rev-parse", "HEAD"] })
      requireSuccess(head, "Read merged commit")
      return { commit: head.stdout.trim(), branch: targetBranch }
    })
  }

  if (options.action === "push" && !completed.has("push"))
    yield* step("push", async () => {
      const remoteBranch = options.remoteBranch ?? targetBranch
      const targetHead = await command({ program: "git", directory: source, args: ["rev-parse", `refs/heads/${targetBranch}`] })
      if (targetHead.exitCode !== 0 || targetHead.stdout.trim() !== completed.get("merge")?.commit)
        throw new Error("Target branch changed after merge")
      requireSuccess(
        await command({ program: "git", directory: source, args: ["push", remote, `${targetBranch}:${remoteBranch}`] }),
        "Push target branch",
      )
      return { branch: targetBranch, remote, remoteBranch }
    })

  if (options.action === "pull_request") {
    if (!completed.has("push")) yield* step("push", async () => {
      const remoteBranch = options.remoteBranch ?? branch
      requireSuccess(await command({ program: "git", directory, args: ["push", "-u", remote, `${branch}:${remoteBranch}`] }), "Push delivery branch")
      return { branch, remote, remoteBranch }
    })
    if (!completed.has("pull_request")) yield* step("pull_request", async () => {
      const result = await command({
        program: "gh",
        directory,
        args: [
          "pr", "create", "--base", options.baseBranch ?? targetBranch, "--head", options.remoteBranch ?? branch,
          "--title", (options.commitMessage ?? delivery.commitMessage ?? "Deliver run").split("\n")[0]!,
          "--body", delivery.summary ?? "",
          ...(options.draft ? ["--draft"] : []),
          ...(options.reviewers?.length ? ["--reviewer", options.reviewers.join(",")] : []),
        ],
      })
      requireSuccess(result, "Open pull request")
      return { pullRequestURL: result.stdout.trim(), branch }
    })
  }

  yield* store.finishIntegration({ runID: detail.run.id, integrationID: record.id, status: "completed" })
  return record.id
})

async function inspect(detail: Orchestration.Detail, options: Orchestration.IntegrationOptions): Promise<Orchestration.IntegrationPreflight> {
  const blockers: string[] = []
  const warnings: string[] = []
  const delivery = detail.deliveries.at(-1)
  const workspace = detail.run.workspace
  const source = detail.run.source?.directory
  if (!delivery || !workspace || !source || detail.run.status !== "delivered") throw new Error("Run has no delivered turn")
  if (delivery.head !== options.expectedHead) blockers.push("Delivery head changed; refresh preflight")
  if (detail.integrations.some((item) => item.deliveryID === delivery.id && item.status === "running")) blockers.push("An integration is already running")
  const head = await command({ program: "git", directory: source, args: ["rev-parse", workspace.runBranch] })
  if (head.exitCode !== 0 || head.stdout.trim() !== delivery.head) blockers.push("Run branch no longer matches the delivery")
  const targetBranch = options.targetBranch ?? workspace.sourceBranch
  if (!targetBranch && options.action !== "discard") blockers.push("Choose a target branch")
  if (targetBranch) {
    const valid = await command({ program: "git", directory: source, args: ["check-ref-format", "--branch", targetBranch] })
    if (valid.exitCode !== 0) blockers.push("Invalid target branch")
  }
  const targetHeadResult = targetBranch
    ? await command({ program: "git", directory: source, args: ["rev-parse", "--verify", `refs/heads/${targetBranch}`] })
    : undefined
  const targetHead = targetHeadResult?.exitCode === 0 ? targetHeadResult.stdout.trim() : undefined
  const branch = options.branch ?? `jewel/${detail.run.id.slice(4).toLowerCase()}`
  const reuse = reusedCommit(detail, delivery.id, branch)
  if (!targetHead && options.action !== "discard") blockers.push("Target branch does not exist locally")
  if (options.expectedTargetHead && targetHead !== options.expectedTargetHead) blockers.push("Target branch moved; refresh preflight")
  const worktrees = await command({ program: "git", directory: source, args: ["worktree", "list", "--porcelain"] })
  requireSuccess(worktrees, "List worktrees")
  const disposableWorktrees = worktrees.stdout.split("\n\n")
    .map((item) => ({ directory: item.match(/^worktree (.+)$/m)?.[1], branch: item.match(/^branch refs\/heads\/(.+)$/m)?.[1] }))
    .filter((item) => item.branch === workspace.runBranch || item.branch?.startsWith(`jewel/attempt/${detail.run.id}/`))
  const attemptRefs = options.action === "discard"
    ? await command({ program: "git", directory: source, args: ["for-each-ref", "--format=%(refname:short)", `refs/heads/jewel/attempt/${detail.run.id}/`] })
    : undefined
  if (attemptRefs) requireSuccess(attemptRefs, "List attempt branches")
  const discardBranches = [...(attemptRefs?.stdout.trim().split("\n").filter(Boolean) ?? []), workspace.runBranch]
  const targetDirectory = targetBranch ? findWorktree(worktrees.stdout, targetBranch) : undefined
  const targetStatus = targetDirectory
    ? await command({ program: "git", directory: targetDirectory, args: ["status", "--porcelain=v1"] })
    : undefined
  if (targetStatus) requireSuccess(targetStatus, "Inspect target worktree")
  const targetDirty = !!targetStatus?.stdout
  if (targetDirty && ["apply", "merge", "push"].includes(options.action)) blockers.push("Target worktree has uncommitted changes")
  if (options.action === "apply" && targetDirectory !== source) blockers.push("Apply requires the source checkout on the target branch")
  if (options.action === "discard") {
    if (head.exitCode !== 0) blockers.push("Run branch was already removed")
    for (const item of disposableWorktrees) {
      if (!item.directory) continue
      const status = await command({ program: "git", directory: item.directory, args: ["status", "--porcelain=v1"] })
      if (status.exitCode !== 0 || status.stdout) blockers.push(`Worktree ${item.branch} has uncommitted changes`)
    }
  }
  const targetMoved = !!targetHead && targetHead !== integrationBase(detail)
  if (targetMoved) warnings.push("Target moved since the turn base")
  const merge = targetHead
    ? await command({ program: "git", directory: source, args: ["merge-tree", "--write-tree", targetHead, reuse?.commit ?? delivery.head] })
    : undefined
  const cleanMerge = !!merge && merge.exitCode === 0
  if (!cleanMerge && options.action === "pull_request" && targetHead)
    warnings.push("Delivery conflicts with target branch; the pull request will need conflict resolution")
  if (!cleanMerge && ["commit", "merge", "push"].includes(options.action)) blockers.push("Delivery conflicts with target branch")
  if (options.action === "apply" && targetHead) {
    const patch = await command({ program: "git", directory: source, args: ["diff", "--binary", integrationBase(detail), delivery.head] })
    requireSuccess(patch, "Generate delivery patch")
    if ((await command({ program: "git", directory: source, args: ["apply", "--check", "--binary", "-"], input: patch.stdout })).exitCode !== 0)
      blockers.push("Delivery patch does not apply cleanly")
  }
  if (["commit", "merge", "push", "pull_request"].includes(options.action)) {
    if ((await command({ program: "git", directory: source, args: ["check-ref-format", "--branch", branch] })).exitCode !== 0) blockers.push("Invalid delivery branch")
    const branchHead = await command({ program: "git", directory: source, args: ["rev-parse", "--verify", `refs/heads/${branch}`] })
    if (branchHead.exitCode === 0 && (!reuse || branchHead.stdout.trim() !== reuse.commit || options.action === "commit"))
      blockers.push("Delivery branch already exists; choose a new branch")
    if (reuse && branchHead.exitCode === 0 && branchHead.stdout.trim() === reuse.commit) warnings.push("Reusing a prior delivery commit")
    if (findWorktree(worktrees.stdout, branch) && !reuse) blockers.push("Delivery branch is already checked out")
    if (branch === targetBranch) blockers.push("Delivery branch and target branch must differ")
    if ((options.history ?? "squash") === "per_task" && targetMoved && !reuse && !(options.action === "pull_request" && !cleanMerge)) blockers.push("Per-task history requires a fast-forward target")
    if ((options.history ?? "squash") === "per_task" && targetHead && !reuse && !(options.action === "pull_request" && !cleanMerge)) {
      const ancestor = await command({ program: "git", directory: source, args: ["merge-base", "--is-ancestor", targetHead, delivery.head] })
      if (ancestor.exitCode !== 0) blockers.push("Per-task history requires the target to be an ancestor of the run branch")
    }
    if (!(options.commitMessage ?? delivery.commitMessage)?.trim() && (options.history ?? "squash") === "squash" && !reuse && !(options.action === "pull_request" && !cleanMerge)) blockers.push("Commit message is required")
    if (!reuse && (options.history ?? "squash") === "squash" && !(options.action === "pull_request" && !cleanMerge)) {
      const patch = await command({ program: "git", directory: source, args: ["diff", "--binary", integrationBase(detail), delivery.head] })
      requireSuccess(patch, "Generate delivery patch")
      if (!patch.stdout) blockers.push("Delivery has no changes since its last integration")
      if (patch.stdout && targetDirectory &&
        (await command({ program: "git", directory: targetDirectory, args: ["apply", "--check", "--binary", "-"], input: patch.stdout })).exitCode !== 0)
        blockers.push("Delivery patch does not apply cleanly to target")
    }
  }
  if (options.action === "discard" && !options.confirmDiscard) blockers.push("Confirm discard")
  const remote = options.remote ?? "origin"
  const defaultRef = await command({ program: "git", directory: source, args: ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`] })
  const defaultBranch = defaultRef.exitCode === 0 ? defaultRef.stdout.trim().replace(`${remote}/`, "") : workspace.sourceBranch
  const pushedBranch = options.action === "pull_request" ? options.remoteBranch ?? branch : options.remoteBranch ?? targetBranch
  const defaultBranchPush = ["push", "pull_request"].includes(options.action) && pushedBranch === defaultBranch
  if (defaultBranchPush && !options.confirmDefaultPush) blockers.push("Confirm direct push to default branch")
  if (["push", "pull_request"].includes(options.action)) {
    if ((await command({ program: "git", directory: source, args: ["remote", "get-url", remote] })).exitCode !== 0) blockers.push("Remote is not configured")
    if (!pushedBranch || (await command({ program: "git", directory: source, args: ["check-ref-format", "--branch", pushedBranch] })).exitCode !== 0) blockers.push("Invalid remote branch")
  }
  return {
    deliveryID: delivery.id,
    head: delivery.head,
    targetHead,
    targetBranch,
    targetDirectory,
    targetDirty,
    targetMoved,
    cleanMerge,
    defaultBranchPush,
    commands: commands(detail, options, targetBranch, branch, remote, targetDirectory, reuse, findWorktree(worktrees.stdout, branch), disposableWorktrees.flatMap((item) => item.directory ? [item.directory] : []), discardBranches, !cleanMerge),
    blockers,
    warnings,
  }
}

function commands(detail: Orchestration.Detail, options: Orchestration.IntegrationOptions, target: string | undefined, branch: string, remote: string, targetDirectory?: string, reuse?: Orchestration.IntegrationStep, branchDirectory?: string, discardWorktrees: string[] = [], discardBranches: string[] = [], conflicts = false) {
  const delivery = detail.deliveries.at(-1)!
  const baseHead = integrationBase(detail)
  const source = detail.run.source!.directory
  const directory = deliveryDirectory(detail.run.workspace!, delivery.id, branch)
  const mergeDirectory = targetDirectory ?? path.join(path.dirname(detail.run.workspace!.integration.directory), `target-${delivery.id}`)
  const message = options.commitMessage ?? delivery.commitMessage ?? "feat: deliver run"
  if (options.action === "discard") return [
    ...discardWorktrees.map((directory) => show("git", source, ["worktree", "remove", directory])),
    ...discardBranches.map((name) => show("git", source, ["branch", "-D", name])),
  ]
  if (options.action === "apply") return [show("git", source, ["diff", "--binary", baseHead, delivery.head]) + " | " + show("git", source, ["apply", "--binary", "-"])]
  const conflictPullRequest = options.action === "pull_request" && conflicts
  const result = reuse
    ? [show("git", source, ["rev-parse", `refs/heads/${branch}`]), ...(options.action === "pull_request" && !branchDirectory ? [show("git", source, ["worktree", "add", directory, branch])] : [])]
    : [show("git", source, ["worktree", "add", "-b", branch, directory, conflictPullRequest ? delivery.head : target ?? delivery.baseHead]),
      ...(conflictPullRequest ? [] : (options.history ?? "squash") === "per_task"
        ? [show("git", directory, ["merge", "--ff-only", delivery.head])]
        : [show("git", source, ["diff", "--binary", baseHead, delivery.head]) + " | " + show("git", directory, ["apply", "--binary", "-"]), show("git", directory, ["add", "--all"]), show("git", directory, ["commit", "-m", message])])]
  if (target && target !== baseHead) result.push(...[...new Map(detail.tasks.flatMap((task) => task.checks).map((check) => [`${check.name}:${check.command}:${check.workingDirectory ?? "."}`, check])).values()].map((check) => show(globalThis.process.platform === "win32" ? "cmd.exe" : "/bin/sh", OrchestrationCheck.displayDirectory(directory, check), globalThis.process.platform === "win32" ? ["/c", check.command] : ["-c", check.command])))
  if (["merge", "push"].includes(options.action)) {
    const strategy = options.mergeStrategy ?? "merge"
    if (!targetDirectory) result.push(show("git", source, ["worktree", "add", mergeDirectory, target ?? ""]))
    result.push(show("git", mergeDirectory, strategy === "ff" ? ["merge", "--ff-only", branch] : strategy === "squash" ? ["merge", "--squash", branch] : ["merge", "--no-ff", "--no-edit", branch]))
    if (strategy === "squash") result.push(show("git", mergeDirectory, ["commit", "-m", message]))
  }
  if (["push", "pull_request"].includes(options.action)) result.push(show("git", options.action === "pull_request" ? directory : source, ["push", ...(options.action === "pull_request" ? ["-u"] : []), remote, `${options.action === "pull_request" ? branch : target}:${options.remoteBranch ?? (options.action === "pull_request" ? branch : target)}`]))
  if (options.action === "pull_request") result.push(show("gh", directory, ["pr", "create", "--base", options.baseBranch ?? target ?? "", "--head", options.remoteBranch ?? branch, "--title", message.split("\n")[0]!, "--body", delivery.summary ?? "", ...(options.draft ? ["--draft"] : []), ...(options.reviewers?.length ? ["--reviewer", options.reviewers.join(",")] : [])]))
  return result
}

function show(program: string, directory: string, args: string[]) {
  const quote = (part: string) => `'${part.replaceAll("'", "'\\''")}'`
  return `(cd ${quote(directory)} && ${[program, ...args].map(quote).join(" ")})`
}

function findWorktree(output: string, branch: string) {
  return output.split("\n\n").map((item) => ({ directory: item.match(/^worktree (.+)$/m)?.[1], branch: item.match(/^branch refs\/heads\/(.+)$/m)?.[1] })).find((item) => item.branch === branch)?.directory
}

function reusedCommit(detail: Orchestration.Detail, deliveryID: Orchestration.DeliveryID, branch: string) {
  const step = detail.integrations
    .filter((item) => item.deliveryID === deliveryID && item.status === "completed")
    .flatMap((item) => item.steps)
    .findLast((item) => item.name === "commit" && item.status === "succeeded" && item.branch === branch)
  return step?.commit ? { ...step, commit: step.commit } : undefined
}

function integrationBase(detail: Orchestration.Detail) {
  const previous = detail.integrations.findLast(
    (item) => item.status === "completed" && item.options.action !== "discard" &&
      detail.deliveries.findIndex((delivery) => delivery.id === item.deliveryID) < detail.deliveries.length - 1,
  )
  return detail.deliveries.find((delivery) => delivery.id === previous?.deliveryID)?.head ?? detail.run.workspace!.sourceHead
}

function deliveryDirectory(workspace: Orchestration.RunWorkspace, deliveryID: Orchestration.DeliveryID, branch: string) {
  return path.join(
    path.dirname(workspace.integration.directory),
    `delivery-${deliveryID}-${createHash("sha256").update(branch).digest("hex").slice(0, 12)}`,
  )
}

function requireSuccess(result: Result, label: string) {
  if (result.exitCode !== 0) throw new Error(`${label}: ${redactRemote(result.stderr || result.stdout).slice(0, outputLimit)}`)
}

function redactRemote(message: string) {
  return message
    .replace(/(?:https?:\/\/|ssh:\/\/|git@)[^\s'"\)]+/g, "<remote>")
    .replace(/(?:\/[\w.~-]+)+\.git\b/g, "<remote>")
}

async function command(input: Command): Promise<Result> {
  const env = {
    ...HarnessEnvironment.make(),
    ...Object.fromEntries(["SSH_AUTH_SOCK", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"].flatMap((key) => globalThis.process.env[key] ? [[key, globalThis.process.env[key]!]] : [])),
  }
  const child = Bun.spawn([input.program, ...input.args], {
    cwd: input.directory,
    env,
    stdin: input.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (input.input !== undefined) {
    if (!child.stdin) throw new Error("Command input stream unavailable")
    child.stdin.write(input.input)
    child.stdin.end()
  }
  const timeout = setTimeout(() => child.kill(), input.timeoutMs ?? 120_000)
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timeout)
  if (stdout.length > 16 * 1024 * 1024) throw new Error("Command output exceeds 16 MiB")
  return { exitCode, stdout, stderr: stderr.slice(0, outputLimit) }
}

async function discard(source: string, workspace: Orchestration.RunWorkspace, runID: Orchestration.RunID) {
  const worktrees = await command({ program: "git", directory: source, args: ["worktree", "list", "--porcelain"] })
  requireSuccess(worktrees, "List worktrees")
  const branches = worktrees.stdout.split("\n\n")
    .map((item) => ({ directory: item.match(/^worktree (.+)$/m)?.[1], branch: item.match(/^branch refs\/heads\/(.+)$/m)?.[1] }))
    .filter((item) => item.branch === workspace.runBranch || item.branch?.startsWith(`jewel/attempt/${runID}/`))
  for (const item of branches) if (item.directory) requireSuccess(await command({ program: "git", directory: source, args: ["worktree", "remove", item.directory] }), "Remove run worktree")
  const refs = await command({ program: "git", directory: source, args: ["for-each-ref", "--format=%(refname:short)", `refs/heads/jewel/attempt/${runID}/`] })
  requireSuccess(refs, "List attempt branches")
  for (const branch of [...refs.stdout.trim().split("\n").filter(Boolean), workspace.runBranch]) {
    const exists = await command({ program: "git", directory: source, args: ["rev-parse", "--verify", `refs/heads/${branch}`] })
    if (exists.exitCode === 0)
      requireSuccess(await command({ program: "git", directory: source, args: ["branch", "-D", branch] }), "Delete run branch")
  }
  return { branch: workspace.runBranch }
}
