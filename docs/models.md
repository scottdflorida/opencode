# Models, routes, and executors

## Separate concepts

JewelCode keeps three concepts independent:

- An Agent defines instructions, permissions, tools, and provider-turn limits.
- A Route Profile defines ordered execution candidates and capacity requirements.
- A Typed Judge answers a bounded question using a declared schema.

An Agent may name a default route profile. A task or operator override may select a different profile without mutating the Agent's behavior.

## Candidate kinds

### Direct model

A direct candidate resolves to an OpenCode provider and model. It executes through the V2 Session runner and preserves the invariant of one explicit stream call per provider turn.

Phase 2 executes direct candidates through isolated V2 Sessions. The selected provider, model, and variant are pinned to the attempt before execution begins.

Local inference servers can participate through configured OpenAI-compatible providers. Their health should be observed separately from paid-provider capacity.

### External harness

A harness candidate invokes an installed coding agent such as Claude Code, Codex, Cursor Agent, or Copilot CLI. Its record includes the harness version, requested model and effort, working directory, process outcome, transcript reference, and artifacts.

Harnesses are not represented as synthetic OpenCode providers. They can contain their own tool loop and authentication behavior, which must remain visible in provenance.

Harness execution is deferred to Phase 4. If a Phase 2 route selects a harness candidate, the scheduler records the route and a failed attempt with an explicit unsupported-executor evaluation.

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
