# Delivery and integration

A delivered turn leaves its work on the run branch `jewel/<run>`. Nothing reaches the source repository's branches, other worktrees, or remotes until the user picks an integration action. Integration is offered after every delivered turn, and the user can also defer it and keep sending follow-ups.

## The delivery

A delivered turn produces:

- the run branch head, the turn's base commit, and the combined diff since the last integration
- a summary written by the summarizer role. It covers what the assignment asked for, how each task addressed it, assumptions and human answers, check results, notable judgments and reassignments, and time, tokens, and quota spent.
- a draft commit message in the repository's convention, which the user can edit
- per-task commits on the run branch, so a per-task history is available

## Integration actions

Each action includes the steps of the actions above it:

| Action | Effect |
| --- | --- |
| `apply` | Apply the changes as uncommitted edits to a chosen worktree (default: the source checkout) |
| `commit` | Create the delivery commit on a branch: a new branch (default `jewel/<slug>`) or an existing branch where it fast-forwards |
| `merge` | Also merge that commit into a target branch (default: the repository's default branch, or any local branch) |
| `push` | Also push the target branch to a remote branch (default: `origin/<target>`) |
| `pull_request` | Commit to a delivery branch, push it, and open a pull request against a base branch with `gh`, using the summary as the body; optionally as a draft |
| `discard` | Delete the run branch, attempt branches, and worktrees |

Options:

- History: `squash` makes one commit (the default). `per_task` keeps one commit per accepted task.
- Merge strategy: `ff`, `merge`, or `squash`.
- Target: any local branch. If the branch is checked out in some worktree, the merge happens in that worktree.
- Remote and remote branch, pull request base, draft flag, and reviewers.
- Worktree cleanup after success: `keep` or `remove` (default `remove` for attempt worktrees).

A policy can set default action choices, but executing an action always requires a user action.
The `integration_default` policy field selects the primary action in the delivery dock; it opens preflight and never executes the action by itself.

## Preflight

Before running anything, the App shows a preflight:

- the exact Git and `gh` commands that will run
- the target worktree's dirty state. Uncommitted changes in the target block `apply` and `merge` until the user resolves them.
- whether the target has moved since the turn's base commit, and whether the run branch merges cleanly into it
- whether the push target is the default or a protected branch. Pushing directly to the default branch requires an explicit confirmation each time unless the policy allows it.

If the target has moved, the controller creates a delivery worktree from its current head, applies the delivery patch or preserves per-task history when a fast-forward is possible, and reruns the configured run-level checks. On a conflict the user can:

- start a resolution turn, where an agent task resolves the conflict and goes through the normal judge loop
- abort
- open a pull request instead and resolve the conflict there

For the pull-request alternative, preflight warns about the conflict and creates the delivery branch from the delivered run head. It preserves the run's commit history even if squash history was selected, because applying a squash patch to the conflicting target would fail. The pull request can then carry the conflict for resolution on the hosting service.

## Execution and recovery

Integration runs as recorded steps (commit, merge, push, pull request). Each step records the resulting commit, the refs, remote names (never URLs), and the pull request URL. A partial failure leaves the completed steps recorded. For example, if the merge succeeded but the push was rejected, the App shows the actual state and offers to retry the remaining steps. Pre-commit and pre-push hooks run normally, and their failures are reported with bounded output.

Git and `gh` use the user's existing configuration and credentials. JewelCode never stores credentials. The subprocess environment allowlist adds only what Git transport needs, such as the SSH agent socket and the `gh` configuration directory.

## Follow-up turns

A follow-up turn starts from the run branch head. If an integration merged the delivery into a target branch that has since moved, the next turn's base is the run branch, and the next integration handles the divergence through preflight. Later integrations include only the changes since the last integration.
