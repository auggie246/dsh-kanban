# Ticket state is the Issue sync outbox

A linked Ticket's durable Board state remains in its Ticket File. The sync
loop reads that state and repeatedly writes it to the Issue. No second desired
state is stored, because two Board-state records could diverge after a crash.
This makes a local Ticket move successful even when the Issue is unavailable;
the next sync attempt reads the same durable column and repairs the remote.

Remote-owned comments and native blockers do not enter the Ticket File. The
Board stores them as an Issue Projection and joins that projection onto the
Ticket card. This keeps remote caches out of Workspace history while preserving
the last successful view during an outage. Sync Status lives beside the Issue
Projection, so failures survive Host restarts without becoming Board-blocking
errors.

We considered rolling back Ticket moves after remote failures, but rejected it
because Issue #13 requires failures not to block the Board. We also considered
putting comments, blockers, and errors in frontmatter, but rejected it because
those remote caches would create noisy Workspace diffs and false merge
conflicts.
