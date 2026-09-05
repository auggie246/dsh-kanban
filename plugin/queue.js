// WIP queue model — pure functions.
//
// This file is the tested seam for issue #5's queue decisions. Dynamic Host
// Packages concatenate it before plugin/host.js, so declarations stay plain
// JavaScript and top-level. Every function reads and returns parsed card
// data (parseTicketFile output) — no file or storage access here.
//
// Vocabulary follows CONTEXT.md: a Ticket dragged into In Progress past the
// Workspace's WIP limit is queued — it sits In Progress with a `queued`
// frontmatter value (the UTC instant it was queued), owns no Agent Session,
// and does not count toward the limit. When a running Ticket leaves In
// Progress, the earliest queued Ticket spawns.

// kanbanQueuedInstant(value) → epoch millis of a `queued` frontmatter value
// (a UTC ISO instant written by the Board), or null when absent or not a
// valid instant. One meaning, one form: the Board writes ISO only.
function kanbanQueuedInstant(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return null
  const millis = Date.parse(text)
  return Number.isNaN(millis) ? null : millis
}

// kanbanIsQueued(card) → true only for a Ticket sitting In Progress with a
// recorded queued instant. A `queued` value on a card in any other column is
// stale hand-editing and reads as not queued.
function kanbanIsQueued(card) {
  return card.column === 'in-progress' && kanbanQueuedInstant(card.queued) !== null
}

// kanbanRunningTickets(tickets) → the In Progress Tickets that own an Agent
// Session slot. Queued Tickets wait and never count toward the limit.
function kanbanRunningTickets(tickets) {
  return (tickets || []).filter((ticket) => ticket.column === 'in-progress' && !kanbanIsQueued(ticket))
}

function kanbanTicketNumber(ticket) {
  const m = /^kan-(\d+)$/i.exec(String((ticket && ticket.id) || '').trim())
  return m === null ? Number.MAX_SAFE_INTEGER : parseInt(m[1], 10)
}

// kanbanQueuedTickets(tickets) → queued Tickets, earliest queued first. The
// recorded instant orders the queue; the KAN number breaks exact ties. This
// order survives DSH restarts because it is read back from Ticket Files.
function kanbanQueuedTickets(tickets) {
  return (tickets || [])
    .filter(kanbanIsQueued)
    .sort((a, b) => {
      const byInstant = kanbanQueuedInstant(a.queued) - kanbanQueuedInstant(b.queued)
      if (byInstant !== 0) return byInstant
      return kanbanTicketNumber(a) - kanbanTicketNumber(b)
    })
}

// kanbanQueueAdmission({ tickets, wipLimit }) → the decision for a Ready →
// In Progress move: { action: 'queue' } when running Tickets already reach
// the limit, or when queued Tickets already wait (the move joins the back of
// the queue instead of jumping it), { action: 'spawn' } when a slot is free
// and the queue is empty. The caller has already established the move
// targets an unstarted Ready Ticket.
function kanbanQueueAdmission({ tickets, wipLimit }) {
  const limit = typeof wipLimit === 'number' && wipLimit > 0 ? wipLimit : 1
  const running = kanbanRunningTickets(tickets).length
  const waiting = kanbanQueuedTickets(tickets).length
  return running >= limit || waiting > 0 ? { action: 'queue' } : { action: 'spawn' }
}

// kanbanQueuePlan({ tickets, wipLimit }) → the queued Ticket to auto-spawn
// now, or undefined when the queue is empty or the limit is still reached.
// The Board calls this after any move that can free a slot.
function kanbanQueuePlan({ tickets, wipLimit }) {
  const limit = typeof wipLimit === 'number' && wipLimit > 0 ? wipLimit : 1
  if (kanbanRunningTickets(tickets).length >= limit) return undefined
  return kanbanQueuedTickets(tickets)[0]
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    kanbanQueuedInstant,
    kanbanIsQueued,
    kanbanQueuedTickets,
    kanbanRunningTickets,
    kanbanQueueAdmission,
    kanbanQueuePlan,
  }
}
