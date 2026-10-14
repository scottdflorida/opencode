export * as Orchestration from "./orchestration"

import { Schema } from "effect"
import { Event } from "./event"
import { ascending } from "./identifier"
import { Location } from "./location"
import { ProjectID } from "./project-id"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { TypedJudge } from "./typed-judge"

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

export const ReviewID = identifier("review_", "Orchestration.ReviewID")
export type ReviewID = typeof ReviewID.Type

export const TriageLabelID = identifier("triage_", "Orchestration.TriageLabelID")
export type TriageLabelID = typeof TriageLabelID.Type

export const JudgmentID = identifier("judgment_", "Orchestration.JudgmentID")
export type JudgmentID = typeof JudgmentID.Type

export const HumanRequestID = identifier("request_", "Orchestration.HumanRequestID")
export type HumanRequestID = typeof HumanRequestID.Type

export const ReassignmentID = identifier("reassign_", "Orchestration.ReassignmentID")
export type ReassignmentID = typeof ReassignmentID.Type

export const TierRecommendationID = identifier("tier_", "Orchestration.TierRecommendationID")
export type TierRecommendationID = typeof TierRecommendationID.Type

export const PlanID = identifier("plan_", "Orchestration.PlanID")
export type PlanID = typeof PlanID.Type

export const DeliveryID = identifier("delivery_", "Orchestration.DeliveryID")
export type DeliveryID = typeof DeliveryID.Type

export const IntegrationID = identifier("integrate_", "Orchestration.IntegrationID")
export type IntegrationID = typeof IntegrationID.Type

export const TurnID = identifier("turn_", "Orchestration.TurnID")
export type TurnID = typeof TurnID.Type

export const RunStatus = Schema.Literals([
  "draft",
  "clarifying",
  "active",
  "reviewing_delivery",
  "delivered",
  "suspended",
  "completed",
  "failed",
  "cancelled",
])
export type RunStatus = typeof RunStatus.Type

export const TaskStatus = Schema.Literals([
  "draft",
  "ready",
  "blocked",
  "running",
  "evaluating",
  "awaiting_review",
  "waiting_on_human",
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

export const ReviewDecision = Schema.Literals(["accepted", "rejected"])
export type ReviewDecision = typeof ReviewDecision.Type

export const TriageDecision = Schema.Literals(["looks_ready", "needs_attention"])
export type TriageDecision = typeof TriageDecision.Type

// Tier IDs are policy-owned so model and hardware changes do not alter task history.
export const CapabilityTier = Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())).annotate({
  identifier: "Orchestration.CapabilityTier",
})
export type CapabilityTier = typeof CapabilityTier.Type

export const Check = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  workingDirectory: Schema.String.pipe(optional),
  baseline: Schema.Boolean.pipe(optional),
  timeoutSeconds: Schema.Int.check(Schema.isGreaterThan(0)).pipe(optional),
}).annotate({ identifier: "Orchestration.Check" })
export interface Check extends Schema.Schema.Type<typeof Check> {}

export const CheckPreset = Schema.Struct({
  description: Schema.String.pipe(optional),
  checks: Schema.Array(Check),
}).annotate({ identifier: "Orchestration.CheckPreset" })
export interface CheckPreset extends Schema.Schema.Type<typeof CheckPreset> {}

export const AcceptanceCriterion = Schema.Struct({
  key: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "Orchestration.AcceptanceCriterion" })
export interface AcceptanceCriterion extends Schema.Schema.Type<typeof AcceptanceCriterion> {}

export const PlanTask = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["agent", "human"]).pipe(optional),
  title: Schema.String,
  description: Schema.String.pipe(optional),
  routeProfile: Schema.String.pipe(optional),
  capabilityTier: CapabilityTier.pipe(optional),
  checks: Schema.Array(Check),
  acceptanceCriteria: Schema.Array(AcceptanceCriterion).pipe(optional),
  dependsOn: Schema.Array(Schema.String),
}).annotate({ identifier: "Orchestration.PlanTask" })
export interface PlanTask extends Schema.Schema.Type<typeof PlanTask> {}

export const PlanOutput = Schema.Struct({
  rationale: Schema.String.pipe(optional),
  clauses: Schema.Array(AcceptanceCriterion).pipe(optional),
  cancelTaskIDs: Schema.Array(TaskID).pipe(optional),
  tasks: Schema.Array(PlanTask),
}).annotate({ identifier: "Orchestration.PlanOutput" })
export interface PlanOutput extends Schema.Schema.Type<typeof PlanOutput> {}

// Models propose structure only. Check commands and route policy stay operator owned.
export const PlanQuestion = Schema.Struct({
  key: Schema.String,
  prompt: Schema.String,
  choices: Schema.Array(Schema.String),
  assumption: Schema.String,
}).annotate({ identifier: "Orchestration.PlanQuestion" })
export interface PlanQuestion extends Schema.Schema.Type<typeof PlanQuestion> {}

export const GeneratedPlanOutput = Schema.Struct({
  kind: Schema.Literals(["plan", "questions"]),
  rationale: Schema.String.pipe(optional),
  questions: Schema.Array(PlanQuestion),
  clauses: Schema.Array(AcceptanceCriterion),
  cancelTaskIDs: Schema.Array(TaskID),
  tasks: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.Literals(["agent", "human"]),
      title: Schema.String,
      description: Schema.String.pipe(optional),
      acceptanceCriteria: Schema.Array(AcceptanceCriterion),
      capabilityTier: CapabilityTier.pipe(Schema.NullOr),
      checkPresets: Schema.Array(Schema.String),
      dependsOn: Schema.Array(Schema.String),
    }),
  ),
}).annotate({ identifier: "Orchestration.GeneratedPlanOutput" })
export interface GeneratedPlanOutput extends Schema.Schema.Type<typeof GeneratedPlanOutput> {}

export const Time = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Time" })
export interface Time extends Schema.Schema.Type<typeof Time> {}

export const Task = Schema.Struct({
  id: TaskID,
  runID: RunID,
  kind: Schema.Literals(["agent", "human"]),
  title: Schema.String,
  description: Schema.String.pipe(optional),
  routeProfile: Schema.String.pipe(optional),
  capabilityTier: CapabilityTier.pipe(optional),
  checks: Schema.Array(Check),
  acceptanceCriteria: Schema.Array(AcceptanceCriterion),
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

export const AttemptVerdictBase = Schema.Struct({
  decision: Schema.Literals(["accept", "revise", "needs_human"]),
  confidence: Schema.Number,
  gateFailures: Schema.Array(Schema.String),
  criteria: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      decision: Schema.Literals(["met", "not_met", "unclear"]),
      request: TypedJudge.ChoiceRequest,
      result: TypedJudge.ChoiceResult,
    }),
  ),
  overall: Schema.Struct({
    request: TypedJudge.ChoiceRequest,
    result: TypedJudge.ChoiceResult,
  }).pipe(optional),
}).annotate({ identifier: "Orchestration.AttemptVerdictBase" })
export const AttemptVerdict = Schema.Struct({
  ...AttemptVerdictBase.fields,
  experiment: Schema.Struct({
    assignment: Schema.Literals(["split", "paired"]),
    authoritativeArm: Schema.String,
    seed: Schema.Int,
    arms: Schema.Array(Schema.Struct({ arm: Schema.String, verdict: AttemptVerdictBase })),
  }).pipe(optional),
}).annotate({ identifier: "Orchestration.AttemptVerdict" })
export interface AttemptVerdict extends Schema.Schema.Type<typeof AttemptVerdict> {}

export const AttemptFeedback = Schema.Struct({
  source: Schema.Literals(["deterministic", "llm", "human"]),
  text: Schema.String,
  criterionKeys: Schema.Array(Schema.String),
  failedChecks: Schema.Array(Schema.String),
}).annotate({ identifier: "Orchestration.AttemptFeedback" })
export interface AttemptFeedback extends Schema.Schema.Type<typeof AttemptFeedback> {}

export const DeliveryReview = Schema.Struct({
  decision: Schema.Literals(["delivered", "gaps", "needs_human"]),
  confidence: Schema.Number,
  gateFailures: Schema.Array(Schema.String),
  clauses: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      decision: Schema.Literals(["met", "not_met", "unclear"]),
      request: TypedJudge.ChoiceRequest,
      result: TypedJudge.ChoiceResult,
    }),
  ),
  overall: Schema.Struct({
    request: TypedJudge.ChoiceRequest,
    result: TypedJudge.ChoiceResult,
  }).pipe(optional),
}).annotate({ identifier: "Orchestration.DeliveryReview" })
export interface DeliveryReview extends Schema.Schema.Type<typeof DeliveryReview> {}

export const Delivery = Schema.Struct({
  id: DeliveryID,
  runID: RunID,
  planID: PlanID.pipe(optional),
  baseHead: Schema.String,
  head: Schema.String,
  changedFiles: Schema.Int,
  review: DeliveryReview,
  summary: Schema.String.pipe(optional),
  commitMessage: Schema.String.pipe(optional),
  summaryGeneration: Schema.suspend(() => PlanGeneration).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis, delivered: DateTimeUtcFromMillis.pipe(optional) }),
}).annotate({ identifier: "Orchestration.Delivery" })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

export const IntegrationAction = Schema.Literals(["apply", "commit", "merge", "push", "pull_request", "discard"])
export type IntegrationAction = typeof IntegrationAction.Type

export const IntegrationTargets = Schema.Struct({
  branches: Schema.Array(Schema.String),
  worktrees: Schema.Array(Schema.Struct({ branch: Schema.String, directory: Schema.String })),
}).annotate({ identifier: "Orchestration.IntegrationTargets" })
export interface IntegrationTargets extends Schema.Schema.Type<typeof IntegrationTargets> {}

export const IntegrationOptions = Schema.Struct({
  action: IntegrationAction,
  branch: Schema.String.pipe(optional),
  targetBranch: Schema.String.pipe(optional),
  remote: Schema.String.pipe(optional),
  remoteBranch: Schema.String.pipe(optional),
  baseBranch: Schema.String.pipe(optional),
  history: Schema.Literals(["squash", "per_task"]).pipe(optional),
  mergeStrategy: Schema.Literals(["ff", "merge", "squash"]).pipe(optional),
  commitMessage: Schema.String.pipe(optional),
  draft: Schema.Boolean.pipe(optional),
  reviewers: Schema.Array(Schema.String).pipe(optional),
  confirmDefaultPush: Schema.Boolean.pipe(optional),
  confirmDiscard: Schema.Boolean.pipe(optional),
  expectedHead: Schema.String,
  expectedTargetHead: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.IntegrationOptions" })
export interface IntegrationOptions extends Schema.Schema.Type<typeof IntegrationOptions> {}

export const IntegrationPreflight = Schema.Struct({
  deliveryID: DeliveryID,
  head: Schema.String,
  targetHead: Schema.String.pipe(optional),
  targetBranch: Schema.String.pipe(optional),
  targetDirectory: Schema.String.pipe(optional),
  targetDirty: Schema.Boolean,
  targetMoved: Schema.Boolean,
  cleanMerge: Schema.Boolean,
  defaultBranchPush: Schema.Boolean,
  commands: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "Orchestration.IntegrationPreflight" })
export interface IntegrationPreflight extends Schema.Schema.Type<typeof IntegrationPreflight> {}

export const IntegrationStep = Schema.Struct({
  name: Schema.Literals(["apply", "commit", "checks", "merge", "push", "pull_request", "discard"]),
  status: Schema.Literals(["succeeded", "failed"]),
  commit: Schema.String.pipe(optional),
  branch: Schema.String.pipe(optional),
  remote: Schema.String.pipe(optional),
  remoteBranch: Schema.String.pipe(optional),
  pullRequestURL: Schema.String.pipe(optional),
  message: Schema.String.pipe(optional),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.IntegrationStep" })
export interface IntegrationStep extends Schema.Schema.Type<typeof IntegrationStep> {}

export const Integration = Schema.Struct({
  id: IntegrationID,
  runID: RunID,
  deliveryID: DeliveryID,
  options: IntegrationOptions,
  status: Schema.Literals(["running", "completed", "failed"]),
  steps: Schema.Array(IntegrationStep),
  time: Time,
}).annotate({ identifier: "Orchestration.Integration" })
export interface Integration extends Schema.Schema.Type<typeof Integration> {}

export const FollowUp = Schema.Struct({
  id: TurnID,
  runID: RunID,
  objective: Schema.String,
  context: Schema.String.pipe(optional),
  baseHead: Schema.String,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.FollowUp" })
export interface FollowUp extends Schema.Schema.Type<typeof FollowUp> {}

export const QueuedFollowUp = Schema.Struct({
  id: TurnID,
  runID: RunID,
  objective: Schema.String,
  context: Schema.String.pipe(optional),
  status: Schema.Literals(["queued", "steered", "started"]),
  time: DateTimeUtcFromMillis,
  timeSteered: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Orchestration.QueuedFollowUp" })
export interface QueuedFollowUp extends Schema.Schema.Type<typeof QueuedFollowUp> {}

export const HumanRequest = Schema.Struct({
  id: HumanRequestID,
  runID: RunID,
  taskID: TaskID.pipe(optional),
  kind: Schema.Literals(["clarification", "human_step", "plan_approval", "budget_exhausted", "recovery"]),
  prompt: Schema.String,
  choices: Schema.Array(Schema.String),
  assumption: Schema.String.pipe(optional),
  status: Schema.Literals(["open", "answered"]),
  answer: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    answered: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Orchestration.HumanRequest" })
export interface HumanRequest extends Schema.Schema.Type<typeof HumanRequest> {}

export const ReassignmentOption = Schema.Struct({
  action: Schema.Literals(["revise", "reassign", "escalate", "rebase", "human"]),
  tier: CapabilityTier.pipe(optional),
  candidateID: Schema.String.pipe(optional),
}).annotate({ identifier: "Orchestration.ReassignmentOption" })
export interface ReassignmentOption extends Schema.Schema.Type<typeof ReassignmentOption> {}

export const Reassignment = Schema.Struct({
  id: ReassignmentID,
  runID: RunID,
  taskID: TaskID,
  afterAttemptID: AttemptID,
  options: Schema.Array(ReassignmentOption),
  selected: ReassignmentOption,
  chooser: Schema.Literals(["rule", "jev", "llm"]),
  request: TypedJudge.ChoiceRequest.pipe(optional),
  result: TypedJudge.ChoiceResult.pipe(optional),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Reassignment" })
export interface Reassignment extends Schema.Schema.Type<typeof Reassignment> {}

export const Attempt = Schema.Struct({
  id: AttemptID,
  runID: RunID,
  taskID: TaskID,
  kind: Schema.Literals(["initial", "revision", "reassignment", "rebase"]),
  status: AttemptStatus,
  candidate: Candidate.pipe(optional),
  sessionID: SessionID.pipe(optional),
  location: Location.Ref.pipe(optional),
  verdict: AttemptVerdict.pipe(optional),
  feedback: AttemptFeedback.pipe(optional),
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

export const HarnessObservation = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["available", "not_installed", "unauthenticated", "unsupported", "unknown"]),
  version: Schema.String.pipe(optional),
  models: Schema.Array(Schema.String).pipe(optional),
  efforts: Schema.Array(Schema.String).pipe(optional),
  modelEfforts: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(optional),
}).annotate({ identifier: "Orchestration.HarnessObservation" })
export interface HarnessObservation extends Schema.Schema.Type<typeof HarnessObservation> {}

export const HarnessSnapshot = Schema.Struct({
  schema: Schema.Literal(1),
  source: Schema.Literal("host"),
  capturedAt: DateTimeUtcFromMillis,
  harnesses: Schema.Array(HarnessObservation),
}).annotate({ identifier: "Orchestration.HarnessSnapshot" })
export interface HarnessSnapshot extends Schema.Schema.Type<typeof HarnessSnapshot> {}

export const HostResourceSnapshot = Schema.Struct({
  schema: Schema.Literal(1),
  source: Schema.Literal("host"),
  capturedAt: DateTimeUtcFromMillis,
  platform: Schema.String,
  architecture: Schema.String,
  totalMemoryBytes: Schema.Int,
  freeMemoryBytes: Schema.Int,
  cpuCount: Schema.Int,
  load1: Schema.Number,
  load5: Schema.Number,
  load15: Schema.Number,
}).annotate({ identifier: "Orchestration.HostResourceSnapshot" })
export interface HostResourceSnapshot extends Schema.Schema.Type<typeof HostResourceSnapshot> {}

export const ResourceObservation = Schema.Struct({
  schema: Schema.Literal(1),
  capturedAt: DateTimeUtcFromMillis,
  quota: CapacitySnapshot,
  host: HostResourceSnapshot,
  harnesses: HarnessSnapshot.pipe(optional),
}).annotate({ identifier: "Orchestration.ResourceObservation" })
export interface ResourceObservation extends Schema.Schema.Type<typeof ResourceObservation> {}

export const CapacityRequirement = Schema.Struct({
  meter: Schema.String,
  remainingAtLeast: Schema.Number,
}).annotate({ identifier: "Orchestration.CapacityRequirement" })
export interface CapacityRequirement extends Schema.Schema.Type<typeof CapacityRequirement> {}

export const RouteCandidate = Schema.Struct({
  candidate: Candidate,
  capabilityTier: CapabilityTier.pipe(optional),
  disabled: Schema.Boolean,
  requirements: Schema.Array(CapacityRequirement),
  hostFreeMemoryAtLeastBytes: Schema.Int.pipe(optional),
}).annotate({ identifier: "Orchestration.RouteCandidate" })
export interface RouteCandidate extends Schema.Schema.Type<typeof RouteCandidate> {}

export const RouteProfile = Schema.Struct({
  name: Schema.String,
  unknownCapacity: Schema.Literals(["wait", "allow"]),
  exhausted: Schema.Literals(["wait_until_soonest_reset", "fail"]),
  maxCapacityAgeSeconds: Schema.Int,
  quotaReserves: Schema.Record(Schema.String, Schema.Number).pipe(optional),
  privacy: Schema.Struct({
    providers: Schema.Array(Schema.String).pipe(optional),
    harnesses: Schema.Array(Schema.String).pipe(optional),
    models: Schema.Array(Schema.String).pipe(optional),
  }).pipe(optional),
  candidates: Schema.Array(RouteCandidate),
}).annotate({ identifier: "Orchestration.RouteProfile" })
export interface RouteProfile extends Schema.Schema.Type<typeof RouteProfile> {}

export const PolicyJudge = Schema.Struct({
  provider: Schema.Literals(["jev", "llm", "experiment"]),
  routeProfile: Schema.String.pipe(optional),
  labelSampleRate: Schema.Number.pipe(optional),
  experiment: Schema.Struct({
    arms: Schema.Record(Schema.String, Schema.Struct({
      provider: Schema.Literals(["jev", "llm"]),
      routeProfile: Schema.String.pipe(optional),
    })),
    assignment: Schema.Literals(["split", "paired"]),
    authoritative: Schema.String,
    seed: Schema.Int,
  }).pipe(optional),
}).annotate({ identifier: "Orchestration.PolicyJudge" })
export interface PolicyJudge extends Schema.Schema.Type<typeof PolicyJudge> {}

export const PolicyRoles = Schema.Struct({
  planner: Schema.String,
  executor: Schema.String,
  judge: PolicyJudge,
  decider: PolicyJudge,
  feedback: Schema.String.pipe(optional),
  deliveryReviewer: Schema.String,
  summarizer: Schema.String,
}).annotate({ identifier: "Orchestration.PolicyRoles" })
export interface PolicyRoles extends Schema.Schema.Type<typeof PolicyRoles> {}

export const PolicySnapshot = Schema.Struct({
  name: Schema.String,
  roles: PolicyRoles,
  tiers: Schema.Record(Schema.String, Schema.String),
  checkPresets: Schema.Record(Schema.String, CheckPreset).pipe(optional),
  escalationChain: Schema.Array(CapabilityTier),
  budgets: Schema.Struct({
    maxRevisionsPerRoute: Schema.Int,
    maxEscalations: Schema.Int,
    maxRebasesPerTask: Schema.Int.pipe(optional),
    maxReplans: Schema.Int,
    maxAttempts: Schema.Int.pipe(optional),
  }),
  acceptance: Schema.Struct({
    mode: Schema.Literals(["human", "judge"]),
    minConfidence: Schema.Number,
    skipJudgeOnRegression: Schema.Boolean,
  }),
  planApproval: Schema.Literals(["auto", "human"]),
  clarify: Schema.Literals(["ask", "assume"]),
  integrationDefault: IntegrationAction.pipe(optional),
  routeProfiles: Schema.Array(RouteProfile),
}).annotate({ identifier: "Orchestration.PolicySnapshot" })
export interface PolicySnapshot extends Schema.Schema.Type<typeof PolicySnapshot> {}

export const PolicyCatalog = Schema.Struct({
  defaultPolicy: Schema.String.pipe(optional),
  policies: Schema.Array(PolicySnapshot),
}).annotate({ identifier: "Orchestration.PolicyCatalog" })
export interface PolicyCatalog extends Schema.Schema.Type<typeof PolicyCatalog> {}

export const RunWorkspace = Schema.Struct({
  sourceBranch: Schema.String.pipe(optional),
  sourceHead: Schema.String,
  runBranch: Schema.String,
  integration: Location.Ref,
}).annotate({ identifier: "Orchestration.RunWorkspace" })
export interface RunWorkspace extends Schema.Schema.Type<typeof RunWorkspace> {}

export const Run = Schema.Struct({
  id: RunID,
  sessionID: SessionID.pipe(optional),
  projectID: ProjectID,
  objective: Schema.String,
  context: Schema.String.pipe(optional),
  status: RunStatus,
  policy: PolicySnapshot.pipe(optional),
  workspace: RunWorkspace.pipe(optional),
  retryAt: DateTimeUtcFromMillis.pipe(optional),
  source: Location.Ref.pipe(optional),
  time: Time,
}).annotate({ identifier: "Orchestration.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

export const RouteRejectionCode = Schema.Literals([
  "disabled",
  "privacy_disallowed",
  "tier_mismatch",
  "provider_unavailable",
  "capacity_unknown",
  "capacity_stale",
  "capacity_below_threshold",
  "harness_unavailable",
  "harness_unsupported",
  "host_memory_unknown",
  "host_memory_below_threshold",
])
export type RouteRejectionCode = typeof RouteRejectionCode.Type

export const RouteRejection = Schema.Struct({
  candidateID: Schema.String,
  code: RouteRejectionCode,
  message: Schema.String,
  meter: Schema.String.pipe(optional),
  remaining: Schema.Number.pipe(optional),
  required: Schema.Number.pipe(optional),
  availableBytes: Schema.Int.pipe(optional),
  requiredBytes: Schema.Int.pipe(optional),
  retryAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Orchestration.RouteRejection" })
export interface RouteRejection extends Schema.Schema.Type<typeof RouteRejection> {}

export const RouteResolution = Schema.Struct({
  status: Schema.Literals(["selected", "waiting", "failed"]),
  profile: Schema.String,
  profileSnapshot: RouteProfile.pipe(optional),
  capacitySnapshot: CapacitySnapshot.pipe(optional),
  harnessSnapshot: HarnessSnapshot.pipe(optional),
  resourceObservation: ResourceObservation.pipe(optional),
  requestedTier: CapabilityTier.pipe(optional),
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

export const Review = Schema.Struct({
  id: ReviewID,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  decision: ReviewDecision,
  note: Schema.String.pipe(optional),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Review" })
export interface Review extends Schema.Schema.Type<typeof Review> {}

export const TriageLabel = Schema.Struct({
  id: TriageLabelID,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  decision: TriageDecision,
  note: Schema.String.pipe(optional),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.TriageLabel" })
export interface TriageLabel extends Schema.Schema.Type<typeof TriageLabel> {}

export const ReviewPacket = Schema.Struct({
  run: Run,
  task: Task,
  attempt: Schema.Struct({
    id: Attempt.fields.id,
    runID: Attempt.fields.runID,
    taskID: Attempt.fields.taskID,
    kind: Attempt.fields.kind,
    status: Attempt.fields.status,
    candidate: Attempt.fields.candidate,
    sessionID: Attempt.fields.sessionID,
    location: Attempt.fields.location,
    time: Attempt.fields.time,
  }),
  routeDecision: RouteDecision.pipe(optional),
  evaluations: Schema.Array(Evaluation),
}).annotate({ identifier: "Orchestration.ReviewPacket" })
export interface ReviewPacket extends Schema.Schema.Type<typeof ReviewPacket> {}

export const JudgeComparison = Schema.Struct({
  arms: Schema.Array(Schema.Struct({
    name: Schema.String,
    provider: Schema.String,
    calls: Schema.Int,
    valid: Schema.Int,
    fallbacks: Schema.Int,
    authoritative: Schema.Int,
    latencyP50Ms: Schema.Number.pipe(optional),
    latencyP95Ms: Schema.Number.pipe(optional),
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    estimatedCostUsd: Schema.Number,
    humanOverrides: Schema.Int,
    downstreamGaps: Schema.Int,
    labeled: Schema.Int,
    labelAgreement: Schema.Int,
  })),
  pairs: Schema.Array(Schema.Struct({
    first: Schema.String,
    second: Schema.String,
    compared: Schema.Int,
    agreed: Schema.Int,
    confusion: Schema.Record(Schema.String, Schema.Int),
  })),
  disagreements: Schema.Array(Schema.Struct({
    runID: RunID,
    taskID: TaskID,
    attemptID: AttemptID,
    first: Schema.String,
    firstDecision: Schema.String,
    second: Schema.String,
    secondDecision: Schema.String,
  })),
}).annotate({ identifier: "Orchestration.JudgeComparison" })
export interface JudgeComparison extends Schema.Schema.Type<typeof JudgeComparison> {}

export const PolicyComparison = Schema.Struct({
  policies: Schema.Array(Schema.Struct({
    name: Schema.String,
    runs: Schema.Int,
    delivered: Schema.Int,
    acceptedTasks: Schema.Int,
    attempts: Schema.Int,
    reassignments: Schema.Int,
    humanRequests: Schema.Int,
    integrations: Schema.Int,
    attemptsPerAcceptedTask: Schema.Number.pipe(optional),
    reassignmentsPerAcceptedTask: Schema.Number.pipe(optional),
    humanRequestsPerDelivery: Schema.Number.pipe(optional),
    timeToDeliveryMs: Schema.Number.pipe(optional),
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    estimatedCostUsd: Schema.Number,
    measuredCalls: Schema.Int,
    examples: Schema.Array(RunID),
  })),
}).annotate({ identifier: "Orchestration.PolicyComparison" })
export interface PolicyComparison extends Schema.Schema.Type<typeof PolicyComparison> {}

export const Judgment = Schema.Struct({
  id: JudgmentID,
  runID: RunID,
  taskID: TaskID,
  attemptID: AttemptID,
  mode: Schema.Literal("shadow"),
  request: TypedJudge.ChoiceRequest,
  result: TypedJudge.ChoiceResult,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.Judgment" })
export interface Judgment extends Schema.Schema.Type<typeof Judgment> {}

export const TierRecommendation = Schema.Struct({
  id: TierRecommendationID,
  runID: RunID,
  taskID: TaskID,
  routeDecisionID: RouteDecisionID,
  explicitTier: CapabilityTier.pipe(optional),
  request: TypedJudge.ChoiceRequest,
  result: TypedJudge.ChoiceResult,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Orchestration.TierRecommendation" })
export interface TierRecommendation extends Schema.Schema.Type<typeof TierRecommendation> {}

export const TierCalibration = Schema.Struct({
  total: Schema.Int,
  valid: Schema.Int,
  invalid: Schema.Int,
  unavailable: Schema.Int,
  timedOut: Schema.Int,
  labeled: Schema.Int,
  agreement: Schema.Int,
  latency: Schema.Struct({
    calls: Schema.Int,
    meanMs: Schema.Number.pipe(optional),
    p50Ms: Schema.Number.pipe(optional),
    p95Ms: Schema.Number.pipe(optional),
  }),
  usage: Schema.Struct({
    measuredCalls: Schema.Int,
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    pricedCalls: Schema.Int,
    estimatedCostUsd: Schema.Number,
  }),
}).annotate({ identifier: "Orchestration.TierCalibration" })
export interface TierCalibration extends Schema.Schema.Type<typeof TierCalibration> {}

export const CalibrationGate = Schema.Struct({
  eligibleForPolicyReview: Schema.Boolean,
  unmet: Schema.Array(Schema.Literals(["sample_size", "validity", "agreement", "latency", "label_conflicts"])),
  uniqueRequests: Schema.Int,
  uniqueLabeled: Schema.Int,
  labelConflicts: Schema.Int,
  minimumLabeled: Schema.Int,
  minimumValidityPercent: Schema.Number,
  minimumAgreementPercent: Schema.Number,
  maximumP95Ms: Schema.Int,
}).annotate({ identifier: "Orchestration.CalibrationGate" })
export interface CalibrationGate extends Schema.Schema.Type<typeof CalibrationGate> {}

export const PlanGeneration = Schema.Struct({
  route: RouteResolution,
  prompt: Schema.String,
  requestDigest: Schema.String,
  latencyMs: Schema.Int,
  inputTokens: Schema.Int.pipe(optional),
  outputTokens: Schema.Int.pipe(optional),
}).annotate({ identifier: "Orchestration.PlanGeneration" })
export interface PlanGeneration extends Schema.Schema.Type<typeof PlanGeneration> {}

export const Plan = Schema.Struct({
  id: PlanID,
  runID: RunID,
  output: PlanOutput,
  generation: PlanGeneration.pipe(optional),
  status: Schema.Literals(["proposed", "applied"]),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    applied: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Orchestration.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const JudgmentCalibration = Schema.Struct({
  total: Schema.Int,
  valid: Schema.Int,
  invalid: Schema.Int,
  unavailable: Schema.Int,
  timedOut: Schema.Int,
  labeled: Schema.Int,
  agreement: Schema.Int,
  confusion: Schema.Struct({
    predictedReadyLabeledReady: Schema.Int,
    predictedReadyLabeledAttention: Schema.Int,
    predictedAttentionLabeledReady: Schema.Int,
    predictedAttentionLabeledAttention: Schema.Int,
  }),
  latency: Schema.Struct({
    calls: Schema.Int,
    meanMs: Schema.Number.pipe(optional),
    p50Ms: Schema.Number.pipe(optional),
    p95Ms: Schema.Number.pipe(optional),
  }),
  usage: Schema.Struct({
    measuredCalls: Schema.Int,
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    pricedCalls: Schema.Int,
    estimatedCostUsd: Schema.Number,
  }),
  tier: TierCalibration,
  promotion: Schema.Struct({
    attemptReview: CalibrationGate,
    tier: CalibrationGate,
  }),
}).annotate({ identifier: "Orchestration.JudgmentCalibration" })
export interface JudgmentCalibration extends Schema.Schema.Type<typeof JudgmentCalibration> {}

export const Detail = Schema.Struct({
  run: Run,
  plans: Schema.Array(Plan),
  deliveries: Schema.Array(Delivery),
  integrations: Schema.Array(Integration),
  followUps: Schema.Array(FollowUp),
  queuedFollowUps: Schema.Array(QueuedFollowUp),
  tasks: Schema.Array(Task),
  dependencies: Schema.Array(Dependency),
  attempts: Schema.Array(Attempt),
  routeDecisions: Schema.Array(RouteDecision),
  evaluations: Schema.Array(Evaluation),
  judgments: Schema.Array(Judgment),
  tierRecommendations: Schema.Array(TierRecommendation),
  reviews: Schema.Array(Review),
  triageLabels: Schema.Array(TriageLabel),
  humanRequests: Schema.Array(HumanRequest),
  reassignments: Schema.Array(Reassignment),
}).annotate({ identifier: "Orchestration.Detail" })
export interface Detail extends Schema.Schema.Type<typeof Detail> {}

export const RunSummary = Schema.Struct({
  runID: RunID,
  status: Run.fields.status,
  acceptedTasks: Schema.Int,
  totalTasks: Schema.Int,
  attention: Schema.String.pipe(optional),
  pendingLabels: Schema.Int,
  unintegrated: Schema.Boolean,
}).annotate({ identifier: "Orchestration.RunSummary" })
export interface RunSummary extends Schema.Schema.Type<typeof RunSummary> {}

const durable = { durable: { aggregate: "runID", version: 1 } } as const
const base = { runID: RunID, timestamp: DateTimeUtcFromMillis }

export const RunCreated = Event.define({
  type: "orchestration.run.created",
  ...durable,
  schema: {
    ...base,
    projectID: ProjectID,
    objective: Schema.String,
    context: Schema.String.pipe(optional),
    policy: PolicySnapshot.pipe(optional),
  },
})

export const RunStatusChanged = Event.define({
  type: "orchestration.run.status.changed",
  ...durable,
  schema: { ...base, status: RunStatus, retryAt: DateTimeUtcFromMillis.pipe(optional) },
})

export const RunSourceSet = Event.define({
  type: "orchestration.run.source.set",
  ...durable,
  schema: { ...base, source: Location.Ref },
})

export const RunWorkspaceSet = Event.define({
  type: "orchestration.run.workspace.set",
  ...durable,
  schema: { ...base, workspace: RunWorkspace },
})

export const RunSessionLinked = Event.define({
  type: "orchestration.run.session.linked",
  ...durable,
  schema: { ...base, sessionID: SessionID },
})

export const TaskAdded = Event.define({
  type: "orchestration.task.added",
  ...durable,
  schema: {
    ...base,
    taskID: TaskID,
    kind: Task.fields.kind.pipe(optional),
    title: Schema.String,
    description: Schema.String.pipe(optional),
    routeProfile: Schema.String.pipe(optional),
    capabilityTier: CapabilityTier.pipe(optional),
    checks: Schema.Array(Check).pipe(optional),
    acceptanceCriteria: Schema.Array(AcceptanceCriterion).pipe(optional),
  },
})

export const PlanProposed = Event.define({
  type: "orchestration.plan.proposed",
  ...durable,
  schema: { ...base, planID: PlanID, output: PlanOutput, generation: PlanGeneration.pipe(optional) },
})

export const PlanApplied = Event.define({
  type: "orchestration.plan.applied",
  ...durable,
  schema: {
    ...base,
    planID: PlanID,
    cancelTaskIDs: Schema.Array(TaskID).pipe(optional),
    tasks: Schema.Array(Schema.Struct({ key: Schema.String, taskID: TaskID })),
  },
})

export const DeliveryReviewed = Event.define({
  type: "orchestration.delivery.reviewed",
  ...durable,
  schema: {
    ...base,
    deliveryID: DeliveryID,
    planID: PlanID.pipe(optional),
    baseHead: Schema.String,
    head: Schema.String,
    changedFiles: Schema.Int,
    review: DeliveryReview,
  },
})

export const DeliverySummarized = Event.define({
  type: "orchestration.delivery.summarized",
  ...durable,
  schema: {
    ...base,
    deliveryID: DeliveryID,
    summary: Schema.String,
    commitMessage: Schema.String,
    summaryGeneration: PlanGeneration.pipe(optional),
  },
})

export const IntegrationStarted = Event.define({
  type: "orchestration.integration.started",
  ...durable,
  schema: { ...base, integrationID: IntegrationID, deliveryID: DeliveryID, options: IntegrationOptions },
})

export const IntegrationStepRecorded = Event.define({
  type: "orchestration.integration.step.recorded",
  ...durable,
  schema: { ...base, integrationID: IntegrationID, step: IntegrationStep },
})

export const IntegrationFinished = Event.define({
  type: "orchestration.integration.finished",
  ...durable,
  schema: { ...base, integrationID: IntegrationID, status: Schema.Literals(["completed", "failed"]) },
})

export const IntegrationResumed = Event.define({
  type: "orchestration.integration.resumed",
  ...durable,
  schema: { ...base, integrationID: IntegrationID },
})

export const FollowUpStarted = Event.define({
  type: "orchestration.follow-up.started",
  ...durable,
  schema: { ...base, turnID: TurnID, objective: Schema.String, context: Schema.String.pipe(optional), baseHead: Schema.String },
})

export const FollowUpQueued = Event.define({
  type: "orchestration.follow-up.queued",
  ...durable,
  schema: { ...base, turnID: TurnID, objective: Schema.String, context: Schema.String.pipe(optional) },
})

export const FollowUpDequeued = Event.define({
  type: "orchestration.follow-up.dequeued",
  ...durable,
  schema: { ...base, turnID: TurnID },
})

export const FollowUpSteered = Event.define({
  type: "orchestration.follow-up.steered",
  ...durable,
  schema: { ...base, turnID: TurnID },
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
    kind: Attempt.fields.kind.pipe(optional),
    candidate: Candidate.pipe(optional),
    sessionID: SessionID.pipe(optional),
    location: Location.Ref.pipe(optional),
  },
})

export const AttemptPrepared = Event.define({
  type: "orchestration.attempt.prepared",
  ...durable,
  schema: {
    ...base,
    attemptID: AttemptID,
    taskID: TaskID,
    sessionID: SessionID.pipe(optional),
    location: Location.Ref,
  },
})

export const AttemptVerdictRecorded = Event.define({
  type: "orchestration.attempt.verdict.recorded",
  ...durable,
  schema: { ...base, taskID: TaskID, attemptID: AttemptID, verdict: AttemptVerdict },
})

export const AttemptFeedbackRecorded = Event.define({
  type: "orchestration.attempt.feedback.recorded",
  ...durable,
  schema: { ...base, taskID: TaskID, attemptID: AttemptID, feedback: AttemptFeedback },
})

export const HumanRequested = Event.define({
  type: "orchestration.human.requested",
  ...durable,
  schema: {
    ...base,
    requestID: HumanRequestID,
    taskID: TaskID.pipe(optional),
    kind: HumanRequest.fields.kind,
    prompt: Schema.String,
    choices: Schema.Array(Schema.String),
    assumption: Schema.String.pipe(optional),
  },
})

export const HumanRequestAnswered = Event.define({
  type: "orchestration.human.request.answered",
  ...durable,
  schema: { ...base, requestID: HumanRequestID, answer: Schema.String },
})

export const ReassignmentRecorded = Event.define({
  type: "orchestration.reassignment.recorded",
  ...durable,
  schema: {
    ...base,
    reassignmentID: ReassignmentID,
    taskID: TaskID,
    afterAttemptID: AttemptID,
    options: Schema.Array(ReassignmentOption),
    selected: ReassignmentOption,
    chooser: Reassignment.fields.chooser,
    request: TypedJudge.ChoiceRequest.pipe(optional),
    result: TypedJudge.ChoiceResult.pipe(optional),
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

export const ReviewRecorded = Event.define({
  type: "orchestration.review.recorded",
  ...durable,
  schema: {
    ...base,
    reviewID: ReviewID,
    taskID: TaskID,
    attemptID: AttemptID,
    decision: ReviewDecision,
    note: Schema.String.pipe(optional),
  },
})

export const TriageLabeled = Event.define({
  type: "orchestration.triage.labeled",
  ...durable,
  schema: {
    ...base,
    labelID: TriageLabelID,
    taskID: TaskID,
    attemptID: AttemptID,
    decision: TriageDecision,
    note: Schema.String.pipe(optional),
  },
})

export const JudgmentRecorded = Event.define({
  type: "orchestration.judgment.recorded",
  ...durable,
  schema: {
    ...base,
    judgmentID: JudgmentID,
    taskID: TaskID,
    attemptID: AttemptID,
    mode: Schema.Literal("shadow"),
    request: TypedJudge.ChoiceRequest,
    result: TypedJudge.ChoiceResult,
  },
})

export const TierRecommendationRecorded = Event.define({
  type: "orchestration.tier.recommended",
  ...durable,
  schema: {
    ...base,
    recommendationID: TierRecommendationID,
    taskID: TaskID,
    routeDecisionID: RouteDecisionID,
    explicitTier: CapabilityTier.pipe(optional),
    request: TypedJudge.ChoiceRequest,
    result: TypedJudge.ChoiceResult,
  },
})

export const Definitions = Event.inventory(
  RunCreated,
  RunStatusChanged,
  RunSourceSet,
  RunWorkspaceSet,
  RunSessionLinked,
  TaskAdded,
  PlanProposed,
  PlanApplied,
  DeliveryReviewed,
  DeliverySummarized,
  IntegrationStarted,
  IntegrationStepRecorded,
  IntegrationFinished,
  IntegrationResumed,
  FollowUpStarted,
  FollowUpQueued,
  FollowUpDequeued,
  FollowUpSteered,
  TaskStatusChanged,
  DependencyAdded,
  AttemptCreated,
  AttemptPrepared,
  AttemptVerdictRecorded,
  AttemptFeedbackRecorded,
  HumanRequested,
  HumanRequestAnswered,
  ReassignmentRecorded,
  AttemptStatusChanged,
  RouteDecided,
  EvaluationRecorded,
  JudgmentRecorded,
  TierRecommendationRecorded,
  ReviewRecorded,
  TriageLabeled,
)

export const Events = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Events = typeof Events.Type
