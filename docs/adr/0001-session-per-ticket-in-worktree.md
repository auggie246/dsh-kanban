# One Agent Session per Ticket, isolated in a per-ticket git worktree

Moving a Ticket to In Progress spawns a fresh Agent Session via
`ctx.agents.create`, whose working directory is a git worktree created for
that Ticket alone, and whose initial prompt is built from the Ticket File. We
rejected queueing tickets into a single long-lived executor session (serial,
no isolation, one stall blocks everything) and a passive board with manual
session linking (does not remove the user-as-bottleneck). Per-Ticket sessions
give true parallelism, per-ticket trajectories, and clean resume/retry
semantics; per-Ticket worktrees (branch `kanban/<id>-<slug>`, defaulting to
the remote default branch, per-ticket override to committed local HEAD,
following the Claude Code / Codex isolation model) keep parallel edits from
colliding on disk. The local HEAD override includes local commits but excludes
staged, unstaged, and untracked working-tree changes. Reversing this later means redesigning the board's whole execution
model, so the direction is recorded here.
