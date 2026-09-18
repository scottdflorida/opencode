# Roadmap

## Phase 0: establish the baseline

- Fork and configure OpenCode remotes.
- Install the pinned toolchain and locked dependencies.
- Run Core, OpenCode, and App baselines.
- Map V2 Sessions, project copies, events, providers, legacy task execution, and the application boundary.

Status: complete. Core and OpenCode suites pass. The App suite has one locale-detection failure for `pa-PK`, which is recorded as an existing baseline issue.

## Phase 1: define the control plane

- Add orchestration schemas and event vocabulary.
- Add run, task, dependency, attempt, decision, and evaluation projections.
- Define route profiles, candidate kinds, and executor capabilities.
- Implement a cached capacity observer interface and UsagePool adapter.
- Expose read-only run and capacity APIs.

Exit condition: policy can explain which route would be selected or why a task would wait, without executing a model.

Status: complete. The control plane now persists runs, tasks, dependencies, attempts, route decisions, and evaluations. Editable route profiles resolve candidates against cached UsagePool observations and expose dry-run explanations through the HTTP API. Phase 1 does not execute models or external harnesses.

## Phase 2: prove the vertical slice

- Create an objective with two explicit independent tasks.
- Allocate a separate ProjectCopy worktree and V2 Session to each task.
- Run both tasks concurrently with configured direct routes.
- Execute deterministic checks and distinguish baseline failures.
- Show status and evidence in the App.
- Support inspect, accept, reject, and retry actions.

Exit condition: a trusted repository can produce two isolated, reviewable changes with durable provenance and no automatic merge.

Status: complete. Operators can create explicit task graphs, attach baseline-aware checks, and start a local scheduler from Mission Control. Independent direct-model tasks run concurrently in separate Git ProjectCopy worktrees and V2 Sessions. Results stop at `awaiting_review` with route, session, workspace, check, and review provenance. Accept, reject, retry, and cancellation are explicit. Harness execution, generated planning, sandboxing, and automatic integration remain outside this phase.

## Phase 3: add planning and typed judgment

- Add a typed planner output schema and validate generated task graphs.
- Integrate Jev behind `TypedJudge` in shadow mode.
- Measure agreement, outcome quality, latency, and cost.
- Grant narrow decision authority only after evaluation thresholds are met.

Exit condition: generated plans and judgments remain bounded, replayable, and overridable.

## Phase 4: add harness execution and quota-aware frontier routing

- Implement Claude, Codex, Cursor, and Copilot harness adapters.
- Discover and validate per-harness model and effort capabilities.
- Apply ordered capacity policy using cached UsagePool observations.
- Suspend runs until the earliest eligible reset when all frontier candidates are exhausted.
- Add a sandbox-backed execution environment for unattended work.

Exit condition: frontier work routes across local subscriptions predictably and never hides a capacity or authority decision.

## Phase 5: optimize from evidence

- Add controlled route experiments and champion-challenger policies.
- Estimate success probability, retry cost, and time-to-result by task class.
- Tune route profiles using recorded outcomes.
- Expand mission-control views for comparisons and operational health.

Exit condition: routing changes are supported by reproducible evaluation data rather than anecdote.
