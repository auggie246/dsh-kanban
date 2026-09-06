const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { kanbanHandleSessionSignal, kanbanBranchHasCommits, kanbanWatchSummary } = require('./watch.js')

// The Board session-watch seam: one observed session signal in, one decision
// out. The adapter carries every Host capability (linkage lookup, Ticket File
// state, git, writes); tests bind fakes at the same seam.

function makeLinkage(overrides) {
  return {
    workspaceId: 'workspace-alpha',
    ticketId: 'KAN-101',
    sessionId: 'kanban-workspace-alpha-kan-101',
    worktreePath: '/tmp/wt/fix-login',
    branch: 'kanban/KAN-101-fix-login',
    baseSha: 'a1b2c3d',
    ...overrides,
  }
}

test('an idle session whose turn completed with commits moves its In Progress ticket to In Review', async () => {
  const linkage = makeLinkage()
  const moved = []
  const adapter = {
    async linkageFor(sessionId) {
      assert.equal(sessionId, linkage.sessionId)
      return linkage
    },
    async linkedTicketColumn(linked) {
      assert.equal(linked.ticketId, linkage.ticketId)
      return 'in-progress'
    },
    async branchHasCommits(linked) {
      assert.equal(linked.branch, linkage.branch)
      return true
    },
    async moveTicketToInReview(linked) {
      moved.push(linked.ticketId)
    },
  }

  const result = await kanbanHandleSessionSignal(
    { signal: 'status', sessionId: linkage.sessionId, status: 'idle', reasonKind: 'completed' },
    adapter,
  )

  assert.deepEqual(result, { attention: 'finished', moved: true })
  assert.deepEqual(moved, ['KAN-101'])
})

test('a superseded completion reports no move when the serialized transition declines it', async () => {
  const result = await kanbanHandleSessionSignal(
    { signal: 'status', sessionId: 'session-review', status: 'idle', reasonKind: 'completed' },
    {
      linkageFor: async () => makeLinkage(),
      linkedTicketColumn: async () => 'in-progress',
      branchHasCommits: async () => true,
      moveTicketToInReview: async () => false,
    },
  )
  assert.equal(result.moved, false)
})

test('a ticket with no commits on its kanban branch does not transition', async () => {
  const linkage = makeLinkage()
  const moves = []
  const adapter = {
    async linkageFor() {
      return linkage
    },
    async linkedTicketColumn() {
      return 'in-progress'
    },
    async branchHasCommits() {
      return false
    },
    async moveTicketToInReview(linked) {
      moves.push(linked.ticketId)
    },
  }

  const result = await kanbanHandleSessionSignal(
    { signal: 'status', sessionId: linkage.sessionId, status: 'idle', reasonKind: 'completed' },
    adapter,
  )

  assert.deepEqual(result, { attention: 'finished', moved: false })
  assert.deepEqual(moves, [])
})

test('an idle session without a linked ticket is a no-op', async () => {
  const adapter = {
    async linkageFor() {
      return undefined
    },
    async linkedTicketColumn() {
      throw new Error('must not read a ticket without linkage')
    },
    async branchHasCommits() {
      throw new Error('must not check commits without linkage')
    },
    async moveTicketToInReview() {
      throw new Error('must not move without linkage')
    },
  }

  const result = await kanbanHandleSessionSignal(
    { signal: 'status', sessionId: 'unlinked-session', status: 'idle', reasonKind: 'completed' },
    adapter,
  )

  assert.deepEqual(result, { attention: 'finished', moved: false })
})

test('a linked ticket outside In Progress never transitions', async () => {
  for (const column of ['in-review', 'done', 'ready', 'backlog']) {
    const linkage = makeLinkage()
    const adapter = {
      async linkageFor() {
        return linkage
      },
      async linkedTicketColumn() {
        return column
      },
      async branchHasCommits() {
        throw new Error('must not check commits outside In Progress')
      },
      async moveTicketToInReview() {
        throw new Error('must not move outside In Progress')
      },
    }

    const result = await kanbanHandleSessionSignal(
      { signal: 'status', sessionId: linkage.sessionId, status: 'idle', reasonKind: 'completed' },
      adapter,
    )

    assert.deepEqual(result, { attention: 'finished', moved: false }, column)
  }
})

test('attention derives from approval, error, and finished signals', async () => {
  const { kanbanAttentionForSignal } = require('./watch.js')
  const sessionId = 'kanban-workspace-alpha-kan-101'

  // turn/end reasons: error and interrupted are attention-worthy; completed
  // means finished; a user abort or a mid-turn ceiling is neither.
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'error' } }), 'error')
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'interrupted' } }), 'error')
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'completed' } }), 'finished')
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'aborted', reason: { kind: 'user' } } }), null)
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'max-tokens' } }), null)
  assert.equal(kanbanAttentionForSignal({ signal: 'turn-end', sessionId, reason: { kind: 'blocked' } }), null)

  // Approval audit events: asked shows the badge, decided clears it.
  assert.equal(kanbanAttentionForSignal({ signal: 'approval-asked', sessionId }), 'approval')
  assert.equal(kanbanAttentionForSignal({ signal: 'approval-decided', sessionId }), null)

  // A running session is working; a stale badge clears. An unknown signal
  // leaves the badge untouched.
  assert.equal(kanbanAttentionForSignal({ signal: 'status', sessionId, status: 'running' }), null)
  assert.equal(kanbanAttentionForSignal({ signal: 'agent-error', sessionId }), 'error')
  assert.equal(kanbanAttentionForSignal({ signal: 'unknown', sessionId }), undefined)
})

test('an errored turn never moves its ticket to In Review', async () => {
  const linkage = makeLinkage()
  const adapter = {
    async linkageFor() {
      return linkage
    },
    async linkedTicketColumn() {
      return 'in-progress'
    },
    async branchHasCommits() {
      return true
    },
    async moveTicketToInReview() {
      throw new Error('an errored turn must not move its ticket')
    },
  }

  const result = await kanbanHandleSessionSignal(
    { signal: 'status', sessionId: linkage.sessionId, status: 'idle', reasonKind: 'error' },
    adapter,
  )

  assert.deepEqual(result, { attention: 'error', moved: false })
})

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function runGitFrom(cwd) {
  return async (args) => git(cwd, ...args)
}

test('the commit check reads real branch state against the spawn sha', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kanban-watch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n')
  git(root, 'add', 'base.txt')
  git(root, '-c', 'user.name=Kanban Test', '-c', 'user.email=kanban@example.test', 'commit', '-m', 'base')
  const baseSha = git(root, 'rev-parse', 'main')
  git(root, 'branch', 'kanban/KAN-101-fix-login')
  const branch = 'kanban/KAN-101-fix-login'
  const runGit = runGitFrom(root)

  // A branch still at its spawn point has no kanban commits.
  assert.equal(await kanbanBranchHasCommits({ branch, baseSha }, runGit), false)

  // One commit on the kanban branch advances the head past the spawn point.
  git(root, 'checkout', '--quiet', branch)
  fs.writeFileSync(path.join(root, 'work.txt'), 'work\n')
  git(root, 'add', 'work.txt')
  git(root, '-c', 'user.name=Kanban Test', '-c', 'user.email=kanban@example.test', 'commit', '-m', 'work')
  git(root, 'checkout', '--quiet', 'main')
  assert.equal(await kanbanBranchHasCommits({ branch, baseSha }, runGit), true)

  // A deleted branch cannot have commits.
  git(root, 'branch', '-D', branch)
  assert.equal(await kanbanBranchHasCommits({ branch, baseSha }, runGit), false)

  // Without a recorded spawn sha the check fails closed.
  git(root, 'branch', branch, 'main')
  assert.equal(await kanbanBranchHasCommits({ branch, baseSha: '' }, runGit), false)
})

test('the watch summary aggregates live attention across linked tickets', () => {
  const first = makeLinkage({ ticketId: 'KAN-102', sessionId: 's-102' })
  const second = makeLinkage({ ticketId: 'KAN-101', sessionId: 's-101' })
  const third = makeLinkage({ ticketId: 'KAN-103', sessionId: 's-103' })
  const attention = { 's-101': 'finished', 's-103': 'approval' }

  const summary = kanbanWatchSummary([first, second, third], (sessionId) => attention[sessionId])

  assert.equal(summary.count, 2)
  assert.deepEqual(summary.tickets, [
    { workspaceId: 'workspace-alpha', ticketId: 'KAN-101', attention: 'finished' },
    { workspaceId: 'workspace-alpha', ticketId: 'KAN-103', attention: 'approval' },
  ])
})

test('the watch summary stays empty when no session needs attention', () => {
  const linkage = makeLinkage()

  const summary = kanbanWatchSummary([linkage], () => undefined)

  assert.deepEqual(summary, { count: 0, tickets: [] })
})
