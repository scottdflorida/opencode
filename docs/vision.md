# JewelCode vision

JewelCode is an engineering workbench that takes a software assignment and carries it to a delivered, verified change set with minimal supervision, while keeping every decision inspectable.

The experience should feel like opening a new thread in Claude Code or Codex and asking for something. The user describes the assignment, answers the clarifying questions that matter, does the steps only a human can do, and receives a summary of how the request was addressed. Behind that exchange, a planning agent breaks the assignment into tasks, the scheduler routes each task to an appropriate executor, a judge evaluates each completed attempt, and the run loops through revision, escalation, and replanning until the whole assignment is accepted as delivered.

## The user's loop

1. Send an assignment and choose a policy (routing, judge, and budgets), or accept the project default.
2. Answer clarifying questions when the planner or a later agent needs them.
3. Complete "a human must do this" steps when the system cannot, such as creating a credential, logging in to a harness, or making a product decision.
4. Read the delivery summary and the combined diff.
5. Choose how to integrate the result: commit, merge, push, open a pull request, or discard.
6. Optionally send a follow-up assignment in the same run, which starts a new turn from the delivered state.

The user does not accept or reject individual attempts. They can watch, inspect, and override any decision, but the default path asks for input only for questions, human steps, exhausted budgets, and the final integration choice.

## Cost and quality

JewelCode should use the least expensive execution path that is likely to succeed. Local models can handle routine generation, deterministic tools can settle questions with exact answers, and frontier models can be reserved for work where their expected value justifies scarce capacity. A cheap attempt that repeatedly fails can cost more than an early frontier attempt, so the system optimizes for expected total cost, quality, and elapsed time to an accepted delivery.

Judgment follows the same logic. Jev and frontier LLM judges share one verdict contract, so a run can use either, or both in a controlled experiment. Recorded outcomes decide over time which judge is reliable enough to be the default.

## What the product makes visible

- what the assignment is, which turn is active, and what remains before delivery
- which questions and human steps are pending, and what is blocked on them
- which tasks exist, which are ready, and which workspace and session own each attempt
- why an executor and model were selected, and which capability tier was requested
- which judge accepted or returned each attempt, with its verdict, confidence, and feedback
- what evidence caused an attempt to pass, fail, be revised, or escalate
- what capacity remains across subscriptions and local hardware
- what each attempt and the whole delivery cost in time, tokens, quota, and hardware

## Product principles

1. Durable state is the source of truth. Process memory may accelerate work but must not define the run.
2. Deterministic evidence wins when it can answer the question. A judge cannot accept an attempt that introduces a check regression.
3. Model judgment is typed, bounded, recorded, and attributable. The judge decides acceptance within limits the controller enforces.
4. Judges are interchangeable. Jev and LLM judges answer the same verdict contract, so their decisions can be compared directly.
5. Routing and judgment are separate decisions.
6. Autonomy has explicit budgets for revisions, escalations, replans, tokens, quota, and time. Exhausting a budget produces a human request, never unbounded spending.
7. Work stays on the run's own branch until the user chooses an integration action. Source branches, remotes, and pull requests change only on that explicit choice.
8. A worktree isolates Git state. It does not provide a security boundary.
9. Every attempt has reproducible provenance, including its input, route, workspace, checks, judgment, feedback, and artifacts.
10. Unknown provider capacity is handled explicitly. The default for scarce frontier routes is to wait rather than spend through an unobserved account.
11. Capability tiers and task outcomes survive changes in model names, providers, and hardware.
12. The same observed resource state drives both routing and the operator's usage display.

## Operator experience

The App presents each run as a thread. [UI](./ui.md) is the canonical design. In summary:

- a composer for the assignment and follow-ups, with a policy selector
- a live timeline of clarifications, the plan, task progress, judgments, revisions, escalations, and replans
- one inbox of pending questions and human steps across all runs
- task detail on demand: route reasons, attempt history, feedback, checks, and diff
- a delivery summary with the combined diff and an integration action bar
- capacity and provider health in the titlebar status popover

The design reuses the existing v2 App wherever it can. Each run is a session, so tabs, Home, docks, child-session navigation, and the review panel carry most of the experience.
