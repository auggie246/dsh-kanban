# The watch loop derives board transitions and attention from DSH session events

The Board must know when its spawned Agent Sessions need the user without
polling git or scraping the GUI. We subscribe on the Host to the DSH
`session/event` stream — `turn/end` (which carries a structured
`TurnEndReason`), plus the log-only `approval/asked`/`approval/decided` audit
events — and to `agent/status` transitions (`idle`/`running`, fired exactly on
phase changes). Rejected alternatives: joining the `approval/request`
waterfall (only answerers may claim a request, so an observer would either
deny approvals or have to thread `next()` through every code path forever),
forwarding raw events to the client (the forwarded-event allowlist is a
deployment decision, and approval transitions have no forwarded event), and
letting the client poll `git` (the client sandbox has no shell). Two design
points follow from the event shapes. The auto-move triggers on
`agent/status` → `idle`, not on `turn/end`, because queued input re-opens a
turn before the next idle — idle genuinely means the loop is done; the Host
glues the two streams together by remembering the last turn-end reason per
session and passing it to the pure watch seam, which stays stateless and
testable. "Has commits" compares the branch head against the `baseSha`
recorded at execution start: a remote default branch can advance, and a
`base: head` Ticket starts from local commits, so any check against a live
ref would misreport; Tickets spawned before this change carry no `baseSha`
and never auto-move (fail closed). Attention Badge state is live-only
(in-memory, keyed by session id): it is rebuilt from real events as sessions
run, while the durable facts stay in Ticket Files and the linkage table. The
client polls a small `board.watch.list` aggregate (5 s) that exists only to
light the sidebar count and refresh open Boards; no host-to-client push was
needed because the aggregate is small and the poll is cheap. The sidebar
button is one global affordance, so its count aggregates attention across
every registered Workspace's linked Tickets, not just the current one.
Reversing this later means re-plumbing every transition signal, so the
direction is recorded here.
