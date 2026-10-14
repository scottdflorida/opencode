# Typed judgment, Jev, and judge experiments

Judgment sits behind a small typed boundary. The orchestration core depends on that boundary, not on Jev's prompt format or any LLM's deployment details. The boundary serves four roles: attempt judge, reassignment decider, delivery reviewer, and tier classifier.

## Interface

A judgment request contains:

- a judgment type: choice, score, classification, or rubric assessment
- a finite choice set for each question
- the evidence the controller selected
- policy constraints and a timeout
- a declared fallback

A result contains:

- the validated typed value, with confidence and a probability distribution when supported
- judge provider, model, and version
- a stable request digest
- latency, token, and cost metadata
- validation and fallback status

The controller validates every result. Invalid, late, or missing results follow the declared fallback. The attempt judge's fallback is `revise` with deterministic feedback only. A result is never treated as `accept` by default.

## Providers

- `jev`: the Jev Choice API. Each typed question is one Choice call. A verdict's questions run in parallel.
- `llm`: a route profile that resolves to a direct model. It answers the same questions through one structured-output call. The schema exposes only the same choice sets, plus confidence, so its answers are comparable with Jev's.

Both providers are fully authoritative. There is no shadow-only mode. Shadow records from Phase 3 remain readable.

```jsonc
{
  "orchestration": {
    "judge": {
      "provider": "experiment", // "jev" | "llm" | "experiment"
      "jev": { "model": "jev-latest", "timeout_ms": 10000 },
      "llm": { "route_profile": "judge-frontier" },
      "experiment": {
        "arms": {
          "jev": { "provider": "jev" },
          "opus": { "provider": "llm", "route_profile": "judge-opus" },
        },
        "assignment": "paired", // "paired" | "split"
        "authoritative": "random", // an arm name or "random"
        "seed": 1,
      },
    },
  },
}
```

A policy can choose the judge per run, so testing different judges needs no configuration edits.

## Experiments

- `split`: each task is assigned to one arm, and that arm is authoritative for every attempt of the task. Assignment is per task, so a task's revisions stay consistent. This measures downstream outcome differences at the cost of one judge.
- `paired`: every arm judges every attempt. One arm is authoritative, either fixed or randomized per task. The others are recorded as comparisons. This measures agreement directly and surfaces disagreements, at the cost of every arm.

The authoritative arm, randomization seed, and assignment are recorded with every judgment.

The judge comparison report (`GET /api/orchestration/judges/compare`) aggregates by arm, role, project, and time window:

- validity, fallback rate, latency percentiles, tokens, and estimated cost
- pairwise agreement and confusion matrices from paired runs
- human override rate: accepted work the user reopened, and returned work the user accepted
- downstream signals: accepted attempts later implicated by delivery review gaps or regressions, and revisions per accepted task
- turn outcomes: delivery rate, time to delivery, and attempts per delivery
- integration outcomes: whether delivered work was committed, merged, or discarded

`judge.label_sample_rate` asks the user to label a sample of judgments, including all paired disagreements if configured. The questions appear in Lab's Labels queue and as optional, non-blocking entries in Home's "Needs you" group and give the report ground truth that does not depend on overrides.

### Existing calibration endpoints

`GET /api/orchestration/calibration` reports project-scoped Jev validity, agreement with explicit attempt triage labels, a confusion matrix, latency percentiles, and token totals. Cached judgments appear in raw totals but have no new token usage. Dollar cost is an estimate only when both price settings are configured, and `pricedCalls` shows how complete the price history is.

For independent labels, `GET /api/orchestration/:runID/task/:taskID/review-packet` returns the latest attempt, route, checks, and Git evidence without any judge's answer. After inspecting it, an operator posts one immutable `looks_ready` or `needs_attention` label to `POST /api/orchestration/:runID/task/:taskID/triage`, optionally with a note. Label before viewing run detail or reports, which reveal the judge's answer. The comparison report extends this endpoint across arms. It keeps the counts of distinct request and model pairs (`uniqueRequests`, `uniqueLabeled`) and `labelConflicts`, so cached repeats cannot inflate samples. See [collecting judge evaluation data](./judge-calibration.md).

The report does not change the default judge by itself. Choosing a default is a policy decision informed by the report. The existing promotion-gate thresholds of 100 labels, 98% validity, 90% agreement, and p95 of 3 seconds or less become report annotations.

## Authority

A judge chooses among legal options the controller supplies. It cannot create routes, relax permissions, spend past budgets or capacity limits, override a deterministic regression, integrate code, or execute tools.

Good uses include:

- accepting or returning an attempt against its acceptance criteria
- choosing between revising, reassigning, or escalating among legal options
- judging whether an assignment or task is ambiguous
- checking a delivery against the assignment's clauses
- recommending a capability tier from a configured set

Poor uses include:

- checking facts available from a parser or command
- reading provider quotas
- deciding which commands are authorized
- inventing executor capabilities

## Evidence and privacy

Authoritative judgment needs the bounded patch and check output. That evidence goes to the configured judge endpoint, which is the Jev service or the LLM provider. Worktree paths and credentials are excluded. A `local-only` policy must select local judges for every role.

## Configuration

Keep the Jev key in the server environment as `TYPESAFE_API_KEY`, outside committed configuration. Set `input_cost_per_million_usd` and `output_cost_per_million_usd` for each provider to store estimated cost with each judgment. These are local estimates, not billing records.

Valid results are cached in SQLite by provider, model, and exact request digest. The default TTL is one day, and `orchestration.judge.cache_ttl_seconds` overrides it. Invalid and unavailable responses are never cached. Paired experiment arms have separate cache entries.
