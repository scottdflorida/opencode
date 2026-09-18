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

export class OrchestrationOperationError extends Schema.ErrorClass<OrchestrationOperationError>(
  "OrchestrationOperationError",
)(
  {
    name: Schema.Literal("OrchestrationOperationError"),
    data: Schema.Struct({ operation: Schema.String, message: Schema.String }),
  },
  { httpApiStatus: 409 },
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
    HttpApiEndpoint.post("orchestration.create", root, {
      query: LocationQuery,
      payload: Schema.Struct({ objective: Schema.String }),
      success: Location.response(Orchestration.Detail),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.create",
          summary: "Create an orchestration run",
          description: "Create a durable manual objective for the current project.",
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
    HttpApiEndpoint.post("orchestration.addTask", `${root}/:runID/task`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Schema.Struct({
        title: Schema.String,
        description: Schema.String.pipe(Schema.optional),
        routeProfile: Schema.String.pipe(Schema.optional),
        checks: Schema.Array(Orchestration.Check).pipe(Schema.optional),
      }),
      success: Location.response(Orchestration.Detail),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.addTask",
          summary: "Add an orchestration task",
          description: "Add an explicit task and deterministic checks to a draft run.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.addDependency", `${root}/:runID/dependency`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Schema.Struct({ taskID: Orchestration.TaskID, dependsOnTaskID: Orchestration.TaskID }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.addDependency",
          summary: "Add a task dependency",
          description: "Require one task to be accepted before another becomes ready.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.start", `${root}/:runID/start`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.start",
          summary: "Start an orchestration run",
          description: "Schedule ready tasks for isolated direct-model execution.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.cancel", `${root}/:runID/cancel`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.cancel",
          summary: "Cancel an orchestration run",
          description: "Interrupt local execution and cancel unfinished tasks.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.accept", `${root}/:runID/task/:taskID/accept`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      payload: Schema.Struct({ note: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.accept",
          summary: "Accept a task result",
          description: "Record acceptance and unlock dependent tasks.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.reject", `${root}/:runID/task/:taskID/reject`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      payload: Schema.Struct({ note: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.reject",
          summary: "Reject a task result",
          description: "Record rejection and leave the isolated result unmerged.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.retry", `${root}/:runID/task/:taskID/retry`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.retry",
          summary: "Retry a task",
          description: "Create a fresh attempt with a new worktree and Session.",
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
