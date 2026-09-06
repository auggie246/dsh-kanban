// ticket.bounce orchestration. Concatenate after frontmatter.js and before
// host.js. Ticket Files own the history; execution linkage is unchanged.
async function kanbanBounceTicket(request, adapter) {
  const comment = request.comment
  if (typeof comment !== 'string' || comment.trim() === '') throw new Error('comment required')
  const card = parseTicketFile(request.file, request.ticketText)
  if (card === null) throw new Error('not-a-ticket-file')
  if (card.column !== 'in-review') throw new Error('ticket-not-in-review')
  if (card.sessionId === '' || card.branch === '' || card.worktreePath === '') {
    throw new Error('ticket-not-started')
  }
  const agent = adapter.liveAgent(card.sessionId)
  if (agent === undefined) throw new Error('session-not-live')
  if (agent.status !== 'idle') throw new Error('session-not-idle')

  // JSON is encoded inside one YAML-lite scalar. Escaped newlines preserve
  // multiline comments without changing the Ticket description or its editor.
  const raw = kanbanParseFrontmatter(request.ticketText).attrs.bounces
  let history = []
  if (raw !== undefined && raw !== '') {
    try { history = JSON.parse(raw) } catch { throw new Error('invalid-bounce-history') }
    if (!Array.isArray(history) || history.some((entry) =>
      entry === null || typeof entry !== 'object' ||
      typeof entry.comment !== 'string' || typeof entry.at !== 'string')) {
      throw new Error('invalid-bounce-history')
    }
  }
  history.push({ at: request.at, comment })
  let text = kanbanSetAttr(request.ticketText, 'column', 'in-progress')
  text = kanbanSetAttr(text, 'queued', null)
  text = kanbanSetAttr(text, 'bounces', JSON.stringify(history))
  await adapter.persistTicket(text)
  try {
    if (adapter.liveAgent(card.sessionId) !== agent || agent.status !== 'idle') {
      throw new Error('session-no-longer-idle')
    }
    adapter.steer(agent, comment)
  } catch (error) {
    try { await adapter.persistTicket(request.ticketText) } catch (rollbackError) {
      throw new Error(String(error.message || error) + '; rollback failed: ' + String(rollbackError.message || rollbackError))
    }
    throw error
  }
  return { file: request.file, column: 'in-progress', sessionId: card.sessionId }
}
