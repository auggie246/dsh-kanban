# Stalled recovery preserves work until an explicit clean Worktree release

Stalled Tickets retain their WIP slot and show an error Attention Badge with a message.
Missing sessions and idle In Progress sessions without a review result also require recovery.
This extends ADR-0006 without adding durable badge state.

Resume steers the same Agent Session, restoring its persisted identity when it is not live.
Retry fresh disposes the Board-owned session and creates a new identity in the existing Worktree and branch.
Retry retains the original Spawn Sha and gives the new session the Ticket File and instructions to preserve existing work.
The Board retains exact factory handles for disposal; it refuses to dispose unrelated live sessions.

Send back to Ready releases execution only after checking the assigned Worktree path and branch.
Dirty Worktrees, including untracked and ignored files, require manual preservation or removal first.
We reject forced Worktree removal because commit confirmation cannot protect uncommitted files.
Unmerged means commits reachable from the Ticket branch but not from the Workspace's current HEAD.
This local comparison avoids network dependence and can conservatively request confirmation before the Workspace updates its merge base.
Confirmation binds to the Ticket's session, branch, Worktree, branch head, and Workspace HEAD.
Changed heads require a new confirmation.
Branch deletion compares the confirmed head atomically, so a concurrent commit prevents deletion.
Successful cleanup removes the Worktree and branch, clears linkage, moves to Ready, and pumps the WIP queue.
Starting the released Ticket again uses a fresh session identity because its earlier session remains persisted.

Recovery actions share the Ticket move tail.
Caught cleanup failures restore the branch, clean Worktree, and Ticket File where possible.
A disposed Agent Session cannot be resurrected by rollback; the Ticket remains visibly Stalled for recovery.
Git operations, file writes, and session lifecycle changes are not crash-atomic.
A process crash or external Git changes during cleanup may require manual repair.
