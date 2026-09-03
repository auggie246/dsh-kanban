# One markdown Ticket File per Ticket, frontmatter state, inside the repo

Board state persists inside the Workspace repository as
`.dsh-kanban/tickets/<id>-<slug>.md`: YAML frontmatter holds state (column,
Issue link, branch, Worktree path) and the markdown body is the Ticket
description. We rejected a single `board.json` (whole-board diffs, JSON merge
conflicts, agents need plugin plumbing to read cards) and a hybrid markdown +
JSON index (two sources of truth for state). Per-Ticket files mean Agent
Sessions read and edit their own Ticket with plain file tools, git history is
reviewable per ticket, and the Ticket File doubles as the session's initial
brief. A known trade-off: column order and scan performance are derived from
directory order plus frontmatter rather than an optimized index; acceptable at
board scale, and an index can be added later without changing the format.
