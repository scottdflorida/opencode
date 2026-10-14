# Capability routing, resources, and execution evidence

This extends the [architecture](./architecture.md) and [roadmap](./roadmap.md) for JewelCode's Mac Studio host. The goal is to explain each dispatch and retain enough evidence to compare the engineering value of routes over time. The examples below are provisional configuration examples, not claims that a model or subscription adapter is currently available.

## Current foundation and next boundary

The control plane persists runs, task graphs, attempts, route decisions, evaluations, reviews, and typed judge results. Route decisions retain the selected profile, UsagePool quota, local host resources, harness observations, and rejection reasons; historical decisions without those fields remain readable. Direct attempts use isolated ProjectCopy worktrees and V2 Sessions. Codex, Claude Code, Cursor Agent, and Copilot CLI have separate harness adapters; the host probes their installation, available authentication status, and model or effort catalogs before routing. The [App UI](./ui.md) places run detail in Sessions and capacity in the status popover; Lab holds comparisons and blind labeling. The host observation records OS free and total memory, CPU count, and load. GPU, queue, model-load, and RTX observations, hierarchical invocation telemetry, learned routing, and remote operation remain future work.

Keep these identities distinct:

| Concept         | Meaning                                                         | Durable link                                  |
| --------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Task            | Requested engineering work and dependencies                     | Run and task IDs                              |
| Capability tier | Policy-owned requirement such as `frontier-high` or `local-9b`  | Task and route decision                       |
| Model           | Concrete model, version, quantization, and effort               | Selected candidate and execution record       |
| Provider        | Account or physical endpoint that supplies the model or harness | Candidate and resource observation            |
| Executor        | Direct V2 stream or external harness process                    | Attempt and execution record                  |
| Resource state  | Observed quota, reset, health, memory, load, and queue          | Versioned observation used for route decision |
| Policy          | Eligible choices, ordering, reserves, privacy, and fallback     | Route profile and decision reasons            |
| Evaluation      | Deterministic checks, typed judgment, and human review          | Attempt, judgment, evaluation, and review IDs |
| Telemetry       | Measurements and relationships from execution                   | Invocation tree under an attempt              |

Tier IDs belong to policy rather than a fixed model list. Initial examples are `frontier-low`, `frontier-high`, `dense-30b`, `moe-35b`, `local-9b`, and `local-4b`. A tier definition should describe required capabilities and acceptable quality, then map to eligible concrete candidates. A local model may satisfy more than one tier when measured evidence supports it. A task can request a tier independently of its route profile. Existing tasks without a tier retain ordered profile behavior; a tiered task may use only candidates explicitly assigned to its tier. Unknown tiers fail with a recorded explanation instead of silently using a weaker route.

## Resource and execution adapters

Use a common _resource observation_ boundary for routing and display. It should compose source snapshots without hiding their provenance, age, unit, or uncertainty. UsagePool remains the current subscription collector; migrate its collectors into the host only after the normalized snapshot and UI consume the same source. Do not create a second quota tracker for the strip. Its stable `--snapshot` schema currently covers Claude, Codex, Cursor, GitHub Copilot, and Antigravity quota meters, provider state, and reset time; it deliberately omits session telemetry and attribution. Invocation evidence must therefore come from orchestration and executor layers, rather than be inferred from quota deltas. Local adapters for the Mac Studio and RTX endpoint should report memory or VRAM available, utilization, loaded models, context or KV capacity when exposed, active jobs, queue depth, and expected model-load delay. Benchmark candidate deployments before assigning models or quantizations to either machine. Missing measurements stay unknown. A local observation must not be interpreted as a subscription percentage or reset window.

Represent each measurement with a unit and eligibility meaning, such as `remaining_percent >= 20`, `free_bytes >= required_bytes`, or `queue_depth <= 2`. Bind observations to a provider endpoint and model deployment. The `remaining_at_least` rule applies to subscription quota. A separate `host_free_memory_at_least_bytes` candidate rule uses an OS-reported local free-memory snapshot; it never interprets bytes as quota percent. The route record contains one versioned observation with UsagePool quota and local host memory, CPU count, and load averages. Host readings refresh every 15 seconds outside dispatch. Missing or stale host memory, or a value below the configured threshold, waits and retries after 30 seconds. OS free memory is a conservative reading and does not measure Mac memory pressure, available unified GPU memory, model loading, or the RTX endpoint. Those require dedicated adapters before they can become eligibility rules. Routing records the exact observation and rejected reasons used for a decision. Unknown or stale scarce frontier capacity waits by default.

"Provider" can mean an account or a machine in product language, but the executable transport stays explicit. An OpenAI-compatible local server is a direct V2 candidate. Codex, Claude Code, Cursor Agent, Copilot CLI, and any supported Antigravity agent are harness candidates with their own tool loops and provenance. Jev is a typed specialist service unless a separate, supported execution adapter is defined. An adapter reports installed and authenticated state, supported models and effort, health, concurrency, and the usage or resource probes it can actually provide. No adapter may infer subscription access merely from a provider name.

## Routing and escalation

The policy pipeline is:

1. Select a profile by operator override, task, Agent, bounded classifier, then project default.
2. Determine the task's requested capability tier. A typed Jev classifier may recommend among configured tiers, with its answer, confidence, fallback, and policy version recorded. Human choice takes precedence.
3. Filter candidates by tier, privacy, model and executor support, installation, authentication, health, and local or remote resource requirements.
4. Apply configurable ordered preference and reserves. For example, keep 20% of an Opus meter for later `frontier-high` work, or decline a second large Mac model load during memory pressure.
5. Pin the selected candidate for one attempt and record the snapshot and explanation. A completed attempt is evaluated. A retry or escalation creates a new attempt with a fresh route decision.

Jev may classify, score, compare, and recommend escalation within a controller-supplied choice set. The deterministic policy still owns provider priority, quota reserves, privacy restrictions, permissions, and execution. Jev and LLM judges are selectable per policy and compared through judge experiments. See [typed judgment](./jev.md). No mid-attempt automatic failover is safe after side effects. Explicit escalation chains, such as `local-9b → moe-35b → frontier-low → frontier-high`, are bounded by policy and linked across attempts, so an early cheap failure contributes to total cost. When an attempt is not accepted, the orchestrator decides whether to revise with the same profile or reassign to another. See [orchestration](./orchestration.md#revisions-and-escalation).

Policy profiles such as `best`, `fast`, `balanced`, `conserve-frontier`, `local-first`, and `local-only` are examples, not hard-coded modes. `local-only` must exclude remote inference, remote Jev, cloud harnesses, network tools, and telemetry upload at every execution boundary. A route allowlist alone cannot guarantee fully private operation. The host needs a network enforcement boundary before the UI can promise a fully local mode.

## Execution evidence and useful metrics

Keep a hierarchy rooted at run, task, and attempt. Each meaningful invocation has its own ID and optional parent invocation ID: direct model turn, harness run, child agent, specialist judgment, retry, and evaluation. Tool and file-context spans can be linked where available. A trace records the requested tier; selected provider, endpoint, model version, quantization and effort; policy and resource snapshot references; start/end times; tokens and cache tokens; queue, first-token, prefill, decode, tool, and wall times; physical resource readings; quota before/after; and error or throttling codes. Every field must state its source and may be absent when an adapter cannot observe it. Store raw transcripts locally under access controls and retention limits, with references in durable records rather than copying large or sensitive text into route decisions.

Link deterministic checks, Jev scores, human review, and final contribution to the invocation or attempt that produced them. An accepted review is an operator decision, while final contribution means the change was integrated into the target work. Keep both signals so rejected, abandoned, or never-integrated work is not counted as success. Useful initial aggregates are first-pass acceptance, retries and escalations per accepted task, elapsed time to accepted result, and tokens or quota per accepted result. Compare by task type, language, repository, context size, model, quantization, effort, and hardware only when sample sizes and selection bias are visible. Raw tokens per second is diagnostic, not the primary productivity metric.

Start with manually authored routes and a small, complete evidence record. Later estimate success probability, expected retries, elapsed time, and resource cost for eligible candidates; evaluate route changes against held-out outcomes or controlled comparisons before granting a learned policy authority. Preserve the policy version and candidate set for every historical decision so model replacements do not rewrite past explanations.

## Product surfaces and future extensions

The [vision](./vision.md#operator-experience) describes where routing, capacity, judgments, and delivery appear in the App.

The Capacity tab in the status popover, described in the [UI](./ui.md), uses the same cached resource observation as routing. It shows UsagePool meters, available harnesses, host memory and load, freshness, and reset times. A meter older than the default five-minute routing age is stale rather than a current percentage. The titlebar warning state makes exhausted or unknown capacity visible across screens.

Attempt evidence includes structured repository worktree, branch, head commit, remote names, and status counts. It omits remote URLs, which may contain credentials. Delivery integration now has guarded apply, commit, merge, push, PR, and discard actions with preflight and recorded steps; broader repository management and fetch remain future work. The worktree boundary remains the isolation mechanism for parallel attempts, and integration requires an explicit human action. The Mac Studio is the initial orchestration host; remote clients should use its authenticated API later without moving scheduler ownership to each client.

If the project becomes open source, anonymous aggregate contribution must be opt-in. Export only coarse task, model, provider, hardware, timing, usage, and outcome buckets with minimum sample sizes and disclosure controls. Never export prompts, code, patches, transcripts, attachments, credentials, repository identity, or raw project paths. Local-only policy disables export regardless of the global setting.
