# ADR-0011: Refinement Sessions use the plain Workspace

## Status

Accepted

## Context

A Backlog Ticket can be a rough idea. Refinement needs an Agent Session that interviews the user and edits the Ticket File.

Ticket execution uses a Worktree and branch. Refinement must not produce code or move the Ticket to Ready.

The `grill-with-docs` skill is an external dependency. A session cannot refine safely when that skill is unavailable to the model.

## Decision

The Board exposes `ticket.refine` only for Backlog Tickets. The Host checks that `grill-with-docs` is model-invocable before spawning.

A Refinement Session uses the plain Workspace as its `cwd`. Its scoped tools allow only skill loading, reading, and editing.

A scoped guard permits `grill-with-docs` and the selected Ticket File only. Edits must replace content from the original Ticket body.

All other tool calls fail before execution. This prevents the session from changing frontmatter, including the Backlog column.

The action does not create a Worktree, branch, commit, execution linkage, or Ticket frontmatter linkage. The Host returns the Session id for immediate Client navigation.

The brief requires the Ticket to remain in Backlog. Only the user moves a refined Ticket to Ready.

If the skill is absent or not model-invocable, the Host returns an installation explanation and creates no session.

## Consequences

Refinement can edit the selected Ticket File directly and produce an ordinary Git diff for review.

The Agent Session can discuss the whole Ticket, but its tools cannot access or modify another file.

A page reload does not reconstruct a Refinement Session link from the Ticket File. Refinement does not overload execution linkage fields.
