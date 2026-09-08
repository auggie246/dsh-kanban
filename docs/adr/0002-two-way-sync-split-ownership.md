# Two-way issue sync via labels, with split ownership of fields

Linked Issues (GitHub or GitLab, detected from the workspace's git remote)
sync both ways with their Tickets. Board state maps to `kanban:*` labels plus
open/closed (closed = Done) rather than native platform boards, because one
mapping code path covers both platforms on any existing repo without
project-board setup. Conflicts are avoided by split ownership: the remote
Issue owns title, description, and human comments; the Board owns column/state,
pushes moves as immediate label writes, and appends the required completion
comment when a Ticket reaches Done. We considered last-write-wins
(all-fields races, silent overwrites) and manual conflict resolution (UI cost,
user interruptions) and rejected both; split ownership makes the common
conflict structurally impossible. We also chose full two-way sync over
import-only at the user's request, accepting the label-write machinery.
