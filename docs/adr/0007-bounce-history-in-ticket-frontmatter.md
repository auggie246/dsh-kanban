# Bounce History stays in Ticket frontmatter, separate from the description

Bounce History belongs to the Ticket File, not the derived execution linkage.
We store it in `bounces`, a JSON array encoded as one quoted YAML-lite scalar.
Each entry contains `at` (a UTC ISO timestamp) and `comment` (the exact submitted text).
This preserves multiline comments within the existing single-line frontmatter format.
Absent or empty `bounces` means no history; malformed history prevents a Bounce.

We rejected a Markdown history section because description edits could replace it with an older copy.
A separate history file or storage table would split authoritative Ticket state across stores, contrary to ADR-0004.
The format needs a migration if changed, so this decision records the less obvious scalar encoding.

`ticket.bounce` requires an In Review Ticket with a live, idle Agent Session and complete execution fields.
It writes the column and history atomically, then sends the exact comment through `agent.steer` as a user message.
An idle session starts a new turn; an already running or missing session returns an error without a Bounce.
A rejected steer restores the prior Ticket File; rollback failure is reported explicitly.
The file write and session inbox write are not a distributed transaction.
A process crash between them can leave an undelivered Bounce; automatic replay is not provided.

Bounce, Ticket edits, and moves share the Host move tail to prevent overlapping Board writes.
Agent edits made outside the Board do not share that tail.
The Watch Loop rechecks the Ticket and turn generation inside the tail before moving it to In Review.
Starting a new turn invalidates older completion decisions and Attention Badges.

Bounce reuses the same session, branch, and Worktree without changing the Spawn Sha.
The existing Watch Loop still checks commits against that Spawn Sha, as ADR-0006 defines.
Bounce does not queue an existing session, even at the WIP limit, consistent with ADR-0005.
Its resumed work counts toward the limit and delays new queued Tickets.
