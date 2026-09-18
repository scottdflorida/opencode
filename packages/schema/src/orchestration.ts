export * as Orchestration from "./orchestration"

import { Schema } from "effect"
import { Event } from "./event"
import { ascending } from "./identifier"
import { Location } from "./location"
import { ProjectID } from "./project-id"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { SessionID } from "./session-id"

const identifier = <Brand extends string>(prefix: string, brand: Brand) =>
  Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const RunID = identifier("run_", "Orchestration.RunID")
export type RunID = typeof RunID.Type

export const TaskID = identifier("task_", "Orchestration.TaskID")
export type TaskID = typeof TaskID.Type

export const AttemptID = identifier("attempt_", "Orchestration.AttemptID")
export type AttemptID = typeof AttemptID.Type

export const RouteDecisionID = identifier("route_", "Orchestration.RouteDecisionID")
export type RouteDecisionID = typeof RouteDecisionID.Type

export const EvaluationID = identifier("eval_", "Orchestration.EvaluationID")
export type EvaluationID = typeof EvaluationID.Type

export const RunStatus = Schema.Literals(["draft", "active", "suspended", "completed", "cancelled"])
export type RunStatus = typeof RunStatus.Type

export const TaskStatus = Schema.Literals([
  "draft",
  "ready",
  "blocked",
  "running",
  "evaluating",
  "awaiting_review",
  "succeeded",
  "failed",
  "cancelled",
  "suspended",
])
export type TaskStatus = typeof TaskStatus.Type

export const AttemptStatus = Schema.Literals([
  "pending",
  "running",
  "evaluating",
  "succeeded",
  "failed",
  "interrupted",
  "abandoned",
])
export type AttemptStatus = typeof AttemptStatus.Type

export const EvaluationStatus = Schema.Literals(["passed", "failed", "indeterminate"])
export type EvaluationStatus = typeof EvaluationStatus.Type

export const Time = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Time" })
export interface Time extends Schema.Schema.Type<typeof Time> {}

export const Run = Schema.Struct({
  id: RunID,
  projectID: ProjectID,
  objective: Schema.String,
  status: RunStatus,
  retryAt: DateTimeUtcFromMillis.pipe(optional),
  time: Time,
}).annotate({ identifier: "Orchestration.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

export const Task = Schema.Struct({
  id: TaskID,
  runID: RunID,
  title: Schema.String,
  description: Schema.String.pipe(optional),
  routeProfile: Schema.String.pipe(optional),
  status: TaskStatus,
  time: Time,
}).annotate({ identifier: "Orchestration.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const Dependency = Schema.Struct({
  runID: RunID,
  taskID: TaskID,
  dependsOnTaskID: TaskID,
}).annotate({ identifier: "Orchestration.Dependency" })
export interface Dependency extends Schema.Schema.Type<typeof Dependency> {}

export const DirectCandidate = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("direct"),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.DirectCandidate" })
export interface DirectCandidate extends Schema.Schema.Type<typeof DirectCandidate> {}

export const HarnessCandidate = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("harness"),
  harnessID: Schema.String,
  modelID: Schema.String,
  effort: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.HarnessCandidate" })
export interface HarnessCandidate extends Schema.Schema.Type<typeof HarnessCandidate> {}

export const Candidate = Schema.Union([DirectCandidate, HarnessCandidate]).pipe(Schema.toTaggedUnion("type"))
export type Candidate = typeof Candidate.Type

export const Attempt = Schema.Struct({
  id: AttemptID,
  runID: RunID,
  taskID: TaskID,
  status: AttemptStatus,
  candidate: Candidate.pipe(optional),
  sessionID: SessionID.pipe(optional),
  location: Location.Ref.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Orchestration.Attempt" })
export interface Attempt extends Schema.Schema.Type<typeof Attempt> {}

export const CapacityProviderState = Schema.Literals([
  "live",
  "partial",
  "no_data",
  "checking",
  "available",
  "not_installed",
  "unavailable",
  "failed_transient",
  "failed_permanent",
  "invalid_report",
  "unknown",
])
export type CapacityProviderState = typeof CapacityProviderState.Type

export const CapacityProvider = Schema.Struct({
  id: Schema.String,
  state: CapacityProviderState,
  coverage: Schema.String.pipe(optional),
  observedAt: DateTimeUtcFromMillis.pipe(optional),
  retryAfterSeconds: Schema.Int.pipe(optional),
  diagnosticCode: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.CapacityProvider" })
export interface CapacityProvider extends Schema.Schema.Type<typeof CapacityProvider> {}

export const CapacityMeter = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  remaining: Schema.Number.pipe(optional),
  timeRemaining: Schema.Number.pipe(optional),
  resetsAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Orchestration.CapacityMeter" })
export interface CapacityMeter extends Schema.Schema.Type<typeof CapacityMeter> {}

export const CapacitySnapshot = Schema.Struct({
  schema: Schema.Int,
  source: Schema.String,
  status: Schema.Literals(["live", "partial", "unavailable"]),
  capturedAt: DateTimeUtcFromMillis,
  providers: Schema.Array(CapacityProvider),
  meters: Schema.Array(CapacityMeter),
  diagnostic: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.CapacitySnapshot" })
export interface CapacitySnapshot extends Schema.Schema.Type<typeof CapacitySnapshot> {}

export const CapacityRequirement = Schema.Struct({
  meter: Schema.String,
  remainingAtLeast: Schema.Number,
}).annotate({ identifier: "Orchestration.CapacityRequirement" })
export interface CapacityRequirement extends Schema.Schema.Type<typeof CapacityRequirement> {}

export const RouteCandidate = Schema.Struct({
  candidate: Candidate,
  disabled: Schema.Boolean,
  requirements: Schema.Array(CapacityRequirement),
}).annotate({ identifier: "Orchestration.RouteCandidate" })
export interface RouteCandidate extends Schema.Schema.Type<typeof RouteCandidate> {}

export const RouteProfile = Schema.Struct({
  name: Schema.String,
  unknownCapacity: Schema.Literals(["wait", "allow"]),
  exhausted: Schema.Literals(["wait_until_soonest_reset", "fail"]),
  maxCapacityAgeSeconds: Schema.Int,
  candidates: Schema.Array(RouteCandidate),
}).annotate({ identifier: "Orchestration.RouteProfile" })
export interface RouteProfile extends Schema.Schema.Type<typeof RouteProfile> {}

export const RouteRejectionCode = Schema.Literals([
  "disabled",
  "provider_unavailable",
  "capacity_unknown",
  "capacity_stale",
  "capacity_below_threshold",
])
export type RouteRejectionCode = typeof RouteRejectionCode.Type

export const RouteRejection = Schema.Struct({
  candidateID: Schema.String,
  code: RouteRejectionCode,
  message: Schema.String,
  meter: Schema.String.pipe(optional),
  remaining: Schema.Number.pipe(optional),
  required: Schema.Number.pipe(optional),
  retryAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Orchestration.RouteRejection" })
export interface RouteRejection extends Schema.Schema.Type<typeof RouteRejection> {}

export const RouteResolution = Schema.Struct({
  status: Schema.Literals(["selected", "waiting", "failed"]),
  profile: Schema.String,
  selected: Candidate.pipe(optional),
  rejected: Schema.Array(RouteRejection),
  capacityCapturedAt: DateTimeUtcFromMillis,
  retryAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Orchestration.RouteResolution" })
export interface RouteResolution extends Schema.Schema.Type<typeof RouteResolution> {}

export const RouteDecision = Schema.Struct({
  id: RouteDecisionID,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID.pipe(optional),
  resolution: RouteResolution,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.RouteDecision" })
export interface RouteDecision extends Schema.Schema.Type<typeof RouteDecision> {}

export const Evaluation = Schema.Struct({
  id: EvaluationID,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  kind: Schema.String,
  status: EvaluationStatus,
  evidence: Schema.Record(Schema.String, Schema.Unknown),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Evaluation" })
export interface Evaluation extends Schema.Schema.Type<typeof Evaluation> {}

export const Detail = Schema.Struct({
  run: Run,
  tasks: Schema.Array(Task),
  dependencies: Schema.Array(Dependency),
  attempts: Schema.Array(Attempt),
  routeDecisions: Schema.Array(RouteDecision),
  evaluations: Schema.Array(Evaluation),
}).annotate({ identifier: "Orchestration.Detail" })
export interface Detail extends Schema.Schema.Type<typeof Detail> {}

const durable = { durable: { aggregate: "runID", version: 1 } } as const
const base = { runID: RunID, timestamp: DateTimeUtcFromMillis }

export const RunCreated = Event.define({
  type: "orchestration.run.created",
  ...durable,
  schema: { ...base, projectID: ProjectID, objective: Schema.String },
})

export const RunStatusChanged = Event.define({
  type: "orchestration.run.status.changed",
  ...durable,
  schema: { ...base, status: RunStatus, retryAt: DateTimeUtcFromMillis.pipe(optional) },
})

export const TaskAdded = Event.define({
  type: "orchestration.task.added",
  ...durable,
  schema: {
    ...base,
    taskID: TaskID,
    title: Schema.String,
    description: Schema.String.pipe(optional),
    routeProfile: Schema.String.pipe(optional),
  },
})

export const TaskStatusChanged = Event.define({
  type: "orchestration.task.status.changed",
  ...durable,
  schema: { ...base, taskID: TaskID, status: TaskStatus },
})

export const DependencyAdded = Event.define({
  type: "orchestration.dependency.added",
  ...durable,
  schema: { ...base, taskID: TaskID, dependsOnTaskID: TaskID },
})

export const AttemptCreated = Event.define({
  type: "orchestration.attempt.created",
  ...durable,
  schema: {
    ...base,
    attemptID: AttemptID,
    taskID: TaskID,
    candidate: Candidate.pipe(optional),
    sessionID: SessionID.pipe(optional),
    location: Location.Ref.pipe(optional),
  },
})

export const AttemptStatusChanged = Event.define({
  type: "orchestration.attempt.status.changed",
  ...durable,
  schema: {
    ...base,
    attemptID: AttemptID,
    taskID: TaskID,
    status: AttemptStatus,
    completed: DateTimeUtcFromMillis.pipe(optional),
  },
})

export const RouteDecided = Event.define({
  type: "orchestration.route.decided",
  ...durable,
  schema: {
    ...base,
    decisionID: RouteDecisionID,
    taskID: TaskID,
    attemptID: AttemptID.pipe(optional),
    resolution: RouteResolution,
  },
})

export const EvaluationRecorded = Event.define({
  type: "orchestration.evaluation.recorded",
  ...durable,
  schema: {
    ...base,
    evaluationID: EvaluationID,
    taskID: TaskID,
    attemptID: AttemptID,
    kind: Schema.String,
    status: EvaluationStatus,
    evidence: Schema.Record(Schema.String, Schema.Unknown),
  },
})

export const Definitions = Event.inventory(
  RunCreated,
  RunStatusChanged,
  TaskAdded,
  TaskStatusChanged,
  DependencyAdded,
  AttemptCreated,
  AttemptStatusChanged,
  RouteDecided,
  EvaluationRecorded,
)

export const Events = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Events = typeof Events.Type
