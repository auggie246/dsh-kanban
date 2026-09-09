const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { kanbanStartTicketExecution, kanbanExecutionBrief } = require('./execution.js')
const { kanbanSetAttr, parseTicketFile } = require('./frontmatter.js')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content)
  git(cwd, 'add', name)
  git(cwd, '-c', 'user.name=Kanban Test', '-c', 'user.email=kanban@example.test', 'commit', '-m', message)
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kanban-execution-'))
  const remote = path.join(root, 'remote.git')
  const workspace = path.join(root, 'workspace')
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(root, 'clone', remote, workspace)
  commitFile(workspace, 'remote.txt', 'remote base\n', 'remote base')
  git(workspace, 'push', '-u', 'origin', 'main')
  git(workspace, 'remote', 'set-head', 'origin', 'main')
  commitFile(workspace, 'local-only.txt', 'local head\n', 'local head')
  return { root, workspace }
}

function makeAdapter(workspace) {
  const observed = { sessions: [], ticketLinks: [], records: [], deletedRecords: [], briefs: [], disposals: [] }
  return {
    observed,
    async runGit(args) {
      return git(workspace, ...args)
    },
    async readIgnore() {
      const target = path.join(workspace, '.gitignore')
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
    },
    async writeIgnore(text) {
      fs.writeFileSync(path.join(workspace, '.gitignore'), text)
    },
    async createSession(spec) {
      observed.sessions.push(spec)
      return {
        id: spec.sessionId,
        async dispose() {
          observed.disposals.push(spec.sessionId)
        },
      }
    },
    setTicketAttr(text, key, value) {
      return kanbanSetAttr(text, key, value)
    },
    async persistTicket(text) {
      observed.ticketLinks.push(text)
    },
    async persistLinkage(key, linkage) {
      observed.records.push({ key, linkage })
    },
    async deleteLinkage(key) {
      observed.deletedRecords.push(key)
    },
    async disposeSession(session) {
      await session.dispose()
    },
    async followup(session, brief) {
      observed.briefs.push({ session, brief })
    },
  }
}

test('a GitHub completion brief requires a pushed Ticket branch and linked Issue PR', () => {
  const brief = kanbanExecutionBrief(
    '---\nid: KAN-101\nissue: https://github.com/owner/repo/issues/10\n---\nFix it.\nissue: https://example.test/wrong\n',
    'kanban/KAN-101-fix', '/workspace', '/workspace/.dsh-kanban/worktrees/fix',
    { platform: 'github', remote: 'origin' }, 'https://github.com/owner/repo/issues/10',
  )
  assert.match(brief, /git push -u origin kanban\/KAN-101-fix/)
  assert.match(brief, /gh pr create/)
  assert.match(brief, /Reference the linked Issue `https:\/\/github\.com\/owner\/repo\/issues\/10`/)
  assert.doesNotMatch(brief, /Reference the linked Issue `https:\/\/example\.test\/wrong`/)
})

test('a GitLab completion brief requires a pushed Ticket branch and MR', () => {
  const brief = kanbanExecutionBrief(
    '---\nid: KAN-102\n---\nFix it.\n', 'kanban/KAN-102-fix', '/workspace', '/workspace/wt',
    { platform: 'gitlab', remote: 'upstream' },
  )
  assert.match(brief, /git push -u upstream kanban\/KAN-102-fix/)
  assert.match(brief, /glab mr create/)
  assert.doesNotMatch(brief, /linked Issue/)
})

test('a local completion brief does not require a push or change request', () => {
  const brief = kanbanExecutionBrief('---\nid: KAN-103\n---\nFix it.\n', 'kanban/KAN-103-fix', '/workspace', '/workspace/wt', { platform: 'none' })
  assert.doesNotMatch(brief, /git push|gh pr create|glab mr create/)
})

test('moving a Ready Ticket starts isolated work from the remote default branch', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const adapter = makeAdapter(repo.workspace)

  const result = await kanbanStartTicketExecution(
    {
      workspaceId: 'workspace-alpha',
      workspacePath: repo.workspace,
      ticketId: 'KAN-101',
      ticketSlug: 'fix-login',
      ticketText: '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\n---\nImplement the login fix.\n',
      baseMode: 'remote',
      autopilot: true,
    },
    adapter,
  )

  assert.equal(result.branch, 'kanban/KAN-101-fix-login')
  assert.equal(result.worktreePath, path.join(repo.workspace, '.dsh-kanban/worktrees/fix-login'))
  // The watch loop compares the branch head against this spawn sha to decide
  // whether the kanban branch has commits (issue #6).
  assert.equal(result.baseSha, git(repo.workspace, 'rev-parse', 'origin/main'))
  assert.equal(fs.readFileSync(path.join(result.worktreePath, 'remote.txt'), 'utf8'), 'remote base\n')
  assert.equal(fs.existsSync(path.join(result.worktreePath, 'local-only.txt')), false)
  assert.equal(fs.readFileSync(path.join(repo.workspace, 'local-only.txt'), 'utf8'), 'local head\n')
  assert.equal(fs.readFileSync(path.join(repo.workspace, '.gitignore'), 'utf8'), '.dsh-kanban/worktrees/\n')
  assert.deepEqual(adapter.observed.sessions, [
    { sessionId: result.sessionId, cwd: result.worktreePath, autopilot: true },
  ])
  assert.equal(
    adapter.observed.ticketLinks[0],
    '---\nid: KAN-101\ntitle: Fix login\ncolumn: in-progress\nbranch: kanban/KAN-101-fix-login\nworktreePath: ' +
      result.worktreePath +
      '\nsessionId: ' +
      result.sessionId +
      '\n---\nImplement the login fix.\n',
  )
  const reopened = parseTicketFile('KAN-101-fix-login.md', adapter.observed.ticketLinks[0])
  assert.equal(reopened.column, 'in-progress')
  assert.equal(reopened.branch, result.branch)
  assert.equal(reopened.worktreePath, result.worktreePath)
  assert.equal(reopened.sessionId, result.sessionId)
  assert.deepEqual(adapter.observed.records, [
    { key: 'workspace-alpha/KAN-101', linkage: result },
  ])
  assert.equal(adapter.observed.briefs.length, 1)
  assert.equal(adapter.observed.briefs[0].session.id, result.sessionId)
  assert.match(adapter.observed.briefs[0].brief, /Implement the login fix\./)
  assert.match(adapter.observed.briefs[0].brief, /Work only on branch `kanban\/KAN-101-fix-login`\./)
  assert.match(adapter.observed.briefs[0].brief, /Never touch the main checkout/)
  assert.match(adapter.observed.briefs[0].brief, /Commit completed work/)
})

test('the remote default branch works when its local symbolic ref is absent', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  git(repo.workspace, 'remote', 'set-head', 'origin', '-d')
  const adapter = makeAdapter(repo.workspace)

  const result = await kanbanStartTicketExecution(
    {
      workspaceId: 'workspace-alpha',
      workspacePath: repo.workspace,
      ticketId: 'KAN-104',
      ticketSlug: 'remote-fallback',
      ticketText: '---\nid: KAN-104\ntitle: Remote fallback\ncolumn: ready\n---\nUse the declared remote default.\n',
      baseMode: 'remote',
    },
    adapter,
  )

  assert.equal(fs.readFileSync(path.join(result.worktreePath, 'remote.txt'), 'utf8'), 'remote base\n')
  assert.equal(fs.existsSync(path.join(result.worktreePath, 'local-only.txt')), false)
})

test('a startup failure rolls back the Worktree, branch, Agent Session, and linkage', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const adapter = makeAdapter(repo.workspace)
  adapter.followup = async () => {
    throw new Error('followup failed')
  }
  const original = '---\nid: KAN-105\ntitle: Roll back\ncolumn: ready\n---\nRollback this start.\n'

  await assert.rejects(
    kanbanStartTicketExecution(
      {
        workspaceId: 'workspace-alpha',
        workspacePath: repo.workspace,
        ticketId: 'KAN-105',
        ticketSlug: 'roll-back',
        ticketText: original,
        baseMode: 'head',
      },
      adapter,
    ),
    /followup failed/,
  )

  assert.equal(fs.existsSync(path.join(repo.workspace, '.dsh-kanban/worktrees/roll-back')), false)
  assert.equal(git(repo.workspace, 'branch', '--list', 'kanban/KAN-105-roll-back'), '')
  assert.equal(adapter.observed.ticketLinks.at(-1), original)
  assert.deepEqual(adapter.observed.deletedRecords, ['workspace-alpha/KAN-105'])
  assert.deepEqual(adapter.observed.disposals, [adapter.observed.sessions[0].sessionId])
})

test('the local HEAD override includes local commits and keeps one worktree ignore line', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const adapter = makeAdapter(repo.workspace)

  const first = await kanbanStartTicketExecution(
    {
      workspaceId: 'workspace-alpha',
      workspacePath: repo.workspace,
      ticketId: 'KAN-102',
      ticketSlug: 'use-local-head',
      ticketText: '---\nid: KAN-102\ntitle: Use local HEAD\ncolumn: ready\nbase: head\n---\nUse local work.\n',
      baseMode: 'head',
    },
    adapter,
  )
  const second = await kanbanStartTicketExecution(
    {
      workspaceId: 'workspace-alpha',
      workspacePath: repo.workspace,
      ticketId: 'KAN-103',
      ticketSlug: 'second-ticket',
      ticketText: '---\nid: KAN-103\ntitle: Second ticket\ncolumn: ready\nbase: head\n---\nSecond local task.\n',
      baseMode: 'head',
    },
    adapter,
  )

  assert.equal(fs.readFileSync(path.join(first.worktreePath, 'local-only.txt'), 'utf8'), 'local head\n')
  assert.equal(fs.readFileSync(path.join(second.worktreePath, 'local-only.txt'), 'utf8'), 'local head\n')
  assert.equal(fs.readFileSync(path.join(repo.workspace, '.gitignore'), 'utf8'), '.dsh-kanban/worktrees/\n')
  assert.equal(git(first.worktreePath, 'branch', '--show-current'), 'kanban/KAN-102-use-local-head')
  assert.equal(git(second.worktreePath, 'branch', '--show-current'), 'kanban/KAN-103-second-ticket')
})

test('auto-spawning a queued Ticket clears the queued marker in the persisted file', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const adapter = makeAdapter(repo.workspace)

  const result = await kanbanStartTicketExecution(
    {
      workspaceId: 'workspace-alpha',
      workspacePath: repo.workspace,
      ticketId: 'KAN-103',
      ticketSlug: 'queued-start',
      ticketText:
        '---\nid: KAN-103\ntitle: Queued start\ncolumn: in-progress\nqueued: "2026-07-14T09:30:00.000Z"\n---\nSpawn me from the queue.\n',
      baseMode: 'remote',
    },
    adapter,
  )

  const persisted = adapter.observed.ticketLinks[0]
  assert.equal(
    persisted,
    '---\nid: KAN-103\ntitle: Queued start\ncolumn: in-progress\nbranch: kanban/KAN-103-queued-start\nworktreePath: ' +
      result.worktreePath +
      '\nsessionId: ' +
      result.sessionId +
      '\n---\nSpawn me from the queue.\n',
  )
  const reopened = parseTicketFile('KAN-103-queued-start.md', persisted)
  assert.equal(reopened.queued, '')
  assert.equal(reopened.column, 'in-progress')
})

test('a failed auto-spawn rolls the Ticket back to its queued state', async (t) => {
  const repo = makeRepository()
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const adapter = makeAdapter(repo.workspace)
  adapter.followup = async () => {
    throw new Error('followup failed')
  }
  const queuedText =
    '---\nid: KAN-105\ntitle: Roll back queue\ncolumn: in-progress\nqueued: "2026-07-14T09:30:00.000Z"\n---\nStay queued.\n'

  await assert.rejects(
    kanbanStartTicketExecution(
      {
        workspaceId: 'workspace-alpha',
        workspacePath: repo.workspace,
        ticketId: 'KAN-105',
        ticketSlug: 'roll-back-queue',
        ticketText: queuedText,
        baseMode: 'head',
      },
      adapter,
    ),
    /followup failed/,
  )

  assert.equal(adapter.observed.ticketLinks.at(-1), queuedText)
  const reopened = parseTicketFile('KAN-105-roll-back-queue.md', adapter.observed.ticketLinks.at(-1))
  assert.equal(reopened.queued, '2026-07-14T09:30:00.000Z')
  assert.equal(reopened.column, 'in-progress')
})
