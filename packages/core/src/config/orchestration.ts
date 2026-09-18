export * as ConfigOrchestration from "./orchestration"

import { Schema } from "effect"

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
  variant: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  requires: CapacityRequirement.pipe(Schema.Array, Schema.optional),
}) {}

export class HarnessCandidate extends Schema.Class<HarnessCandidate>("ConfigV2.Orchestration.HarnessCandidate")({
  id: Schema.String,
  type: Schema.Literal("harness"),
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.String.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  requires: CapacityRequirement.pipe(Schema.Array, Schema.optional),
}) {}

export const Candidate = Schema.Union([DirectCandidate, HarnessCandidate]).pipe(Schema.toTaggedUnion("type"))

export class RouteProfile extends Schema.Class<RouteProfile>("ConfigV2.Orchestration.RouteProfile")({
  unknown_capacity: Schema.Literals(["wait", "allow"]).pipe(Schema.optional),
  exhausted: Schema.Literals(["wait_until_soonest_reset", "fail"]).pipe(Schema.optional),
  max_capacity_age_seconds: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  candidates: Candidate.pipe(Schema.Array),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Orchestration")({
  default_route_profile: Schema.String.pipe(Schema.optional),
  max_concurrency: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional),
  route_profiles: Schema.Record(Schema.String, RouteProfile).pipe(Schema.optional),
}) {}
