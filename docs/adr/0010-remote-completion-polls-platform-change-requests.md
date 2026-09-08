# ADR-0010: Remote completion polls platform change requests

## Status

Accepted

## Context

GitHub and GitLab Workspaces cannot use the local Accept merge. Their shared branch must pass through a PR or MR.

The Board must capture that change request and finish cleanup after the platform merges it. Platform polling must not spam APIs.

## Decision

Remote detection parses each remote URL host. For an arbitrary enterprise host, authenticated CLI configuration identifies the platform.

`origin` wins when multiple supported remotes exist.

Platform commands bind to the detected repository. After capture, polling addresses the durable PR/MR URL instead of its source branch.

GitHub and GitLab Agent Session briefs require the Ticket branch to be pushed. They require `gh pr create` or `glab mr create` respectively.

The sidebar's existing Board watch poll drives remote completion. The Host queries the platform CLI only when each Ticket's backoff deadline arrives.

Backoff starts at 15 seconds, doubles after each check, and stops growing at 5 minutes.

The first discovered PR/MR URL is written to `reviewUrl` in the Ticket File. The card renders that URL.

When the platform reports merged, the Host removes the Worktree and local Ticket branch. It clears execution linkage and moves the Ticket to Done.

Cleanup uses the local branch ref only. A platform-deleted remote branch is therefore an ordinary successful case.

Dirty Worktrees fail closed. A later poll retries cleanup without repeating the remote merge.

## Consequences

Remote completion continues while the Board overlay is closed because the sidebar watch remains mounted.

Unsupported remotes receive neither local Accept nor automatic PR/MR completion.

The implementation depends on authenticated `gh` or `glab` commands in the Workspace environment.
