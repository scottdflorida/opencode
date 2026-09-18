# ADR 0002: Separate routing from typed judgment

- Status: accepted
- Date: 2026-09-18

## Context

Route selection combines hard facts such as installed executors, authentication, capacity, permissions, health, and policy thresholds. Some earlier design ideas also ask a model to classify task difficulty or judge ambiguous evidence. Combining both concerns would make spending controls probabilistic and make decisions harder to reproduce.

## Decision

Implement route resolution as deterministic policy over a bounded, ordered candidate list and a versioned capacity snapshot. Define a separate `TypedJudge` interface for probabilistic questions. Jev is one replaceable adapter behind that interface.

A judge may select a route profile from options supplied by the controller. The route resolver remains responsible for candidate eligibility and the final route decision.

## Consequences

- Capacity and spending limits remain enforceable without model cooperation.
- Judgment can be shadowed, cached, compared, and replaced.
- Every route decision can list rejected candidates and exact reasons.
- Policies need explicit behavior for unknown or stale capacity.
- Optimization can later combine deterministic constraints with learned success estimates without granting a judge operational authority.
