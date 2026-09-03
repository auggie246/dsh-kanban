# Build plan: dsh-kanban

One Cordis Plugin (`kanban`), delivered as successive immutable Packages.
Each milestone is a runnable increment: the board is useful from M0 and each
subsequent Package deepens orchestration. Verified capability anchors point at
the installed DSH bundle (`@deepseek-ai/dsh-*/lib`), confirmed feasible during
design.

Vocabulary throughout follows `CONTEXT.md`; rationale lives in `docs/adr/`.

## M0 — Board skeleton (manual kanban)

**Deliverable:** a fully usable manual board. No agents.

- Host: read/write `.dsh-kanban/tickets/<id>-<slug>.md` (frontmatter parse,
  atomic write); `ctx.storageDomain` (zod) for board↔workspaceUuid mapping
  and WIP settings; `harness.handle` methods: `board.get`, `ticket.create`,
  `ticket.update`, `ticket.move`, `ticket.list`.
- Client: `sidebar.footer.action` "Kanban" button → full-screen
  `shell.overlay` board: five columns, drag-and-drop, card editor, Blocked
  badge, WIP-limit warning. `conversation.view` "Board" tab (same component,
  scoped to the session's workspace). `settings.section` page stub.
- Cut line for v1 demo: a workspace kanban that survives restarts via the
  repo files.

## M1 — Execution: session spawn + worktree

**Deliverable:** dragging a ticket to In Progress starts real agent work.

- Host: worktree layer — `git worktree add .dsh-kanban/worktrees/<slug>` on
  branch `kanban/<id>-<slug>`, base = remote default branch (per-ticket
  override: local HEAD); `.gitignore` line for the worktree dir, added once.
- Host: spawn — `ctx.agents.create({ meta: { cwd: worktreePath } })`,
  `agent.followup(brief)` where the brief is the Ticket File contents plus
  board rules (commit on branch `kanban/...`, do not touch the main checkout).
- Host: WIP queue — moves past the limit queue; on In Progress exit, the next
  queued ticket starts.
- State linkage: ticket frontmatter records `sessionId`, `worktreePath`,
  `branch`; `ctx.storageDomain` mirrors it for fast lookups.

## M2 — Watch + review loop

**Deliverable:** the board gates results.

- Host: watch via `agent/status` (idle = awaiting input/finished signal) and
  `session/event` (`turn/end` with reason); ticket auto-moves In Progress →
  In Review when its session idles with commits on its branch.
- Bounce: user's comment → `agent.steer()` to the same session; ticket back
  to In Progress, same worktree.
- Stalled: `agent/error`/crash → Attention Badge; card actions Resume
  (`ctx.agents.resume` + steer), Retry fresh (new session, same worktree),
  Send back to Ready (release worktree).
- Client: Attention Badges on cards, aggregated count on the sidebar button;
  card → session click-through.

## M3 — Completion integration

**Deliverable:** accept = integrated result.

- Remote-detected repos: brief instructs the session to push and open a PR/MR
  (`gh pr create` / `glab mr create`); board polls the remote; merged PR/MR →
  ticket Done automatically.
- Local repos: in-board diff view (branch vs base); Accept button merges the
  branch locally.
- Done → worktree cleanup (`git worktree remove`), branch deletion after
  remote merge detection.

## M4 — Refinement Session

**Deliverable:** brain-dump → grilled → Ready.

- Host: "Refine" action on Backlog cards spawns a session (workspace cwd, no
  worktree) instructed to run the `grill-with-docs` skill against the ticket
  and write the enriched fields back into the Ticket File.
- Only the user moves the ticket to Ready (human gate; ADR-0001 context).
- Declared dependency: `grill-with-docs` skill installed in the user's DSH
  (`~/.dsh/skills/`); feature degrades gracefully when absent.

## M5 — Issue sync (GitHub + GitLab)

**Deliverable:** ADR-0002 in action.

- Remote detection from git config; import open issues as Backlog/Ready
  tickets with issue links in frontmatter.
- Column moves → immediate `kanban:*` label writes; Done → close issue.
- Periodic pull: split ownership (remote text → card; board state → labels);
  remote native blockers displayed and enforced (blocked tickets cannot enter
  In Progress).

## M6 — Settings, autonomy, polish

- `settings.section` full page: per-workspace WIP limit (default 2), label
  mapping, sync interval.
- Autopilot: per-workspace opt-in; board-spawned sessions run with the
  elevated policy for that workspace; off = Attention Badge flow (M2).
- Empty states, error surfaces, board ordering polish.

## Permanence note

Dynamic Cordis Plugins are process-lifetime definitions. M0–M6 are authored
as successive Packages of one Plugin for fast iteration in the running DSH;
once the design proves itself, the same halves ship as a permanent Host
composition row (and/or preset) so the board exists across process restarts
without re-defining it per session.

## Capability anchors (verified in the installed bundle)

- Sessions: `ctx.agents.create/.resume`, `agent.followup/.steer`
  (`dsh-agent/lib/types/index.d.ts`).
- Workspaces: `ctx.workspaceRegistry` (UUID-keyed).
- Storage: `ctx.storageDomain` zod domains over the JSON backend.
- Events: `agent/status`, `agent/error`, `session/event` (`turn/end`).
- Slots: `shell.overlay`, `sidebar.footer.action`, `conversation.view`,
  `settings.section` — all additive (replaceRisk: none).
- RPC: Host `harness.handle` ↔ Client `host.call`.
