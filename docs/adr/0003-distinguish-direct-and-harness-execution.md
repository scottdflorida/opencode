# ADR 0003: Distinguish direct and harness execution

- Status: accepted
- Date: 2026-09-18

## Context

OpenCode's V2 runner owns a direct model turn and its tools. Local coding harnesses such as Claude Code, Codex, Cursor Agent, and Copilot CLI may own an entire nested agent loop, including prompts, tools, authentication, and model selection. Treating a harness as a normal model provider would hide those semantics and weaken provenance.

## Decision

Represent route candidates and attempts with an explicit execution kind:

```ts
type RouteCandidate =
  | { type: "direct"; providerID: string; modelID: string }
  | { type: "harness"; harnessID: string; modelID: string; effort?: string }
```

Direct candidates execute inside a V2 Session. Harness candidates execute through a dedicated adapter and record their own process, transcript, and artifact references. Both produce a normalized attempt outcome for evaluation.

## Consequences

- V2 model-stream invariants remain clear.
- Harness-specific capabilities and quota meters can be modeled honestly.
- An evaluator can compare normalized outcomes while retaining full provenance.
- Harness adapters require explicit cancellation, timeout, output, and side-effect policies.
- A future harness that can participate as a true streaming provider may add a direct adapter without changing existing execution records.
