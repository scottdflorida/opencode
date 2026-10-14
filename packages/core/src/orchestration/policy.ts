export * as OrchestrationPolicy from "./policy"

import { Orchestration } from "@opencode-ai/schema/orchestration"
import { ConfigOrchestration } from "../config/orchestration"

export type Resolution =
  | { readonly status: "resolved"; readonly policy: Orchestration.PolicySnapshot }
  | { readonly status: "error"; readonly message: string }

type Merged = {
  roles: Partial<ConfigOrchestration.PolicyRoles>
  tiers: Record<string, string>
  escalationChain: ReadonlyArray<Orchestration.CapabilityTier>
  budgets: Partial<ConfigOrchestration.PolicyBudgets>
  acceptance: Partial<ConfigOrchestration.PolicyAcceptance>
  planApproval: "auto" | "human"
  clarify: "ask" | "assume"
  integrationDefault: Orchestration.IntegrationAction
}

export function resolve(
  name: string,
  config: ConfigOrchestration.Info,
  profiles: readonly Orchestration.RouteProfile[],
): Resolution {
  const policies: Readonly<Record<string, ConfigOrchestration.Policy>> = config.policies ?? {}
  if (!policies[name]) return { status: "error", message: `Unknown orchestration policy: ${name}` }

  const chain: ConfigOrchestration.Policy[] = []
  const seen = new Set<string>()
  let current: string | undefined = name
  while (current) {
    if (seen.has(current)) return { status: "error", message: `Policy inheritance cycle at ${current}` }
    seen.add(current)
    const policy: ConfigOrchestration.Policy | undefined = policies[current]
    if (!policy) return { status: "error", message: `Unknown parent orchestration policy: ${current}` }
    chain.unshift(policy)
    current = policy.extends
  }

  const merged = chain.reduce<Merged>(
    (value, policy) => ({
      roles: { ...value.roles, ...policy.roles },
      tiers: { ...value.tiers, ...policy.tiers },
      escalationChain: policy.escalation_chain ?? value.escalationChain,
      budgets: { ...value.budgets, ...policy.budgets },
      acceptance: { ...value.acceptance, ...policy.acceptance },
      planApproval: policy.plan_approval ?? value.planApproval,
      clarify: policy.clarify ?? value.clarify,
      integrationDefault: policy.integration_default ?? value.integrationDefault,
    }),
    {
      roles: {},
      tiers: {},
      escalationChain: [],
      budgets: {},
      acceptance: {},
      planApproval: "auto",
      clarify: "ask",
      integrationDefault: "commit",
    },
  )
  const executor = merged.roles.executor ?? config.default_route_profile
  if (!executor) return { status: "error", message: `Policy ${name} needs an executor route profile` }
  const planner = merged.roles.planner ?? executor
  const judge = merged.roles.judge
    ? {
        provider: merged.roles.judge.provider,
        routeProfile: merged.roles.judge.route_profile,
        labelSampleRate: merged.roles.judge.label_sample_rate,
        experiment: merged.roles.judge.experiment && {
          ...merged.roles.judge.experiment,
          arms: Object.fromEntries(Object.entries(merged.roles.judge.experiment.arms).map(([arm, config]) => [arm, {
            provider: config.provider,
            routeProfile: config.route_profile,
          }])),
        },
      }
    : { provider: "jev" as const }
  const decider = merged.roles.decider
    ? { provider: merged.roles.decider.provider, routeProfile: merged.roles.decider.route_profile }
    : judge.provider === "experiment" ? { provider: "jev" as const } : judge
  const roles = {
    planner,
    executor,
    judge,
    decider,
    feedback: merged.roles.feedback,
    deliveryReviewer: merged.roles.delivery_reviewer ?? planner,
    summarizer: merged.roles.summarizer ?? planner,
  }
  const available = new Set(profiles.map((profile) => profile.name))
  const referenced = [
    roles.planner,
    roles.executor,
    roles.feedback,
    roles.deliveryReviewer,
    roles.summarizer,
    roles.judge.provider === "llm" ? roles.judge.routeProfile : undefined,
    ...Object.values(roles.judge.experiment?.arms ?? {}).flatMap((arm) => arm.provider === "llm" ? [arm.routeProfile] : []),
    roles.decider.provider === "llm" ? roles.decider.routeProfile : undefined,
  ]
  const missing = referenced.find((profile) => profile && !available.has(profile))
  if (missing) return { status: "error", message: `Policy ${name} references unknown route profile: ${missing}` }
  if (roles.judge.provider === "llm" && !roles.judge.routeProfile)
    return { status: "error", message: `Policy ${name} needs a judge route profile` }
  if (roles.judge.provider === "experiment") {
    const experiment = roles.judge.experiment
    if (!experiment || Object.keys(experiment.arms).length < 2)
      return { status: "error", message: `Policy ${name} needs at least two judge experiment arms` }
    if (experiment.authoritative !== "random" && !(experiment.authoritative in experiment.arms))
      return { status: "error", message: `Policy ${name} references an unknown authoritative judge arm` }
    if (Object.values(experiment.arms).some((arm) => arm.provider === "llm" && !arm.routeProfile))
      return { status: "error", message: `Policy ${name} has an LLM judge arm without a route profile` }
  }
  if (roles.decider.provider === "llm" && !roles.decider.routeProfile)
    return { status: "error", message: `Policy ${name} needs a decider route profile` }

  const tiers = Object.keys(merged.tiers).length ? merged.tiers : (config.tier_classifier?.tiers ?? {})
  const unknownTier = merged.escalationChain.find((tier) => !(tier in tiers))
  if (unknownTier) return { status: "error", message: `Policy ${name} references unknown tier: ${unknownTier}` }

  return {
    status: "resolved",
    policy: {
      name,
      roles,
      tiers,
      checkPresets: config.check_presets,
      escalationChain: [...merged.escalationChain],
      budgets: {
        maxRevisionsPerRoute: merged.budgets.max_revisions_per_route ?? 2,
        maxEscalations: merged.budgets.max_escalations ?? 2,
        maxRebasesPerTask: merged.budgets.max_rebases_per_task ?? 2,
        maxReplans: merged.budgets.max_replans ?? 2,
        maxAttempts: merged.budgets.max_attempts,
      },
      acceptance: {
        mode: merged.acceptance.mode ?? "judge",
        minConfidence: merged.acceptance.min_confidence ?? 0.8,
        skipJudgeOnRegression: merged.acceptance.skip_judge_on_regression ?? true,
      },
      planApproval: merged.planApproval,
      clarify: merged.clarify,
      integrationDefault: merged.integrationDefault,
      routeProfiles: [...profiles],
    },
  }
}
