# CONTEXT.md

Ubiquitous language for the DSH Kanban project: a DeepSeek Harness plugin
that gives every workspace a kanban board acting as an orchestration layer
for agent sessions.

## Core concepts

### Workspace

A DSH workspace: a project directory registered in the DeepSeek Harness GUI.
The board is scoped to exactly one Workspace — there is no cross-workspace board.

### Board

The kanban board of one Workspace. A full-page view shown over the whole DSH
GUI, opened from a Kanban button at the sidebar foot (with a per-session
Board tab as a shortcut). Ticket state persists inside the Workspace
repository. Per-Workspace Board configuration persists separately in DSH.
The Board is the orchestration surface: it starts, watches, and review-gates
Agent Sessions.

### Ticket

One unit of work on the Board, shown as a card. A Ticket has a title, a
description with acceptance criteria, a column (its state), and optionally a
link to a remote Issue. "Ticket" and "card" mean the same thing; prefer
"Ticket" in writing.

### Issue

A remote issue on GitHub or GitLab, detected from the Workspace's git remote.
An Issue can be imported as a Ticket; the Ticket keeps a link to it. The
board syncs both ways with the Issue tracker. Never use "issue" to mean a
Ticket — Tickets live on the Board, Issues live on the remote.

## Ticket states (columns)

A Ticket moves through exactly these columns, in order:

### Backlog

Parking lot. No quality bar. An agent must never start from Backlog.

### Ready

Refined: the Ticket has a clear goal, acceptance criteria, and enough context
that an agent can complete it without asking the user anything. Moving a
Ticket to Ready is the user's refinement act.

### In Progress

Exactly one Agent Session owns this Ticket, working in that Ticket's
Worktree. The column carries a per-Workspace WIP limit, which defaults to 3.
The Board tab, Board overlay, and settings page use the same durable value.
Dragging past the limit queues the Ticket until a slot frees: a queued
Ticket sits In Progress with a Queued badge, owns no Agent Session, and does
not count toward the limit. The queue is earliest-first, ordered by the
instant each Ticket was queued. When a running Ticket leaves In Progress —
moving to In Review, Done, or anywhere else — the earliest queued Ticket
spawns automatically, respecting the limit. If that Ticket gained an open
native blocker while queued, it returns to Ready and the next queued Ticket
is considered. Manually dequeuing returns the Ticket to Ready with no session
spawned.

### In Review

The Agent Session has finished and produced its result (committed changes on
the Ticket's branch; a PR/MR when the Workspace has a GitHub/GitLab remote,
local commits otherwise). Nothing moves until the user accepts or bounces it.
For a Workspace without a remote, the Board shows the Ticket branch diff against its Base Branch.
Accept merges locally, records the Merge Sha, removes the Worktree and branch, then moves the Ticket to Done.
A merge conflict disables Accept and appears on the Ticket. For a GitHub or GitLab Workspace, the
Agent Session pushes its branch and opens a PR/MR. The Board records the PR/MR URL and polls its state.
A merged PR/MR moves the Ticket to Done and removes local execution resources without user action.
Bouncing returns the Ticket to In Progress with the user's comment fed back
to the same Agent Session as revision instructions. The Watch Loop moves a
Ticket here without user action: when the Ticket's Agent Session idles after
a completed turn and the Ticket's branch has commits past its spawn sha.

### Done

Accepted/merged. Terminal state. Worktree cleanup happens here.

### Blocked

Not a column — a badge on any Ticket, in any column, recording why the
Ticket cannot move and what unblocks it. Locally the reason is free-text.
When the Ticket links to an Issue with native platform blockers (GitHub
issue dependencies, GitLab blocking issues), the card displays those blockers
and the Board enforces them: a blocked Ticket cannot move to In Progress.

### Stalled

An In Progress Ticket whose Agent Session errored, crashed, or stopped
mid-work. A Stalled Ticket stays In Progress with an Attention Badge; the
card offers Resume (same session, same Worktree), Retry fresh (new session,
same Worktree), and Send back to Ready (release the Worktree).

## Execution concepts

### Agent Session

A DSH agent session spawned by the Board for one Ticket. Its working
directory is the Ticket's Worktree. One Ticket in In Progress has exactly one
Agent Session, and one Agent Session serves exactly one Ticket.

### Watch Loop

The Board's session watcher on the Host. It subscribes to the DSH
`session/event` stream (`turn/end` with its reason, plus the log-only
`approval/asked`/`approval/decided` audit events) and to `agent/status`
transitions, and drives two behaviours. Auto-move: an In Progress Ticket
whose session idles after a completed turn moves to In Review when the
Ticket's branch has commits past its Spawn Sha. Attention: the loop derives
each session's Attention Badge state (awaiting approval, errored, finished)
from the same events; badge state is live-only and never durable.

### Base Branch

The local branch from which a Ticket branch started in a Workspace without a remote.
Local completion merges the Ticket branch into this branch.

### Merge Sha

The local commit at the Base Branch head after Accept completes its merge.
The Ticket File records this commit before Worktree cleanup.

### Spawn Sha

The commit a Ticket's branch was created from, recorded in the execution
linkage when the Ticket moves to In Progress. The Watch Loop compares the
branch head against it: a different head means the branch has commits. A
missing spawn sha (Tickets started before the Watch Loop existed) fails
closed — the Ticket never auto-moves.

### Worktree

A git worktree created for one Ticket, isolating its edits from the main
checkout and from other Tickets. Branched from the remote default branch by
default ("fresh"); a Ticket may instead branch from committed local HEAD,
chosen per Ticket. Working-tree changes never enter this base. Each Ticket's
Worktree has its own branch.

### Refinement

The act of bringing a Ticket from Backlog quality to Ready quality: clear
goal, acceptance criteria, context. Until Refinement happens, the Ticket stays
Backlog and no agent may touch it. Refinement has two modes: capture a rough
Ticket by hand (brain-dump, no quality bar), then run a **Refinement Session**
— an Agent Session that runs the `grill-with-docs` skill (an external
dependency, from Matt Pocock's skills) to interview the user and pull the
missing detail out of their head. The Refine action opens that session in the
plain Workspace and creates no Worktree or execution linkage. Without a
model-invocable copy of the skill, the action explains the dependency and
spawns nothing; manual editing still works.

### Refinement Session

An Agent Session dedicated to one Backlog Ticket. It grills the user about the
Ticket and writes the enriched goal, context, and acceptance criteria back to
the Ticket. Distinct from the working Agent Session: it produces no code
changes and uses no Worktree.

### Bounce

Rejecting a Ticket in In Review. The Ticket returns to In Progress and the
user's comment is delivered to the same Agent Session as revision
instructions, in the same Worktree.

### Bounce History

The ordered record of a Ticket's review comments and their timestamps, kept in its Ticket File.
Description edits do not remove this record.

## Sync concepts

### Sync

The two-way exchange between a Ticket and its linked Issue, driven by labels
plus open/closed state. Both GitHub and GitLab are supported, detected from
the Workspace's git remote.

### Split Ownership

The sync conflict policy: the remote Issue owns title, description, and human
comments. The Board owns column/state and pushes column moves as label writes
immediately. When a Ticket reaches Done, the Board appends one completion
comment that references its merge, PR, or MR. No other Board action writes
Issue text. Conflicts are avoided by partitioning the fields each side may
write.

### Issue Projection

The Board's last successful view of a linked Issue's comments and native
blockers. A Ticket card displays this projection without treating it as
Board-owned state. An unavailable Issue leaves the last successful projection
in place.

### Sync Status

The durable delivery state for one linked Ticket. Pending means the Board has
not confirmed synchronization. Error records the last failed synchronization
attempt. Success clears the error. A Sync Status never prevents a Ticket move.

## Autonomy concepts

### Attention Badge

A live indicator on a Ticket (and aggregated on the Workspace's board button
in the sidebar) showing its Agent Session needs the user: awaiting approval,
errored, or finished. Clicking through opens the session.

### Autopilot

A per-workspace, opt-in board setting that lets board-spawned Agent Sessions
run with an elevated auto-approve policy for that Workspace only. Off by
default; when off, approvals surface through the Attention Badge instead.

### Refinement Session

An Agent Session dedicated to one Backlog Ticket. It grills the user about the
Ticket and writes the enriched goal, context, and acceptance criteria back to
the Ticket. Distinct from the working Agent Session: it produces no code
changes and uses no Worktree. Only the user may move a Ticket to Ready — an
agent never self-certifies its own work order.

### Ticket File

The on-disk form of a Ticket: one markdown file per Ticket at
`.dsh-kanban/tickets/KAN-<n>-<slug>.md`, with frontmatter for state and the
body as the description. New ids never go below `KAN-101`, which keeps them
visually distinct from Issue numbers. The slug uses lowercase alphanumerics
and dashes, with a 40-character limit and `ticket` fallback. The Board renders
by scanning the directory; Agent Sessions read and edit Ticket Files with
plain file tools.

Frontmatter keys: `id` (KAN-<n>), `title`, `column` (one of `backlog`,
`ready`, `in-progress`, `in-review`, `done` — kebab-case), `queued` (the UTC
instant the Ticket was queued past the WIP limit; empty/absent means not
queued — see ADR-0005), `blocked`
(free-text reason, shown as a Blocked badge in any column; empty/absent
means not Blocked), `issue` (Issue URL, empty when none), `reviewUrl` (the
remote PR/MR URL), `base` (`head` for the committed local HEAD override;
absent means the remote default branch),
`branch`, `worktreePath`, `sessionId` (Agent Session id), `bounces`
(Bounce History — see ADR-0007), `baseBranch` (Base Branch for local completion),
and `mergeSha` (Merge Sha after local Accept). Values are
scalars on one line; multi-line YAML is not used. Scalars containing `:`, `#`, quotes or
backslashes are double-quoted with `\"` and `\\` escapes. The
`<id>-<slug>` file name is fixed at creation: editing the title does not
rename the file. The parser and serializer live in `plugin/frontmatter.js`
and are the tested seam for the format.

## Execution concepts

See `docs/adr/` for design decisions as they are made.
