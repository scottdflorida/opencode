import { DateTime, Effect, Option, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { OrchestrationRouting } from "@opencode-ai/core/orchestration/routing"
import { OrchestrationPolicy } from "@opencode-ai/core/orchestration/policy"
import { OrchestrationComparison } from "@opencode-ai/core/orchestration/comparison"
import { OrchestrationPlanGenerator } from "@opencode-ai/core/orchestration/generator"
import { OrchestrationScheduler } from "@opencode-ai/core/orchestration/scheduler"
import { OrchestrationIntegration } from "@opencode-ai/core/orchestration/integration"
import { Config } from "@opencode-ai/core/config"
import { ConfigOrchestration } from "@opencode-ai/core/config/orchestration"
import { TypedJudge } from "@opencode-ai/core/typed-judge"
import { Location } from "@opencode-ai/core/location"
import { Api } from "../api"
import { response } from "../location"
import {
  OrchestrationNotFoundError,
  OrchestrationOperationError,
  RouteProfileNotFoundError,
} from "@opencode-ai/protocol/groups/orchestration"

export const OrchestrationHandler = HttpApiBuilder.group(Api, "server.orchestration", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* OrchestrationScheduler.Service
    const projectDetails = Effect.gen(function* () {
      const orchestration = yield* Orchestration.Service
      const location = yield* Location.Service
      const runs = yield* orchestration.list({ projectID: location.project.id })
      return yield* Effect.forEach(runs, (run) => orchestration.get(run.id).pipe(Effect.orDie), { concurrency: 4 })
    })
    return handlers
      .handle("orchestration.list", () =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          return yield* response(orchestration.list({ projectID: location.project.id }))
        }),
      )
      .handle("orchestration.summaries", () => response(projectDetails.pipe(Effect.map((details) => details.map((detail) => {
        const latest = detail.deliveries.at(-1)
        const tasks = detail.tasks.filter((task) => task.status !== "cancelled")
        return {
          runID: detail.run.id,
          status: detail.run.status,
          acceptedTasks: tasks.filter((task) => task.status === "succeeded").length,
          totalTasks: tasks.length,
          attention: detail.humanRequests.find((request) => request.status === "open")?.prompt,
          pendingLabels: OrchestrationComparison.pendingLabels([detail]).length,
          unintegrated: detail.run.status === "delivered" && !!latest &&
            !detail.integrations.some((item) => item.deliveryID === latest.id && item.status === "completed"),
        }
      })))))
      .handle("orchestration.create", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          const run = yield* orchestration.create({
            projectID: location.project.id,
            project: { directory: location.project.directory, vcs: location.vcs },
            objective: ctx.payload.objective,
            policy: yield* resolvePolicy(ctx.payload.policy),
          })
          yield* scheduler.ensureSession({ runID: run.id, source: ref(location) }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(run.id).pipe(Effect.orDie))
        }),
      )
      .handle("orchestration.submit", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          const executionTrust = yield* Config.Service.use((config) =>
            config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration")?.execution_trust)),
          )
          if (executionTrust === "untrusted")
            return yield* new OrchestrationOperationError({
              name: "OrchestrationOperationError",
              data: { operation: "submit", message: "Untrusted orchestration requires an isolated worker, which is not configured on this host" },
            })
          const configured = yield* resolvePolicy(ctx.payload.policy)
          if (!configured)
            return yield* new OrchestrationOperationError({
              name: "OrchestrationOperationError",
              data: { operation: "policy", message: "Set a default policy or select one for this assignment" },
            })
          if (ctx.payload.judge === "llm" && !configured.roles.judge.routeProfile)
            return yield* new OrchestrationOperationError({
              name: "OrchestrationOperationError",
              data: { operation: "judge", message: "This policy has no LLM judge route profile" },
            })
          if (ctx.payload.judge === "experiment" && !configured.roles.judge.experiment)
            return yield* new OrchestrationOperationError({
              name: "OrchestrationOperationError",
              data: { operation: "judge", message: "This policy has no judge experiment" },
            })
          const policy = !ctx.payload.judge || ctx.payload.judge === "policy"
            ? configured
            : {
                ...configured,
                roles: {
                  ...configured.roles,
                  judge: {
                    provider: ctx.payload.judge,
                    routeProfile: ctx.payload.judge === "llm" ? configured.roles.judge.routeProfile : undefined,
                    experiment: ctx.payload.judge === "experiment" ? configured.roles.judge.experiment : undefined,
                    labelSampleRate: configured.roles.judge.labelSampleRate,
                  },
                },
              }
          const run = yield* orchestration.create({
            projectID: location.project.id,
            project: { directory: location.project.directory, vcs: location.vcs },
            objective: ctx.payload.objective,
            context: ctx.payload.context,
            policy: ctx.payload.minConfidence === undefined ? policy : {
              ...policy,
              acceptance: { ...policy.acceptance, minConfidence: ctx.payload.minConfidence },
            },
          })
          yield* scheduler.ensureSession({ runID: run.id, source: ref(location) }).pipe(mapSchedulerError)
          const plan = yield* generatePlanWithRetry({ runID: run.id }).pipe(mapPlanError)
          if ("kind" in plan) return yield* response(orchestration.get(run.id).pipe(Effect.orDie))
          if (policy.planApproval === "human") {
            yield* orchestration.openHumanRequest({
              runID: run.id,
              kind: "plan_approval",
              prompt: `Review plan ${plan.id} for this assignment, then approve or reject it.`,
              choices: ["approve", "reject"],
            }).pipe(Effect.orDie)
            return yield* response(orchestration.get(run.id).pipe(Effect.orDie))
          }
          yield* orchestration.applyPlan({ runID: run.id, planID: plan.id }).pipe(mapPlanError)
          yield* scheduler.start({ runID: run.id, source: ref(location) }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(run.id).pipe(Effect.orDie))
        }),
      )
      .handle("orchestration.policies", () =>
        Effect.gen(function* () {
          const configured = yield* Config.Service.use((config) =>
            config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration"))),
          )
          const profiles = yield* OrchestrationRouting.Service.use((routing) => routing.profiles)
          const policies = Object.keys(configured?.policies ?? {}).map((name) =>
            OrchestrationPolicy.resolve(name, configured ?? new ConfigOrchestration.Info({}), profiles),
          )
          const invalid = policies.find((policy) => policy.status === "error")
          if (invalid?.status === "error")
            return yield* new OrchestrationOperationError({
              name: "OrchestrationOperationError",
              data: { operation: "policy", message: invalid.message },
            })
          return yield* response(
            Effect.succeed({
              defaultPolicy: configured?.default_policy,
              policies: policies.flatMap((policy) => (policy.status === "resolved" ? [policy.policy] : [])),
            }),
          )
        }),
      )
      .handle("orchestration.capacity", () => OrchestrationRouting.Service.use((routing) => response(routing.capacity)))
      .handle("orchestration.jevStatus", () => Effect.gen(function* () {
        const configured = yield* Config.Service.use((config) =>
          config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration"))),
        )
        return yield* response(Effect.succeed({
          keyPresent: !!globalThis.process.env.TYPESAFE_API_KEY,
          model: configured?.judge?.model ?? "jev-latest",
        }))
      }))
      .handle("orchestration.testJev", () => Effect.gen(function* () {
        const result = Option.getOrUndefined(yield* TypedJudge.Service.use((judge) => judge.choice({
          purpose: "connection_test",
          state: { nonce: Date.now() },
          question: {
            instructions: "Choose the option named ready to verify this connection.",
            criteria: { ready: "The connection is working.", unavailable: "The connection failed." },
          },
          fallback: "unavailable",
        }, { authoritative: true })))
        return yield* response(Effect.succeed({
          status: result?.status ?? "unavailable",
          model: result?.model ?? "jev-latest",
          latencyMs: result?.latencyMs ?? 0,
        }))
      }))
      .handle("orchestration.verifyCheckPreset", (ctx) => Effect.gen(function* () {
        const location = yield* Location.Service
        const configured = yield* Config.Service.use((config) =>
          config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration"))),
        )
        const preset = configured?.check_presets?.[ctx.params.name]
        if (!preset) return yield* new OrchestrationNotFoundError({
          name: "OrchestrationNotFoundError", data: { resource: "check preset", id: ctx.params.name },
        })
        if (preset.checks.length < 1 || preset.checks.length > 16)
          return yield* new OrchestrationOperationError({
            name: "OrchestrationOperationError",
            data: { operation: "verify check preset", message: "A check preset must contain 1 to 16 checks" },
          })
        const results = yield* scheduler.verifyPreset({ source: ref(location), checks: preset.checks }).pipe(
          Effect.mapError((error) => new OrchestrationOperationError({
            name: "OrchestrationOperationError", data: { operation: "verify check preset", message: error.message },
          })),
        )
        return yield* response(Effect.succeed(results))
      }))
      .handle("orchestration.resources", () => OrchestrationRouting.Service.use((routing) => response(routing.resources)))
      .handle("orchestration.integrationTargets", (ctx) => Effect.gen(function* () {
        const orchestration = yield* Orchestration.Service
        const location = yield* Location.Service
        const detail = yield* owned(orchestration, location, ctx.params.runID)
        return yield* response(OrchestrationIntegration.targets(detail).pipe(Effect.mapError((error) =>
          new OrchestrationOperationError({
            name: "OrchestrationOperationError", data: { operation: "integration targets", message: error.message },
          }))))
      }))
      .handle("orchestration.compareJudges", (ctx) => response(projectDetails.pipe(
        Effect.map((details) => (ctx.query.role === "delivery" ? OrchestrationComparison.deliveryJudges : OrchestrationComparison.judges)(
          details.filter((detail) => !ctx.query.since || DateTime.toEpochMillis(detail.run.time.created) >= Date.parse(ctx.query.since)))),
      )))
      .handle("orchestration.comparePolicies", (ctx) => response(projectDetails.pipe(
        Effect.map((details) => OrchestrationComparison.policies(details.filter((detail) =>
          !ctx.query.since || DateTime.toEpochMillis(detail.run.time.created) >= Date.parse(ctx.query.since)))),
      )))
      .handle("orchestration.labels", () =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const details = yield* projectDetails
          const pending = OrchestrationComparison.pendingLabels(details)
          return yield* response(Effect.forEach(pending, (item) => orchestration.reviewPacket(item).pipe(Effect.orDie)))
        }),
      )
      .handle("orchestration.calibration", () =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          return yield* response(orchestration.calibration({ projectID: location.project.id }))
        }),
      )
      .handle("orchestration.routeProfiles", () =>
        OrchestrationRouting.Service.use((routing) => response(routing.profiles)),
      )
      .handle("orchestration.resolveRoute", (ctx) =>
        OrchestrationRouting.Service.use((routing) =>
          response(
            routing.resolve(ctx.payload.profile, ctx.payload.capabilityTier).pipe(
              Effect.mapError(
                (error) =>
                  new RouteProfileNotFoundError({
                    name: "RouteProfileNotFoundError",
                    data: { profile: error.profile },
                  }),
              ),
            ),
          ),
        ),
      )
      .handle("orchestration.addTask", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* orchestration.addTask({ runID: ctx.params.runID, ...ctx.payload }).pipe(mapNotFound)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.proposePlan", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* orchestration.proposePlan({ runID: ctx.params.runID, output: ctx.payload }).pipe(mapPlanError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.generatePlan", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* generatePlanWithRetry({ runID: ctx.params.runID, ...ctx.payload }).pipe(mapPlanError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.applyPlan", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          return yield* response(orchestration.applyPlan(ctx.params).pipe(mapPlanError))
        }),
      )
      .handle("orchestration.addDependency", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* orchestration.addDependency({ runID: ctx.params.runID, ...ctx.payload }).pipe(
            Effect.mapError((error) => {
              if (error instanceof Orchestration.NotFoundError) return mapNotFoundError(error)
              return new OrchestrationOperationError({
                name: "OrchestrationOperationError",
                data: {
                  operation: "dependency",
                  message:
                    error.reason === "self" ? "A task cannot depend on itself" : "Dependency would create a cycle",
                },
              })
            }),
          )
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.start", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.start({ runID: ctx.params.runID, source: ref(location) }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.cancel", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.cancel(ctx.params.runID).pipe(mapNotFound)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.integrationPreflight", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          return yield* response(scheduler.integrationPreflight({ runID: ctx.params.runID, options: ctx.payload }).pipe(mapSchedulerError))
        }),
      )
      .handle("orchestration.integrate", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.integrate({ runID: ctx.params.runID, options: ctx.payload }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.retryIntegration", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.retryIntegration(ctx.params).pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.followUp", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          const before = yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.followUp({ runID: ctx.params.runID, ...ctx.payload }).pipe(mapSchedulerError)
          if (before.run.status !== "delivered" || before.queuedFollowUps.some((item) => item.status === "queued"))
            return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
          const plan = yield* generatePlanWithRetry({ runID: ctx.params.runID }).pipe(mapPlanError)
          if ("kind" in plan) return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
          if (before.run.policy?.planApproval === "human") {
            yield* orchestration.openHumanRequest({
              runID: ctx.params.runID,
              kind: "plan_approval",
              prompt: `Review follow-up plan ${plan.id}, then approve or reject it.`,
              choices: ["approve", "reject"],
            }).pipe(mapNotFound)
            return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
          }
          yield* orchestration.applyPlan({ runID: ctx.params.runID, planID: plan.id }).pipe(mapPlanError)
          yield* scheduler.start({ runID: ctx.params.runID, source: ref(location) }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.steerFollowUp", (ctx) => Effect.gen(function* () {
        const orchestration = yield* Orchestration.Service
        const location = yield* Location.Service
        yield* owned(orchestration, location, ctx.params.runID)
        yield* scheduler.steerFollowUp({ ...ctx.params, source: ref(location) }).pipe(mapSchedulerError)
        return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
      }))
      .handle("orchestration.reviewPacket", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          return yield* response(orchestration.reviewPacket(ctx.params).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.labelTriage", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          const packet = yield* orchestration.reviewPacket(ctx.params).pipe(mapNotFound)
          return yield* response(
            orchestration
              .recordTriageLabel({
                runID: ctx.params.runID,
                taskID: ctx.params.taskID,
                attemptID: packet.attempt.id,
                ...ctx.payload,
              })
              .pipe(
                Effect.mapError((error) => {
                  if (error instanceof Orchestration.NotFoundError) return mapNotFoundError(error)
                  return new OrchestrationOperationError({
                    name: "OrchestrationOperationError",
                    data: {
                      operation: "triage",
                      message:
                        error.reason === "already_labeled"
                          ? "Attempt already has a triage label"
                          : "Attempt is not ready for triage",
                    },
                  })
                }),
              ),
          )
        }),
      )
      .handle("orchestration.accept", (ctx) => review(scheduler, ctx, "accepted"))
      .handle("orchestration.reject", (ctx) => review(scheduler, ctx, "rejected"))
      .handle("orchestration.reopen", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler.reopen({ ...ctx.params, feedback: ctx.payload.feedback, source: ref(location) }).pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.answerRequest", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          const before = yield* owned(orchestration, location, ctx.params.runID)
          const request = before.humanRequests.find((item) => item.id === ctx.params.requestID)
          yield* scheduler
            .answerRequest({
              runID: ctx.params.runID,
              requestID: ctx.params.requestID,
              answer: ctx.payload.answer,
              source: ref(location),
            })
            .pipe(mapSchedulerError)
          const detail = yield* orchestration.get(ctx.params.runID).pipe(mapNotFound)
          if (
            request?.kind === "clarification" &&
            !request.taskID &&
            detail.run.status === "clarifying" &&
            !detail.humanRequests.some((item) => item.kind === "clarification" && !item.taskID && item.status === "open")
          ) {
            const context = detail.humanRequests
              .filter((item) =>
                item.kind === "clarification" &&
                !item.taskID &&
                item.status === "answered" &&
                (!detail.followUps.at(-1) || DateTime.toEpochMillis(item.time.created) >= DateTime.toEpochMillis(detail.followUps.at(-1)!.time)),
              )
              .map((item) => `Question: ${item.prompt}\nAnswer: ${item.answer}`)
              .join("\n\n")
            const plan = yield* generatePlanWithRetry({ runID: ctx.params.runID, context }).pipe(mapPlanError)
            if ("kind" in plan || !detail.run.policy)
              return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
            if (detail.run.policy.planApproval === "human") {
              yield* orchestration.openHumanRequest({
                runID: ctx.params.runID,
                kind: "plan_approval",
                prompt: `Review plan ${plan.id} for this assignment, then approve or reject it.`,
                choices: ["approve", "reject"],
              }).pipe(mapNotFound)
              return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
            }
            yield* orchestration.applyPlan({ runID: ctx.params.runID, planID: plan.id }).pipe(mapPlanError)
            yield* scheduler.start({ runID: ctx.params.runID, source: ref(location) }).pipe(mapSchedulerError)
          }
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.retry", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          yield* scheduler
            .retry({ runID: ctx.params.runID, taskID: ctx.params.taskID, source: ref(location) })
            .pipe(mapSchedulerError)
          return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
        }),
      )
      .handle("orchestration.get", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          return yield* response(
            orchestration.get(ctx.params.runID).pipe(
              Effect.filterOrFail(
                (detail) => detail.run.projectID === location.project.id,
                () => new Orchestration.NotFoundError({ resource: "run", id: ctx.params.runID }),
              ),
              Effect.mapError(
                (error) =>
                  new OrchestrationNotFoundError({
                    name: "OrchestrationNotFoundError",
                    data: { resource: error.resource, id: error.id },
                  }),
              ),
            ),
          )
        }),
      )
      .handle("orchestration.history", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          return yield* response(orchestration.history({
            runID: ctx.params.runID,
            after: ctx.query.after,
            limit: ctx.query.limit ?? 50,
          }).pipe(mapNotFound, Effect.map((page) => ({ data: page.events, hasMore: page.hasMore }))))
        }),
      )
      .handle("orchestration.events", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          yield* owned(orchestration, location, ctx.params.runID)
          return orchestration.events({ runID: ctx.params.runID, after: ctx.query.after }).pipe(Stream.orDie)
        }),
      )
  }),
)

function review(
  scheduler: OrchestrationScheduler.Interface,
  ctx: {
    readonly params: { readonly runID: Orchestration.RunID; readonly taskID: Orchestration.TaskID }
    readonly payload: { readonly note?: string }
  },
  decision: "accepted" | "rejected",
) {
  return Effect.gen(function* () {
    const orchestration = yield* Orchestration.Service
    const location = yield* Location.Service
    yield* owned(orchestration, location, ctx.params.runID)
    yield* scheduler
      .review({
        runID: ctx.params.runID,
        taskID: ctx.params.taskID,
        decision,
        note: ctx.payload.note,
        source: ref(location),
      })
      .pipe(mapSchedulerError)
    return yield* response(orchestration.get(ctx.params.runID).pipe(mapNotFound))
  })
}

function ref(location: Location.Interface) {
  return Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
}

function resolvePolicy(name?: string) {
  return Effect.gen(function* () {
    const configured = yield* Config.Service.use((config) =>
      config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration"))),
    )
    const selected = name ?? configured?.default_policy
    if (!selected) return undefined
    const resolution = OrchestrationPolicy.resolve(
      selected,
      configured ?? new ConfigOrchestration.Info({}),
      yield* OrchestrationRouting.Service.use((routing) => routing.profiles),
    )
    if (resolution.status === "resolved") return resolution.policy
    return yield* new OrchestrationOperationError({
      name: "OrchestrationOperationError",
      data: { operation: "policy", message: resolution.message },
    })
  })
}

function generatePlanWithRetry(input: {
  readonly runID: Orchestration.RunID
  readonly profile?: string
  readonly context?: string
}) {
  return OrchestrationPlanGenerator.Service.use((generator) =>
    generator.generate(input).pipe(
      Effect.catchTag("Orchestration.InvalidPlanError", (error) =>
        generator.generate({
          ...input,
          context: [input.context, `Your previous plan was invalid: ${error.message}. Return a corrected plan.`]
            .filter(Boolean)
            .join("\n\n")
            .slice(0, 12_000),
        }),
      ),
    ),
  )
}

function owned(orchestration: Orchestration.Interface, location: Location.Interface, runID: Orchestration.RunID) {
  return orchestration.get(runID).pipe(
    Effect.filterOrFail(
      (detail) => detail.run.projectID === location.project.id,
      () => new Orchestration.NotFoundError({ resource: "run", id: runID }),
    ),
    mapNotFound,
  )
}

function mapNotFound<A, R>(effect: Effect.Effect<A, Orchestration.NotFoundError, R>) {
  return effect.pipe(Effect.mapError(mapNotFoundError))
}

function mapNotFoundError(error: Orchestration.NotFoundError) {
  return new OrchestrationNotFoundError({
    name: "OrchestrationNotFoundError",
    data: { resource: error.resource, id: error.id },
  })
}

function mapSchedulerError<A, R>(
  effect: Effect.Effect<A, Orchestration.NotFoundError | OrchestrationScheduler.OperationError, R>,
) {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof Orchestration.NotFoundError)
        return new OrchestrationNotFoundError({
          name: "OrchestrationNotFoundError",
          data: { resource: error.resource, id: error.id },
        })
      return new OrchestrationOperationError({
        name: "OrchestrationOperationError",
        data: { operation: error.operation, message: error.message },
      })
    }),
  )
}

function mapPlanError<A, R>(
  effect: Effect.Effect<
    A,
    Orchestration.NotFoundError | Orchestration.InvalidPlanError | OrchestrationPlanGenerator.GenerationError,
    R
  >,
) {
  return effect.pipe(
    Effect.mapError((error) => {
      if (error instanceof Orchestration.NotFoundError) return mapNotFoundError(error)
      return new OrchestrationOperationError({
        name: "OrchestrationOperationError",
        data: { operation: "plan", message: error.message },
      })
    }),
  )
}
