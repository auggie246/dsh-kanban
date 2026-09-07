# Local completion merges into the recorded Base Branch

A Workspace without a remote records the checked-out local branch as the Ticket's Base Branch when execution starts.
In Review compares the Ticket branch with that branch and uses `git merge-tree` to detect conflicts without changing either checkout.
Accept requires the Base Branch in the Workspace checkout and clean Workspace and Ticket Worktree states.
The Workspace check excludes `.dsh-kanban` and the Board-managed `.gitignore`, while Git still rejects an unsafe merge over either path.
It then fast-forwards or creates a merge commit, records the resulting Merge Sha, removes the Worktree, deletes the exact reviewed Ticket branch head, clears execution linkage, and moves the Ticket to Done.
A missing Base Branch, changed review snapshot, merge conflict, remote, dirty checkout, unexpected branch, or unsafe Worktree linkage fails closed.
A truncated diff remains acceptable when the complete Git objects have no merge conflict.

The merge and cleanup cannot form one atomic Git and Ticket File transaction.
The Board records the Merge Sha before cleanup and recognizes an already-merged Ticket branch.
A later Accept can finish interrupted cleanup without repeating the merge.
Ticket branches and Base Branches remain local refs; pushing and remote completion belong to the remote integration path.
