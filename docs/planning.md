# Planning

The planner turns an assignment into a validated task graph. It then revises that graph when the assignment turns out to need more. It is a role with its own route profile in the run's policy.

## Clarify or plan

For each new turn, the planner receives the assignment, bounded repository context, the configured capability tiers, check presets, and, for follow-up turns, the previous delivery summary. It returns one of two typed outputs:

- `questions`: one to five clarifying questions. Each has optional choices and the assumption the planner would make without an answer. Each question becomes a `clarification` human request, and the run waits in `clarifying`.
- `plan`: a rationale, the assignment clauses the delivery reviewer will check, and a task graph.

`clarify: assume` makes the planner proceed with its stated assumptions instead of asking. The delivery summary lists every assumption so the user can see what was assumed.

Each planned task contains:

- a key, title, and description
- `kind`: `agent`, or `human` for a step only the user can do
- one to eight acceptance criteria, which the judge evaluates
- a capability tier from the configured set
- check preset names from the project's configured presets
- optional allowed paths, which become an exact rule
- dependencies on other task keys

A `human` task becomes a `human_step` request when its dependencies are accepted. It is accepted when the user marks it done and any verification checks pass.

The model-generated schema cannot define check commands, candidates, permissions, or policy. Caller-submitted proposals can still carry explicit check commands and route profiles for manual testing. Operators review these commands before the run starts.

## Validation and application

Validation requires 1–16 uniquely keyed tasks per proposal, valid dependency references, no cycles, known tiers and check presets, at most eight checks per task, and bounded text fields. An invalid plan is returned to the planner once, with the validation errors. A second failure opens a human request.

With `plan_approval: auto`, the default, a valid proposal is applied in one durable `orchestration.plan.applied` event and dispatch begins. With `plan_approval: human`, the user approves or rejects the proposal through a `plan_approval` request. The approval dock can edit the plan as validated JSON; saving stores a new proposal, and Approve applies the latest proposal.

## Replanning

The planner is called again when:

- the delivery reviewer reports `gaps`
- a task exhausts its budget and the user chooses replan
- a human step cannot be completed and its reason becomes planner feedback
- queued follow-up guidance is sent to the planner during an active turn

A replan receives the run's current state and may add tasks and cancel or replace tasks that have not started. It cannot change accepted or running tasks. `max_replans` bounds replans per turn. Each replan is a new proposal linked to the previous one.

## Tier selection

The planner assigns a tier to each task by default. `tier_classifier.provider` can move that responsibility to a typed judge: `planner`, `jev`, `llm`, or `experiment`. The classifier chooses among the configured tiers and a fallback, and its decision is recorded beside the route decision. A tier the user sets explicitly always wins.

## Provenance

Generated proposals retain the exact prompt, request digest, route and capacity snapshot, latency, and token usage. Supplied context is part of the stored prompt and is returned with run detail to authorized clients, so keep credentials out of it.

## API

- `POST /api/orchestration/:runID/plan` submits a caller-authored proposal to a draft run.
- `POST /api/orchestration/:runID/plan/generate` runs the planner on demand. It accepts optional `profile` and `context`.
- `POST /api/orchestration/:runID/plan/:planID/apply` applies a proposal.

The submit-assignment endpoint performs clarify, plan, and apply automatically under the run's policy.
