# Models, routes, and executors

## Separate concepts

See [Capability routing, resources, and execution evidence](./routing-telemetry.md) for the expanded task, tier, provider, resource, evaluation, and telemetry boundaries.

JewelCode keeps three concepts independent:

- An Agent defines instructions, permissions, tools, and provider-turn limits.
- A Route Profile defines ordered execution candidates and capacity requirements.
- A Typed Judge answers a bounded question using a declared schema.

An Agent may name a default route profile. A task or operator override may select a different profile without mutating the Agent's behavior.

A task may also request a policy-owned capability tier independently of its route profile. Candidates may declare `capability_tier`; a tiered request skips unlabelled and differently labelled candidates with a durable `tier_mismatch` reason. A profile can hold candidates from several tiers. These labels are configurable strings so the examples do not become a permanent model taxonomy.

For example, a task with `capabilityTier: "frontier-high"` can use a configured candidate with `"capability_tier": "frontier-high"`. A task without `capabilityTier` retains the profile's original ordered behavior. A requested tier with no enabled matching candidate fails with an explicit route decision.

## Candidate kinds

### Direct model

A direct candidate resolves to an OpenCode provider and model. It executes through the V2 Session runner and preserves the invariant of one explicit stream call per provider turn.

Phase 2 executes direct candidates through isolated V2 Sessions. The selected provider, model, and variant are pinned to the attempt before execution begins.

Local inference servers can participate through configured OpenAI-compatible providers. Their health should be observed separately from paid-provider capacity.

### External harness

A harness candidate invokes an installed coding agent such as Claude Code, Codex, Cursor Agent, or Copilot CLI. Its record includes the harness version, requested model and effort, working directory, process outcome, transcript reference, and artifacts.

Harnesses are not represented as synthetic OpenCode providers. They can contain their own tool loop and authentication behavior, which must remain visible in provenance.

Codex, Claude Code, Cursor Agent, and Copilot CLI adapters exist. Routing checks installation, observed authentication where the CLI exposes it, model catalogs where available, and effort support before selecting one. Codex was exercised in a disposable worktree. Claude, Cursor, and Copilot execution still need live verification; Cursor Agent is absent on the current host, and Copilot has no confirmed non-billable entitlement probe here. An unavailable harness produces an explicit route rejection.

## Roles and policies

Each model-backed role in the delivery loop selects its own route profile:

| Role | Purpose |
| --- | --- |
| `planner` | Clarifying questions, task graphs, and replans |
| `executor` | Task attempts. The task's tier picks candidates from this profile. |
| `judge` | Attempt verdicts: Jev, an LLM route profile, or an experiment |
| `decider` | Reassignment decisions. Uses the judge's provider selection by default. |
| `feedback` | Optional LLM feedback writer |
| `delivery_reviewer` | Checks the whole turn against the assignment |
| `summarizer` | Delivery summary and commit message |

A policy bundles role profiles, tiers and escalation chains, budgets, acceptance thresholds, and approval settings under one name. The user picks a policy when submitting an assignment. The run stores a snapshot of it, so later configuration edits do not rewrite history. Policies are how routing and judging strategies are tested against each other.

```jsonc
{
  "orchestration": {
    "default_policy": "balanced",
    "policies": {
      "balanced": {
        "roles": {
          "planner": "frontier",
          "executor": "local-first",
          "judge": { "provider": "jev" },
          "feedback": "frontier-low",
          "delivery_reviewer": "frontier",
          "summarizer": "frontier-low",
        },
        "escalation_chain": ["local-9b", "moe-35b", "frontier-low", "frontier-high"],
        "budgets": { "max_revisions_per_route": 2, "max_escalations": 3, "max_replans": 2 },
        "acceptance": { "mode": "judge", "min_confidence": 0.8 },
        "plan_approval": "auto",
        "clarify": "ask",
        "integration_default": "commit",
      },
      "frontier-llm-judge": {
        "extends": "balanced",
        "roles": { "executor": "frontier", "judge": { "provider": "llm", "route_profile": "judge-opus" } },
      },
    },
  },
}
```

The policy comparison report groups turns by policy snapshot. It reports delivery rate, attempts, revisions and reassignments per accepted task, time to delivery, tokens, quota, estimated cost, human requests, and overrides per delivery.

## Resolution order

Route profile selection follows this precedence:

1. explicit operator override
2. task-level profile
3. Agent-level profile
4. bounded classifier result
5. project default

Candidate selection then walks the chosen profile in order and takes the first eligible candidate. Eligibility combines installation and authentication state, model availability, policy, recent health, and provider capacity.

The selected candidate remains pinned for the attempt. A retry may make a new decision from a fresh snapshot.

## Capacity policy

The capacity adapter reads UsagePool's stable snapshot output. Relevant meters include:

- `copilot.monthly.plan-credits`
- `cursor.api`
- `cursor.models`
- `claude.session`
- `claude.weekly.all-models`
- `codex.account.five-hour`
- `codex.account.weekly`

The observer normalizes each meter to state, remaining percentage when available, observation time, and reset time. It stores no provider credential material.

A policy matching the intended frontier route could be expressed as:

```jsonc
{
  "orchestration": {
    "default_route_profile": "frontier",
    "route_profiles": {
      "frontier": {
        "unknown_capacity": "wait",
        "exhausted": "wait_until_soonest_reset",
        "max_capacity_age_seconds": 300,
        "candidates": [
          {
            "id": "copilot-opus",
            "type": "harness",
            "harness": "copilot",
            "model": "opus-5",
            "requires": [{ "meter": "copilot.monthly.plan-credits", "remaining_at_least": 20 }],
          },
          {
            "id": "cursor-opus",
            "type": "harness",
            "harness": "cursor",
            "model": "opus-5",
            "requires": [{ "meter": "cursor.api", "remaining_at_least": 20 }],
          },
          {
            "id": "cursor-grok",
            "type": "harness",
            "harness": "cursor",
            "model": "grok-4.6",
            "effort": "xhigh",
            "requires": [{ "meter": "cursor.models", "remaining_at_least": 20 }],
          },
          {
            "id": "claude-opus",
            "type": "harness",
            "harness": "claude",
            "model": "opus-5",
            "requires": [
              { "meter": "claude.session", "remaining_at_least": 20 },
              { "meter": "claude.weekly.all-models", "remaining_at_least": 20 },
            ],
          },
          {
            "id": "codex-sol",
            "type": "harness",
            "harness": "codex",
            "model": "gpt-5.6-sol",
            "effort": "xhigh",
            "requires": [
              { "meter": "codex.account.five-hour", "remaining_at_least": 10 },
              { "meter": "codex.account.weekly", "remaining_at_least": 10 },
            ],
          },
        ],
      },
    },
  },
}
```

The model names and thresholds are configuration examples. The implementation must validate them against capabilities reported by each installed harness.

## Freshness and failure behavior

Capacity snapshots are cached in the background and stamped with their observation time. Policy declares a maximum age. A stale, unavailable, or malformed required meter is `unknown`, not zero.

The default frontier policy treats `unknown` as ineligible and suspends until a new observation. Policies may explicitly allow unknown capacity for routes where billing risk is acceptable.

If all candidates are ineligible, the resolver records every rejection reason and sets `retry_at` to the earliest known reset when one is available. A later capacity observation can trigger reevaluation when no reset is known. It does not hold a worker open while waiting.
