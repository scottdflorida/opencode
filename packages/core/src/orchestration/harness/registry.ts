export * as OrchestrationHarnessRegistry from "./registry"

import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import path from "path"
import { ChildProcess } from "effect/unstable/process"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { makeGlobalNode } from "../../effect/app-node"
import { AppProcess } from "../../process"
import { HarnessEnvironment } from "./environment"

export interface Interface {
  readonly latest: Effect.Effect<Orchestration.HarnessSnapshot>
  readonly refresh: Effect.Effect<Orchestration.HarnessSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationHarnessRegistry") {}

const ClaudeAuth = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean })))
const CodexCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  client_version: Schema.String,
  fetched_at: Schema.String,
  models: Schema.Array(Schema.Struct({
    slug: Schema.String,
    visibility: Schema.String,
    supported_reasoning_levels: Schema.Array(Schema.Struct({ effort: Schema.String })),
  })),
})))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const state = yield* Ref.make<Orchestration.HarnessSnapshot>({
      schema: 1,
      source: "host",
      capturedAt: yield* DateTime.now,
      harnesses: [{ id: "codex", state: "unknown" }],
    })
    const refresh = Effect.gen(function* () {
      const capturedAt = yield* DateTime.now
      const version = yield* process
        .run(
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
        .pipe(Effect.option)
      const authenticated =
        version?._tag === "Some" && version.value.exitCode === 0
          ? yield* process
              .run(
                ChildProcess.make("codex", ["login", "status"], {
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
              .pipe(Effect.option)
          : undefined
      const codexCatalogText = authenticated?._tag === "Some" && authenticated.value.exitCode === 0
        ? yield* Effect.tryPromise({
            try: () => Bun.file(path.join(globalThis.process.env.CODEX_HOME ?? path.join(globalThis.process.env.HOME ?? "", ".codex"), "models_cache.json")).text(),
            catch: (error) => error instanceof Error ? error : new Error(String(error)),
          }).pipe(Effect.option)
        : undefined
      const codexCatalog = codexCatalogText?._tag === "Some"
        ? Option.getOrUndefined(CodexCatalog(codexCatalogText.value))
        : undefined
      const codexCacheAge = codexCatalog ? Date.now() - Date.parse(codexCatalog.fetched_at) : Number.POSITIVE_INFINITY
      const codexModelCatalog = codexCatalog && version?._tag === "Some" &&
        codexCacheAge >= -300_000 && codexCacheAge <= 86_400_000
        ? codexCatalog.models.filter((model) => model.visibility === "list")
        : []
      const claudeVersion = yield* process
        .run(
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
        .pipe(Effect.option)
      const claudeAuth =
        claudeVersion?._tag === "Some" && claudeVersion.value.exitCode === 0
          ? yield* process
              .run(
                ChildProcess.make("claude", ["auth", "status", "--json"], {
                  stdin: "ignore",
                  env: HarnessEnvironment.make(),
                  extendEnv: false,
                }),
                {
                  timeout: "10 seconds",
                  maxOutputBytes: 1024,
                  maxErrorBytes: 256,
                },
              )
              .pipe(Effect.option)
          : undefined
      const claudeHelp = claudeAuth?._tag === "Some" && claudeAuth.value.exitCode === 0
        ? yield* process.run(ChildProcess.make("claude", ["--help"], {
            stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false,
          }), { timeout: "10 seconds", maxOutputBytes: 32 * 1024, maxErrorBytes: 256 }).pipe(Effect.option)
        : undefined
      const claudeEfforts = claudeHelp?._tag === "Some" && !claudeHelp.value.stdoutTruncated
        ? claudeHelp.value.stdout.toString("utf8").match(/--effort <level>[^\n]*\n\s*\(([^)]+)\)/)?.[1]
          ?.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined
      const cursorVersion = yield* process
        .run(
          ChildProcess.make("cursor-agent", ["--version"], {
            stdin: "ignore",
            env: HarnessEnvironment.make(),
            extendEnv: false,
          }),
          { timeout: "10 seconds", maxOutputBytes: 256, maxErrorBytes: 256 },
        )
        .pipe(Effect.option)
      const cursorAuth =
        cursorVersion?._tag === "Some" && cursorVersion.value.exitCode === 0
          ? yield* process
              .run(
                ChildProcess.make("cursor-agent", ["status"], {
                  stdin: "ignore",
                  env: HarnessEnvironment.make(),
                  extendEnv: false,
                }),
                { timeout: "10 seconds", maxOutputBytes: 512, maxErrorBytes: 256 },
              )
              .pipe(Effect.option)
          : undefined
      const cursorModels =
        cursorAuth?._tag === "Some" && cursorAuth.value.exitCode === 0
          ? yield* process.run(ChildProcess.make("cursor-agent", ["--list-models"], {
              stdin: "ignore",
              env: HarnessEnvironment.make(),
              extendEnv: false,
            }), { timeout: "10 seconds", maxOutputBytes: 64 * 1024, maxErrorBytes: 256 }).pipe(Effect.option)
          : undefined
      const modelIDs = cursorModels?._tag === "Some" && cursorModels.value.exitCode === 0 && !cursorModels.value.stdoutTruncated
        ? cursorModels.value.stdout.toString("utf8").split(/\r?\n/).map((line) =>
            line.trim().replace(/^[-*]\s+/, "").split(/\s+/)[0] ?? "",
          ).filter((model) => /^[a-z0-9][a-z0-9._/-]{1,100}$/i.test(model))
        : []
      const copilotVersion = yield* process
        .run(
          ChildProcess.make("copilot", ["--version"], {
            stdin: "ignore",
            env: HarnessEnvironment.make(),
            extendEnv: false,
          }),
          { timeout: "10 seconds", maxOutputBytes: 256, maxErrorBytes: 256 },
        )
        .pipe(Effect.option)
      const copilotHelp = copilotVersion?._tag === "Some" && copilotVersion.value.exitCode === 0
        ? yield* process.run(ChildProcess.make("copilot", ["--help"], {
            stdin: "ignore", env: HarnessEnvironment.make(), extendEnv: false,
          }), { timeout: "10 seconds", maxOutputBytes: 32 * 1024, maxErrorBytes: 256 }).pipe(Effect.option)
        : undefined
      const copilotEfforts = copilotHelp?._tag === "Some" && !copilotHelp.value.stdoutTruncated
        ? copilotHelp.value.stdout.toString("utf8").match(/--reasoning-effort <level>[\s\S]{0,200}?\[possible values: ([^\]]+)\]/)?.[1]
          ?.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined
      const snapshot: Orchestration.HarnessSnapshot = {
        schema: 1,
        source: "host",
        capturedAt,
        harnesses: [
          {
            id: "codex",
            state:
              version?._tag !== "Some" || version.value.exitCode !== 0
                ? "not_installed"
                : authenticated?._tag === "Some" && authenticated.value.exitCode === 0 && codexModelCatalog.length > 0
                  ? "available"
                  : authenticated?._tag === "Some" && authenticated.value.exitCode === 0 ? "unknown" : "unauthenticated",
            version: version?._tag === "Some" ? version.value.stdout.toString("utf8").trim() : undefined,
            models: codexModelCatalog.length ? codexModelCatalog.map((model) => model.slug) : undefined,
            modelEfforts: codexModelCatalog.length ? Object.fromEntries(codexModelCatalog.map((model) =>
              [model.slug, model.supported_reasoning_levels.map((level) => level.effort)])) : undefined,
          },
          {
            id: "claude",
            state:
              claudeVersion?._tag !== "Some" || claudeVersion.value.exitCode !== 0
                ? "not_installed"
                : claudeAuth?._tag === "Some" &&
                    claudeAuth.value.exitCode === 0 &&
                    Option.getOrUndefined(ClaudeAuth(claudeAuth.value.stdout.toString("utf8")))?.loggedIn
                  ? "available"
                  : "unauthenticated",
            version: claudeVersion?._tag === "Some" ? claudeVersion.value.stdout.toString("utf8").trim() : undefined,
            efforts: claudeEfforts,
          },
          {
            id: "cursor",
            state:
              cursorVersion?._tag !== "Some" || cursorVersion.value.exitCode !== 0
                ? "not_installed"
                : cursorAuth?._tag === "Some" && cursorAuth.value.exitCode === 0 && modelIDs.length > 0
                  ? "available"
                  : cursorAuth?._tag === "Some" && cursorAuth.value.exitCode === 0 ? "unknown" : "unauthenticated",
            version: cursorVersion?._tag === "Some" ? cursorVersion.value.stdout.toString("utf8").trim() : undefined,
            models: modelIDs.length ? modelIDs : undefined,
          },
          {
            id: "copilot",
            // Copilot exposes no non-billable CLI status command that verifies its account and entitlement.
            state: copilotVersion?._tag === "Some" && copilotVersion.value.exitCode === 0 ? "unknown" : "not_installed",
            version: copilotVersion?._tag === "Some" ? copilotVersion.value.stdout.toString("utf8").trim() : undefined,
            efforts: copilotEfforts,
          },
        ],
      }
      yield* Ref.set(state, snapshot)
      return snapshot
    })
    yield* refresh
    yield* Effect.sleep("5 minutes").pipe(Effect.andThen(refresh), Effect.forever, Effect.forkScoped)
    return Service.of({ latest: Ref.get(state), refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
