export * as ConfigOrchestration from "./orchestration"

import { Schema } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"

const Percentage = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

export class CapacityRequirement extends Schema.Class<CapacityRequirement>(
  "ConfigV2.Orchestration.CapacityRequirement",
)({
  meter: Schema.String,
  remaining_at_least: Percentage,
}) {}

export class DirectCandidate extends Schema.Class<DirectCandidate>("ConfigV2.Orchestration.DirectCandidate")({
  id: Schema.String,
  type: Schema.Literal("direct"),
  provider: Schema.String,
  model: Schema.String,
  capability_tier: Orchestration.CapabilityTier.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  requires: CapacityRequirement.pipe(Schema.Array, Schema.optional),
  host_free_memory_at_least_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
}) {}

export class HarnessCandidate extends Schema.Class<HarnessCandidate>("ConfigV2.Orchestration.HarnessCandidate")({
  id: Schema.String,
  type: Schema.Literal("harness"),
  harness: Schema.String,
  model: Schema.String,
  capability_tier: Orchestration.CapabilityTier.pipe(Schema.optional),
  effort: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  requires: CapacityRequirement.pipe(Schema.Array, Schema.optional),
  host_free_memory_at_least_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
}) {}

export const Candidate = Schema.Union([DirectCandidate, HarnessCandidate]).pipe(Schema.toTaggedUnion("type"))

export class RouteProfile extends Schema.Class<RouteProfile>("ConfigV2.Orchestration.RouteProfile")({
  unknown_capacity: Schema.Literals(["wait", "allow"]).pipe(Schema.optional),
  exhausted: Schema.Literals(["wait_until_soonest_reset", "fail"]).pipe(Schema.optional),
  max_capacity_age_seconds: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  quota_reserves: Schema.Record(Schema.String, Percentage).pipe(Schema.optional),
  privacy: Schema.Struct({
    providers: Schema.Array(Schema.String).pipe(Schema.optional),
    harnesses: Schema.Array(Schema.String).pipe(Schema.optional),
    models: Schema.Array(Schema.String).pipe(Schema.optional),
  }).pipe(Schema.optional),
  candidates: Candidate.pipe(Schema.Array),
}) {}

export class Judge extends Schema.Class<Judge>("ConfigV2.Orchestration.Judge")({
  mode: Schema.Literals(["off", "shadow"]),
  provider: Schema.Literal("jev").pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  base_url: Schema.String.pipe(Schema.optional),
  timeout_ms: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  cache_ttl_seconds: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  input_cost_per_million_usd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  output_cost_per_million_usd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
}) {}

export class TierClassifier extends Schema.Class<TierClassifier>("ConfigV2.Orchestration.TierClassifier")({
  mode: Schema.Literals(["off", "shadow"]),
  tiers: Schema.Record(Schema.String, Schema.String),
  fallback: Orchestration.CapabilityTier,
}) {}

export class PolicyJudge extends Schema.Class<PolicyJudge>("ConfigV2.Orchestration.PolicyJudge")({
  provider: Schema.Literals(["jev", "llm", "experiment"]),
  route_profile: Schema.String.pipe(Schema.optional),
  label_sample_rate: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
  experiment: Schema.Struct({
    arms: Schema.Record(Schema.String, Schema.Struct({
      provider: Schema.Literals(["jev", "llm"]),
      route_profile: Schema.String.pipe(Schema.optional),
    })),
    assignment: Schema.Literals(["split", "paired"]),
    authoritative: Schema.String,
    seed: Schema.Int,
  }).pipe(Schema.optional),
}) {}

export class PolicyRoles extends Schema.Class<PolicyRoles>("ConfigV2.Orchestration.PolicyRoles")({
  planner: Schema.String.pipe(Schema.optional),
  executor: Schema.String.pipe(Schema.optional),
  judge: PolicyJudge.pipe(Schema.optional),
  decider: PolicyJudge.pipe(Schema.optional),
  feedback: Schema.String.pipe(Schema.optional),
  delivery_reviewer: Schema.String.pipe(Schema.optional),
  summarizer: Schema.String.pipe(Schema.optional),
}) {}

export class PolicyBudgets extends Schema.Class<PolicyBudgets>("ConfigV2.Orchestration.PolicyBudgets")({
  max_revisions_per_route: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  max_escalations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  max_rebases_per_task: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  max_replans: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  max_attempts: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
}) {}

export class PolicyAcceptance extends Schema.Class<PolicyAcceptance>("ConfigV2.Orchestration.PolicyAcceptance")({
  mode: Schema.Literals(["human", "judge"]).pipe(Schema.optional),
  min_confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
  skip_judge_on_regression: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Policy extends Schema.Class<Policy>("ConfigV2.Orchestration.Policy")({
  extends: Schema.String.pipe(Schema.optional),
  roles: PolicyRoles.pipe(Schema.optional),
  tiers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  escalation_chain: Orchestration.CapabilityTier.pipe(Schema.Array, Schema.optional),
  budgets: PolicyBudgets.pipe(Schema.optional),
  acceptance: PolicyAcceptance.pipe(Schema.optional),
  plan_approval: Schema.Literals(["auto", "human"]).pipe(Schema.optional),
  clarify: Schema.Literals(["ask", "assume"]).pipe(Schema.optional),
  integration_default: Orchestration.IntegrationAction.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Orchestration")({
  execution_trust: Schema.Literals(["trusted", "untrusted"]).pipe(Schema.optional),
  check_runtime: Schema.Literals(["host", "colima"]).pipe(Schema.optional),
  default_route_profile: Schema.String.pipe(Schema.optional),
  default_policy: Schema.String.pipe(Schema.optional),
  max_concurrency: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  route_profiles: Schema.Record(Schema.String, RouteProfile).pipe(Schema.optional),
  check_presets: Schema.Record(Schema.String, Orchestration.CheckPreset).pipe(Schema.optional),
  policies: Schema.Record(Schema.String, Policy).pipe(Schema.optional),
  judge: Judge.pipe(Schema.optional),
  tier_classifier: TierClassifier.pipe(Schema.optional),
}) {}
