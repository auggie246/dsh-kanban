// WIP queue model tests — pure functions over parsed card data.
//
// The seam is the Board Ticket move interface (`ticket.move`): these are the
// decisions that interface consults. Card literals mirror parseTicketFile
// output, the same shape `board.list` and the move handler see.

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  kanbanQueuedInstant,
  kanbanIsQueued,
  kanbanQueuedTickets,
  kanbanRunningTickets,
  kanbanQueueAdmission,
  kanbanQueuePlan,
} = require('./queue.js')

// Card literal with the exact fields parseTicketFile returns; tests override
// only what matters for the queue.
const card = (overrides) => ({
  id: 'KAN-101',
  title: 'Ticket',
  column: 'ready',
  blocked: '',
  issue: '',
  base: 'remote',
  branch: '',
  worktreePath: '',
  sessionId: '',
  queued: '',
  body: '',
  preview: '',
  ...overrides,
})

test('kanbanQueuedInstant reads a recorded UTC instant and rejects everything else', () => {
  assert.equal(kanbanQueuedInstant('2026-07-14T09:30:00.000Z'), Date.parse('2026-07-14T09:30:00.000Z'))
  assert.equal(kanbanQueuedInstant(''), null)
  assert.equal(kanbanQueuedInstant(undefined), null)
  assert.equal(kanbanQueuedInstant('not-a-time'), null)
})

test('a Ticket is queued only when it sits In Progress with a recorded instant', () => {
  assert.equal(kanbanIsQueued(card({ column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' })), true)
  assert.equal(kanbanIsQueued(card({ column: 'in-progress' })), false)
  assert.equal(kanbanIsQueued(card({ column: 'ready', queued: '2026-07-14T09:30:00.000Z' })), false)
})

test('queued Tickets do not count toward the WIP limit', () => {
  const tickets = [
    card({ id: 'KAN-101', column: 'in-progress' }),
    card({ id: 'KAN-102', column: 'in-progress', queued: '2026-07-14T09:31:00.000Z' }),
    card({ id: 'KAN-103', column: 'in-progress', queued: '2026-07-14T09:32:00.000Z' }),
    card({ id: 'KAN-104', column: 'ready' }),
  ]
  const running = kanbanRunningTickets(tickets)
  assert.deepEqual(running.map((t) => t.id), ['KAN-101'])
})

test('queued Tickets come back earliest-first, KAN number breaking ties', () => {
  const tickets = [
    card({ id: 'KAN-104', column: 'in-progress', queued: '2026-07-14T09:32:00.000Z' }),
    card({ id: 'KAN-102', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' }),
    card({ id: 'KAN-103', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' }),
    card({ id: 'KAN-105', column: 'in-progress' }),
  ]
  const queued = kanbanQueuedTickets(tickets)
  assert.deepEqual(queued.map((t) => t.id), ['KAN-102', 'KAN-103', 'KAN-104'])
})

test('a move into In Progress queues when running Tickets reach the limit', () => {
  const tickets = [
    card({ id: 'KAN-101', column: 'in-progress' }),
    card({ id: 'KAN-102', column: 'in-progress' }),
    card({ id: 'KAN-103', column: 'ready' }),
  ]
  assert.deepEqual(kanbanQueueAdmission({ tickets, wipLimit: 2 }), { action: 'queue' })
})

test('a move into In Progress spawns when a slot is free', () => {
  const tickets = [
    card({ id: 'KAN-101', column: 'in-progress' }),
    card({ id: 'KAN-103', column: 'ready' }),
  ]
  assert.deepEqual(kanbanQueueAdmission({ tickets, wipLimit: 2 }), { action: 'spawn' })
})

test('a move queues behind existing queued Tickets even when a slot is free', () => {
  const tickets = [
    card({ id: 'KAN-101', column: 'in-progress' }),
    card({ id: 'KAN-102', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' }),
    card({ id: 'KAN-103', column: 'ready' }),
  ]
  assert.deepEqual(kanbanQueueAdmission({ tickets, wipLimit: 2 }), { action: 'queue' })
})

test('the queue plan proposes the earliest queued Ticket only when a slot is free', () => {
  const full = [
    card({ id: 'KAN-101', column: 'in-progress' }),
    card({ id: 'KAN-102', column: 'in-progress' }),
    card({ id: 'KAN-103', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' }),
    card({ id: 'KAN-104', column: 'in-progress', queued: '2026-07-14T09:31:00.000Z' }),
  ]
  assert.equal(kanbanQueuePlan({ tickets: full, wipLimit: 2 }), undefined)

  const freed = full.filter((t) => t.id !== 'KAN-102')
  const plan = kanbanQueuePlan({ tickets: freed, wipLimit: 2 })
  assert.equal(plan.id, 'KAN-103')
})

test('the queue plan is undefined when the queue is empty', () => {
  const tickets = [card({ id: 'KAN-101', column: 'in-progress' }), card({ id: 'KAN-104', column: 'ready' })]
  assert.equal(kanbanQueuePlan({ tickets, wipLimit: 3 }), undefined)
})
