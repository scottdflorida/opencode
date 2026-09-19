# Typed judgment and Jev

Jev is an adapter behind a small typed-judgment boundary. The orchestration core depends on the boundary, not on Jev's prompt format or deployment details.

## Interface

A judgment request contains:

- a judgment type such as choice, score, classification, or rubric assessment
- a finite candidate set or bounded output schema
- the evidence selected by the controller
- policy constraints and a timeout
- a declared fallback action

A result contains:

- the validated typed value
- confidence or uncertainty data when supported
- judge identity and version
- a stable request digest
- latency and token or cost metadata
- validation and fallback status

The controller validates every result. Invalid, late, or missing results follow the request's declared fallback.

## Authority

The judge may recommend among legal choices supplied by the controller. It cannot create routes, relax permissions, spend through capacity limits, merge code, or execute tools.

Good uses include:

- selecting a route profile from a bounded set
- judging whether a task description is ambiguous
- scoring a change against a written rubric
- deciding whether deterministic evidence warrants escalation
- comparing several completed candidates

Poor uses include:

- checking facts available from a parser or command
- reading provider quotas
- deciding which commands are authorized
- inventing executor capabilities
- silently changing retry or spending limits

## Rollout

The first integration runs in shadow mode. After a direct attempt finishes its deterministic checks, the controller sends Jev a compact attempt summary and asks it to choose `looks_ready` or `needs_attention`. The summary includes the task, selected model, check statuses, exit codes, and whether the worktree changed. It excludes patch contents, command output, worktree paths, and credentials.

Every configured shadow request produces a durable judgment record. The record contains the bounded request, request digest, validated answer and probability distribution, resolved model version, latency, token usage, cache status, and a stable error code when the provider is unavailable or its response is invalid. Mission Control shows the record beside the deterministic evidence. The result does not change task state. Tasks still stop at `awaiting_review` until a person accepts or rejects them.

Enable the integration in `opencode.jsonc` and keep the API key in the server environment:

```jsonc
{
  "orchestration": {
    "judge": {
      "mode": "shadow",
      "provider": "jev",
      "model": "jev-latest",
      "timeout_ms": 10000,
    },
  },
}
```

Set `TYPESAFE_API_KEY` outside committed configuration. Set `mode` to `off` or remove `judge` to disable provider calls.

Judgments should be cached by request digest when their evidence and policy are unchanged. This reduces cost and makes repeated orchestration replay stable.
