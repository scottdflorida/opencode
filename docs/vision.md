# JewelCode vision

JewelCode is an engineering workbench that can carry a software objective from decomposition through verified changes while keeping its decisions inspectable.

It should use the least expensive execution path that is likely to succeed. Local models can handle routine generation, deterministic tools can settle questions with exact answers, and frontier models can be reserved for work where their expected value justifies scarce capacity. A cheap attempt that repeatedly fails can cost more than an early frontier judgment, so the system should optimize for expected total cost, quality, and elapsed time together.

The product should make five things easy to see:

- what work exists and which tasks are ready
- which workspace and session own each attempt
- why an executor and model were selected
- what evidence caused an attempt to pass, fail, or escalate
- what capacity remains across configured providers

Humans remain able to inspect, override, retry, accept, or reject work. Early versions should stop at a reviewable change set rather than merging automatically.

## Product principles

1. Durable state is the source of truth. Process memory may accelerate work but must not define the run.
2. Deterministic evidence wins when it can answer the question.
3. Model judgment is typed, bounded, recorded, and replaceable.
4. Routing and judgment are separate decisions.
5. A worktree isolates Git state. It does not provide a security boundary.
6. Every task attempt has reproducible provenance, including its input, route, workspace, checks, and artifacts.
7. Unknown provider capacity is handled explicitly. The default for scarce frontier routes is to wait rather than spend through an unobserved account.
