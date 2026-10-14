import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Location } from "@opencode-ai/schema/location"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/orchestration"
const historyLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

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
    HttpApiEndpoint.get("orchestration.summaries", `${root}/summaries`, {
      query: LocationQuery,
      success: Location.response(Schema.Array(Orchestration.RunSummary)),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.summaries", summary: "List project run summaries" })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.create", root, {
      query: LocationQuery,
      payload: Schema.Struct({ objective: Schema.String, policy: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
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
    HttpApiEndpoint.post("orchestration.submit", `${root}/submit`, {
      query: LocationQuery,
      payload: Schema.Struct({
        objective: Schema.String,
        policy: Schema.String.pipe(Schema.optional),
        judge: Schema.Literals(["policy", "jev", "llm", "experiment"]).pipe(Schema.optional),
        minConfidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
        context: Schema.String.pipe(Schema.optional),
      }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.submit",
          summary: "Submit an assignment",
          description: "Create a policy run, generate its plan, and start when plan approval is automatic.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("orchestration.policies", `${root}/policy`, {
      query: LocationQuery,
      success: Location.response(Orchestration.PolicyCatalog),
      error: OrchestrationOperationError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.policies",
          summary: "List resolved orchestration policies",
          description: "Return validated policy snapshots and the configured default for the current project.",
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
    HttpApiEndpoint.get("orchestration.jevStatus", `${root}/judges/jev`, {
      query: LocationQuery,
      success: Location.response(Schema.Struct({ keyPresent: Schema.Boolean, model: Schema.String })),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.jevStatus", summary: "Get Jev connection configuration" })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.testJev", `${root}/judges/jev/test`, {
      query: LocationQuery,
      success: Location.response(Schema.Struct({ status: Schema.String, model: Schema.String, latencyMs: Schema.Number })),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.testJev", summary: "Test a Jev Choice call" })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.verifyCheckPreset", `${root}/check-presets/:name/run`, {
      params: { name: Schema.String },
      query: LocationQuery,
      success: Location.response(Schema.Array(Schema.Struct({
        name: Schema.String,
        exitCode: Schema.Int,
        stdout: Schema.String,
        stderr: Schema.String,
        truncated: Schema.Boolean,
      }))),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.verifyCheckPreset", summary: "Run a check preset in an isolated worktree" })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.resources", `${root}/resources`, {
      query: LocationQuery,
      success: Location.response(Orchestration.ResourceObservation),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.resources",
        summary: "Get combined routing resources",
        description: "Return one versioned observation of provider quota and host resources.",
      })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.compareJudges", `${root}/judges/compare`, {
      query: Schema.Struct({ ...LocationQuery.fields, since: Schema.String.pipe(Schema.optional), role: Schema.Literals(["attempt", "delivery"]).pipe(Schema.optional) }),
      success: Location.response(Orchestration.JudgeComparison),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.compareJudges", summary: "Compare judge arms" })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.comparePolicies", `${root}/policies/compare`, {
      query: Schema.Struct({ ...LocationQuery.fields, since: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.PolicyComparison),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.comparePolicies", summary: "Compare run policies" })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.labels", `${root}/labels`, {
      query: LocationQuery,
      success: Location.response(Schema.Array(Orchestration.ReviewPacket)),
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.labels", summary: "List blind review packets awaiting labels" })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.calibration", `${root}/calibration`, {
      query: LocationQuery,
      success: Location.response(Orchestration.JudgmentCalibration),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.calibration",
          summary: "Read shadow-judgment calibration",
          description:
            "Aggregate Jev validity, agreement with human review, latency, tokens, and priced estimates for the current project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.addTask", `${root}/:runID/task`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Schema.Struct({
        kind: Orchestration.Task.fields.kind.pipe(Schema.optional),
        title: Schema.String,
        description: Schema.String.pipe(Schema.optional),
        routeProfile: Schema.String.pipe(Schema.optional),
        capabilityTier: Orchestration.CapabilityTier.pipe(Schema.optional),
        checks: Schema.Array(Orchestration.Check).pipe(Schema.optional),
        acceptanceCriteria: Schema.Array(Orchestration.AcceptanceCriterion).pipe(Schema.optional),
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
    HttpApiEndpoint.post("orchestration.proposePlan", `${root}/:runID/plan`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Orchestration.PlanOutput,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.proposePlan",
          summary: "Propose a typed task graph",
          description: "Validate and durably store a bounded plan for an empty draft run.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.generatePlan", `${root}/:runID/plan/generate`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Schema.Struct({
        profile: Schema.String.pipe(Schema.optional),
        context: Schema.String.pipe(Schema.optional),
      }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.generatePlan",
          summary: "Generate a plan proposal",
          description: "Use a routed direct model to generate a bounded task graph and store it for review.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.applyPlan", `${root}/:runID/plan/:planID/apply`, {
      params: { runID: Orchestration.RunID, planID: Orchestration.PlanID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.applyPlan",
          summary: "Apply a plan proposal",
          description: "Atomically add a validated plan's tasks and dependencies to a draft run.",
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
    HttpApiEndpoint.get("orchestration.integrationTargets", `${root}/:runID/integration/targets`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      success: Location.response(Orchestration.IntegrationTargets),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.integrationTargets", summary: "List local integration branches and worktrees" })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.integrationPreflight", `${root}/:runID/integration/preflight`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Orchestration.IntegrationOptions,
      success: Location.response(Orchestration.IntegrationPreflight),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.integrationPreflight",
        summary: "Preview delivery integration",
        description: "Inspect target state and the commands for an explicit integration action.",
      })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.integrate", `${root}/:runID/integration`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Orchestration.IntegrationOptions,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.integrate",
        summary: "Integrate a delivered turn",
        description: "Run the previewed Git or pull request action and record each completed step.",
      })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.retryIntegration", `${root}/:runID/integration/:integrationID/retry`, {
      params: { runID: Orchestration.RunID, integrationID: Orchestration.IntegrationID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.retryIntegration",
        summary: "Retry remaining integration steps",
        description: "Verify recorded Git refs and continue a failed integration after its completed steps.",
      })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.followUp", `${root}/:runID/follow-up`, {
      params: { runID: Orchestration.RunID },
      query: LocationQuery,
      payload: Schema.Struct({ objective: Schema.String, context: Schema.String.pipe(Schema.optional) }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.followUp",
        summary: "Start a follow-up turn",
        description: "Continue on the run branch with a new assignment and a new delivery review.",
      })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.steerFollowUp", `${root}/:runID/follow-up/:turnID/steer`, {
      params: { runID: Orchestration.RunID, turnID: Orchestration.TurnID },
      query: LocationQuery,
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    }).annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.orchestration.steerFollowUp", summary: "Send a queued follow-up to the current planner" })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.reviewPacket", `${root}/:runID/task/:taskID/review-packet`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      success: Location.response(Orchestration.ReviewPacket),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.reviewPacket",
          summary: "Read attempt evidence without shadow judgments",
          description: "Return a review packet for an independent triage label.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("orchestration.labelTriage", `${root}/:runID/task/:taskID/triage`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      payload: Schema.Struct({
        decision: Orchestration.TriageDecision,
        note: Schema.String.pipe(Schema.optional),
      }),
      success: Location.response(Orchestration.TriageLabel),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.labelTriage",
          summary: "Record an independent attempt triage label",
          description: "Store one immutable reviewer label per completed attempt, separate from acceptance.",
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
    HttpApiEndpoint.post("orchestration.reopen", `${root}/:runID/task/:taskID/reopen`, {
      params: { runID: Orchestration.RunID, taskID: Orchestration.TaskID },
      query: LocationQuery,
      payload: Schema.Struct({ feedback: Schema.String }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.reopen",
        summary: "Reopen accepted work with feedback",
        description: "Revert an accepted merge at a safe boundary and schedule a revision with human feedback.",
      })),
  )
  .add(
    HttpApiEndpoint.post("orchestration.answerRequest", `${root}/:runID/request/:requestID/answer`, {
      params: { runID: Orchestration.RunID, requestID: Orchestration.HumanRequestID },
      query: LocationQuery,
      payload: Schema.Struct({ answer: Schema.String }),
      success: Location.response(Orchestration.Detail),
      error: [OrchestrationNotFoundError, OrchestrationOperationError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.orchestration.answerRequest",
          summary: "Answer an orchestration human request",
          description: "Record guidance or a budget decision and resume the affected task.",
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
      payload: Schema.Struct({
        profile: Schema.String.pipe(Schema.optional),
        capabilityTier: Orchestration.CapabilityTier.pipe(Schema.optional),
      }),
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
    HttpApiEndpoint.get("orchestration.history", `${root}/:runID/history`, {
      params: { runID: Orchestration.RunID },
      query: Schema.Struct({
        ...LocationQuery.fields,
        limit: Schema.NumberFromString.pipe(Schema.decodeTo(historyLimit), Schema.optional),
        after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
      }),
      success: Location.response(Schema.Struct({
        data: Schema.Array(Orchestration.Events),
        hasMore: Schema.Boolean,
      })),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.history",
        summary: "Get run event history",
        description: "Read one finite page of durable run events after an exclusive sequence.",
      })),
  )
  .add(
    HttpApiEndpoint.get("orchestration.events", `${root}/:runID/event`, {
      params: { runID: Orchestration.RunID },
      query: Schema.Struct({
        ...LocationQuery.fields,
        after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
      }),
      success: HttpApiSchema.StreamSse({ data: Orchestration.Events }),
      error: OrchestrationNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({
        identifier: "v2.orchestration.events",
        summary: "Subscribe to run events",
        description: "Replay durable run events after a sequence, then continue with new events.",
      })),
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
