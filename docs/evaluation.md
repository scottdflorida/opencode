# Evaluation

Evaluation decides, without a human in the default path, whether an attempt is accepted into the run branch or goes back for more work. It is evidence-driven, typed, and reproducible.

## Evaluation order

1. Check that the executor completed and the expected artifacts exist. An executor that reported a question or a blocked step raises a human request instead of being judged.
2. Commit the attempt worktree and run the task's deterministic checks, comparing against the baseline.
3. Apply exact rules, such as "the patch is empty", "the patch touches files outside the allowed paths", or "a required file is missing".
4. Ask the configured judge for a typed verdict. See [typed judgment](./jev.md).
5. Combine the verdict, deterministic gates, and budget into an action.

Deterministic checks may include formatting, type checking, unit tests, integration tests, build commands, static analysis, and focused repository scripts. Projects define them as named check presets. Planners select presets by name.

## Verdict contract

Every judge answers the same typed questions, so Jev and LLM judges are directly comparable:

- For each acceptance criterion on the task: `met`, `not_met`, or `unclear`.
- Overall: `accept`, `revise`, or `needs_human`.

Each answer carries a confidence and, where the provider supports it, a probability distribution. The judge receives the task, its acceptance criteria, the bounded patch, check results with baseline relationships, and the feedback history of earlier attempts.

An attempt is accepted only when all of these hold:

- the overall verdict is `accept` with confidence at or above `acceptance.min_confidence` (default 0.8, a key setting to tune during testing)
- every required criterion is `met`
- no check has a new regression
- no exact rule failed

A new regression, a failed exact rule, or an empty patch where changes were expected returns the attempt without a judge call when `acceptance.skip_judge_on_regression` is true (the default). This saves cost and still produces feedback from the evidence.

A `needs_human` verdict opens a clarification request, with the unclear criteria as context.

## Feedback

Feedback is composed separately from the verdict. That way, a judge comparison measures judgment, not writing quality.

- The deterministic composer always runs. It lists unmet and unclear criteria, new check failures with bounded output, and failed exact rules.
- An optional feedback writer, which is a route profile for a direct LLM, turns that evidence plus the patch into concrete revision guidance.

The feedback record is stored with the attempt and is the input to the next revision or reassignment. What happens next is decided as described in [revisions and escalation](./orchestration.md#revisions-and-escalation).

## Delivery review

When every task in a turn is accepted, the delivery reviewer evaluates the whole turn:

- run-level checks on the run branch, compared against the turn's base commit
- a typed judgment of each clause the planner extracted from the assignment: `met`, `not_met`, or `unclear`
- an overall `delivered`, `gaps`, or `needs_human`

`gaps` returns the unmet clauses to the planner as a replan, within the turn's replan budget. The delivery reviewer uses the same provider selection as the judge.

## Human overrides

Before integration, the user can reopen any accepted task with feedback, or accept a returned attempt. Overrides are recorded as labels against the judgment they overturn. They are the strongest available signal for comparing judges.

## Evaluator record

Each evaluator result stores:

- evaluator kind and version
- exact command and arguments
- working directory and environment policy
- start time, duration, and exit status
- bounded stdout and stderr references
- produced artifacts
- baseline relationship
- normalized verdict and reason

The evaluator registry runs commands in the attempt worktree.

## Baselines

Repositories may begin with known failures. The system captures a baseline before an attempt when a check is selected. Results then distinguish:

- a new regression
- a fixed baseline failure
- an unchanged baseline failure
- an indeterminate result caused by environment or infrastructure

An unchanged baseline failure stays visible to the judge without automatically blaming the attempt.
