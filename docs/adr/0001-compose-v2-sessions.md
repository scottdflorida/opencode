# ADR 0001: Compose V2 Sessions and ProjectCopy

- Status: accepted
- Date: 2026-09-18

## Context

OpenCode has two relevant execution paths. The legacy task tool creates child sessions and can run them through process-local background jobs, but those jobs are not durable and the child sessions remain in the current location. V2 has durable Session state, serialized execution, event replay, and a `ProjectCopy` service that can create registered Git worktrees.

JewelCode needs durable task graphs, concurrent isolated attempts, restart recovery, and reviewable provenance.

## Decision

Create a new V2 orchestration domain. An `OrchestrationRun` owns tasks, dependencies, attempts, routes, evaluations, and reviews. Each direct attempt composes one V2 Session with one ProjectCopy location.

The legacy task tool remains a compatibility feature and is not the orchestration persistence or scheduler boundary. `SessionTodo` continues to describe work inside a Session and is not reused as the cross-session task graph.

## Consequences

- Existing Session semantics and the one-stream-per-turn invariant remain intact.
- Parallel tasks receive separate worktrees and Sessions.
- The scheduler can rebuild ready work from durable projections.
- Interrupted provider work still needs explicit recovery policy because durable state alone cannot prove that an external side effect is safe to repeat.
- The App can migrate from legacy prompt paths incrementally while new orchestration APIs target V2 contracts.
