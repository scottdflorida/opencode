# Evaluation

Evaluation determines whether an attempt produced acceptable work and what should happen next. It is evidence-driven and reproducible.

## Evaluation order

1. Check that the executor completed and expected artifacts exist.
2. Run deterministic repository checks.
3. Compare failures with the recorded baseline.
4. Apply task-specific rubric rules that can be computed exactly.
5. Ask a typed judge only for remaining subjective questions.
6. Escalate to a frontier reviewer or human when policy requires it.

Deterministic checks may include formatting, type checking, unit tests, integration tests, build commands, static analysis, and focused repository scripts.

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

The evaluator registry runs commands in the attempt worktree. A project configuration chooses which evaluators apply to each task profile.

## Baselines

Repositories may begin with known failures. The system should capture a baseline before an attempt when a check is selected. Results then distinguish:

- a new regression
- a fixed baseline failure
- an unchanged baseline failure
- an indeterminate result caused by environment or infrastructure

An unchanged baseline failure should remain visible without automatically blaming the attempt.

## Outcomes

Evaluation policy can produce these actions:

- accept the attempt for review
- retry with the same route and revised context
- retry with a different route
- split or replan the task
- request typed or frontier review
- request human review
- fail the task

Retry and escalation limits are explicit. The system records the evidence that triggered every transition.
