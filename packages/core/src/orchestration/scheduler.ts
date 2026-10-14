export * as OrchestrationScheduler from "./scheduler"

import { Cause, Context, DateTime, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { Agent } from "@opencode-ai/schema/agent"
import {
  Attempt,
  AttemptID,
  Check,
  Delivery,
  Detail,
  Events,
  HumanRequestID,
  IntegrationOptions,
  IntegrationPreflight,
  IntegrationID,
  PlanTask,
  ReassignmentOption,
  ReviewDecision,
  RouteDecisionID,
  Run,
  RunID,
  Task,
  TaskID,
  TurnID,
} from "@opencode-ai/schema/orchestration"
import { Config } from "../config"
import { ConfigOrchestration } from "../config/orchestration"
import { AppProcess } from "../process"
import { Global } from "../global"
import { AbsolutePath } from "../schema"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { LocationServiceMap } from "../location-service-map"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { EventV2 } from "../event"
import { TypedJudge } from "../typed-judge"
import { Orchestration } from "../orchestration"
import { OrchestrationExecutor } from "./executor"
import { OrchestrationCapacity } from "./capacity"
import { OrchestrationRouting } from "./routing"
import { OrchestrationJudge } from "./judge"
import { OrchestrationFeedback } from "./feedback"
import { OrchestrationDelivery } from "./delivery"
import { OrchestrationPlanGenerator } from "./generator"
import { OrchestrationIntegration } from "./integration"

const maximumJudgmentTextCharacters = 8_000
const maximumJudgmentEvaluations = 64

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("Orchestration.OperationError", {
  operation: Schema.Literals(["start", "cancel", "accept", "reject", "retry", "answer", "integrate", "follow_up", "check"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly verifyPreset: (input: {
    readonly source: Location.Ref
    readonly checks: ReadonlyArray<Check>
  }) => Effect.Effect<ReadonlyArray<{ name: string; exitCode: number; stdout: string; stderr: string; truncated: boolean }>, OperationError>
  readonly start: (input: {
    readonly runID: RunID
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly cancel: (runID: RunID) => Effect.Effect<void, Orchestration.NotFoundError>
  readonly review: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly decision: ReviewDecision
    readonly note?: string
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly retry: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly reopen: (input: {
    readonly runID: RunID
    readonly taskID: TaskID
    readonly feedback: string
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly answerRequest: (input: {
    readonly runID: RunID
    readonly requestID: HumanRequestID
    readonly answer: string
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly integrationPreflight: (input: {
    readonly runID: RunID
    readonly options: IntegrationOptions
  }) => Effect.Effect<IntegrationPreflight, Orchestration.NotFoundError | OperationError>
  readonly integrate: (input: {
    readonly runID: RunID
    readonly options: IntegrationOptions
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly retryIntegration: (input: {
    readonly runID: RunID
    readonly integrationID: IntegrationID
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly followUp: (input: {
    readonly runID: RunID
    readonly objective: string
    readonly context?: string
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly steerFollowUp: (input: {
    readonly runID: RunID
    readonly turnID: TurnID
    readonly source: Location.Ref
  }) => Effect.Effect<void, Orchestration.NotFoundError | OperationError>
  readonly ensureSession: (input: {
    readonly runID: RunID
    readonly source: Location.Ref
  }) => Effect.Effect<SessionV2.ID, Orchestration.NotFoundError | OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OrchestrationScheduler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const orchestration = yield* Orchestration.Service
    const executor = yield* OrchestrationExecutor.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const process = yield* AppProcess.Service
    const global = yield* Global.Service
    const scope = yield* Scope.Scope
    const sources = new Map<RunID, Location.Ref>()
    const timers = new Map<RunID, Fiber.Fiber<void>>()
    const integrationLocks = KeyedMutex.makeUnsafe<RunID>()
    const timelineLocks = KeyedMutex.makeUnsafe<RunID>()
    const syncTimeline = Effect.fn("OrchestrationScheduler.syncTimeline")((runID: RunID) =>
      timelineLocks.withLock(runID)(Effect.gen(function* () {
        const detail = yield* orchestration.get(runID)
        const run = detail.run
        if (!run.sessionID) return
        let after: number | undefined
        let planCount = 0
        let plannedTasks: readonly PlanTask[] = []
        let hasTask = false
        const proposedTasks = new Map<string, readonly PlanTask[]>()
        const taskKeys = new Map<TaskID, string>()
        const taskCards = new Map<TaskID, SessionMessage.ID>()
        const humanCards = new Map<HumanRequestID, SessionMessage.ID>()
        while (true) {
          const page = yield* orchestration.history({ runID, after, limit: 100 })
          for (const event of page.events) {
            after = event.durable!.seq
            const id = SessionMessage.ID.make(`msg_orch_evt_${event.id}`)
            if (event.type === "orchestration.follow-up.started") {
              planCount = 0
              plannedTasks = []
              hasTask = false
              yield* sessions.appendControllerUser({ sessionID: run.sessionID, id, text: event.data.objective })
            }
            if (event.type === "orchestration.follow-up.steered") {
              const queued = detail.queuedFollowUps.find((item) => item.id === event.data.turnID)
              if (queued) yield* sessions.appendControllerUser({
                sessionID: run.sessionID, id, text: `Guidance for the current turn: ${queued.objective}`,
              })
            }
            if (event.type === "orchestration.plan.proposed") {
              const before = plannedTasks
              const cancelled = (event.data.output.cancelTaskIDs ?? []).flatMap((taskID) => {
                const task = detail.tasks.find((item) => item.id === taskID)
                return task ? [{ id: taskID, title: task.title }] : []
              })
              const after = [...plannedTasks.filter((task) =>
                ![...taskKeys].some(([id, key]) => key === task.key && cancelled.some((item) => item.id === id))),
                ...event.data.output.tasks]
              proposedTasks.set(event.data.planID, event.data.output.tasks)
              const replan = planCount++ > 0 || hasTask
              yield* sessions.appendControllerPart({
                sessionID: run.sessionID, id,
                kind: replan ? "replan" : "plan",
                title: replan ? "Replanned" : "Plan",
                summary: replan ? `+${event.data.output.tasks.length} proposed tasks${cancelled.length ? ` · ${cancelled.length} cancelled` : ""}` : `${event.data.output.tasks.length} tasks proposed`,
                detail: { planID: event.data.planID, output: event.data.output, before, after, cancelled },
              })
            }
            if (event.type === "orchestration.task.added") {
              hasTask = true
              taskCards.set(event.data.taskID, id)
              yield* sessions.appendControllerPart({
                sessionID: run.sessionID, id,
                kind: "task", title: event.data.title, summary: event.data.description ?? event.data.title,
                detail: { taskID: event.data.taskID, kind: event.data.kind ?? "agent" },
              })
            }
            if (event.type === "orchestration.plan.applied") {
              event.data.tasks.forEach((task) => taskKeys.set(task.taskID, task.key))
              const cancelled = new Set(event.data.cancelTaskIDs ?? [])
              plannedTasks = [...plannedTasks.filter((task) =>
                ![...taskKeys].some(([id, key]) => key === task.key && cancelled.has(id))),
                ...(proposedTasks.get(event.data.planID) ?? [])]
              hasTask = true
              yield* Effect.forEach(event.data.tasks, (planned) => {
                if (taskCards.has(planned.taskID)) return Effect.void
                const task = detail.tasks.find((item) => item.id === planned.taskID)
                if (!task) return Effect.void
                const id = SessionMessage.ID.make(`msg_orch_plan_task_${planned.taskID}`)
                taskCards.set(planned.taskID, id)
                return sessions.appendControllerPart({
                  sessionID: run.sessionID!, id,
                  kind: "task", title: task.title, summary: task.description ?? task.title,
                  detail: { taskID: task.id, kind: task.kind },
                })
              }, { discard: true })
            }
            if (event.type === "orchestration.human.requested") {
              humanCards.set(event.data.requestID, id)
              yield* sessions.appendControllerPart({
                sessionID: run.sessionID, id,
                kind: event.data.kind === "clarification" ? "clarification" : "human_request",
                title: event.data.kind === "clarification" ? "Question" : "Waiting on you",
                summary: event.data.prompt,
                detail: { requestID: event.data.requestID, taskID: event.data.taskID, choices: event.data.choices, assumption: event.data.assumption },
              })
            }
            if (event.type === "orchestration.delivery.reviewed") {
              yield* sessions.appendControllerPart({
                sessionID: run.sessionID, id,
                kind: "delivery_review", title: "Delivery review",
                summary: `${event.data.review.decision} · ${event.data.changedFiles} files`,
                detail: { deliveryID: event.data.deliveryID, review: event.data.review, baseHead: event.data.baseHead, head: event.data.head },
              })
            }
            if (event.type === "orchestration.delivery.summarized") {
              yield* sessions.appendControllerText({
                sessionID: run.sessionID,
                id: SessionMessage.ID.make(`msg_delivery_${event.data.deliveryID}`),
                text: event.data.summary,
                kind: "summary",
              })
            }
            if (event.type === "orchestration.integration.finished") {
              yield* sessions.appendControllerPart({
                sessionID: run.sessionID, id,
                kind: "integration", title: "Integration",
                summary: `Integration ${event.data.status}`,
                detail: { integrationID: event.data.integrationID, status: event.data.status },
              })
            }
          }
          if (!page.hasMore) break
        }
        yield* Effect.forEach([...taskCards], ([taskID, id]) => {
          const task = detail.tasks.find((item) => item.id === taskID)
          if (!task) return Effect.void
          const attempts = detail.attempts.filter((attempt) => attempt.taskID === taskID)
          return sessions.updateControllerPart({
            sessionID: run.sessionID!, id, title: task.title,
            summary: `${task.status.replaceAll("_", " ")} · ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}${task.capabilityTier ? ` · ${task.capabilityTier}` : ""}`,
            detail: {
              taskID,
              status: task.status,
              kind: task.kind,
              capabilityTier: task.capabilityTier,
              acceptanceCriteria: task.acceptanceCriteria.map((item) => ({ key: item.key, description: item.description })),
              attempts: attempts.map((attempt) => ({
                id: attempt.id,
                status: attempt.status,
                candidate: attempt.candidate?.id,
                sessionID: attempt.sessionID,
                decision: attempt.verdict?.decision,
                confidence: attempt.verdict?.confidence,
                feedback: attempt.feedback?.text,
              })),
            },
          })
        }, { discard: true })
        yield* Effect.forEach([...humanCards], ([requestID, id]) => {
          const request = detail.humanRequests.find((item) => item.id === requestID)
          if (!request) return Effect.void
          return sessions.updateControllerPart({
            sessionID: run.sessionID!, id,
            title: request.kind === "clarification" ? "Question" : "Waiting on you",
            summary: `${request.status === "answered" ? "Answered" : "Waiting"} · ${request.prompt}`,
            detail: { requestID, taskID: request.taskID, status: request.status, prompt: request.prompt,
              choices: request.choices, assumption: request.assumption, answer: request.answer },
          })
        }, { discard: true })
      })),
    )
    const ensureRoot = Effect.fn("OrchestrationScheduler.ensureRoot")(function* (
      detail: Detail,
      source: Location.Ref,
    ) {
      if (detail.run.sessionID) return detail.run.sessionID
      const session = yield* sessions.create({
        id: SessionV2.ID.make(`ses_orch_${detail.run.id}`),
        agent: Agent.ID.make("orchestrate"),
        kind: "orchestration",
        title: `Run: ${detail.run.objective.slice(0, 80)}`,
        location: source,
      })
      yield* sessions.appendControllerUser({
        sessionID: session.id,
        id: SessionMessage.ID.make(`msg_orch_${detail.run.id}`),
        text: detail.run.objective,
      }).pipe(Effect.orDie)
      yield* orchestration.linkRunSession({ runID: detail.run.id, sessionID: session.id })
      yield* syncTimeline(detail.run.id).pipe(Effect.orDie)
      return session.id
    })
    // The coordinator is created after its drain callback, so the timer receives its wake function afterward.
    let wake: (runID: RunID) => Effect.Effect<void> = () => Effect.void

    const recordShadowJudgment = Effect.fn("OrchestrationScheduler.recordShadowJudgment")(function* (
      run: Run,
      task: Task,
      attemptID: AttemptID,
      candidate: NonNullable<Attempt["candidate"]>,
      evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>,
      source: Location.Ref,
    ) {
      const request = attemptReviewRequest(run, task, candidate, evaluations)
      const result = yield* TypedJudge.Service.use((judge) => judge.choice(request)).pipe(
        Effect.provide(locations.get(source)),
      )
      if (Option.isNone(result)) return
      yield* orchestration.recordJudgment({
        runID: run.id,
        taskID: task.id,
        attemptID,
        mode: "shadow",
        request,
        result: result.value,
      })
    })

    const scheduleShadowJudgment = (
      run: Run,
      task: Task,
      attemptID: AttemptID,
      candidate: NonNullable<Attempt["candidate"]>,
      evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>,
      source: Location.Ref,
    ) =>
      recordShadowJudgment(run, task, attemptID, candidate, evaluations, source).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Shadow judgment failed", cause).pipe(
            Effect.annotateLogs({ runID: run.id, taskID: task.id, attemptID }),
          ),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )

    const recordShadowTierRecommendation = Effect.fn("OrchestrationScheduler.recordShadowTierRecommendation")(
      function* (run: Run, task: Task, decisionID: RouteDecisionID, source: Location.Ref) {
        const policy = yield* Config.Service.use((config) =>
          config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration")?.tier_classifier)),
        ).pipe(Effect.provide(locations.get(source)))
        if (policy?.mode !== "shadow") return
        const request = tierRecommendationRequest(run, task, policy)
        if (!request) {
          yield* Effect.logWarning("Invalid tier classifier policy").pipe(
            Effect.annotateLogs({ runID: run.id, taskID: task.id }),
          )
          return
        }
        const result = yield* TypedJudge.Service.use((judge) => judge.choice(request)).pipe(
          Effect.provide(locations.get(source)),
        )
        if (Option.isNone(result)) return
        yield* orchestration.recordTierRecommendation({
          runID: run.id,
          taskID: task.id,
          routeDecisionID: decisionID,
          explicitTier: task.capabilityTier,
          request,
          result: result.value,
        })
      },
    )

    const scheduleShadowTier = (run: Run, task: Task, decisionID: RouteDecisionID, source: Location.Ref) =>
      recordShadowTierRecommendation(run, task, decisionID, source).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Shadow tier recommendation failed", cause).pipe(
            Effect.annotateLogs({ runID: run.id, taskID: task.id, routeDecisionID: decisionID }),
          ),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )

    const executeTask = Effect.fn("OrchestrationScheduler.executeTask")(function* (
      run: Run,
      task: Task,
      source: Location.Ref,
      history: Detail,
    ) {
      if (task.kind === "human") {
        yield* orchestration.openHumanRequest({
          runID: run.id,
          taskID: task.id,
          kind: "human_step",
          prompt: [
            task.title,
            task.description,
            ...history.humanRequests
              .filter((request) => request.taskID === task.id && request.kind === "human_step" && request.status === "answered")
              .slice(-1)
              .map((request) => `Previous guidance: ${request.answer}`),
          ]
            .filter(Boolean)
            .join("\n\n"),
          choices: ["done", "skip", "cancel"],
        })
        yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "waiting_on_human" })
        return
      }
      const priorAttempts = history.attempts.filter((attempt) => attempt.taskID === task.id)
      const priorRevisions = priorAttempts.filter((attempt) => attempt.kind !== "rebase")
      const policy = run.policy?.acceptance.mode === "judge" ? run.policy : undefined
      const firstTier = task.capabilityTier ? policy?.escalationChain.indexOf(task.capabilityTier) : 0
      const tiers =
        policy && task.capabilityTier && firstTier === -1
          ? [task.capabilityTier]
          : (policy?.escalationChain.slice(firstTier ?? 0, (firstTier ?? 0) + policy.budgets.maxEscalations + 1) ?? [])
      const attemptsPerTier = (policy?.budgets.maxRevisionsPerRoute ?? 0) + 1
      const requestedTier = policy
        ? (tiers[Math.min(Math.floor(priorRevisions.length / attemptsPerTier), tiers.length - 1)] ??
          task.capabilityTier)
        : task.capabilityTier
      const previous = history.attempts.findLast((attempt) => attempt.taskID === task.id)
      const previousEvaluations = history.evaluations.filter((evaluation) => evaluation.attemptID === previous?.id)
      const previousCommit = previousEvaluations.find((evaluation) => evaluation.kind === "git:commit")
      const rebase = previousEvaluations.some(
        (evaluation) => evaluation.kind === "git:merge" && evaluation.status === "failed",
      )
      const revision =
        run.policy?.acceptance.mode === "judge" && previous && previousCommit && !rebase
          ? `jewel/attempt/${run.id}/${task.id}/${previous.id}`
          : undefined
      const feedback =
        run.policy?.acceptance.mode === "judge" && previous
          ? [
              previous.feedback?.text,
              ...previousEvaluations
                .filter((evaluation) => evaluation.kind === "git:merge" && evaluation.status === "failed")
                .map(
                  (evaluation) =>
                    `Merge conflict: ${typeof evaluation.evidence.message === "string" ? evaluation.evidence.message.slice(0, 1_000) : "reapply the task on the current run branch"}`,
                ),
              ...history.humanRequests
                .filter((request) => request.taskID === task.id && request.status === "answered")
                .slice(-1)
                .map((request) => `Human guidance: ${request.answer?.slice(0, 2_000) ?? ""}`),
            ]
              .filter(Boolean)
              .join("\n")
          : undefined
      const routed = yield* OrchestrationRouting.Service.use((routing) => {
        if (!run.policy) return routing.resolve(task.routeProfile, requestedTier)
        const name = task.routeProfile ?? run.policy.roles.executor
        const profile = run.policy.routeProfiles.find((item) => item.name === name)
        if (!profile) return Effect.fail(new OrchestrationRouting.ProfileNotFoundError({ profile: name }))
        const reassignment = history.reassignments.findLast((item) => item.taskID === task.id)
        const selected = reassignment?.selected
        if (selected?.action !== "reassign" || !selected.candidateID) return routing.resolveSnapshot(profile, requestedTier)
        return routing.resolveSnapshot({
          ...profile,
          candidates: profile.candidates.map((item) => ({
            ...item,
            disabled: item.disabled || item.candidate.id !== selected.candidateID,
          })),
        }, requestedTier)
      }).pipe(Effect.provide(locations.get(source)), Effect.exit)
      if (Exit.isFailure(routed)) {
        if (run.policy?.acceptance.mode === "judge")
          yield* orchestration.openHumanRequest({
            runID: run.id,
            taskID: task.id,
            kind: "recovery",
            prompt: `Routing failed for ${task.title}: ${errorMessage(routed.cause)}. Choose retry, skip, or cancel.`,
            choices: ["retry", "skip", "cancel"],
          })
        yield* orchestration.setTaskStatus({
          runID: run.id,
          taskID: task.id,
          status: run.policy?.acceptance.mode === "judge" ? "waiting_on_human" : "failed",
        })
        return
      }
      const resolution = routed.value
      if (resolution.status !== "selected" || !resolution.selected) {
        const decision = yield* orchestration.recordRouteDecision({ runID: run.id, taskID: task.id, resolution })
        yield* scheduleShadowTier(run, task, decision.id, source)
        if (resolution.status === "failed" && run.policy?.acceptance.mode === "judge")
          yield* orchestration.openHumanRequest({
            runID: run.id,
            taskID: task.id,
            kind: "recovery",
            prompt: `No eligible executor is available for ${task.title}. Choose retry, skip, or cancel.`,
            choices: ["retry", "skip", "cancel"],
          })
        yield* orchestration.setTaskStatus({
          runID: run.id,
          taskID: task.id,
          status:
            resolution.status === "waiting"
              ? "suspended"
              : run.policy?.acceptance.mode === "judge"
                ? "waiting_on_human"
                : "failed",
        })
        return
      }

      const attempt = yield* orchestration.createAttempt({
        runID: run.id,
        taskID: task.id,
        candidate: resolution.selected,
        kind: !previous
          ? "initial"
          : rebase
            ? "rebase"
            : requestedTier !==
                  history.routeDecisions.findLast((decision) => decision.attemptID === previous.id)?.resolution
                    .requestedTier || resolution.selected.id !== previous.candidate?.id
              ? "reassignment"
              : "revision",
      })
      const decision = yield* orchestration.recordRouteDecision({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        resolution,
      })
      yield* scheduleShadowTier(run, task, decision.id, source)
      const prepared = yield* executor
        .prepare({ run, task, attemptID: attempt.id, candidate: resolution.selected, source, revision })
        .pipe(Effect.exit)
      if (Exit.isFailure(prepared)) {
        yield* finishFailure(orchestration, run, task, attempt.id, errorMessage(prepared.cause))
        return
      }
      yield* orchestration.prepareAttempt({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        sessionID: prepared.value.sessionID,
        location: prepared.value.location,
      })
      yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "running" })
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        status: "running",
      })

      const evaluated = yield* executor
        .execute({ run, task, prepared: prepared.value, source, feedback })
        .pipe(Effect.exit)
      if (Exit.isFailure(evaluated)) {
        const evaluation = {
          kind: "execution",
          status: "failed",
          evidence: { message: errorMessage(evaluated.cause) },
        } as const
        yield* scheduleShadowJudgment(run, task, attempt.id, resolution.selected, [evaluation], source)
        yield* finishFailure(orchestration, run, task, attempt.id, evaluation.evidence.message)
        return
      }

      yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "evaluating" })
      yield* orchestration.setAttemptStatus({
        runID: run.id,
        taskID: task.id,
        attemptID: attempt.id,
        status: "evaluating",
      })
      yield* Effect.forEach(
        evaluated.value,
        (evaluation) =>
          orchestration.recordEvaluation({
            runID: run.id,
            taskID: task.id,
            attemptID: attempt.id,
            ...evaluation,
          }),
        { discard: true },
      )
      const committed = run.workspace
        ? yield* executor
            .commitAttempt({
              run,
              task,
              attemptID: attempt.id,
              location: prepared.value.location,
              mirrorSessionID: resolution.selected.type === "harness" ? prepared.value.sessionID : undefined,
            })
            .pipe(Effect.exit)
        : undefined
      if (committed) {
        if (Exit.isFailure(committed)) {
          yield* finishFailure(orchestration, run, task, attempt.id, errorMessage(committed.cause))
          return
        }
        yield* orchestration.recordEvaluation({
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          ...committed.value,
        })
      }
      const verdict =
        run.policy
          ? yield* OrchestrationJudge.assess({
              run,
              task,
              evaluations: [...evaluated.value, ...(committed && Exit.isSuccess(committed) ? [committed.value] : [])],
            }).pipe(
              Effect.provide(locations.get(source)),
              Effect.provideService(AppProcess.Service, process),
              Effect.provideService(Global.Service, global),
              Effect.exit,
            )
          : undefined
      if (verdict && Exit.isSuccess(verdict) && verdict.value)
        yield* orchestration.recordAttemptVerdict({
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          verdict: verdict.value,
        })
      if (verdict && Exit.isSuccess(verdict) && verdict.value && verdict.value.decision !== "accept")
        yield* orchestration.recordAttemptFeedback({
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          feedback: OrchestrationFeedback.compose(task, verdict.value, evaluated.value),
        })
      if (verdict && Exit.isFailure(verdict))
        yield* Effect.logWarning("Policy judgment failed", verdict.cause).pipe(
          Effect.annotateLogs({ runID: run.id, taskID: task.id, attemptID: attempt.id }),
        )
      if (run.policy?.acceptance.mode === "judge") {
        const decision = verdict && Exit.isSuccess(verdict) ? verdict.value?.decision : undefined
        const grants = history.humanRequests.filter(
          (request) =>
            request.taskID === task.id &&
            request.kind === "budget_exhausted" &&
            request.status === "answered" &&
            !["accept", "skip", "cancel"].includes(request.answer ?? ""),
        ).length
        const limit =
          Math.min(
            attemptsPerTier * Math.max(tiers.length, 1),
            run.policy.budgets.maxAttempts ?? Number.POSITIVE_INFINITY,
          ) + grants
        if (decision === "accept") {
          const merged = yield* executor.mergeAttempt({ run, task, attemptID: attempt.id }).pipe(Effect.exit)
          if (Exit.isSuccess(merged)) {
            yield* orchestration.recordEvaluation({
              runID: run.id,
              taskID: task.id,
              attemptID: attempt.id,
              kind: "git:merge",
              status: "passed",
              evidence: { head: merged.value, branch: run.workspace?.runBranch },
            })
            yield* orchestration.setAttemptStatus({
              runID: run.id,
              taskID: task.id,
              attemptID: attempt.id,
              status: "succeeded",
              completed: yield* DateTime.now,
            })
            yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "succeeded" })
            return
          }
          yield* orchestration.recordEvaluation({
            runID: run.id,
            taskID: task.id,
            attemptID: attempt.id,
            kind: "git:merge",
            status: "failed",
            evidence: { message: errorMessage(merged.cause) },
          })
        }
        yield* orchestration.setAttemptStatus({
          runID: run.id,
          taskID: task.id,
          attemptID: attempt.id,
          status: "failed",
          completed: yield* DateTime.now,
        })
        const conflict = decision === "accept"
        const attempted = priorAttempts.length + 1
        const totalExhausted = attempted >= (run.policy.budgets.maxAttempts ?? Number.POSITIVE_INFINITY) + grants
        const exhausted = conflict
          ? priorAttempts.filter((item) => item.kind === "rebase").length >=
              (run.policy.budgets.maxRebasesPerTask ?? 2) || totalExhausted
          : priorRevisions.length + (attempt.kind === "rebase" ? 0 : 1) >= limit || totalExhausted
        const nextIndex = Math.floor(
          (priorRevisions.length + (attempt.kind === "rebase" ? 0 : 1)) / attemptsPerTier,
        )
        const nextTier = tiers[Math.min(nextIndex, tiers.length - 1)] ?? requestedTier
        const escalates = !conflict && nextTier !== requestedTier
        const profile = run.policy.routeProfiles.find(
          (item) => item.name === (task.routeProfile ?? run.policy?.roles.executor),
        )
        const escalation = escalates && profile
          ? yield* OrchestrationRouting.Service.use((routing) => routing.resolveSnapshot(profile, nextTier)).pipe(
              Effect.provide(locations.get(source)),
            )
          : undefined
        const alternative = !conflict && !exhausted && decision === "revise" && profile && resolution.selected
          ? yield* OrchestrationRouting.Service.use((routing) => routing.resolveSnapshot({
              ...profile,
              candidates: profile.candidates.map((item) => ({
                ...item,
                disabled: item.disabled || item.candidate.id === resolution.selected?.id,
              })),
            }, requestedTier)).pipe(Effect.provide(locations.get(source)))
          : undefined
        const automatic: ReassignmentOption | undefined =
          !exhausted && decision !== "needs_human" && decision !== undefined &&
          (!escalates || escalation?.status === "selected")
            ? { action: conflict ? "rebase" : escalates ? "escalate" : "revise", tier: nextTier }
            : undefined
        const options: ReassignmentOption[] = [
          ...(automatic ? [automatic] : []),
          ...(alternative?.status === "selected" && alternative.selected
            ? [{ action: "reassign" as const, tier: requestedTier, candidateID: alternative.selected.id }]
            : []),
          { action: "human" },
        ]
        const request = options.length > 1
          ? {
              purpose: "reassignment_decision",
              state: {
                objective: run.objective.slice(0, 4_000),
                task: task.title,
                attempted,
                currentTier: requestedTier ?? null,
                nextTier: nextTier ?? null,
                verdict: decision ?? null,
                confidence: verdict && Exit.isSuccess(verdict) ? verdict.value?.confidence ?? 0 : 0,
                gateFailures: verdict && Exit.isSuccess(verdict) ? verdict.value?.gateFailures ?? [] : [],
                failedChecks: evaluated.value.filter((item) => item.kind.startsWith("check:") && item.status === "failed").map((item) => item.kind),
              },
              question: {
                instructions: "Choose the best legal next action for this task. Human means pause and ask for guidance.",
                criteria: Object.fromEntries(options.map((option) => [option.action,
                  option.action === "human"
                    ? "Pause for a human decision because the evidence is ambiguous or further automatic work is unlikely to help."
                    : option.action === "reassign"
                      ? `Try eligible candidate ${option.candidateID} at the same tier.`
                      : `Continue automatically with ${option.action}${option.tier ? ` at tier ${option.tier}` : ""}.`,
                ])),
              },
              fallback: "human",
            } satisfies import("@opencode-ai/schema/typed-judge").ChoiceRequest
          : undefined
        const result = request
          ? yield* OrchestrationJudge.choose({ run, role: run.policy.roles.decider, request }).pipe(
              Effect.provide(locations.get(source)),
              Effect.provideService(AppProcess.Service, process),
              Effect.provideService(Global.Service, global),
            )
          : undefined
        const selected: ReassignmentOption =
          result?.status === "valid"
            ? options.find((option) => option.action === result.answer?.choice) ?? { action: "human" }
            : { action: "human" }
        yield* orchestration.recordReassignment({
          runID: run.id,
          taskID: task.id,
          afterAttemptID: attempt.id,
          options,
          selected,
          chooser: request ? run.policy.roles.decider.provider === "llm" ? "llm" : "jev" : "rule",
          request,
          result,
        })
        if (selected.action === "human") {
          const needsGuidance = decision === "needs_human" || (!exhausted && decision !== undefined)
          yield* orchestration.openHumanRequest({
            runID: run.id,
            taskID: task.id,
            kind: needsGuidance ? "clarification" : decision === undefined ? "recovery" : "budget_exhausted",
            prompt:
              decision === "needs_human"
                ? `The judge needs human guidance for ${task.title}. Answer with the missing decision or context.`
                : needsGuidance
                  ? `The decider requested human guidance before continuing ${task.title}. Answer with guidance or choose retry, accept, skip, or cancel.`
                : decision === undefined
                  ? `The judge could not complete evaluation for ${task.title}. Choose how to continue.`
                  : `The attempt budget is exhausted for ${task.title}. Choose retry, replan, accept, skip, or cancel.`,
            choices: decision === "needs_human" ? [] : ["retry", "replan", "accept", "skip", "cancel"],
          })
        }
        yield* orchestration.setTaskStatus({
          runID: run.id,
          taskID: task.id,
          status: selected.action === "human" ? "waiting_on_human" : "ready",
        })
        return
      }
      yield* scheduleShadowJudgment(run, task, attempt.id, resolution.selected, evaluated.value, source)
      yield* completeAttempt(
        orchestration,
        run.id,
        task.id,
        attempt.id,
        evaluated.value.some((evaluation) => evaluation.status === "failed") ? "failed" : "succeeded",
      )
    })

    const activateQueuedFollowUp = Effect.fn("OrchestrationScheduler.activateQueuedFollowUp")(function* (
      runID: RunID,
      source: Location.Ref,
    ) {
      const detail = yield* orchestration.get(runID)
      const next = detail.queuedFollowUps.find((item) => item.status === "queued")
      if (!next) return false
      if (detail.run.status === "delivered") {
        const baseHead = yield* OrchestrationIntegration.verifyDeliveredHead(detail).pipe(Effect.exit)
        if (Exit.isFailure(baseHead)) {
          yield* orchestration.openHumanRequest({
            runID,
            kind: "recovery",
            prompt: `Queued follow-up could not start: ${errorMessage(baseHead.cause)}. Resolve the run branch and retry.`,
            choices: ["retry", "cancel"],
          })
          return false
        }
        yield* orchestration.startFollowUp({
          runID,
          turnID: next.id,
          objective: next.objective,
          context: next.context,
          baseHead: baseHead.value,
        })
      }
      const planned = yield* OrchestrationPlanGenerator.Service.use((generator) =>
        generator.generate({ runID }),
      ).pipe(Effect.provide(locations.get(source)), Effect.exit)
      if (Exit.isFailure(planned)) {
        yield* orchestration.openHumanRequest({
          runID,
          kind: "recovery",
          prompt: `Queued follow-up planning failed: ${errorMessage(planned.cause)}. Choose retry or cancel.`,
          choices: ["retry", "cancel"],
        })
        return false
      }
      if ("kind" in planned.value) {
        yield* orchestration.dequeueFollowUp({ runID, turnID: next.id })
        return false
      }
      if (detail.run.policy?.planApproval === "human") {
        yield* orchestration.dequeueFollowUp({ runID, turnID: next.id })
        yield* orchestration.openHumanRequest({
          runID,
          kind: "plan_approval",
          prompt: `Review follow-up plan ${planned.value.id}, then approve or reject it.`,
          choices: ["approve", "reject"],
        })
        return false
      }
      const applied = yield* orchestration.applyPlan({ runID, planID: planned.value.id }).pipe(Effect.exit)
      if (Exit.isFailure(applied)) {
        yield* orchestration.openHumanRequest({
          runID,
          kind: "recovery",
          prompt: `Queued follow-up plan could not be applied: ${errorMessage(applied.cause)}. Choose retry or cancel.`,
          choices: ["retry", "cancel"],
        })
        return false
      }
      yield* orchestration.dequeueFollowUp({ runID, turnID: next.id })
      yield* orchestration.setRunStatus({ runID, status: "active" })
      return true
    })

    const drain = Effect.fn("OrchestrationScheduler.drain")(function* (runID: RunID) {
      const source = sources.get(runID)
      if (!source) return yield* Effect.die(`Missing source Location for orchestration run ${runID}`)
      yield* recoverInterrupted(orchestration, runID)
      const suspended = yield* orchestration.get(runID)
      const now = yield* DateTime.now
      if (
        suspended.run.status === "suspended" &&
        suspended.run.retryAt &&
        DateTime.toEpochMillis(suspended.run.retryAt) <= DateTime.toEpochMillis(now)
      ) {
        yield* OrchestrationCapacity.Service.use((capacity) => capacity.refresh).pipe(
          Effect.provide(locations.get(source)),
        )
        yield* Effect.forEach(
          suspended.tasks.filter((task) => {
            if (task.status !== "suspended") return false
            const retryAt = suspended.routeDecisions.findLast((decision) => decision.taskID === task.id)?.resolution
              .retryAt
            return retryAt !== undefined && DateTime.toEpochMillis(retryAt) <= DateTime.toEpochMillis(now)
          }),
          (task) => orchestration.setTaskStatus({ runID, taskID: task.id, status: "ready" }),
          { discard: true },
        )
        yield* orchestration.setRunStatus({ runID, status: "active" })
      }
      while (true) {
        const detail = yield* orchestration.get(runID)
        if (["cancelled", "completed", "failed"].includes(detail.run.status)) return yield* Effect.void
        if (detail.run.status === "delivered") {
          if (yield* activateQueuedFollowUp(runID, source)) continue
          return yield* Effect.void
        }
        if (
          detail.run.status === "draft" &&
          detail.queuedFollowUps.some((item) => item.status === "queued" && detail.followUps.some((turn) => turn.id === item.id))
        ) return yield* Effect.void
        yield* refreshReadiness(orchestration, detail)
        const current = yield* orchestration.get(runID)
        const ready = current.tasks.filter((task) => task.status === "ready")
        if (ready.length === 0) {
          if (
            current.run.policy?.acceptance.mode === "judge" &&
            current.tasks.length > 0 &&
            current.tasks.every((task) => ["succeeded", "cancelled"].includes(task.status))
          ) {
            const previous = current.deliveries.at(-1)
            const followUp = current.followUps.at(-1)
            const currentPlans = current.plans.filter(
              (plan) => plan.status === "applied" &&
                (!followUp || DateTime.toEpochMillis(plan.time.created) >= DateTime.toEpochMillis(followUp.time)),
            )
            const latestPlan = currentPlans.at(-1)
            if (
              previous?.summary &&
              (!latestPlan || DateTime.toEpochMillis(latestPlan.time.applied!) <= DateTime.toEpochMillis(previous.time.delivered!))
            ) {
              yield* syncTimeline(runID).pipe(Effect.orDie)
              yield* orchestration.setRunStatus({ runID, status: "delivered" })
              if (yield* activateQueuedFollowUp(runID, source)) continue
              return yield* Effect.void
            }
            if (current.humanRequests.some((request) => !request.taskID && request.status === "open"))
              return yield* Effect.void
            yield* orchestration.setRunStatus({ runID, status: "reviewing_delivery" })
            const delivery = yield* Effect.gen(function* () {
              if (
                previous?.review.decision === "delivered" &&
                latestPlan &&
                DateTime.toEpochMillis(previous.time.created) >= DateTime.toEpochMillis(latestPlan.time.applied!)
              ) return previous
              const reviewed = yield* OrchestrationDelivery.review(current).pipe(
                Effect.provideService(AppProcess.Service, process),
                Effect.provide(locations.get(source)),
                Effect.exit,
              )
              if (Exit.isFailure(reviewed)) {
                yield* orchestration.openHumanRequest({
                  runID,
                  kind: "recovery",
                  prompt: `Delivery review could not complete: ${errorMessage(reviewed.cause)}. Choose retry or cancel.`,
                  choices: ["retry", "cancel"],
                })
                return undefined
              }
              return yield* orchestration.recordDeliveryReview({
                runID,
                planID: latestPlan?.id,
                baseHead: reviewed.value.baseHead,
                head: reviewed.value.head,
                changedFiles: reviewed.value.changedFiles,
                review: reviewed.value.review,
              })
            })
            if (!delivery) return yield* Effect.void
            if (delivery.review.decision !== "delivered") {
              const policy = current.run.policy!
              const replans = replansInTurn(current)
              const grants = current.humanRequests.filter(
                (request) =>
                  !request.taskID &&
                  request.kind === "budget_exhausted" &&
                  request.answer === "grant-replan" &&
                  (!followUp || DateTime.toEpochMillis(request.time.created) >= DateTime.toEpochMillis(followUp.time)),
              ).length
              if (delivery.review.decision === "gaps" && replans < policy.budgets.maxReplans + grants) {
                const context = `Address these unmet delivery clauses with new tasks: ${delivery.review.clauses
                  .filter((clause) => clause.decision !== "met")
                  .map((clause) => `${clause.key}: ${clause.decision}`)
                  .join("; ")}`.slice(0, Math.max(0, 12_000 - (current.run.context?.length ?? 0)))
                const planned = yield* OrchestrationPlanGenerator.Service.use((generator) =>
                  generator.generate({ runID, context }).pipe(
                    Effect.catchTag("Orchestration.InvalidPlanError", (error) =>
                      generator.generate({
                        runID,
                        context: `${context}\nPrevious supplemental plan was invalid: ${error.message}`.slice(
                          0,
                          Math.max(0, 12_000 - (current.run.context?.length ?? 0)),
                        ),
                      }),
                    ),
                  ),
                ).pipe(Effect.provide(locations.get(source)), Effect.exit)
                if (Exit.isFailure(planned)) {
                  yield* orchestration.openHumanRequest({
                    runID,
                    kind: "recovery",
                    prompt: `Supplemental planning failed: ${errorMessage(planned.cause)}. Choose retry, accept, or cancel.`,
                    choices: ["retry", "accept", "cancel"],
                  })
                  return yield* Effect.void
                }
                if ("kind" in planned.value) return yield* Effect.void
                if (policy.planApproval === "human") {
                  yield* orchestration.openHumanRequest({
                    runID,
                    kind: "plan_approval",
                    prompt: `Review supplemental plan ${planned.value.id}, then approve or reject it.`,
                    choices: ["approve", "reject"],
                  })
                  return yield* Effect.void
                }
                const applied = yield* orchestration.applyPlan({ runID, planID: planned.value.id }).pipe(Effect.exit)
                if (Exit.isFailure(applied)) {
                  yield* orchestration.openHumanRequest({
                    runID,
                    kind: "recovery",
                    prompt: `Supplemental plan could not be applied: ${errorMessage(applied.cause)}. Choose retry, accept, or cancel.`,
                    choices: ["retry", "accept", "cancel"],
                  })
                  return yield* Effect.void
                }
                yield* orchestration.setRunStatus({ runID, status: "active" })
                continue
              }
              yield* orchestration.openHumanRequest({
                runID,
                kind: delivery.review.decision === "gaps" ? "budget_exhausted" : "recovery",
                prompt: `Delivery review returned ${delivery.review.decision}. Choose ${delivery.review.decision === "gaps" ? "grant-replan" : "retry"}, accept, or cancel.`,
                choices: delivery.review.decision === "gaps" ? ["grant-replan", "accept", "cancel"] : ["retry", "accept", "cancel"],
              })
              return yield* Effect.void
            }
            const summarized = yield* OrchestrationDelivery.generateSummary({
              detail: yield* orchestration.get(runID),
              process,
              temporaryDirectory: AbsolutePath.make(global.tmp),
            }).pipe(Effect.provide(locations.get(source)), Effect.exit)
            if (Exit.isFailure(summarized)) {
              yield* orchestration.openHumanRequest({
                runID,
                kind: "recovery",
                prompt: `Delivery summary could not complete: ${errorMessage(summarized.cause)}. Choose retry, accept a basic summary, or cancel.`,
                choices: ["retry", "accept", "cancel"],
              })
              return yield* Effect.void
            }
            const summary = yield* orchestration.summarizeDelivery({ runID, deliveryID: delivery.id, ...summarized.value })
            yield* syncTimeline(runID).pipe(Effect.orDie)
            yield* orchestration.setRunStatus({ runID, status: "delivered" })
            if (yield* activateQueuedFollowUp(runID, source)) continue
            return yield* Effect.void
          }
          const retryAt = nextRetryAt(current, yield* DateTime.now)
          yield* settleRun(orchestration, current, retryAt)
          yield* scheduleWake(runID, retryAt)
          return yield* Effect.void
        }
        const concurrency = yield* Config.Service.use((config) =>
          config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration")?.max_concurrency ?? 2)),
        ).pipe(Effect.provide(locations.get(source)))
        yield* executeReadyTasks(ready, concurrency, (task) => executeTask(current.run, task, source, current))
      }
    })

    const coordinator = yield* SessionRunCoordinator.make<RunID, never>({
      drain: (runID) =>
        drain(runID).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Orchestration run failed", cause).pipe(Effect.annotateLogs({ runID })),
          ),
        ),
    })
    wake = coordinator.wake

    const scheduleWake = Effect.fn("OrchestrationScheduler.scheduleWake")(function* (
      runID: RunID,
      retryAt?: DateTime.Utc,
    ) {
      const prior = timers.get(runID)
      if (prior) yield* Fiber.interrupt(prior)
      timers.delete(runID)
      if (!retryAt) return
      const delay = Math.max(1_000, DateTime.toEpochMillis(retryAt) - Date.now())
      const timer = yield* Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(Effect.suspend(() => wake(runID))),
        Effect.forkIn(scope),
      )
      timers.set(runID, timer)
    })

    yield* events.all().pipe(
      Stream.filter(Schema.is(Events)),
      Stream.map((event) => event.data.runID),
      Stream.runForEach((runID) =>
        syncTimeline(runID).pipe(Effect.catchCause((cause) =>
          Effect.logWarning("Could not project orchestration timeline", cause).pipe(Effect.annotateLogs({ runID })),
        )),
      ),
      Effect.forkIn(scope),
    )
    yield* Effect.forEach(
      (yield* orchestration.list()).filter((run) => run.sessionID),
      (run) => syncTimeline(run.id).pipe(Effect.orDie),
      { discard: true },
    )
    yield* Effect.forEach(
      (yield* orchestration.list()).filter((run) => run.status === "suspended"),
      (run) => {
        const source = run.source
        if (!source || !run.retryAt) return Effect.void
        return Effect.sync(() => sources.set(run.id, source)).pipe(Effect.andThen(scheduleWake(run.id, run.retryAt)))
      },
      { discard: true },
    )

    const launch = (runID: RunID, source: Location.Ref) =>
      Effect.sync(() => sources.set(runID, source)).pipe(Effect.andThen(coordinator.wake(runID)))

    yield* Effect.forEach(
      (yield* orchestration.list()).filter((run) => run.status === "delivered" && run.source),
      (run) => orchestration.get(run.id).pipe(Effect.orDie, Effect.flatMap((detail) =>
        detail.queuedFollowUps.some((item) => item.status === "queued") && run.source
          ? launch(run.id, run.source)
          : Effect.void,
      )),
      { discard: true },
    )

    const start = Effect.fn("OrchestrationScheduler.start")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const executionTrust = yield* Config.Service.use((config) =>
        config.entries().pipe(Effect.map((entries) => Config.latest(entries, "orchestration")?.execution_trust)),
      ).pipe(Effect.provide(locations.get(input.source)))
      if (executionTrust === "untrusted")
        return yield* new OperationError({
          operation: "start",
          message: "Untrusted orchestration requires an isolated worker, which is not configured on this host",
        })
      if (["cancelled", "completed", "delivered"].includes(detail.run.status))
        return yield* new OperationError({ operation: "start", message: `Run is ${detail.run.status}` })
      if (detail.tasks.length === 0)
        return yield* new OperationError({ operation: "start", message: "Add at least one task before starting" })
      yield* ensureRoot(detail, input.source)
      const followUp = detail.followUps.at(-1)
      if (
        followUp &&
        !detail.plans.some(
          (plan) => plan.status === "applied" && DateTime.toEpochMillis(plan.time.created) >= DateTime.toEpochMillis(followUp.time),
        )
      ) return yield* new OperationError({ operation: "start", message: "Apply the follow-up plan before starting" })
      if (detail.run.policy?.acceptance.mode === "judge" && detail.run.policy.roles.decider.provider === "experiment")
        return yield* new OperationError({
          operation: "start",
          message: `Decider provider ${detail.run.policy.roles.decider.provider} is not implemented yet`,
        })
      if (
        detail.run.policy?.acceptance.mode === "judge" &&
        detail.tasks.some((task) => !task.acceptanceCriteria.length)
      )
        return yield* new OperationError({
          operation: "start",
          message: "Judge-driven runs require acceptance criteria on every task",
        })
      if (detail.run.policy && !detail.run.workspace) {
        const workspace = yield* executor.prepareRun({ run: detail.run, source: input.source }).pipe(Effect.exit)
        if (Exit.isFailure(workspace))
          return yield* new OperationError({ operation: "start", message: errorMessage(workspace.cause) })
        yield* orchestration.setRunWorkspace({ runID: input.runID, workspace: workspace.value })
      }
      yield* scheduleWake(input.runID)
      yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
      if (detail.run.status !== "active") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      yield* Effect.forEach(
        detail.tasks.filter((task) => task.status === "suspended"),
        (task) => orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "ready" }),
        { discard: true },
      )
      return yield* launch(input.runID, input.source)
    })

    const cancel = Effect.fn("OrchestrationScheduler.cancel")(function* (runID: RunID) {
      const detail = yield* orchestration.get(runID)
      yield* scheduleWake(runID)
      yield* Effect.forEach(
        detail.attempts.flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : [])),
        sessions.interrupt,
        { concurrency: "unbounded", discard: true },
      )
      yield* coordinator.interrupt(runID)
      const completed = yield* DateTime.now
      yield* Effect.forEach(
        detail.attempts.filter((attempt) => ["pending", "running", "evaluating"].includes(attempt.status)),
        (attempt) =>
          orchestration.setAttemptStatus({
            runID,
            taskID: attempt.taskID,
            attemptID: attempt.id,
            status: "interrupted",
            completed,
          }),
        { discard: true },
      )
      yield* Effect.forEach(
        detail.tasks.filter((task) => !["succeeded", "failed", "cancelled"].includes(task.status)),
        (task) => orchestration.setTaskStatus({ runID, taskID: task.id, status: "cancelled" }),
        { discard: true },
      )
      yield* orchestration.setRunStatus({ runID, status: "cancelled" })
    })

    const review = Effect.fn("OrchestrationScheduler.review")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const task = detail.tasks.find((item) => item.id === input.taskID)
      if (!task) return yield* new Orchestration.NotFoundError({ resource: "task", id: input.taskID })
      const override = input.decision === "accepted" && ["failed", "waiting_on_human"].includes(task.status)
      if (task.status !== "awaiting_review" && !override)
        return yield* new OperationError({
          operation: input.decision === "accepted" ? "accept" : "reject",
          message: `Task is ${task.status}`,
        })
      const attempt = detail.attempts.findLast((item) => item.taskID === task.id)
      if (!attempt) return yield* new Orchestration.NotFoundError({ resource: "attempt", id: task.id })
      if (override && !detail.evaluations.some((item) => item.attemptID === attempt.id && item.kind === "git:commit" && item.status === "passed"))
        return yield* new OperationError({ operation: "accept", message: "Latest attempt has no committed change" })
      if (override && ["delivered", "completed", "cancelled"].includes(detail.run.status))
        return yield* new OperationError({ operation: "accept", message: `Run is ${detail.run.status}` })
      if (input.decision === "accepted" && detail.run.workspace) {
        const merged = yield* executor.mergeAttempt({ run: detail.run, task, attemptID: attempt.id }).pipe(Effect.exit)
        if (Exit.isFailure(merged))
          return yield* new OperationError({ operation: "accept", message: errorMessage(merged.cause) })
        yield* orchestration.recordEvaluation({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          kind: "git:merge",
          status: "passed",
          evidence: { head: merged.value, branch: detail.run.workspace.runBranch },
        })
      }
      yield* orchestration.recordReview({
        runID: input.runID,
        taskID: task.id,
        attemptID: attempt.id,
        decision: input.decision,
        note: input.note,
      })
      if (override) {
        yield* Effect.forEach(
          detail.humanRequests.filter((request) => request.taskID === task.id && request.status === "open"),
          (request) => orchestration.answerHumanRequest({ runID: input.runID, requestID: request.id, answer: "accept" }),
          { discard: true },
        ).pipe(Effect.mapError((error) => new OperationError({ operation: "accept", message: error.message })))
      }
      yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
      if (override && detail.run.status === "failed") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      yield* orchestration.setTaskStatus({
        runID: input.runID,
        taskID: task.id,
        status: input.decision === "accepted" ? "succeeded" : "failed",
      })
      return yield* launch(input.runID, input.source)
    })

    const retry = Effect.fn("OrchestrationScheduler.retry")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const task = detail.tasks.find((item) => item.id === input.taskID)
      if (!task) return yield* new Orchestration.NotFoundError({ resource: "task", id: input.taskID })
      if (!["awaiting_review", "failed", "suspended"].includes(task.status))
        return yield* new OperationError({ operation: "retry", message: `Task is ${task.status}` })
      yield* scheduleWake(input.runID)
      yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
      if (detail.run.status !== "active") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      yield* orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "ready" })
      return yield* launch(input.runID, input.source)
    })

    const reopen = Effect.fn("OrchestrationScheduler.reopen")((input: Parameters<Interface["reopen"]>[0]) =>
      integrationLocks.withLock(input.runID)(Effect.gen(function* () {
        const detail = yield* orchestration.get(input.runID)
        const task = detail.tasks.find((item) => item.id === input.taskID)
        if (!task) return yield* new Orchestration.NotFoundError({ resource: "task", id: input.taskID })
        if (task.status !== "succeeded" || !["active", "suspended"].includes(detail.run.status))
          return yield* new OperationError({ operation: "reject", message: "Task is not an active accepted result" })
        if (!input.feedback.trim() || input.feedback.length > 8_000)
          return yield* new OperationError({ operation: "reject", message: "Feedback must be 1 to 8,000 characters" })
        if (detail.tasks.some((item) => item.id !== task.id && ["running", "ready"].includes(item.status)))
          return yield* new OperationError({ operation: "reject", message: "Wait for other runnable tasks to reach a safe boundary" })
        if (detail.dependencies.some((dependency) => dependency.dependsOnTaskID === task.id &&
          (!["draft", "blocked"].includes(detail.tasks.find((item) => item.id === dependency.taskID)?.status ?? "") ||
            detail.attempts.some((attempt) => attempt.taskID === dependency.taskID))))
          return yield* new OperationError({ operation: "reject", message: "Dependent work has already started" })
        const attempt = detail.attempts.findLast((item) => item.taskID === task.id)
        if (!attempt) return yield* new Orchestration.NotFoundError({ resource: "attempt", id: task.id })
        const merge = detail.evaluations.findLast((item) => item.attemptID === attempt.id && item.kind === "git:merge")
        const head = merge?.evidence.head
        if (typeof head !== "string")
          return yield* new OperationError({ operation: "reject", message: "Accepted merge revision is missing" })
        const reverted = yield* executor.revertAccepted({ run: detail.run, mergeHead: head }).pipe(Effect.exit)
        if (Exit.isFailure(reverted))
          return yield* new OperationError({ operation: "reject", message: errorMessage(reverted.cause) })
        yield* orchestration.recordEvaluation({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          kind: "git:revert",
          status: "passed",
          evidence: { revertedMerge: head, head: reverted.value },
        })
        yield* orchestration.recordReview({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          decision: "rejected",
          note: input.feedback.trim(),
        })
        yield* orchestration.recordAttemptFeedback({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          feedback: { source: "human", text: input.feedback.trim(), criterionKeys: [], failedChecks: [] },
        })
        yield* orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "ready" })
        yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
        if (detail.run.status === "suspended") yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
        yield* launch(input.runID, input.source)
      })),
    )

    const replanBlocked = Effect.fn("OrchestrationScheduler.replanBlocked")(function* (
      runID: RunID, task: Task, source: Location.Ref, reason: string,
    ) {
      const detail = yield* orchestration.get(runID)
      const policy = detail.run.policy
      if (!policy) return yield* new OperationError({ operation: "answer", message: "Run has no planning policy" })
      const followUp = detail.followUps.at(-1)
      const replans = replansInTurn(detail)
      const grants = detail.humanRequests.filter((request) =>
        request.taskID === task.id && request.answer === "grant-replan" &&
        (!followUp || DateTime.toEpochMillis(request.time.created) >= DateTime.toEpochMillis(followUp.time)),
      ).length
      const requested = detail.humanRequests.filter((request) =>
        request.taskID === task.id && request.answer === "replan" &&
        (!followUp || DateTime.toEpochMillis(request.time.created) >= DateTime.toEpochMillis(followUp.time)),
      ).length
      if (replans >= policy.budgets.maxReplans + grants + requested) {
        yield* orchestration.openHumanRequest({
          runID, taskID: task.id, kind: "budget_exhausted",
          prompt: `The replan budget is exhausted for ${task.title}. Grant one replan or cancel the run.`,
          choices: ["grant-replan", "cancel"],
        })
        return
      }
      const planned = yield* OrchestrationPlanGenerator.Service.use((generator) =>
        generator.generate({ runID, context: `Replace blocked task ${task.id} (${task.title}). Reason: ${reason}`.slice(0, 2_000) }).pipe(
          Effect.catchTag("Orchestration.InvalidPlanError", (error) => generator.generate({
            runID,
            context: `Replace blocked task ${task.id} (${task.title}). Reason: ${reason}. Previous plan was invalid: ${error.message}`.slice(0, 2_000),
          })),
        ),
      ).pipe(Effect.provide(locations.get(source)), Effect.exit)
      if (Exit.isFailure(planned)) {
        yield* orchestration.openHumanRequest({
          runID, taskID: task.id, kind: "recovery",
          prompt: `Replanning ${task.title} failed: ${errorMessage(planned.cause)}. Retry planning or cancel the run.`,
          choices: ["retry-plan", "cancel"],
        })
        return
      }
      if ("kind" in planned.value) return
      if (policy.planApproval === "human") {
        yield* orchestration.openHumanRequest({
          runID, kind: "plan_approval",
          prompt: `Review replacement plan ${planned.value.id}, then approve or reject it.`,
          choices: ["approve", "reject"],
        })
        return
      }
      const applied = yield* orchestration.applyPlan({ runID, planID: planned.value.id }).pipe(Effect.exit)
      if (Exit.isFailure(applied)) {
        yield* orchestration.openHumanRequest({
          runID, taskID: task.id, kind: "recovery",
          prompt: `Replacement plan could not be applied: ${errorMessage(applied.cause)}. Retry planning or cancel the run.`,
          choices: ["retry-plan", "cancel"],
        })
        return
      }
      yield* orchestration.setRunStatus({ runID, status: "active" })
      return yield* launch(runID, source)
    })

    const skipTaskAndDependents = Effect.fn("OrchestrationScheduler.skipTaskAndDependents")(function* (
      detail: Detail, taskID: TaskID,
    ) {
      const downstream = (selected: ReadonlySet<TaskID>): ReadonlySet<TaskID> => {
        const next = new Set([...selected, ...detail.dependencies
          .filter((dependency) => selected.has(dependency.dependsOnTaskID))
          .map((dependency) => dependency.taskID)])
        return next.size === selected.size ? next : downstream(next)
      }
      const skipped = downstream(new Set([taskID]))
      if (detail.tasks.some((task) => skipped.has(task.id) && task.id !== taskID &&
        !["draft", "blocked", "ready", "suspended", "failed", "cancelled"].includes(task.status)))
        return yield* new OperationError({ operation: "answer", message: "A dependent task has already started; replan instead of skipping" })
      yield* Effect.forEach(detail.tasks.filter((task) => skipped.has(task.id) && task.status !== "cancelled"),
        (task) => orchestration.setTaskStatus({ runID: detail.run.id, taskID: task.id, status: "cancelled" }),
        { discard: true })
    })

    const answerRequest = Effect.fn("OrchestrationScheduler.answerRequest")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      const request = detail.humanRequests.find((item) => item.id === input.requestID)
      if (!request) return yield* new Orchestration.NotFoundError({ resource: "request", id: input.requestID })
      if (request.status !== "open")
        return yield* new OperationError({ operation: "answer", message: "Request was already answered" })
      if (!input.answer.trim())
        return yield* new OperationError({ operation: "answer", message: "Answer cannot be empty" })
      if (request.kind === "plan_approval") {
        if (input.answer !== "approve" && input.answer !== "reject")
          return yield* new OperationError({ operation: "answer", message: "Answer approve or reject" })
        if (input.answer === "approve") {
          const plan = detail.plans.findLast((item) => item.status === "proposed")
          if (!plan)
            return yield* new OperationError({ operation: "answer", message: "No proposed plan is available" })
          yield* orchestration.applyPlan({ runID: input.runID, planID: plan.id }).pipe(
            Effect.mapError((error) => new OperationError({ operation: "answer", message: error.message })),
          )
        }
        yield* orchestration.answerHumanRequest({
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
        }).pipe(
          Effect.catchTag(
            "Orchestration.HumanRequestError",
            (error) => new OperationError({ operation: "answer", message: error.message }),
          ),
        )
        if (input.answer === "approve") return yield* start({ runID: input.runID, source: input.source })
        return
      }
      const task = detail.tasks.find((item) => item.id === request.taskID)
      if (task && request.kind === "recovery" && request.choices.includes("retry-plan")) {
        if (!["retry-plan", "cancel"].includes(input.answer))
          return yield* new OperationError({ operation: "answer", message: "Choose retry planning or cancel" })
        yield* orchestration.answerHumanRequest({ runID: input.runID, requestID: input.requestID, answer: input.answer }).pipe(
          Effect.catchTag("Orchestration.HumanRequestError", (error) =>
            new OperationError({ operation: "answer", message: error.message })),
        )
        if (input.answer === "cancel") return yield* cancel(input.runID)
        return yield* replanBlocked(input.runID, task, input.source, request.prompt)
      }
      if (task && request.kind === "budget_exhausted" && request.choices.includes("grant-replan")) {
        if (!["grant-replan", "cancel"].includes(input.answer))
          return yield* new OperationError({ operation: "answer", message: "Choose grant one replan or cancel" })
        yield* orchestration.answerHumanRequest({ runID: input.runID, requestID: input.requestID, answer: input.answer }).pipe(
          Effect.catchTag("Orchestration.HumanRequestError", (error) =>
            new OperationError({ operation: "answer", message: error.message })),
        )
        if (input.answer === "cancel") return yield* cancel(input.runID)
        return yield* replanBlocked(input.runID, task, input.source, request.prompt)
      }
      if (
        !task && request.kind === "recovery" &&
        ["draft", "delivered"].includes(detail.run.status) &&
        detail.queuedFollowUps.some((item) => item.status === "queued")
      ) {
        if (!["retry", "cancel"].includes(input.answer))
          return yield* new OperationError({ operation: "answer", message: "Choose retry or cancel" })
        yield* orchestration.answerHumanRequest({
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
        }).pipe(Effect.mapError((error) =>
          error instanceof Orchestration.HumanRequestError
            ? new OperationError({ operation: "answer", message: error.message })
            : error,
        ))
        if (input.answer === "cancel") return yield* cancel(input.runID)
        if (yield* activateQueuedFollowUp(input.runID, input.source))
          return yield* launch(input.runID, input.source)
        return
      }
      if (!task && ["recovery", "budget_exhausted"].includes(request.kind) && detail.run.status === "reviewing_delivery") {
        if (!(request.kind === "budget_exhausted" ? ["grant-replan", "accept", "cancel"] : ["retry", "accept", "cancel"]).includes(input.answer))
          return yield* new OperationError({ operation: "answer", message: "Choose one of the request actions" })
        yield* orchestration.answerHumanRequest({
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
        }).pipe(
          Effect.catchTag(
            "Orchestration.HumanRequestError",
            (error) => new OperationError({ operation: "answer", message: error.message }),
          ),
        )
        if (input.answer === "cancel") return yield* cancel(input.runID)
        if (input.answer === "accept") {
          const delivery = detail.deliveries.at(-1)
          if (!delivery)
            return yield* new OperationError({ operation: "answer", message: "No delivery review is available" })
          yield* orchestration.summarizeDelivery({
            runID: input.runID,
            deliveryID: delivery.id,
            ...OrchestrationDelivery.summarize(detail, delivery.changedFiles),
          })
          return yield* orchestration.setRunStatus({ runID: input.runID, status: "delivered" })
        }
        yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
        yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
        return yield* launch(input.runID, input.source)
      }
      if (request.kind === "human_step" && task) {
        if (!["done", "skip", "cancel"].includes(input.answer) && !input.answer.startsWith("cannot:"))
          return yield* new OperationError({ operation: "answer", message: "Choose done, skip, or explain why this step cannot be done" })
        if (input.answer === "done") {
          const checks = yield* executor.verifyHuman({ run: detail.run, task, source: input.source }).pipe(
            Effect.mapError((error) => new OperationError({ operation: "answer", message: error.message })),
          )
          const failed = checks.find((check) => check.status !== "passed")
          if (failed)
            return yield* new OperationError({
              operation: "answer",
              message: `Human step verification failed: ${failed.kind}. ${typeof failed.evidence.stderr === "string" ? failed.evidence.stderr.slice(0, 500) : ""}`,
            })
        }
        yield* orchestration.answerHumanRequest({
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
        }).pipe(
          Effect.catchTag(
            "Orchestration.HumanRequestError",
            (error) => new OperationError({ operation: "answer", message: error.message }),
          ),
        )
        if (input.answer === "cancel") return yield* cancel(input.runID)
        if (input.answer === "skip") yield* skipTaskAndDependents(detail, task.id)
        else yield* orchestration.setTaskStatus({
          runID: input.runID,
          taskID: task.id,
          status: input.answer === "done" ? "succeeded" : "failed",
        })
        yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
        if (input.answer.startsWith("cannot:"))
          return yield* replanBlocked(input.runID, task, input.source, input.answer.slice("cannot:".length).trim())
        return yield* launch(input.runID, input.source)
      }
      const attempt = detail.attempts.findLast((item) => item.taskID === task?.id)
      if (input.answer === "accept" && task && attempt) {
        if (!detail.evaluations.some((item) => item.attemptID === attempt.id && item.kind === "git:commit" && item.status === "passed"))
          return yield* new OperationError({ operation: "answer", message: "Latest attempt has no committed change" })
        const merged = yield* executor.mergeAttempt({ run: detail.run, task, attemptID: attempt.id }).pipe(Effect.exit)
        if (Exit.isFailure(merged))
          return yield* new OperationError({ operation: "answer", message: errorMessage(merged.cause) })
        yield* orchestration.recordEvaluation({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          kind: "git:merge",
          status: "passed",
          evidence: { head: merged.value, branch: detail.run.workspace?.runBranch },
        })
      }
      yield* orchestration
        .answerHumanRequest({
          runID: input.runID,
          requestID: input.requestID,
          answer: input.answer,
        })
        .pipe(
          Effect.catchTag(
            "Orchestration.HumanRequestError",
            (error) => new OperationError({ operation: "answer", message: error.message }),
          ),
        )
      if (!task) return
      if (input.answer === "cancel") return yield* cancel(input.runID)
      if (input.answer === "replan" && task && request.kind === "budget_exhausted") {
        yield* orchestration.setTaskStatus({ runID: input.runID, taskID: task.id, status: "failed" })
        yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
        return yield* replanBlocked(input.runID, task, input.source, request.prompt)
      }
      if (input.answer === "accept" && attempt) {
        yield* orchestration.recordReview({
          runID: input.runID,
          taskID: task.id,
          attemptID: attempt.id,
          decision: "accepted",
          note: "Human override from request inbox",
        })
      }
      if (input.answer === "skip") yield* skipTaskAndDependents(detail, task.id)
      else yield* orchestration.setTaskStatus({
        runID: input.runID,
        taskID: task.id,
        status: input.answer === "accept" ? "succeeded" : "ready",
      })
      yield* orchestration.setRunSource({ runID: input.runID, source: input.source })
      if (detail.run.status === "failed")
        yield* orchestration.setRunStatus({ runID: input.runID, status: "active" })
      return yield* launch(input.runID, input.source)
    })

    const integrationPreflight = Effect.fn("OrchestrationScheduler.integrationPreflight")(function* (input) {
      const detail = yield* orchestration.get(input.runID)
      return yield* OrchestrationIntegration.preflight(detail, input.options).pipe(
        Effect.mapError((error) => new OperationError({ operation: "integrate", message: error.message })),
      )
    })

    const integrate = Effect.fn("OrchestrationScheduler.integrate")((input: Parameters<Interface["integrate"]>[0]) =>
      integrationLocks.withLock(input.runID)(
        Effect.gen(function* () {
          const detail = yield* orchestration.get(input.runID)
          const preview = yield* OrchestrationIntegration.preflight(detail, input.options).pipe(
            Effect.mapError((error) => new OperationError({ operation: "integrate", message: error.message })),
          )
          if (input.options.action !== "discard" && input.options.expectedTargetHead !== preview.targetHead)
            return yield* new OperationError({ operation: "integrate", message: "Target head must match the preflight preview" })
          yield* OrchestrationIntegration.execute(detail, input.options).pipe(
            Effect.provideService(Orchestration.Service, orchestration),
            Effect.mapError((error) =>
              error instanceof Orchestration.NotFoundError
                ? error
                : new OperationError({ operation: "integrate", message: error.message }),
            ),
          )
        }),
      ),
    )

    const retryIntegration = Effect.fn("OrchestrationScheduler.retryIntegration")((input: Parameters<Interface["retryIntegration"]>[0]) =>
      integrationLocks.withLock(input.runID)(
        Effect.gen(function* () {
          const detail = yield* orchestration.get(input.runID)
          const record = detail.integrations.find((item) => item.id === input.integrationID)
          if (!record) return yield* new Orchestration.NotFoundError({ resource: "integration", id: input.integrationID })
          yield* OrchestrationIntegration.execute(detail, record.options, record).pipe(
            Effect.provideService(Orchestration.Service, orchestration),
            Effect.mapError((error) =>
              error instanceof Orchestration.NotFoundError
                ? error
                : new OperationError({ operation: "integrate", message: error.message }),
            ),
          )
        }),
      ),
    )

    const followUp = Effect.fn("OrchestrationScheduler.followUp")((input: Parameters<Interface["followUp"]>[0]) =>
      integrationLocks.withLock(input.runID)(
        Effect.gen(function* () {
          const detail = yield* orchestration.get(input.runID)
          if (!input.objective.trim() || input.objective.length > 8_000 || (input.context?.length ?? 0) > 12_000)
            return yield* new OperationError({ operation: "follow_up", message: "Follow-up objective or context is invalid" })
          if (detail.integrations.some((item) => item.status === "running"))
            return yield* new OperationError({ operation: "follow_up", message: "Wait for the running integration to finish" })
          if (detail.run.status !== "delivered" || detail.queuedFollowUps.some((item) => item.status === "queued")) {
            if (["cancelled", "completed", "failed"].includes(detail.run.status))
              return yield* new OperationError({ operation: "follow_up", message: `Run is ${detail.run.status}` })
            yield* orchestration.queueFollowUp(input)
            if (detail.run.status === "delivered" && detail.run.source) yield* launch(input.runID, detail.run.source)
            return
          }
          const baseHead = yield* OrchestrationIntegration.verifyDeliveredHead(detail).pipe(
            Effect.mapError((error) => new OperationError({ operation: "follow_up", message: error.message })),
          )
          const sessionID = yield* ensureRoot(detail, detail.run.source!)
          const turn = yield* orchestration.startFollowUp({ ...input, baseHead })
          yield* syncTimeline(input.runID).pipe(Effect.orDie)
        }),
      ),
    )

    const steerFollowUp = Effect.fn("OrchestrationScheduler.steerFollowUp")((input: Parameters<Interface["steerFollowUp"]>[0]) =>
      integrationLocks.withLock(input.runID)(Effect.gen(function* () {
        const detail = yield* orchestration.get(input.runID)
        const queued = detail.queuedFollowUps.find((item) => item.id === input.turnID)
        if (!queued) return yield* new Orchestration.NotFoundError({ resource: "queued follow-up", id: input.turnID })
        if (detail.run.status !== "active" || !detail.run.policy || queued.status === "started")
          return yield* new OperationError({ operation: "follow_up", message: "Guidance can be sent only during an active policy run" })
        if (replansInTurn(detail) >= detail.run.policy.budgets.maxReplans)
          return yield* new OperationError({ operation: "follow_up", message: "This turn has exhausted its replan budget" })
        if (queued.status === "queued") yield* orchestration.steerFollowUp(input).pipe(Effect.mapError((error) =>
          error instanceof Orchestration.InvalidPlanError
            ? new OperationError({ operation: "follow_up", message: error.message }) : error))
        const planned = yield* OrchestrationPlanGenerator.Service.use((generator) =>
          generator.generate({ runID: input.runID }),
        ).pipe(Effect.provide(locations.get(input.source)), Effect.mapError((error) =>
          error instanceof Orchestration.NotFoundError ? error :
            new OperationError({ operation: "follow_up", message: error.message })))
        if ("kind" in planned) return
        if (detail.run.policy.planApproval === "human") {
          yield* orchestration.openHumanRequest({
            runID: input.runID, kind: "plan_approval",
            prompt: `Review updated plan ${planned.id}, then approve or reject it.`,
            choices: ["approve", "reject"],
          })
          return
        }
        yield* orchestration.applyPlan({ runID: input.runID, planID: planned.id }).pipe(Effect.mapError((error) =>
          error instanceof Orchestration.NotFoundError ? error :
            new OperationError({ operation: "follow_up", message: error.message })))
        return yield* launch(input.runID, input.source)
      })),
    )

    const ensureSession = Effect.fn("OrchestrationScheduler.ensureSession")((input: Parameters<Interface["ensureSession"]>[0]) =>
      integrationLocks.withLock(input.runID)(
        orchestration.get(input.runID).pipe(Effect.flatMap((detail) => ensureRoot(detail, input.source))),
      ),
    )

    const verifyPreset = Effect.fn("OrchestrationScheduler.verifyPreset")((input: Parameters<Interface["verifyPreset"]>[0]) =>
      executor.verifyPreset(input).pipe(Effect.mapError((error) => new OperationError({ operation: "check", message: error.message }))),
    )

    return Service.of({ verifyPreset, start, cancel, review, retry, reopen, answerRequest, integrationPreflight, integrate, retryIntegration, followUp, steerFollowUp, ensureSession })
  }),
)

export function readyTaskIDs(detail: Detail) {
  const status = new Map(detail.tasks.map((task) => [task.id, task.status] as const))
  return detail.tasks
    .filter((task) => ["draft", "blocked"].includes(task.status))
    .filter((task) =>
      detail.dependencies
        .filter((dependency) => dependency.taskID === task.id)
        .every((dependency) => status.get(dependency.dependsOnTaskID) === "succeeded"),
    )
    .map((task) => task.id)
}

function replansInTurn(detail: Detail) {
  const followUp = detail.followUps.at(-1)
  const applied = detail.plans.filter((plan) => plan.status === "applied" &&
    (!followUp || DateTime.toEpochMillis(plan.time.created) >= DateTime.toEpochMillis(followUp.time)))
  const manualTasks = detail.tasks.length > detail.plans.filter((plan) => plan.status === "applied")
    .reduce((count, plan) => count + plan.output.tasks.length, 0)
  return Math.max(0, applied.length - (followUp || !manualTasks ? 1 : 0))
}

export function executeReadyTasks<A, E, R>(
  tasks: ReadonlyArray<A>,
  concurrency: number,
  execute: (task: A) => Effect.Effect<void, E, R>,
) {
  return Effect.forEach(tasks.slice(0, concurrency), execute, { concurrency: "unbounded", discard: true })
}

function refreshReadiness(orchestration: Orchestration.Interface, detail: Detail) {
  const ready = new Set(readyTaskIDs(detail))
  return Effect.forEach(
    detail.tasks.filter((task) => ["draft", "blocked"].includes(task.status)),
    (task) =>
      orchestration.setTaskStatus({
        runID: detail.run.id,
        taskID: task.id,
        status: ready.has(task.id) ? "ready" : "blocked",
      }),
    { discard: true },
  )
}

function recoverInterrupted(orchestration: Orchestration.Interface, runID: RunID) {
  return Effect.gen(function* () {
    const detail = yield* orchestration.get(runID)
    const completed = yield* DateTime.now
    yield* Effect.forEach(
      detail.attempts.filter((attempt) => ["running", "evaluating"].includes(attempt.status)),
      (attempt) =>
        orchestration.setAttemptStatus({
          runID,
          taskID: attempt.taskID,
          attemptID: attempt.id,
          status: "interrupted",
          completed,
        }),
      { discard: true },
    )
    yield* Effect.forEach(
      detail.tasks.filter((task) => ["running", "evaluating"].includes(task.status)),
      (task) =>
        Effect.gen(function* () {
          if (detail.run.policy?.acceptance.mode === "judge") {
            yield* orchestration.openHumanRequest({
              runID,
              taskID: task.id,
              kind: "recovery",
              prompt: `Execution was interrupted for ${task.title}. Choose retry, skip, or cancel.`,
              choices: ["retry", "skip", "cancel"],
            })
          }
          yield* orchestration.setTaskStatus({
            runID,
            taskID: task.id,
            status: detail.run.policy?.acceptance.mode === "judge" ? "waiting_on_human" : "awaiting_review",
          })
        }),
      { discard: true },
    )
  })
}

function settleRun(orchestration: Orchestration.Interface, detail: Detail, retryAt?: DateTime.Utc) {
  if (detail.tasks.every((task) => ["succeeded", "failed", "cancelled", "blocked"].includes(task.status)))
    return orchestration.setRunStatus({
      runID: detail.run.id,
      status: detail.tasks.every((task) => task.status === "succeeded") ? "completed" : "failed",
    })
  if (detail.tasks.some((task) => task.status === "suspended"))
    return orchestration.setRunStatus({ runID: detail.run.id, status: "suspended", retryAt })
  return Effect.void
}

export function nextRetryAt(detail: Detail, now: DateTime.Utc) {
  const earliest = detail.tasks
    .filter((task) => task.status === "suspended")
    .flatMap((task) => {
      const retryAt = detail.routeDecisions.findLast((decision) => decision.taskID === task.id)?.resolution.retryAt
      return retryAt ? [DateTime.toEpochMillis(retryAt)] : []
    })
    .toSorted((a, b) => a - b)[0]
  if (earliest === undefined) return undefined
  return DateTime.makeUnsafe(earliest > DateTime.toEpochMillis(now) ? earliest : DateTime.toEpochMillis(now) + 60_000)
}

function completeAttempt(
  orchestration: Orchestration.Interface,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  status: "succeeded" | "failed",
) {
  return Effect.gen(function* () {
    yield* orchestration.setAttemptStatus({
      runID,
      taskID,
      attemptID,
      status,
      completed: yield* DateTime.now,
    })
    yield* orchestration.setTaskStatus({ runID, taskID, status: "awaiting_review" })
  })
}

function finishFailure(
  orchestration: Orchestration.Interface,
  run: Run,
  task: Task,
  attemptID: AttemptID,
  message: string,
) {
  return Effect.gen(function* () {
    yield* orchestration.recordEvaluation({
      runID: run.id,
      taskID: task.id,
      attemptID,
      kind: "execution",
      status: "failed",
      evidence: { message },
    })
    if (run.policy?.acceptance.mode !== "judge")
      return yield* completeAttempt(orchestration, run.id, task.id, attemptID, "failed")
    yield* orchestration.setAttemptStatus({
      runID: run.id,
      taskID: task.id,
      attemptID,
      status: "failed",
      completed: yield* DateTime.now,
    })
    yield* orchestration.openHumanRequest({
      runID: run.id,
      taskID: task.id,
      kind: "recovery",
      prompt: `Execution failed for ${task.title}: ${message.slice(0, 1_000)}. Choose retry, skip, or cancel.`,
      choices: ["retry", "skip", "cancel"],
    })
    yield* orchestration.setTaskStatus({ runID: run.id, taskID: task.id, status: "waiting_on_human" })
  })
}

function errorMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export function attemptReviewRequest(
  run: Run,
  task: Task,
  candidate: NonNullable<Attempt["candidate"]>,
  evaluations: ReadonlyArray<OrchestrationExecutor.Evaluation>,
) {
  return {
    purpose: "attempt_review",
    state: {
      objective: run.objective.slice(0, maximumJudgmentTextCharacters),
      task: {
        title: task.title.slice(0, maximumJudgmentTextCharacters),
        description: task.description?.slice(0, maximumJudgmentTextCharacters) ?? null,
      },
      route: judgmentRoute(candidate),
      evaluations: evaluations.slice(0, maximumJudgmentEvaluations).map((evaluation) => ({
        kind: evaluation.kind.slice(0, maximumJudgmentTextCharacters),
        status: evaluation.status,
        exitCode: typeof evaluation.evidence.exitCode === "number" ? evaluation.evidence.exitCode : null,
        baselineExitCode:
          typeof evaluation.evidence.baseline === "object" &&
          evaluation.evidence.baseline !== null &&
          "exitCode" in evaluation.evidence.baseline &&
          typeof evaluation.evidence.baseline.exitCode === "number"
            ? evaluation.evidence.baseline.exitCode
            : null,
        changed:
          evaluation.kind === "workspace"
            ? typeof evaluation.evidence.patch === "string" && evaluation.evidence.patch.length > 0
            : null,
        truncated: evaluation.evidence.truncated === true,
      })),
      inputTruncated:
        run.objective.length > maximumJudgmentTextCharacters ||
        task.title.length > maximumJudgmentTextCharacters ||
        (task.description?.length ?? 0) > maximumJudgmentTextCharacters ||
        evaluations.length > maximumJudgmentEvaluations ||
        evaluations.some((evaluation) => evaluation.kind.length > maximumJudgmentTextCharacters) ||
        judgmentRouteInputTruncated(candidate),
    },
    question: {
      instructions:
        "Classify whether this coding attempt looks ready for routine human review or needs extra attention. Use only the supplied task, route, and evaluation summary. A failed check, execution failure, missing change, or indeterminate evidence should favor needs_attention.",
      criteria: {
        looks_ready: "The attempt has a change and the available deterministic checks support routine review.",
        needs_attention:
          "The evidence is failed, indeterminate, missing, contradictory, or suggests closer investigation before acceptance.",
      },
    },
    fallback: "needs_attention",
  } as const
}

export function tierRecommendationRequest(run: Run, task: Task, policy: ConfigOrchestration.TierClassifier) {
  const tiers = Object.entries(policy.tiers)
  if (
    tiers.length < 2 ||
    tiers.length > 16 ||
    !Object.hasOwn(policy.tiers, policy.fallback) ||
    tiers.some(
      ([tier, description]) =>
        tier.length === 0 ||
        tier.length > 80 ||
        tier.trim() !== tier ||
        description.trim().length === 0 ||
        description.length > 500,
    )
  )
    return undefined

  return {
    purpose: "capability_tier",
    state: {
      objective: run.objective.slice(0, maximumJudgmentTextCharacters),
      task: {
        title: task.title.slice(0, maximumJudgmentTextCharacters),
        description: task.description?.slice(0, maximumJudgmentTextCharacters) ?? null,
      },
      inputTruncated:
        run.objective.length > maximumJudgmentTextCharacters ||
        task.title.length > maximumJudgmentTextCharacters ||
        (task.description?.length ?? 0) > maximumJudgmentTextCharacters,
    },
    question: {
      instructions:
        "Choose the least costly capability tier whose stated capabilities are sufficient for the task. Use only the objective, task, and tier descriptions. Return exactly one configured tier. This is a recommendation and does not choose a provider or route.",
      criteria: Object.fromEntries(tiers),
    },
    fallback: policy.fallback,
  } as const
}

function judgmentRoute(candidate: NonNullable<Attempt["candidate"]>): Record<string, string | null> {
  if (candidate.type === "direct")
    return {
      type: candidate.type,
      provider: candidate.providerID.slice(0, maximumJudgmentTextCharacters),
      model: candidate.modelID.slice(0, maximumJudgmentTextCharacters),
      variant: candidate.variant?.slice(0, maximumJudgmentTextCharacters) ?? null,
    }
  return {
    type: candidate.type,
    harness: candidate.harnessID.slice(0, maximumJudgmentTextCharacters),
    model: candidate.modelID.slice(0, maximumJudgmentTextCharacters),
    effort: candidate.effort?.slice(0, maximumJudgmentTextCharacters) ?? null,
  }
}

function judgmentRouteInputTruncated(candidate: NonNullable<Attempt["candidate"]>) {
  const values =
    candidate.type === "direct"
      ? [candidate.providerID, candidate.modelID, candidate.variant]
      : [candidate.harnessID, candidate.modelID, candidate.effort]
  return values.some((value) => (value?.length ?? 0) > maximumJudgmentTextCharacters)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Orchestration.node, OrchestrationExecutor.node, LocationServiceMap.node, SessionV2.node, AppProcess.node, Global.node, EventV2.node],
})
