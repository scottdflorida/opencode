import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { OrchestrationRouting } from "@opencode-ai/core/orchestration/routing"
import { Location } from "@opencode-ai/core/location"
import { Api } from "../api"
import { response } from "../location"
import { OrchestrationNotFoundError, RouteProfileNotFoundError } from "@opencode-ai/protocol/groups/orchestration"

export const OrchestrationHandler = HttpApiBuilder.group(Api, "server.orchestration", (handlers) =>
  Effect.succeed(
    handlers
      .handle("orchestration.list", () =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration.Service
          const location = yield* Location.Service
          return yield* response(orchestration.list({ projectID: location.project.id }))
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
      ),
  ),
)
