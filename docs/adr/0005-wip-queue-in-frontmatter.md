# WIP queue state lives in the Ticket File frontmatter, ordered by queued instant

Moving a Ticket into In Progress past the Workspace's WIP limit queues it:
the Ticket File records `column: in-progress` plus `queued`, the UTC instant
the Ticket was queued. The queue order is that instant ascending, with the
KAN number breaking exact ties, so the earliest queued Ticket is stable
across DSH restarts with no extra index — `board.list` and the move handler
re-derive everything from the Ticket Files. Queued Tickets render in the In
Progress column with a Queued badge, own no Agent Session, and do not count
toward the limit. Any move of a queued Ticket out of In Progress clears the
marker; the move back to Ready is the manual dequeue. After any move that
can free a slot, the host re-reads the Board and spawns the earliest queued
Ticket, one spawn per free slot.

We rejected a `queuePos` ordinal in frontmatter (every reorder renumbers
files the user may be editing concurrently), a `storageDomain` queue table
(a second source of truth for Ticket state, against ADR-0004), and ordering
by file mtime (any edit would reorder the queue). The recorded instant also
gives the queue a reviewable git history.

The queue is strictly FIFO: a move joins the back of the queue whenever any
queued Ticket waits, even if a slot is momentarily free, and the pump then
spawns the queue head. Spawning reuses `kanbanStartTicketExecution`, which
clears the `queued` marker on success and rolls the Ticket back to its
queued text on failure — a failed auto-spawn leaves the Ticket queued for
the next move. Moves serialize behind one host-side tail, and the pump runs
inside that tail. The queue gates only the Ready → In Progress move, the
only move that spawns execution (ADR-0001); other moves into In Progress
keep their existing behavior and count toward the limit. The pump is a
host-side helper any future writer can call: the issue #6 watch loop's
automatic In Review transitions must invoke it, or over-limit auto-
transitions would free slots without auto-starting queued Tickets.

A pump at plugin start was considered and deferred: queue state is read back
from files on restart, and the first move that frees a slot heals any drift.
Spawning Agent Sessions as a side effect of plugin load is not a side effect
the Board should own.
