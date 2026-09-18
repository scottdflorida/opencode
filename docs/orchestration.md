# Orchestration model

## Aggregate boundary

The first implementation should use one `OrchestrationRun` aggregate per objective. A single event order makes task readiness and dependency transitions atomic without introducing distributed coordination too early.

Projection tables should make the run queryable:

- runs
- tasks
- task dependencies
- attempts
- route decisions
- evaluations
- reviews

Large installations may later move task attempts into separate aggregates. The public identifiers and event vocabulary should leave room for that change.

## State model

A task moves through these states:

- `draft`: created but not yet eligible
- `ready`: dependencies are satisfied
- `blocked`: a dependency or explicit condition prevents execution
- `running`: an attempt owns an executor and workspace
- `evaluating`: execution finished and checks are running
- `awaiting_review`: automation cannot safely decide the next transition
- `succeeded`: the task met its completion policy
- `failed`: the task exhausted its allowed recovery policy
- `cancelled`: an operator or parent decision stopped the task
- `suspended`: no route is currently eligible and a future observation or reset can make progress possible

An attempt is immutable after completion. Retries create new attempts so evidence and route history remain intact.

## Readiness and concurrency

A task is ready when all required predecessors have succeeded and its run is active. The scheduler selects ready work within run, executor, model, and host concurrency limits. Different tasks may run concurrently because V2 already permits different Sessions to drain concurrently.

Each attempt receives:

- a registered `ProjectCopy` location
- a clean task-specific branch or worktree state
- a V2 Session for direct execution, or a harness execution identity
- an immutable route decision
- a configured evaluation plan

Parallel attempts never edit the same checkout.

## Recovery

The scheduler may rebuild its queue from projections after restart. It must not blindly repeat provider work whose outcome is uncertain. Attempts interrupted after side effects move to an explicit recovery or review state until the system can prove whether replay is safe.

Capacity suspension records the earliest relevant reset time. A timer or later capacity observation wakes the run. The task returns to `ready` only after route eligibility is recalculated.

## Initial vertical slice

The first end-to-end slice should deliberately avoid a generative planner:

1. Create one objective with two explicit independent tasks.
2. Persist the run and task graph.
3. Create separate Git worktrees.
4. Execute both tasks concurrently through V2 Sessions using configured route profiles.
5. Run configured deterministic checks in each worktree.
6. Display task, route, session, workspace, and check status.
7. Allow an operator to inspect, accept, reject, or retry each result.
8. Require explicit integration rather than merging automatically.

This slice proves the durable control plane before model-generated planning adds another failure mode.

## Phase 2 implementation

The local scheduler owns one process-local drain per run. It rebuilds readiness from the durable projection at each boundary, starts up to `orchestration.max_concurrency` ready tasks, and lets separate runs drain independently. The default task concurrency is two. Self-dependencies and dependency cycles are rejected when the graph is edited.

Direct candidates execute through one V2 Session in a Git `ProjectCopy` created under the orchestration data directory. The attempt records the selected candidate, Session ID, and Location before model execution starts. Harness candidates remain visible to route resolution, but execution records a failed attempt until Phase 4 adds harness adapters.

Configured checks run once in the source checkout and once in the attempt worktree unless `baseline` is false. A passing attempt is `passed`. A failing attempt whose baseline passed is `failed`. When both fail, the result is `indeterminate` so a pre-existing repository failure is not attributed to the attempt. Command output and the Git patch are bounded before they are stored as evaluation evidence.

Completed attempts always stop at `awaiting_review`, including attempts with failed checks. Accepting a task marks it `succeeded` and may unlock dependents. Rejecting marks it `failed`. Retry creates a fresh attempt and preserves earlier evidence. Cancellation interrupts known Sessions, marks unfinished attempts as interrupted, and cancels unfinished tasks. A recovered running or evaluating attempt moves to review without replaying uncertain provider work.

The HTTP control surface supports:

- creating runs, tasks, and dependencies
- starting and cancelling runs
- accepting, rejecting, and retrying task results
- reading run detail, route profiles, and capacity explanations

The App exposes these operations at `/mission-control/:dir`. It shows each task's current route, Session, worktree, checks, patch evidence, and review actions. Inspection never commits, merges, or deletes an attempt worktree.

## Security boundary

The current Bash tool runs with the host user's authority. A worktree protects branch state but does not confine filesystem, process, or network access. Early automation therefore assumes trusted repositories, approved commands, and human review. Unattended execution requires a separate execution-environment abstraction that can select a real sandbox.
