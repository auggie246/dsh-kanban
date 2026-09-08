const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

async function openCompletionBoard(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-completion-'))
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.trim()
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(root + '/.gitignore', '')
  fs.writeFileSync(root + '/login.txt', 'old login\n')
  git('add', '.'); git('commit', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  const branch = 'kanban/KAN-101-fix-login'
  const tree = root + '/.dsh-kanban/worktrees/fix-login'
  git('worktree', 'add', '-b', branch, tree)
  fs.writeFileSync(tree + '/login.txt', 'fixed login\n')
  git('-C', tree, 'commit', '-am', 'fix login')
  const head = git('rev-parse', branch)
  const file = 'KAN-101-fix-login.md'
  const ticketPath = root + '/.dsh-kanban/tickets/' + file
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true })
  fs.writeFileSync(ticketPath, '---\nid: KAN-101\ntitle: Fix login\ncolumn: in-review\nbaseBranch: main\nbranch: ' + branch + '\nworktreePath: ' + tree + '\nsessionId: test-session\n---\nFix login.\n')
  const methods = new Map()
  const disposers = []
  const liveAgents = new Map()
  const disposedSessions = []
  const workspace = { id: 'local-workspace', path: root, title: 'Local' }
  const domains = new Map()
  const ctx = {
    workspaceRegistry: { list: () => [workspace], get: (id) => id === workspace.id ? workspace : undefined },
    fs: {
      resolve: async (target) => target,
      stat: async (target) => fs.existsSync(target) ? { type: fs.statSync(target).isDirectory() ? 'directory' : 'file' } : undefined,
      readText: async (target) => fs.readFileSync(target, 'utf8'),
      writeText: async (target, text) => { if (options.beforeWrite) await options.beforeWrite(target, text); fs.writeFileSync(target, text) },
      listDir: async (target) => fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', target: path.join(target, entry.name) })),
    },
    shell: {
      resolve: (request) => request,
      run: async (request) => {
        if (options.beforeGit) await options.beforeGit(request)
        const run = spawnSync('bash', ['-c', request.command], { cwd: request.workdir, encoding: 'utf8' })
        const truncated = options.truncateDiff === true && request.command.includes("'diff'")
        return { exitCode: run.status, stdout: { text: run.stdout, truncated }, stderr: { text: run.stderr, truncated: false } }
      },
    },
    storageDomain: { open: async (spec) => {
      const rows = new Map()
      if (spec.name === 'kanban_execution') rows.set(workspace.id + '/KAN-101', {
        workspaceId: workspace.id, ticketId: 'KAN-101', sessionId: 'test-session', worktreePath: tree, branch, baseSha,
      })
      domains.set(spec.name, rows)
      return { table: () => ({ get: (key) => rows.get(key), keys: () => rows.keys(), put: async (key, value) => rows.set(key, value), delete: async (key) => rows.delete(key) }), close: async () => {} }
    } },
    agents: { get: (id) => liveAgents.get(id), create: async (spec) => {
      const agent = { id: spec.sessionId, status: 'idle', whenIdle: async () => {}, followup: () => { agent.status = 'running' } }
      liveAgents.set(agent.id, agent)
      return { agent, dispose: async () => { disposedSessions.push(agent.id); liveAgents.delete(agent.id) } }
    } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { resolve: async () => ({ id: 'test' }), mount: async () => {} },
    on: () => {}, effect: (setup) => { const dispose = setup(); if (dispose) disposers.push(dispose) },
  }
  const sources = ['frontmatter', 'settings', 'queue', 'execution', 'watch', 'bounce', 'completion', 'import', 'host']
  const plugin = new Function('harness', sources.map((name) => fs.readFileSync(path.join(__dirname, name + '.js'), 'utf8')).join('\n'))({
    handle: (name, handler) => { methods.set(name, handler); return () => methods.delete(name) },
  })
  await plugin.apply(ctx)
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, tree, branch, baseSha, head, file, ticketPath, git, domains, liveAgents, disposedSessions,
    call: async (name, args = {}) => {
      assert.equal(typeof methods.get(name), 'function', name + ' must be registered')
      return methods.get(name)({ workspaceId: workspace.id, file, ...args })
    },
  }
}

test('review reports merge conflicts without changing the base or leaving a merge in progress', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.root + '/login.txt', 'different login\n')
  board.git('commit', '-am', 'base change')
  const before = board.git('rev-parse', 'HEAD')
  const review = await board.call('ticket.review')
  assert.equal(review.ok, true, review.error)
  assert.equal(review.canAccept, false)
  assert.match(review.conflict, /login.txt/)
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, false)
  assert.match(accepted.error, /CONFLICT|conflict/i)
  assert.equal(board.git('rev-parse', 'HEAD'), before)
  assert.equal(fs.existsSync(board.root + '/.git/MERGE_HEAD'), false)
})

test('Accept fast-forwards locally, records the merge SHA, and releases the Ticket Worktree and branch', async (t) => {
  const board = await openCompletionBoard(t)
  const review = await board.call('ticket.review')
  const result = await board.call('ticket.accept', { review })
  assert.equal(result.ok, true, result.error)
  assert.equal(board.git('rev-parse', 'HEAD'), board.head)
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.column, 'done')
  assert.equal(card.sessionId, '')
  assert.match(fs.readFileSync(board.ticketPath, 'utf8'), new RegExp('mergeSha: ' + board.head))
  assert.equal(fs.existsSync(board.tree), false)
  assert.equal(board.git('branch', '--list', board.branch), '')
})

test('local completion refuses Workspaces with a remote', async (t) => {
  const board = await openCompletionBoard(t)
  board.git('remote', 'add', 'origin', '/not-contacted')
  const review = await board.call('ticket.review')
  assert.equal(review.ok, false)
  assert.match(review.error, /local-completion-only/)
})

test('Accept refuses a different checked-out base rather than merging into the wrong branch', async (t) => {
  const board = await openCompletionBoard(t)
  board.git('checkout', '-b', 'unrelated')
  const review = await board.call('ticket.review')
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, false)
  assert.match(accepted.error, /base-not-checked-out/)
  assert.equal(board.git('rev-parse', 'HEAD'), board.baseSha)
})

test('Accept preserves uncommitted Workspace files instead of including them in a merge', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.root + '/notes.txt', 'private draft\n')
  board.git('add', 'notes.txt')
  const review = await board.call('ticket.review')
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, false)
  assert.match(accepted.error, /workspace-not-clean/)
  assert.equal(board.git('rev-parse', 'HEAD'), board.baseSha)
  assert.equal(fs.readFileSync(board.root + '/notes.txt', 'utf8'), 'private draft\n')
})

test('Accept detects dirty Ticket Worktrees before merging anything', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.tree + '/draft.txt', 'unfinished\n')
  const review = await board.call('ticket.review')
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, false)
  assert.match(accepted.error, /worktree-not-clean/)
  assert.equal(board.git('rev-parse', 'HEAD'), board.baseSha)
  assert.equal(fs.readFileSync(board.tree + '/draft.txt', 'utf8'), 'unfinished\n')
})

test('a Workspace without a remote starts a Ticket from its local base branch and records that branch', async (t) => {
  const board = await openCompletionBoard(t)
  board.git('worktree', 'remove', board.tree); board.git('branch', '-D', board.branch)
  fs.writeFileSync(board.ticketPath, '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\n---\nFix login.\n')
  const start = await board.call('ticket.move', { column: 'in-progress' })
  assert.equal(start.ok, true, start.error)
  assert.equal((await board.call('board.list')).tickets[0].baseBranch, 'main')
  assert.equal(board.git('rev-parse', board.branch), board.baseSha)
  const card = (await board.call('board.list')).tickets[0]
  fs.writeFileSync(card.worktreePath + '/login.txt', 'fixed again\n')
  board.git('-C', card.worktreePath, 'commit', '-am', 'fix again')
  board.liveAgents.get(card.sessionId).status = 'idle'
  assert.equal((await board.call('ticket.move', { column: 'in-review' })).ok, true)
  const accepted = await board.call('ticket.accept', { review: await board.call('ticket.review') })
  assert.equal(accepted.ok, true, accepted.error)
  assert.deepEqual(board.disposedSessions, [card.sessionId])
})

test('review rejects execution linkage that could delete the Workspace base branch', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.ticketPath, fs.readFileSync(board.ticketPath, 'utf8').replace('branch: ' + board.branch, 'branch: main'))
  const review = await board.call('ticket.review')
  assert.equal(review.ok, false)
  assert.match(review.error, /unsafe-execution-linkage/)
  assert.equal(board.git('rev-parse', 'main'), board.baseSha)
})

test('Accept retries cleanup after a successful merge without creating another merge', async (t) => {
  let failDelete = true
  const board = await openCompletionBoard(t, { beforeGit: async ({ command }) => {
    if (failDelete && command.includes("'update-ref' '-d'")) { failDelete = false; throw new Error('branch locked') }
  } })
  const first = await board.call('ticket.accept', { review: await board.call('ticket.review') })
  assert.equal(first.ok, false)
  assert.match(first.error, /branch locked/)
  assert.equal(board.git('rev-parse', 'HEAD'), board.head)
  assert.match(fs.readFileSync(board.ticketPath, 'utf8'), /mergeSha:/)
  const secondReview = await board.call('ticket.review')
  assert.equal(secondReview.cleanupPending, true)
  const second = await board.call('ticket.accept', { review: secondReview })
  assert.equal(second.ok, true, second.error)
  assert.equal(board.git('rev-parse', 'HEAD'), board.head)
  assert.equal((await board.call('board.list')).tickets[0].column, 'done')
})

test('Accept creates a merge commit when the base and Ticket branches diverge', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.root + '/base.txt', 'base change\n')
  board.git('add', 'base.txt'); board.git('commit', '-m', 'advance base')
  const baseBefore = board.git('rev-parse', 'HEAD')
  const review = await board.call('ticket.review')
  assert.equal(review.canAccept, true)
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, true, accepted.error)
  const mergeSha = board.git('rev-parse', 'HEAD')
  assert.notEqual(mergeSha, board.head)
  assert.equal(board.git('rev-list', '--parents', '-n', '1', mergeSha).split(' ').length, 3)
  assert.equal(board.git('merge-base', '--is-ancestor', baseBefore, mergeSha), '')
  assert.match(fs.readFileSync(board.ticketPath, 'utf8'), new RegExp('mergeSha: ' + mergeSha))
})

test('moving In Review directly to Done cannot bypass local Accept', async (t) => {
  const board = await openCompletionBoard(t)
  const result = await board.call('ticket.move', { column: 'done' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'accept-required')
  assert.equal(board.git('rev-parse', 'HEAD'), board.baseSha)
  assert.equal(fs.existsSync(board.tree), true)
})

test('review fails closed when a legacy local Ticket has no recorded Base Branch', async (t) => {
  const board = await openCompletionBoard(t)
  fs.writeFileSync(board.ticketPath, fs.readFileSync(board.ticketPath, 'utf8').replace('baseBranch: main\n', ''))
  const review = await board.call('ticket.review')
  assert.equal(review.ok, false)
  assert.match(review.error, /base-branch-missing/)
})

test('review rejects a different branch occupying the recorded Worktree path', async (t) => {
  const board = await openCompletionBoard(t)
  board.git('worktree', 'remove', board.tree)
  board.git('branch', 'unrelated-worktree', board.baseSha)
  board.git('worktree', 'add', board.tree, 'unrelated-worktree')
  const review = await board.call('ticket.review')
  assert.equal(review.ok, false)
  assert.match(review.error, /worktree-branch-mismatch/)
  assert.equal(fs.existsSync(board.tree), true)
  assert.notEqual(board.git('branch', '--list', board.branch), '')
})

test('indirect moves cannot bypass Accept or Bounce from In Review', async (t) => {
  const board = await openCompletionBoard(t)
  for (const column of ['backlog', 'ready', 'done']) {
    const result = await board.call('ticket.move', { column })
    assert.equal(result.ok, false)
    assert.equal(result.error, column === 'done' ? 'accept-required' : 'review-decision-required')
  }
  assert.equal((await board.call('board.list')).tickets[0].column, 'in-review')
})

test('cleanup retry preserves the original recorded Merge Sha after the Base Branch advances', async (t) => {
  let failDelete = true
  const board = await openCompletionBoard(t, { beforeGit: async ({ command }) => {
    if (failDelete && command.includes("'update-ref' '-d'")) { failDelete = false; throw new Error('branch locked') }
  } })
  const first = await board.call('ticket.accept', { review: await board.call('ticket.review') })
  assert.equal(first.ok, false)
  const originalMergeSha = board.git('rev-parse', 'HEAD')
  fs.writeFileSync(board.root + '/later.txt', 'later\n')
  board.git('add', 'later.txt'); board.git('commit', '-m', 'later base work')
  const laterSha = board.git('rev-parse', 'HEAD')
  assert.notEqual(laterSha, originalMergeSha)
  const accepted = await board.call('ticket.accept', { review: await board.call('ticket.review') })
  assert.equal(accepted.ok, true, accepted.error)
  assert.match(fs.readFileSync(board.ticketPath, 'utf8'), new RegExp('mergeSha: ' + originalMergeSha))
})

test('a truncated but conflict-free diff remains acceptable', async (t) => {
  const board = await openCompletionBoard(t, { truncateDiff: true })
  const review = await board.call('ticket.review')
  assert.equal(review.truncated, true)
  assert.equal(review.conflict, null)
  assert.equal(review.canAccept, true)
  const accepted = await board.call('ticket.accept', { review })
  assert.equal(accepted.ok, true, accepted.error)
})

test('review returns the Ticket branch diff against its recorded base without changing either checkout', async (t) => {
  const board = await openCompletionBoard(t)
  const review = await board.call('ticket.review')
  assert.equal(review.ok, true, review.error)
  assert.equal(review.baseBranch, 'main')
  assert.match(review.diff, /-old login\n\+fixed login/)
  assert.equal(board.git('rev-parse', 'HEAD'), board.baseSha)
  assert.equal(fs.readFileSync(board.root + '/login.txt', 'utf8'), 'old login\n')
  assert.equal(fs.readFileSync(board.tree + '/login.txt', 'utf8'), 'fixed login\n')
})
