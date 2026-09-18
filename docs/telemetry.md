# Telemetry and provenance

Telemetry should answer why the system acted, how much the action cost, and whether it worked.

## Event families

- run created, started, suspended, resumed, completed, or cancelled
- task added, dependency changed, ready, blocked, or completed
- attempt created, started, interrupted, completed, or abandoned
- workspace created, adopted, inspected, or released
- capacity observed or invalidated
- route considered, rejected, selected, or overridden
- model or harness execution started and completed
- evaluator started and completed
- judgment requested, validated, rejected, or timed out
- review requested, accepted, rejected, or revised

## Common fields

Every event should carry stable run, task, attempt, workspace, and session identifiers where applicable, plus timestamps and a schema version. Decision events also carry policy version, candidate set, evidence references, outcome, and a human-readable reason.

Execution records should include executor kind, provider or harness, model, effort, duration, token counts when available, reported cost, process status, and artifact references.

## Privacy and retention

Prompts, source excerpts, command output, and harness transcripts can contain secrets. Store bounded artifacts with explicit retention and redaction policy. Durable events should prefer digests and references over copying large sensitive payloads into every projection.

Credentials and provider authentication material never enter telemetry. Capacity records contain only normalized usage, state, reset time, and observation metadata.

## Mission-control views

The initial UI should show:

- run progress and dependency state
- active and suspended attempts
- workspace and Session links
- route choice and rejected alternatives
- latest capacity observations and freshness
- deterministic check output
- pending human decisions

Historical comparison and optimizer dashboards can follow after the event vocabulary is stable.
