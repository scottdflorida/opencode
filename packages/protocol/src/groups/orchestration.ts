import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/orchestration"

export class OrchestrationNotFoundError extends Schema.ErrorClass<OrchestrationNotFoundError>(
  "OrchestrationNotFoundError",
)(
  {
    name: Schema.Literal("OrchestrationNotFoundError"),
    data: Schema.Struct({ resource: Schema.String, id: Schema.String }),
  },
  { httpApiStatus: 404 },
) {}

export class RouteProfileNotFoundError extends Schema.ErrorClass<RouteProfileNotFoundError>(
  "RouteProfileNotFoundError",
)(
  {
    name: Schema.Literal("RouteProfileNotFoundError"),
    data: Schema.Struct({ profile: Schema.String }),
  },
  { httpApiStatus: 404 },
) {}

export const OrchestrationGroup = HttpApiGroup.make("server.orchestration")
  .add(
    HttpApiEndpoint.get("orchestration.list", root, {
      query: LocationQuery,
      success: Location.response(Schema.Array(Orchestration.Run)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.list",
          summary: "List orchestration runs",
          description: "List durable orchestration runs for the current project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.capacity", `${root}/capacity`, {
      query: LocationQuery,
      success: Location.response(Orchestration.CapacitySnapshot),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.capacity",
          summary: "Get provider capacity",
          description: "Return the latest cached provider-capacity observation.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.routeProfiles", `${root}/route-profile`, {
      query: LocationQuery,
      success: Location.response(Schema.Array(Orchestration.RouteProfile)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.routeProfiles",
          summary: "List route profiles",
          description: "Return normalized route profiles from the effective location configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.resolveRoute", `${root}/route/resolve`, {
      query: LocationQuery,
      payload: Schema.Struct({ profile: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.RouteResolution),
      error: RouteProfileNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.resolveRoute",
          summary: "Resolve a route without executing it",
          description: "Dry-run an ordered route profile against the latest cached capacity snapshot.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.get", `${root}/:runID`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.get",
          summary: "Get an orchestration run",
          description: "Return a durable run with tasks, dependencies, attempts, decisions, and evaluations.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "orchestration",
      description: "Durable orchestration inspection and route-resolution routes.",
    }),
  )
