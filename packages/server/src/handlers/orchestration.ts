import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { OrchestrationRouting } from "@opencode-ai/core/orchestration/routing"
import { OrchestrationScheduler } from "@opencode-ai/core/orchestration/scheduler"
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
    return handlers
      .handle("orchestration.list", () =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          return yield* response(orchestration.list({ projectID: location.project.id }))
        }),
      )
      .handle("orchestration.create", (ctx) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          const run = yield* orchestration.create({
            projectID: location.project.id,
            project: { directory: location.project.directory, vcs: location.vcs },
            objective: ctx.payload.objective,
          })
          return yield* response(orchestration.get(run.id).pipe(Effect.orDie))
        }),
      )
      .handle("orchestration.capacity", () => OrchestrationRouting.Service.use((routing) => response(routing.capacity)))
      .handle("orchestration.routeProfiles", () =>
        OrchestrationRouting.Service.use((routing) => response(routing.profiles)),
      )
      .handle("orchestration.resolveRoute", (ctx) =>
        OrchestrationRouting.Service.use((routing) =>
          response(
            routing.resolve(ctx.payload.profile).pipe(
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
      .handle("orchestration.accept", (ctx) => review(scheduler, ctx, "accepted"))
      .handle("orchestration.reject", (ctx) => review(scheduler, ctx, "rejected"))
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
