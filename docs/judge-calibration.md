# Collecting judge evaluation data

Use blind review packets and independent labels to compare the authoritative judges in [judge experiments](./jev.md#experiments). Labels help tune policies and confidence thresholds; they do not grant authority to a judge.

The App's Lab Labels tab and the headless API can collect this evidence. A run stores its task, route, isolated attempt, deterministic checks, Git change, and typed judge responses. The evaluation set must come from varied real tasks and independent operator labels; repeated calls on a toy task establish that the pipeline works but do not establish judgment quality.

## Collection protocol

1. Choose a named policy with a `jev`, `llm`, or `experiment` judge. For paired comparison, configure both arms and record which arm is authoritative. Keep the policy snapshot fixed within one cohort.
2. Select representative tasks from the target projects. Include straightforward and difficult work, passed and failed checks, missing changes, interrupted attempts, and different languages or packages. Record the source objective and the reason for each explicit task tier before seeing a classifier recommendation.
3. Submit each assignment from the App or API. The executor writes into an isolated Git worktree and records checks and a bounded patch. Open the blind packet in Lab's Labels tab, or fetch `GET /api/orchestration/:runID/task/:taskID/review-packet` after an attempt finishes. Inspect the packet before opening run detail or judge reports, which reveal the answers.
4. An independent reviewer records `looks_ready` when the deterministic evidence and change support routine human review, or `needs_attention` when extra investigation is needed. Lab provides those two actions and an optional note. The API accepts `{ "decision": "looks_ready", "note": "..." }` or its `needs_attention` equivalent at `POST /api/orchestration/:runID/task/:taskID/triage`. Each completed attempt accepts one immutable triage label. Accepting or reopening the work is a separate action and does not count as this blind label.
5. After labeling, inspect the full run, `GET /api/orchestration/judges/compare`, and the Jev-specific `GET /api/orchestration/calibration`. Review disagreements case by case, especially a judge acceptance on an attempt labeled `needs_attention`. Record whether the task was eventually integrated separately from triage.

The original shadow-mode report marked a cohort eligible for policy review at 100 distinct labeled request and model pairs, 98% valid responses, 90% agreement, and uncached p95 latency of at most three seconds. These thresholds are historical report annotations under the revised plan; they do not gate judge authority. `uniqueRequests` and `uniqueLabeled` still prevent cached repeats from inflating samples, and conflicting labels still need adjudication before interpreting agreement.

## First disposable pilot

An isolated backend and Git repository exercised the full path. The initial run exposed a missing project-root registration on a fresh API-created run; that is now fixed. A second run selected Codex Luna, produced `greeting.ts` in its own worktree, and passed a check that had exited 1 on the baseline and 0 on the attempt. Jev returned valid `looks_ready` and `routine` shadow choices. The tier request occurred twice across the two pilot runs; the gate correctly counts one unique case. No independent triage label has been recorded for the completed attempt, and this toy case should not be used to justify promotion.

## First repository cohort

The user authorized ten bounded tasks against this OpenCode repository. A disposable clone from source commit `19bcead23` carried the evaluation route configuration; Codex Luna ran every task in its own worktree. All ten attempts reached review with passing focused checks, and Jev returned ten valid attempt-review and ten valid tier-classification shadow results. The [blind review index](./evaluation-cohorts/2026-09-23/README.md) contains the task, check evidence, and patch for each attempt, with Jev results omitted. No attempt change was merged into the working checkout.

The user delegated this cohort's blind packet review to Codex. Its labels were locked before Jev's choices were opened, and the [agent comparison](./evaluation-cohorts/2026-09-23/agent-comparison.md) records the result. Agent labels are marked as such and were not submitted to the triage API or counted as independent human labels. This first cohort probes the review process; a larger, more varied set with independent human labels remains necessary before drawing reliability conclusions.
