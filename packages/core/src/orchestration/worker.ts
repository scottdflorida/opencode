export * as OrchestrationWorker from "./worker"

import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Duration, Effect, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { AbsolutePath } from "../schema"
import { AppProcess } from "../process"
import { OrchestrationCheck } from "./check"

const maximumSnapshotBytes = 32 * 1024 * 1024
const maximumEvidenceBytes = 128 * 1024
const image = "oven/bun@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0"

export class WorkerError extends Schema.TaggedErrorClass<WorkerError>()("Orchestration.WorkerError", {
  message: Schema.String,
}) {}

export function runCheck(process: AppProcess.Interface, check: Orchestration.Check, directory: AbsolutePath) {
  return Effect.gen(function* () {
    const cwd = yield* Effect.try({
      try: () => OrchestrationCheck.directory(directory, check),
      catch: (error) => new WorkerError({ message: error instanceof Error ? error.message : String(error) }),
    })
    const snapshot = yield* process.run(ChildProcess.make("tar", [
      "-cf", "-", "--exclude=.git", "--exclude=node_modules", "--exclude=.env*", "--exclude=**/.env*",
      "-C", directory, ".",
    ], { stdin: "ignore", env: { PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" }, extendEnv: false }), {
      timeout: Duration.seconds(30), maxOutputBytes: maximumSnapshotBytes, maxErrorBytes: 4_096,
    }).pipe(Effect.mapError((error) => new WorkerError({ message: error.message })))
    if (snapshot.exitCode !== 0 || snapshot.stdoutTruncated)
      return yield* new WorkerError({
        message: snapshot.stdoutTruncated ? "Worker snapshot exceeds 32 MiB" : snapshot.stderr.toString("utf8") || "Worker snapshot failed",
      })
    const socket = `unix://${path.join(os.homedir(), ".colima", "jewelcode", "docker.sock")}`
    const name = `jewel-check-${randomUUID()}`
    const env = {
      PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin",
      DOCKER_CONFIG: path.join(os.tmpdir(), "opencode-worker-docker-config"),
    }
    const result = yield* process.run(ChildProcess.make("docker", [
      "--host", socket,
      "run", "--rm", "--name", name, "--interactive", "--pull=never", "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=1",
      "--user=65534:65534", "--tmpfs=/workspace:rw,exec,nosuid,mode=1777,size=512m", "--tmpfs=/tmp:rw,noexec,nosuid,mode=1777,size=64m",
      "--workdir=/workspace", "--env=HOME=/tmp", image, "sh", "-ec",
      "tar -xf - -C /workspace; cd \"/workspace/$1\"; exec /bin/sh -c \"$2\"", "--", path.relative(directory, cwd), check.command,
    ], {
      stdin: "ignore",
      env,
      extendEnv: false,
    }), {
      stdin: snapshot.stdout,
      timeout: Duration.seconds(check.timeoutSeconds ?? 300),
      maxOutputBytes: maximumEvidenceBytes,
      maxErrorBytes: maximumEvidenceBytes,
    }).pipe(
      Effect.ensuring(process.run(ChildProcess.make("docker", ["--host", socket, "rm", "--force", name], {
        stdin: "ignore", env, extendEnv: false,
      }), { timeout: Duration.seconds(10), maxOutputBytes: 512, maxErrorBytes: 512 }).pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      )),
      Effect.mapError((error) => new WorkerError({
        message: error.cause instanceof Error && error.cause.message === "Timed out"
          ? `Worker check timed out after ${check.timeoutSeconds ?? 300} seconds`
          : error.stderr || "Worker runtime failed",
      })),
    )
    if (result.exitCode === 125)
      return yield* new WorkerError({ message: result.stderr.toString("utf8") || "Worker runtime failed" })
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
      truncated: result.stdoutTruncated || result.stderrTruncated,
    }
  })
}
