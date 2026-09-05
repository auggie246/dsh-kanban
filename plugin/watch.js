// Board session-watch model — pure functions over one observed session signal.
//
// This file is the tested seam for issue #6's watch loop. Dynamic Host
// Packages concatenate it before plugin/host.js, so declarations stay plain
// JavaScript and top-level. The Host wiring (plugin/host.js) subscribes to
// the real DSH events and forwards each one here as a signal request; this
// module owns the decision, the Host adapter owns every side effect.
//
// Vocabulary follows CONTEXT.md: an Attention Badge marks a session that
// awaits approval, errored, or finished; a session idling after a completed
// turn with commits on its kanban branch moves its Ticket to In Review.

// kanbanHandleSessionSignal(request, adapter) →
//   { attention, moved } — `attention` is the next Attention Badge state for
//   the session ('approval' | 'error' | 'finished', null clears, undefined
//   leaves it unchanged); `moved` reports an automatic In Review transition.
//
// request — one observed session signal:
//   { signal: 'status', sessionId, status: 'idle' | 'running', reasonKind }
//   { signal: 'turn-end', sessionId, reason }
//   { signal: 'approval-asked', sessionId }
//   { signal: 'approval-decided', sessionId }
//   { signal: 'agent-error', sessionId }
//
// adapter (bound by the Host; faked by tests):
//   linkageFor(sessionId) → linkage | undefined
//   linkedTicketColumn(linkage) → column string
//   branchHasCommits(linkage) → boolean
//   moveTicketToInReview(linkage) → writes column: in-review
async function kanbanHandleSessionSignal(request, adapter) {
  const sessionId = String((request && request.sessionId) || '')
  const signal = request && request.signal
  const attention = kanbanAttentionForSignal(request)
  let moved = false
  if (signal === 'status' && request.status === 'idle' && request.reasonKind === 'completed') {
    const linkage = await adapter.linkageFor(sessionId)
    if (linkage !== undefined && (await adapter.linkedTicketColumn(linkage)) === 'in-progress') {
      if (await adapter.branchHasCommits(linkage)) {
        await adapter.moveTicketToInReview(linkage)
        moved = true
      }
    }
  }
  return { attention, moved }
}

function kanbanAttentionForSignal(request) {
  if (request === null || typeof request !== 'object') return undefined
  if (request.signal === 'status') {
    if (request.status !== 'idle') return null
    if (request.reasonKind === 'completed') return 'finished'
    if (request.reasonKind === 'error' || request.reasonKind === 'interrupted') return 'error'
    return null
  }
  if (request.signal === 'turn-end') {
    const kind = request.reason && request.reason.kind
    if (kind === 'completed') return 'finished'
    if (kind === 'error' || kind === 'interrupted') return 'error'
    return null
  }
  if (request.signal === 'approval-asked') return 'approval'
  if (request.signal === 'approval-decided') return null
  if (request.signal === 'agent-error') return 'error'
  return undefined
}

// kanbanBranchHasCommits(linkage, runGit) → whether the Ticket's kanban
// branch has advanced past the sha it was spawned from. The spawn sha
// (`baseSha`, recorded at execution start) is the source of truth: a remote
// default branch can move and a `base: head` branch starts from local
// commits, so anything derived from a live ref would lie. A deleted branch
// or a missing spawn sha fails closed (no commits).
async function kanbanBranchHasCommits(linkage, runGit) {
  if (linkage === null || typeof linkage !== 'object') return false
  const branch = String(linkage.branch || '')
  const baseSha = String(linkage.baseSha || '')
  if (branch === '' || baseSha === '') return false
  try {
    const head = String(await runGit(['rev-parse', '--verify', 'refs/heads/' + branch])).trim()
    return head !== '' && head !== baseSha
  } catch {
    return false
  }
}

// kanbanWatchSummary(linkages, attentionFor) → { count, tickets } — the
// aggregate behind the sidebar Kanban button: every linked Ticket whose
// session currently carries an Attention Badge, sorted by Ticket id for a
// stable list. `attentionFor(sessionId)` returns the live badge state.
function kanbanWatchSummary(linkages, attentionFor) {
  const tickets = []
  for (const linkage of Array.isArray(linkages) ? linkages : []) {
    if (linkage === null || typeof linkage !== 'object') continue
    const attention = attentionFor(String(linkage.sessionId || ''))
    if (attention !== 'approval' && attention !== 'error' && attention !== 'finished') continue
    tickets.push({
      workspaceId: String(linkage.workspaceId || ''),
      ticketId: String(linkage.ticketId || ''),
      attention,
    })
  }
  tickets.sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0))
  return { count: tickets.length, tickets }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    kanbanHandleSessionSignal,
    kanbanAttentionForSignal,
    kanbanBranchHasCommits,
    kanbanWatchSummary,
  }
}
