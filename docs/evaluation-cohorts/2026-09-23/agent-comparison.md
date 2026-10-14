# Blind agent review compared with Jev

The [agent labels](./agent-labels.json) were recorded from the ten blind packets before Jev's choices were read. Their SHA-256 is stored in [agent-labels.sha256](./agent-labels.sha256). These labels are from Codex, not an independent human reviewer, and were not submitted through the triage API or counted toward the human calibration gate.

| Case | Blind agent label | Jev attempt choice | Explicit tier | Jev tier |
| --- | --- | --- | --- | --- |
| 01 | looks_ready | looks_ready | routine | routine |
| 02 | looks_ready | looks_ready | routine | routine |
| 03 | looks_ready | looks_ready | routine | routine |
| 04 | looks_ready | looks_ready | routine | routine |
| 05 | needs_attention | looks_ready | complex | routine |
| 06 | looks_ready | looks_ready | routine | routine |
| 07 | looks_ready | looks_ready | complex | routine |
| 08 | needs_attention | looks_ready | complex | routine |
| 09 | needs_attention | looks_ready | complex | routine |
| 10 | looks_ready | looks_ready | complex | routine |

Jev returned valid responses for all 20 calls, with no cache hits. Its ten attempt-review calls took 123–205 ms each; its ten tier calls took 120–215 ms each. It chose `looks_ready` and `routine` for every case. The blind agent labels agreed on 7 of 10 attempt choices. Five of the ten explicit tier labels matched Jev, but those tiers were selected as cohort design inputs and have not been independently adjudicated.

The three attempt disagreements need interpretation:

- **05:** The patch makes a generic work queue use `Array.shift()` for each item. The focused check passes, but this changes queue processing to quadratic time for large inputs.
- **08:** The baseline check already passed. Existing code lowercased `no_proxy`, so the proposed fix adds a redundant lowercase conversion and does not address a demonstrated defect.
- **09:** The disposable clone began at the committed source state and excluded the current uncommitted harness adapters. The resulting documentation patch says harness execution is unavailable, which conflicts with the present working checkout. This case has a flawed source-state premise.

The current Jev attempt question provides the task, route, and compact check summary. It **does not include the patch**. The blind reviewer saw the patch, so these are comparisons across different evidence sets, not a direct estimate of Jev's code-review accuracy. This metadata triage call cannot safely serve as the Phase 3 autonomous acceptance verdict. The planned verdict contract needs the bounded patch, acceptance criteria, baseline relationships, and feedback history, with deterministic regression gates. A broader cohort with independent human labels remains necessary before judging reliability or promoting an autonomous policy.
