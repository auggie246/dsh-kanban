# ADR-0013: A non-Git Workspace is an ordinary Board state

## Status

Accepted

## Context

DSH registers a Workspace for any project directory. That directory need not
be a Git repository.

Outside a Git repository, `git remote` exits with code 128 and prints a fatal
line. The completion path allowed only exit code 0 for that call, so the failure
escaped as a thrown error.

The sidebar watch covers every registered Workspace and polls every few
seconds. The catch block logged the raw fatal line on every poll, so one
non-Git Workspace flooded the terminal forever.

The Issue import path already tolerated exit code 128 for its own remote
listing. The completion path did not.

## Decision

Remote detection owns the tolerance. `kanbanDetectRemote` allows exit code 128
for the remote listing and returns `repository: false`. Every other exit code
still throws.

Detection failures and the non-Git state are logged once per Workspace. The
record clears when that Workspace next detects a Git repository, so a real
recovery then re-failure logs again.

`board.list` returns `repository`. The Board shows a warn-colored notice for a
non-Git Workspace: Ticket execution and remote PR/MR completion need Git. The
notice never blocks reading the Board, and a non-Git Workspace still shows its
Ticket Files.

The Issue import path drops its own exit-code-128 special case, because the
shared detection seam now carries it.

## Consequences

The terminal gets at most one line per Workspace per problem, not one per poll.

The Board explains why a Ticket cannot start, instead of failing when the user
starts it.

Remote completion and Issue sync stay off for a non-Git Workspace. No Git
repository is created and no Worktree is made.

`kanbanDetectRemote` returns a fifth field. Every caller must accept it.

A Workspace that stays non-Git still costs one `git remote` command per
`board.list` call, which the Board already pays for its Ticket scan.
