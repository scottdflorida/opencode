# Telemetry and provenance

Telemetry should answer why the system acted, how much the action cost, and whether it worked.

## Event families

- run created, turn started, clarifying, delivered, suspended, resumed, failed, or cancelled
- plan proposed, applied, or replanned
- task added, dependency changed, ready, blocked, or completed
- attempt created, started, interrupted, completed, or abandoned
- workspace created, adopted, inspected, or released
- capacity observed or invalidated
- route considered, rejected, selected, or overridden
- model or harness execution started and completed
- evaluator started and completed
- judgment requested, validated, rejected, or timed out, with its arm and whether it was authoritative
- attempt accepted, returned with feedback, or merged into the run branch
- reassignment decided, with its legal options and chooser
- human request opened, answered, or withdrawn
- human override recorded
- delivery reviewed and summarized
- integration step started, completed, or failed

## Common fields

Every event should carry stable run, task, attempt, workspace, and session identifiers where applicable, plus timestamps and a schema version. Decision events also carry policy version, candidate set, evidence references, outcome, and a human-readable reason.

Execution records should include executor kind, provider or harness, model, effort, duration, token counts when available, reported cost, process status, and artifact references.

## Privacy and retention

Prompts, source excerpts, command output, and harness transcripts can contain secrets. Store bounded artifacts with explicit retention and redaction policy. Durable events should prefer digests and references over copying large sensitive payloads into every projection.

Credentials and provider authentication material never enter telemetry. Capacity records contain only normalized usage, state, reset time, and observation metadata.

## App views

The [UI](./ui.md) defines where this evidence appears:

- milestones in the run Session timeline
- per-attempt evidence in the Run side-panel tab
- open requests in docks and Home's "Needs you" group
- capacity in the status popover
- judge and policy comparisons in Lab
