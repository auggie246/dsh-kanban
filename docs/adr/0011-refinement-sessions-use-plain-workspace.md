# ADR-0011: Refinement Sessions use the plain Workspace

## Status

Accepted

## Context

A Backlog Ticket can be a rough idea. Refinement needs an Agent Session that interviews the user and edits the Ticket File.

Ticket execution uses a Worktree and branch. Refinement must not produce code or move the Ticket to Ready.

The `grill-with-docs` skill is an external dependency. A session cannot refine safely when that skill is unavailable to the model.

## Decision

The Board exposes `ticket.refine` only for Backlog Tickets. The Host checks that `grill-with-docs` is model-invocable before spawning.

A Refinement Session uses the plain Workspace as its `cwd`. It receives a brief that permits changes only to the selected Ticket File.

The action does not create a Worktree, branch, commit, execution linkage, or Ticket frontmatter linkage. The Host returns the Session id for immediate Client navigation.

The brief requires the Ticket to remain in Backlog. Only the user moves a refined Ticket to Ready.

If the skill is absent or not model-invocable, the Host returns an installation explanation and creates no session.

## Consequences

Refinement can edit the selected Ticket File directly and produce an ordinary Git diff for review.

The Board cannot technically isolate a Workspace-level session to one file. The brief carries that restriction until a narrower sandbox capability exists.

A page reload does not reconstruct a Refinement Session link from the Ticket File. Refinement does not overload execution linkage fields.
