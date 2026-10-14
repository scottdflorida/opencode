# Orchestration model

## Aggregate boundary

The first implementation uses one `OrchestrationRun` aggregate per assignment thread. A single event order makes task readiness, acceptance, and run-branch integration atomic without distributed coordination.

Projection tables make the run queryable:

- runs and turns
- tasks and task dependencies
- attempts
- plan proposals
- route decisions
- evaluations and judgments
- feedback
- human requests
- deliveries and integrations

Large installations may later move task attempts into separate aggregates. The public identifiers and event vocabulary leave room for that change.

## Runs and turns

A run is a thread. Its first turn is the original assignment. Each follow-up assignment starts another turn in the same run, from the run branch as the previous turn left it. A turn ends when its delivery is accepted, it fails, or it is cancelled. Integration actions are offered whenever a turn is delivered.

A run moves through these states:

- `clarifying`: the planner asked questions that must be answered before planning
- `planning`: the planner is producing or revising the task graph
- `running`: tasks are executing, being evaluated, or being revised
- `reviewing_delivery`: every task in the turn is accepted and the delivery reviewer is checking the whole assignment
- `delivered`: the turn is delivered and its summary is available; the run can accept integration actions or a follow-up
- `integrating`: a user-selected integration action is in progress
- `suspended`: no runnable task has an eligible route until capacity changes
- `failed` or `cancelled`

Pending human requests do not change the run state. They block only the work that depends on them, so unrelated tasks keep running.

## Run sessions

The App presents each run as a session (see [UI](./ui.md)). The run owns a root V2 Session of kind `orchestration`. It is created at submission, and the user's assignment and follow-ups are its user messages. The controller appends orchestration parts to it: clarification, plan, task, replan, human request, delivery review, and integration. It writes the delivery summary as an assistant text message. The runner never drives an `orchestration` Session with a model, so its history is presentation, not execution conversation. The run aggregate stays the source of truth, and parts are projections of run events that can be rebuilt from them.

Every direct attempt Session is created with `parentID` set to the run Session, so attempts open as child sessions. Harness attempts have no V2 Session. Their structured output (messages, tool calls, and the final diff) is mirrored into a read-only child Session of the run, so every attempt opens the same way. Until mirroring is in place, harness attempts appear only in the Run panel.

Planner, judge, decider, feedback, delivery-review, and summary calls are not child Sessions. Their records appear inside the relevant parts and in the Run panel.

## Task states

- `draft`: created but not yet eligible
- `ready`: dependencies are satisfied; may carry feedback for the next attempt
- `blocked`: a dependency prevents execution
- `waiting_on_human`: an open human request blocks this task
- `running`: an attempt owns an executor and workspace
- `evaluating`: checks and judgment are running
- `accepted`: the judge (or the user) accepted an attempt and its changes were merged into the run branch
- `failed`: the task exhausted its budget and the user chose not to continue it
- `cancelled`: an operator, replan, or parent decision stopped the task
- `suspended`: no route is currently eligible and a future observation or reset can make progress possible

`awaiting_review` remains available only when a policy sets `acceptance.mode` to `human`, which reproduces the Phase 2 behavior for comparison runs.

An attempt is immutable after completion. Each attempt has a kind: `initial`, `revision` (same route, with feedback), `reassignment` (a different agent profile in the same or a higher tier, with feedback), or `rebase` (reapplying accepted work after a run-branch conflict). Every attempt has its own route decision, so route and evidence history stay intact.

## The delivery loop

1. The user submits an assignment with a policy. The run records a snapshot of that policy.
2. The planner either asks clarifying questions, which creates human requests and puts the run in `clarifying`, or returns a plan. See [planning](./planning.md).
3. A valid plan is applied automatically unless the policy requires plan approval.
4. The scheduler dispatches ready tasks within concurrency limits. Each attempt branches from the run branch head at dispatch time, so it sees accepted predecessor work.
5. The executor finishes. The controller commits the attempt worktree to its attempt branch, runs deterministic checks against the baseline, and asks the configured judge for a verdict. See [evaluation](./evaluation.md).
6. An accepted verdict accepts the attempt. Otherwise the orchestrator makes a reassignment decision (see below): revise with the same agent profile and feedback, move to a different profile or tier, replan, or open a human request.
7. Accepting an attempt merges its branch into the run branch. A conflict produces a `rebase` attempt against the current run branch instead of an acceptance.
8. When every task in the turn is accepted, the delivery reviewer checks the combined run-branch diff and run-level checks against the original assignment. Gaps go back to the planner as additional tasks, within the replan budget.
9. When the delivery review passes, the summarizer writes the delivery summary and a draft commit message. The turn is `delivered`.
10. The user chooses an integration action or sends a follow-up. See [delivery and integration](./delivery.md).

## Revisions and escalation

When an attempt is not accepted, the orchestrator makes an explicit reassignment decision: return the work to the same agent profile with feedback, or give the task to a different profile. For example, if the `local-9b` candidate has failed three times, the task might go to a `frontier-low` candidate. The decision happens in three steps:

1. The controller builds the legal options from policy and current capacity: `revise` with the same candidate, `lateral` to another eligible candidate in the same tier, `escalate` to each higher tier in the escalation chain that has an eligible candidate, `replan`, or `human`. Options that are out of budget or have no eligible route are removed.
2. Deterministic rules settle the obvious cases. If the current route has used `max_revisions_per_route`, `revise` is removed. If only one option remains, it is taken without a model call. A new check regression after repeated revisions can be configured to force escalation.
3. Otherwise the configured decider picks among the remaining options. The decider receives the attempt history for the task, the judge's per-criterion results and confidence, check trends across attempts, and each option's route and expected cost. The decider uses the same provider selection as the judge (Jev, an LLM, or an experiment), so its choices can be compared across providers too.

Each reassignment decision is recorded with its legal options, the rule or decider that chose, and the resulting attempt. This supports later questions such as whether escalating after one failure beats three local retries for a class of task.

A revision continues from the previous attempt's committed head in a fresh ProjectCopy worktree. A direct executor continues the same V2 Session by admitting the feedback as a new prompt, which keeps V2 steer and queue semantics intact. A harness executor resumes its own session when the adapter supports it, such as a Codex thread or a Claude Code session ID. Otherwise it starts a fresh session with the task, the previous diff, and the feedback.

A reassignment makes a fresh route decision for the chosen tier. Escalations follow the policy's escalation chain, for example `local-9b → moe-35b → frontier-low → frontier-high`, but the decider may skip tiers when the evidence supports it. The new agent receives the task, the feedback history, and the previous diff. `escalation_base` selects whether it starts from the previous attempt (`previous`, the default) or the run branch (`clean`). Earlier failed attempts remain linked, so their cost counts toward the task's total.

## Budgets

Policies set explicit limits:

- per task: `max_revisions_per_route` (default 2), `max_escalations` (default 2), `max_rebases_per_task` (default 2), and a wall-clock limit
- per turn: `max_attempts`, `max_replans` (default 2), and optional token and quota ceilings

When a budget is exhausted, the controller opens a `budget_exhausted` human request. The user can grant more budget, provide guidance that becomes feedback, accept the latest attempt as it is, skip the task, ask for a replan, or cancel the run.

## Run branch

At the start of the first turn, the run records the source repository, the source branch, and its head commit, and creates the run branch `jewel/<run>` from that commit. Each attempt commits its worktree on `jewel/attempt/<run>/<task>/<attempt>`; this separate namespace is required because Git refs cannot have both `jewel/<run>` and a child ref below it. The controller merges accepted attempts into the run branch inside a controller-owned integration worktree, in the order they are accepted. The source checkout is never modified during a run.

Parallel tasks that touch overlapping code can conflict at merge time. The conflicting task gets a `rebase` attempt with the conflict evidence, based on the current run branch. It uses the same route unless the rebase budget is exhausted.

## Human requests

Human requests are durable records with a kind, a prompt, optional choices, a default, the tasks or run they block, and the answer:

- `clarification`: a question from the planner, an executor, or the delivery reviewer
- `human_step`: work only a human can do, from a planner task of kind `human` or an executor that reports it is blocked
- `plan_approval`: when the policy requires approval before execution
- `budget_exhausted`: see Budgets
- `recovery`: when an interrupted attempt cannot be evaluated safely

Answers are recorded and passed as context to the planner, feedback, or next attempt. A `human_step` can declare verification checks that must pass after the user marks it done.

Open requests are published on the same Session request stream the App's question and permission docks consume, attached to the run Session or to the attempt Session that raised them. Existing descendant-request bubbling therefore surfaces attempt requests in the run, and the session avatar's attention dot and the Home "Needs you" group cover every run without a separate inbox. `clarification` requests use the question-request shape, with options and a custom answer. `human_step`, `plan_approval`, `budget_exhausted`, and `recovery` use an orchestration request shape with typed actions. Answering through the dock or the API is the same durable event.

Executors can raise requests. A direct executor gets a `request_human` tool. Harness output that ends with an explicit blocked or question result is translated into a request instead of being judged as a failed attempt.

## Readiness and concurrency

A task is ready when all predecessors are accepted, no open human request blocks it, and its run is active. The scheduler selects ready work within run, executor, model, and host concurrency limits. Different tasks run concurrently because V2 permits different Sessions to drain concurrently.

Each attempt receives:

- a registered `ProjectCopy` location based on the run branch or the previous attempt
- a V2 Session for direct execution, or a harness execution identity
- an immutable route decision
- the task's acceptance criteria, selected checks, and any feedback

Parallel attempts never edit the same checkout.

## Recovery

The scheduler rebuilds its queue from projections after a restart. It does not repeat provider work whose outcome is uncertain. An attempt interrupted during execution is recorded as `interrupted`. Because its effects are confined to its worktree, the default policy commits and evaluates the worktree as it is. The verdict then drives the next step, which may be a new revision attempt. `recover_interrupted: ask` opens a `recovery` human request instead. Interrupted judge, delivery review, or summary calls are simply repeated, because they have no side effects beyond cost.

Capacity suspension records the earliest relevant reset time. A timer or later capacity observation wakes the run. The task returns to `ready` only after route eligibility is recalculated.

## Execution implementation

The local scheduler owns one process-local drain per run. It rebuilds readiness from the durable projection at each boundary, starts up to `orchestration.max_concurrency` ready tasks, and lets separate runs drain independently. The default task concurrency is two. Self-dependencies and dependency cycles are rejected when the graph is edited.

Direct candidates execute through one V2 Session in a Git `ProjectCopy` created under the orchestration data directory. The attempt records the selected candidate, Session ID, and Location before model execution starts. Codex, Claude, Cursor, and Copilot harness candidates use the same isolated ProjectCopy, with read-only mirror Sessions for their transcripts. Codex receives the task prompt through stdin and runs with automatic approval review, which applies its workspace-write sandbox. User Codex configuration is omitted so unrelated plugins and settings do not change the adapter's execution context. Claude uses restricted mode, which confines its file tools to the working directory and removes command execution, with file edits accepted and other permission prompts denied. Cursor and Copilot use their CLI sandbox options. Structured output contributes session or thread ID, CLI version, model, effort, timing, and usage evidence; deterministic checks and the Git diff follow. The host probes installed and authenticated state where available; routing records the versioned observation and rejects unavailable or unsupported harnesses. A fresh API-created run registers its project root with ProjectCopy before scheduling its first attempt. Claude, Cursor, and Copilot execution have not yet been verified with live models on this host.

Harness subprocesses receive an allowlist of path, locale, and CLI configuration environment variables. Unrelated server credentials, including the Jev API key, are not inherited by the coding agent.

When every eligible candidate is exhausted and a reset time is known, the run records its source location and next retry time. The scheduler wakes at that time, refreshes the UsagePool snapshot, and retries tasks whose latest route decision is due. On startup it restores timers for suspended runs with a persisted source and retry time. A failed or unchanged capacity refresh leaves the task suspended with a bounded retry delay. Runs without a known reset time, or older runs that lack a stored source, require an operator retry.

Every completed attempt records structured Git evidence: worktree, branch, head commit, remote names, and counts of staged, unstaged, and untracked paths. Remote URLs and their possible credentials are not stored.

Route profiles can set `host_free_memory_at_least_bytes` on a candidate. This checks the local host's OS-reported free bytes against a cached, versioned observation and records a distinct memory rejection with a 30-second retry. The same route decision retains the UsagePool quota snapshot and host CPU and load readings.

Configured checks run once in the source checkout and once in the attempt worktree unless `baseline` is false. A passing attempt is `passed`. A failing attempt whose baseline passed is `failed`. When both fail, the result is `indeterminate` so a pre-existing repository failure is not attributed to the attempt. Command output and the Git patch are bounded before they are stored as evaluation evidence.

Phase 2 stopped every completed attempt at `awaiting_review`. Phase 3 replaces that with judge-driven acceptance. The user can still override at any time before integration: reopening an accepted task creates a revision with the user's feedback and removes its merge from the run branch before the turn is delivered, and accepting a returned task merges its latest attempt. Overrides are recorded as labels for judge evaluation.

## HTTP control surface

- submit an assignment or follow-up with a policy
- read run, turn, task, attempt, judgment, and delivery detail
- subscribe to run events on the server event stream. This replaces Mission Control's polling and drives the run Session's parts, the Run panel, and the plan dock.
- read diffs between arbitrary refs (turn base to run branch head, attempt base to attempt head) for the Review panel's run, turn, task, and attempt scopes
- list and answer human requests
- override acceptance, grant budget, retry, and cancel
- run integration actions on a delivered turn
- create runs, tasks, and dependencies manually, and apply plan proposals
- read route profiles, policies, capacity explanations, and judge comparison reports

## Security boundary

The current Bash tool runs with the host user's authority. A worktree protects branch state but does not confine filesystem, process, or network access. Autonomous acceptance removes the per-attempt human checkpoint, so Phase 3 assumes trusted repositories and configured check commands. The planner selects check presets by name rather than writing commands. Projects can set `orchestration.execution_trust: "untrusted"` to refuse assignment submission, run starts, and attempt or preset check execution until the [isolated worker](./sandbox.md) is available. Integration actions that touch remotes always require an explicit user choice.
