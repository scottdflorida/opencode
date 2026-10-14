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

Status: complete. Operators can create explicit task graphs, attach baseline-aware checks, and start a local scheduler from Lab's manual-run tool or the API. Independent direct-model tasks run concurrently in separate Git ProjectCopy worktrees and V2 Sessions. Under the Phase 2 human-acceptance policy, results stop at `awaiting_review` with route, session, workspace, check, and review provenance. Accept, reject, retry, and cancellation are explicit. Later phases added harness execution, generated planning, and user-triggered integration.

Phase 2 required a person to accept or reject every attempt. Phase 3 replaces that checkpoint with judge-driven acceptance. Human acceptance remains available as a policy option for comparison runs.

## Phase 3: autonomous delivery loop

Goal: a user sends an assignment and gets back a delivered, summarized change set, with no per-attempt review. They answer questions and do human-only steps along the way, then choose how to integrate the result. The user experience should match opening a new Claude Code or Codex thread.

Milestones, in build order. The first three can be tested with hand-written plans before the planner is autonomous.

1. **Policies and roles.** Named policies bundle role route profiles (planner, executor, judge, decider, feedback, delivery reviewer, summarizer), tiers, escalation chains, budgets, and acceptance settings. The run stores a policy snapshot. Policies are selected per run. See [models](./models.md#roles-and-policies).
2. **Run branch.** Create `jewel/<run>` from the source head. Commit each attempt to its own branch. Merge accepted attempts into the run branch. Dependents branch from the run branch. Conflicts become rebase attempts. See [orchestration](./orchestration.md#run-branch).
3. **Judge verdicts and the revision loop.** One typed verdict contract answered by Jev or an LLM. Deterministic regression gates. Feedback composition. Reassignment decisions (revise with the same profile, move to a different profile in the same tier, escalate, replan, or ask a human) under explicit budgets. Session or harness resume for revisions. See [evaluation](./evaluation.md) and [orchestration](./orchestration.md#revisions-and-escalation).
4. **Judge experiments.** `jev`, `llm`, and `experiment` providers with `split` and `paired` assignment, optional label sampling, and the judge comparison report. This replaces shadow mode and promotion gates. See [typed judgment](./jev.md).
5. **Autonomous planner.** Clarify-or-plan output, automatic application, acceptance criteria, check presets, tier assignment, human tasks, and replanning. See [planning](./planning.md).
6. **Human requests.** Durable clarifications, human steps, plan approvals, budget decisions, and recovery prompts. Each blocks only the work that depends on it. Executors can raise requests. Requests are published on the Session request stream the App's docks already consume. See [orchestration](./orchestration.md#human-requests).
7. **Delivery review and summary.** Clause-level review of the whole turn, replanning of gaps, a delivery summary, and a draft commit message.
8. **Integration actions.** Apply, commit, merge, push, pull request, and discard, with preflight, guarded default-branch pushes, conflict handling, and recorded steps. Follow-up turns in the same run. See [delivery](./delivery.md).
9. **Run sessions and live events.** A root `orchestration` Session per run with controller-appended parts. Attempt Sessions as children of the run. Harness transcripts mirrored into read-only child Sessions. A run event stream instead of polling. Diffs between arbitrary refs. See [orchestration](./orchestration.md#run-sessions).
10. **App, stage 1: the loop is testable end to end.**
    - the Orchestrate agent in the composer, with policy and judge selects
    - timeline renderers
    - the plan dock, question dock, and human-step, budget, and plan-approval docks
    - attempt child sessions
    - the delivery dock and the integration preflight dialog

    See [UI](./ui.md).
11. **App, stage 2: long runs are comfortable to supervise.**
    - the Run side-panel tab (task list and attempt history)
    - run, turn, task, and attempt review scopes, and the Usage tab
    - question and permission alerts ported to the v2 layout
    - the Home "Needs you" group and run tags
    - the Capacity tab in the status popover
12. **App, stage 3: tuning and comparison.**
    - the Orchestration settings group (policies with inline min confidence and budgets, judges, check presets)
    - the Lab page (judge comparison, policy comparison, blind labeling queue, manual runs)
    - Mission Control is removed

Exit condition: from the App, on a trusted repository, a user submits an assignment under a chosen policy and judge, answers any questions, and receives a delivered summary with one combined change set. They never accept or reject an individual attempt, and every automated decision is inspectable. From the same screen they can commit, merge, push, or open a pull request. Judge and policy comparison reports cover the runs.

Status: implemented for trusted repositories. The backend has named policy snapshots, typed Jev and LLM judgments, judge experiments and comparison, bounded revisions and reassignment, autonomous clarify-or-plan and supplemental replanning, durable human requests, whole-turn delivery review and summary, follow-up turns, root and child Sessions, event streaming, and user-triggered integration with preflight and recorded steps. The App has the Orchestrate composer, timeline and docks, Run/Review/Usage panels, Capacity, orchestration settings, and Lab. Disposable API runs verified a Jev-judged Luna attempt, dependent task visibility, budget recovery, automatic supplemental planning, explicit replanning, queued guidance sent to the planner, and isolated check-preset execution. The [ten-task cohort](./evaluation-cohorts/2026-09-23/README.md) has agent labels; those are kept separate from independent human calibration labels.

The App created a new `llm-smoke` run from its Orchestrate composer in a disposable repository; it planned and completed one task, delivered a summary, and displayed its timeline and combined diff. Browser inspection also covered Home's Needs you group and integration preflight. A separate disposable run completed with a valid `gpt-6-luna` LLM judge verdict (`accept`, 0.99 confidence); another returned a valid Luna LLM decider choice of `revise` after a deterministic check regression. Lab offers project-scoped, time-windowed, role-filtered comparisons and blind packets in the shared diff viewer. Local-only commit and merge actions completed with recorded steps, including reuse of an earlier delivery commit. A local bare remote rejected a push after commit and merge; retry finished the push using the durable partial record. The integration dialog offers agent resolution and a conflicting-PR fallback; preflight confirmed the conflict warning and branch-from-delivery preview. Creating an actual external PR through that fallback remains unverified because it requires a user-selected remote action. Independent human judge calibration is still outstanding for threshold tuning. The older shadow endpoint remains for comparison; its numeric thresholds are report annotations rather than an authority gate. See [collecting judge evaluation data](./judge-calibration.md).

## Phase 4: add harness execution and quota-aware frontier routing

- Implement Claude, Codex, Cursor, and Copilot harness adapters.
- Discover and validate per-harness model and effort capabilities.
- Apply ordered capacity policy using cached UsagePool observations.
- Suspend runs until the earliest eligible reset when all frontier candidates are exhausted.
- Add the [sandbox-backed execution environment](./sandbox.md) for unattended work.
- Compose UsagePool quota meters with measured Mac Studio and RTX endpoint resources in one versioned observation used by routing and UI.
- Show provider health, stale observations, and local resources in the status popover's Capacity tab (built in Phase 3, App stage 2), and add a titlebar warning state.
- Add configurable capability tier mappings, privacy allowlists, and quota reserves. Bounded escalation chains are part of Phase 3.
- Harden that execution boundary before autonomous runs on untrusted repositories.
- Surface project execution trust, worker readiness, and the check runtime in Orchestration settings and the Capacity tab; explain a blocked untrusted submission in the composer. See [UI](./ui.md#phase-4-execution-trust).

Exit condition: frontier work routes across local subscriptions predictably and never hides a capacity or authority decision.

Status: in progress. Ordered UsagePool routing records quota snapshots and rejection reasons; suspended runs retain their source and retry time across host restarts. Codex, Claude, Cursor, and Copilot CLI adapters use isolated ProjectCopy worktrees and an environment allowlist that excludes the server's Jev key. Their execution, checks, transcript evidence, and Git changes are recorded. The host observes installation, available authentication probes, a fresh Codex model catalog with per-model effort levels, Cursor's model listing when installed, and CLI effort lists for Claude and Copilot. Routing rejects observed model or effort mismatches and unavailable harnesses. Copilot entitlement remains unknown because this CLI exposes no confirmed non-billable probe. A versioned resource snapshot composes UsagePool quota with Mac memory and load; candidates can require free host bytes and wait with a bounded retry when memory is low. Codex execution and catalog routing were verified in a disposable worktree. The `orchestration.execution_trust: "untrusted"` setting fails closed until the full worker path is available. A dedicated Colima VM and Docker CLI are installed; opt-in `check_runtime: "colima"` ran a disposable repository check with no host mount or direct container network. Safe model-edited artifact transfer, direct V2 tool execution, and a credential broker remain before unattended untrusted work can run. Claude, Cursor, and Copilot live execution, Mac GPU and queue measurements, and RTX endpoint observation also remain. RTX telemetry needs the endpoint's URL, authentication, and metrics contract.

## Phase 5: optimize from evidence

- Add controlled route experiments and champion-challenger policies, building on Phase 3 policy snapshots and judge experiments.
- Choose default judges and acceptance thresholds for each role from the judge comparison data.
- Estimate success probability, retry cost, and time-to-result by task class.
- Tune route profiles using recorded outcomes.
- Expand Lab with route experiments and operational health views.
- Record a parent-linked invocation tree, resource and quota deltas, model identity and effort, and final contribution outcomes.
- Compare accepted engineering work per unit of time, quota, and local compute before promoting empirical routing rules.

Exit condition: routing changes are supported by reproducible evaluation data rather than anecdote.

## Later extensions

- Add enforceable local-only operation, including network tools, specialist calls, and telemetry export.
- Serve authenticated remote clients from the Mac Studio host without duplicating scheduler ownership.
- Consider opt-in anonymous aggregate statistics only after local telemetry is complete and privacy controls can be audited.
