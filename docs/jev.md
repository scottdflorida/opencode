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
- input and output digests
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

The first integration should run in shadow mode. It records what Jev would have decided while deterministic policy remains authoritative. Compare agreement, downstream success, cost, and latency before allowing it to control any transition.

Judgments should be cached by request digest when their evidence and policy are unchanged. This reduces cost and makes repeated orchestration replay stable.
