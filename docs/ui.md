# JewelCode UI

This design layers orchestration onto the existing v2 App, which has been the default layout since 1.17.19. It reuses v2 surfaces wherever their meaning fits and adds new UI only where no existing surface can carry the concept. This is the canonical UI design. The backend requirements in the next section are tracked in the [roadmap](./roadmap.md) and [orchestration](./orchestration.md#run-sessions).

## Core decision: a run is a session

A run is shown as a root session of kind `orchestration`. The user's assignment is its first user message. Orchestration progress appears as parts in its timeline. Each direct attempt is already a V2 Session, so it becomes a child session of the run.

That single mapping gives the run, with no new UI:

- a titlebar tab with the status avatar: progress while working, a dot when it needs you
- a row in Home's session list, including search, archive, and rename
- child-session navigation with the existing breadcrumb (`Run / Task · Attempt 2`) and the "Back to parent" composer
- the question and permission docks, including requests that bubble up from descendant sessions (`session-request-tree.ts`)
- the todo dock, the follow-up queue dock, the review side panel, context usage, share, and export
- notifications on idle and error

Backend implications:

- An `orchestration` session kind whose history the controller appends to and the runner never drives.
- Attempt sessions created with `parentID` set to the run session.
- Human requests exposed through the same request stream the question and permission docks consume.
- A run event stream instead of Mission Control's polling.
- `vcs.diff` that accepts an arbitrary base and head ref.
- A harness attempt has no execution V2 Session. Mirror its structured output into a read-only child session so it opens like any other attempt, with its route and verdict in the Run panel.

## Screen layout

```
┌ titlebar: [⌂] [Run: Add SSO ●] [session tab] [+] ··········· [status ◔] ┐
│ ┌ session panel ─────────────────────────┐ ┌ side panel ─────────────┐ │
│ │ Add SSO to the admin app   ◔ ⋯         │ │ [Run] [Review] [Usage]  │ │
│ │                                         │ │                         │ │
│ │ You: Add SSO login to the admin app…    │ │ ✓ Schema migration      │ │
│ │ ▸ Asked 2 questions · answered          │ │ ◐ OIDC callback  att 3  │ │
│ │ ▸ Plan · 6 tasks · balanced · Jev       │ │   local-9b ✗✗ → f-low   │ │
│ │ ⇢ Schema migration        ✓ accepted    │ │ ⚑ Create IdP app (you)  │ │
│ │ ⇢ OIDC callback  ◐ attempt 3 · f-low    │ │ ○ Admin UI button       │ │
│ │ ⇢ Session middleware      ✓ accepted    │ │ ○ Tests                 │ │
│ │ ▸ Replanned · +1 task                   │ │                         │ │
│ ├─────────────────────────────────────────┤ │ ▾ OIDC callback         │ │
│ │ dock: Plan 3/6 ✓ ◐ ⚑ ○ ○ ○              │ │   Attempt 1 local-9b ✗  │ │
│ │ dock: ⚑ Create the Okta app… [Done]     │ │   2 criteria not met    │ │
│ │ [ Follow up…     ] Orchestrate balanced │ │   Attempt 2 …           │ │
│ └─────────────────────────────────────────┘ └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

## 1. Starting a run: the existing composer

The run starts in the new-session draft view and composer. The composer's three selects change meaning when the orchestrator is chosen:

| Composer slot | Normal session | Orchestrator selected |
| --- | --- | --- |
| Agent select | build, plan, … | **Orchestrate** (a new built-in agent entry) |
| Model select | model | **Policy** (from `orchestration.policies`, default marked) |
| Variant select | effort | **Judge** (policy default, Jev, LLM, or Experiment) |

- Workspace selector: hidden, because runs always use their own worktrees. The existing `PromptGitStatus` chip shows the source branch the run will start from.
- The policy select's menu shows each policy's key settings (executor tiers, judge, min confidence, budgets) as secondary text, so choosing one is informed without opening settings.
- Submit creates the run session and navigates to it like any new session.

**Net new:** an agent entry and two option sources for existing selects.

## 2. The run timeline: renderers in the existing tool registry

Orchestration parts render with `BasicTool` / `basic-tool-v2` shells registered in the `ToolRegistry`, so they collapse, stream, and style like tool calls. The top level shows milestones only. Detail lives inside each item.

| Part | Collapsed row | Expanded |
| --- | --- | --- |
| Clarification | "Asked 3 questions · answered" | Reuse the `question` tool renderer, which already shows answers |
| Plan | "Plan · 6 tasks · policy · judge" | Task list with tier `Tag`s, acceptance criteria, dependencies, and assumptions |
| Task | The existing **task link card**: title, a tier-colored label in place of the agent color, spinner, arrow to the attempt session. The card updates in place: attempt number, current tier, and a verdict tag (`accepted`, `revising`, `escalated`, `waiting on you`). | Attempt list with each attempt's route, verdict and confidence, one-line feedback, and reassignment reason. Click to open that attempt's child session. |
| Replan | "Replanned · +1 task, 1 cancelled · delivery gaps" | Before/after task list |
| Human request | "Waiting on you: Create the Okta app" (answered state afterwards) | Prompt, answer, and who or what raised it |
| Delivery review | "Delivery review · 5/5 clauses met" | Per-clause verdicts |
| Summary | An ordinary assistant **text** message with markdown | The existing per-turn diff summary (`summary-diffs`) below it |

Judgments, reassignments, and feedback are not separate top-level rows, which keeps a 20-attempt run readable. They are visible inside the task card and in the Run panel.

**Net new:** about six renderers, built on existing shells, `Tag`, and the task card.

## 3. Docks: plan, questions, human steps, decisions, delivery

The docks above the composer are where the user acts. Every orchestration interaction maps onto an existing dock:

- **Plan dock**: the **todo dock** with orchestration statuses. Accepted shows as a checked strikethrough item, running shows a spinner, waiting on you shows a flag, and suspended shows a clock. Progress uses the existing `AnimatedNumber`. Clicking an item opens it in the Run panel.
- **Clarifications**: the **question dock** as it is, with multi-question tabs, options, custom answers, and minimize. Each question's default assumption becomes the preselected option.
- **Human steps**: a `DockPrompt` in the permission-dock style. Instructions, then **Done**, **I can't do this…** (which opens a text field and becomes feedback), and **Skip task**. If verification checks exist, Done shows their result inline.
- **Budget exhausted**: a `DockPrompt` with the latest verdict, one line of evidence, and the actions **Grant more** (a split button: +1 revision or +1 escalation), **Accept as is**, **Replan**, **Skip**, and **Cancel run**. It also has a guidance text field, which becomes feedback on the next attempt.
- **Plan approval** (only when policy requires it): a `DockPrompt` with **Approve** and **Reject**. **Edit** expands the plan part in the timeline.
- **Delivery dock**: after a turn is delivered, "Delivered · 12 files +410 −38" with **Review changes**, which opens the Review tab at the turn scope, and the **Integrate** split button (section 5). It stays until the user integrates, discards, or dismisses it. After dismissal the header keeps a small Integrate button.
- **Follow-ups**: typing while a turn runs uses the **follow-up queue dock**. By default the message is queued as the next turn. A menu item on the queued message, "Send to planner now", sends it as guidance that may trigger a replan. This mirrors V2's steer and queue vocabulary.

**Net new:** status mappings for the todo dock and three `DockPrompt` variants.

## 4. Side panel: one new tab, two reused

The session side panel already has Review, Context, and file tabs. For run sessions:

- **Run** (new, first tab): the inspector.
  - Top: the task list grouped by state, with dependencies shown as indentation under their first unaccepted predecessor. There is no graph canvas.
  - Selecting a task expands an **attempt ledger** built from `Accordion` rows. Each attempt shows:
    - route and tier, plus "why this route" (selected candidate and rejected alternatives with reasons)
    - checks with baseline relationships
    - judge arm and verdict per criterion with confidence, highlighted when it is close to the threshold
    - feedback sent
    - reassignment decision and chooser (rule or decider)
    - time, tokens, and quota
  - Each attempt has **Open session**, **View diff** (the Review tab scoped to that attempt), and override actions: **Accept this attempt** on returned work, **Reopen with feedback** on accepted work.
  - Overrides are always available but visually secondary, because the default path doesn't need them.
- **Review** (reused): the existing v2 review panel, `@pierre/diffs`, and file list. The diff scope `SelectV2` gains options for run sessions: **This turn**, **Whole run**, and **Task ▸ / Attempt ▸**. **Line comments** already feed the prompt, so commenting on the delivery diff and sending it becomes a follow-up turn. This is the natural "fix these things" loop with no new UI.
- **Usage** (the reused Context tab, retitled for runs): the existing stats and breakdown-bar layout, showing tokens, quota, time, and estimated cost by role (planner, executors by tier, judge, and so on), plus attempts per accepted task.

The terminal panel is unchanged. A "Open terminal in attempt worktree" action is cheap to add later.

## 5. Integration: split button, preflight dialog, toasts

- The **Integrate** control is the v2 `SplitButton`. Its primary action is the policy's default action, for example **Create PR**. The menu lists Apply to working tree, Commit…, Merge into…, Push…, Create PR…, and Discard run.
- Each action opens a `DialogV2` **preflight**:
  - fields: branch name, target branch (`SelectV2` over local branches and worktrees), remote, strategy (`SegmentedControlV2`: squash, per task, merge), and draft PR (`SwitchV2`)
  - the editable commit message drafted by the summarizer, prefilled
  - warnings: dirty target, target moved since base, conflicts, protected-branch push confirmation
  - a collapsible **"Commands to run"** block showing the exact `git` and `gh` commands
- Progress and results use toasts: "Merged into main · pushed · PR #412", with an open-PR action. Partial failures use a persistent toast with **Retry remaining steps**.
- Integration history appears as timeline rows ("Integrated · PR #412"), so the thread records what happened.
- On a conflict, the dialog offers **Resolve with an agent**, which starts a resolution turn, and **Open PR instead**.

The same actions are registered in the command palette ("Integrate run…").

**Net new:** one dialog. Everything else is existing primitives.

## 6. Attention across runs

This fixes a v2 gap that also affects normal sessions:

- **Port the legacy permission and question alerts to the v2 layout**: the persistent toast with "Go to session", the system notification, and the sound, governed by the existing `settings.notifications.*`. Orchestration human requests use the same path.
- The tab avatar's `unread` state already includes pending requests in the session tree, so run tabs and Home rows show the dot for free once requests use that stream.
- **Home "Needs you" group**: a group pinned above Today in the existing time-grouped session list. It contains sessions with open requests, each row showing the request text. This is the cross-run inbox, with no separate inbox screen.
- Run rows on Home and in the tab hover preview add a small `Tag`: "Run · 3/6 · waiting on you" or "Delivered · not integrated".
- Optional later: a desktop dock badge count of open requests.

## 7. Capacity: the status popover

The capacity strip moves into the existing **`StatusPopoverV2`** as a **Capacity** tab next to servers, MCP, LSP, and plugins:

- a meter per UsagePool meter
- the host memory and load observation
- stale and unknown states, and reset times

The popover's titlebar indicator adds a warning state when a policy's frontier candidates are all ineligible or when observations are stale. A suspended run's timeline row links to this tab ("Waiting for Claude weekly reset · Tue 09:00").

## 8. Settings: an Orchestration group in settings v2

Add a group to the existing `DialogSettingsV2` vertical tabs, built with its list and row helpers:

- **Policies**: a row per policy showing role profiles, escalation chain, budgets, and acceptance settings. Controls: set default and duplicate. Frequently tuned values get inline controls: **min confidence** as a number or slider, max revisions, max escalations, and plan approval. Everything else is behind "Open in config".
- **Judges**: Jev connection status (whether the key is present, a test call, and latency), the LLM judge profile, experiment arms and assignment, and label sample rate.
- **Check presets**: name, command, and working directory rows, plus a Run once button to validate each preset.

Min confidence is the main tuning knob, so the run's policy chip also shows it, and a run can override it at submission.

## 9. Lab: the one new page

Judge and policy comparison, plus blind labeling, have no existing home. Mission Control becomes **Lab**, rebuilt on v2 components, reachable from Home's left column (below the project list) and the command palette. It has three `TabsV2`:

- **Judges**: per arm, validity, fallbacks, latency p50 and p95, cost, agreement matrix from paired runs, override rate, downstream failures, and a list of disagreements that link to attempts. Filters cover project, role, and time window.
- **Policies**: per policy, delivery rate, attempts and reassignments per accepted task, time to delivery, cost, and human requests per delivery. Rows link to example runs.
- **Labels**: the blind labeling queue. Each item reuses the review panel (the diff plus a check summary, with no judge output) and has two buttons, **Looks ready** and **Needs attention**, with an optional note and a keyboard-first flow. Sampled items also appear as non-blocking entries in Home's Needs you group.

Tables are rows from the settings list helpers plus `Tag`, not a new data-grid component. Charts can wait until the numbers stabilize.

Mission Control's manual run and task editor moves into Lab as a developer tool, **New manual run**, for hand-written plans during testing. The standalone `/mission-control` page is removed, which also removes its hardcoded English copy.

## Phase 4 execution trust

The Orchestration settings group gains a per-project **Execution trust** row: trusted host or untrusted isolated worker. The latter stays unavailable until the [worker boundary](./sandbox.md) can run model tools and checks, and rejects any harness that cannot use that boundary. Its status and reason appear beside the row and in the Capacity tab. If a project is configured as untrusted while the worker is unavailable, the composer explains why submission is blocked. Check preset rows show whether the check runs on the host or in the Colima worker; the opt-in Colima check path alone does not make an entire run safe for an untrusted repository.

## Net-new UI inventory

| Item | Size |
| --- | --- |
| Orchestrate agent entry, plus policy and judge option sources in composer selects | S |
| Six timeline renderers (clarify, plan, task, replan, request, delivery review) | M |
| Todo-dock status mapping and three `DockPrompt` variants | S |
| Run side-panel tab (task list and attempt ledger) | M |
| Review scope options and Usage tab adaptation | S |
| Integration split button and preflight dialog | M |
| v2 request alerts port, Home "Needs you" group, run tags | S |
| Capacity tab in the status popover | S |
| Orchestration settings group | M |
| Lab page (Judges, Policies, Labels, manual runs) | M–L |

Everything else is existing v2 UI.

## Build order

1. Session mapping, composer entry, timeline renderers, plan, question and human docks, attempt child sessions, delivery dock, and the integration dialog. This is enough to test the loop end to end.
2. Run tab, review scopes, Usage tab, v2 alerts, Home Needs you, and the Capacity tab. This makes long runs comfortable to supervise.
3. Settings group, then Lab. This is what's needed to tune policies and compare judges.

## Open design questions

- Harness transcript mirroring into read-only child sessions: fidelity differs by harness, so decide the minimum part set (messages, tool calls, and diff).
- Whether dependency indentation is enough, or wide plans eventually need a small graph view in the Run tab.
- The mobile layout: the side-panel tabs collapse into the existing mobile tab bar. Check that the delivery dock and Integrate button fit.
