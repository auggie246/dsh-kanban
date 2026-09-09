const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const workspace = { id: 'ws-review', title: 'Review Workspace', path: '/workspace' }
const file = 'KAN-101-fix-login.md'
const ticketPath = '/workspace/.dsh-kanban/tickets/' + file
const reviewText = '---\nid: KAN-101\ntitle: Fix login\ncolumn: in-review\nbranch: kanban/KAN-101-fix-login\nworktreePath: /workspace/.dsh-kanban/worktrees/fix-login\nsessionId: session-review\n---\nFix the login timeout.\n'

// Exercise registered RPC methods and subscribed events. Only external Host
// capabilities are replaced; all Board orchestration runs from source.
async function openBoard(t, options = {}) {
  const files = new Map([[ticketPath, options.ticketText || reviewText]])
  const methods = new Map()
  const listeners = new Map()
  const disposers = []
  const domains = new Map()
  const messages = []
  const created = []
  const disposed = []
  const liveAgents = new Map()
  const gitCommands = []
  const ambientPolicyEvents = []
  const agent = {
    id: 'session-review',
    status: options.status || 'idle',
    session: {
      header: { cwd: '/workspace/.dsh-kanban/worktrees/fix-login', agentPreset: 'test' },
      append(type, data) { ambientPolicyEvents.push({ type, data }) },
    },
    policyEvents: ambientPolicyEvents,
    steer(message) {
      if (options.steerError) throw new Error('delivery failed')
      messages.push(message)
      agent.status = 'running'
      emit('agent/status', { agent, status: 'running' })
    },
  }
  if (!options.missingSession) liveAgents.set(agent.id, agent)
  const emit = (name, ...args) => {
    for (const callback of listeners.get(name) || []) callback(...args)
  }
  const ctx = {
    workspaceRegistry: {
      list: () => [workspace],
      get: (id) => id === workspace.id ? workspace : undefined,
    },
    fs: {
      resolve: async (value) => value,
      stat: async (target) => files.has(target) ? { type: 'file' }
        : target === '/workspace/.dsh-kanban/tickets' ? { type: 'directory' } : undefined,
      readText: async (target) => files.get(target),
      writeText: async (target, text) => {
        if (options.beforeWrite) await options.beforeWrite(target, text)
        if (options.writeError) throw new Error('write failed')
        files.set(target, text)
      },
      listDir: async () => [...files.keys()].map((target) => ({
        name: path.basename(target), type: 'file', target,
      })),
    },
    storageDomain: {
      async open(spec) {
        const rows = new Map()
        if (spec.name === 'kanban_execution') rows.set(workspace.id + '/KAN-101', {
          workspaceId: workspace.id, ticketId: 'KAN-101', sessionId: agent.id,
          branch: 'kanban/KAN-101-fix-login',
          worktreePath: '/workspace/.dsh-kanban/worktrees/fix-login', baseSha: 'spawn-sha',
        })
        domains.set(spec.name, rows)
        return {
          table: () => ({
            get: (key) => rows.get(key), keys: () => rows.keys(),
            put: async (key, value) => rows.set(key, value),
            delete: async (key) => rows.delete(key),
          }),
          close: async () => {},
        }
      },
    },
    shell: {
      resolve: (request) => request,
      run: async (request) => {
        gitCommands.push(request.command)
        if (options.runGit) return options.runGit(request)
        if (options.beforeGit) await options.beforeGit()
        const text = request.command.includes("'--show-toplevel'") ? '/workspace/.dsh-kanban/worktrees/fix-login' :
          request.command.includes("'symbolic-ref'") ? 'kanban/KAN-101-fix-login' : 'review-sha\n'
        return { exitCode: 0, stdout: { text }, stderr: { text: '' } }
      },
    },
    agents: {
      get: (id) => liveAgents.get(id),
      resume: async (spec) => {
        if (options.resumeError) throw new Error('session restore failed')
        assert.equal(spec.resumeSessionId, agent.id)
        agent.session = { header: { cwd: '/workspace/.dsh-kanban/worktrees/fix-login', agentPreset: 'test' } }
        agent.whenIdle = async () => {}
        liveAgents.set(agent.id, agent)
        return { agent, dispose: async () => liveAgents.delete(agent.id) }
      },
      create: async (spec) => {
        if (!options.allowCreate) throw new Error('Bounce must not create another session')
        if (options.createError && created.length) throw new Error('spawn failed')
        if (created.some((entry) => entry.spec.sessionId === spec.sessionId)) throw new Error('session identity already persisted')
        const policyEvents = []
        const next = {
          id: spec.sessionId, status: 'idle', whenIdle: async () => {},
          session: {
            header: { cwd: spec.meta.cwd, agentPreset: spec.meta.agentPreset },
            append(type, data) { policyEvents.push({ type, data }) },
          },
          policyEvents,
          followup(message) { messages.push(message); next.status = 'running'; emit('agent/status', { agent: next, status: 'running' }) },
        }
        if (spec.setup) await spec.setup({ agent: next })
        created.push({ spec, agent: next })
        liveAgents.set(next.id, next)
        return { agent: next, async dispose() {
          disposed.push(next.id); liveAgents.delete(next.id)
          emit('agent/disposed', next)
        } }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { resolve: async () => ({ id: 'test' }), mount: async () => {} },
    effect: (setup) => { const dispose = setup(); if (dispose) disposers.push(dispose) },
    on: (name, callback) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(callback)
    },
  }
  const source = ['frontmatter', 'settings', 'queue', 'execution', 'watch', 'bounce', 'completion', 'import', 'host']
    .map((name) => fs.readFileSync(path.join(__dirname, name + '.js'), 'utf8')).join('\n')
  const plugin = new Function('harness', source)({
    handle(name, handler) {
      methods.set(name, handler)
      return () => methods.delete(name)
    },
  })
  await plugin.apply(ctx)
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose() })
  return {
    agent, messages, files, domains, emit, created, disposed, liveAgents, gitCommands,
    async call(name, args = {}) {
      assert.equal(typeof methods.get(name), 'function', name + ' must be registered')
      return methods.get(name)({ workspaceId: workspace.id, file, ...args })
    },
    async settleSignals() { await new Promise((resolve) => setImmediate(resolve)) },
  }
}

test('Autopilot is off by default and persists per Workspace through Board methods', async (t) => {
  const board = await openBoard(t)

  const initial = await board.call('board.settings.list')
  assert.equal(initial.workspaces[0].autopilot, false)

  const updated = await board.call('board.settings.update', { wipLimit: 3, autopilot: true })
  assert.equal(updated.ok, true, updated.error)
  assert.equal(updated.autopilot, true)
  assert.equal((await board.call('board.list')).autopilot, true)
})

test('an errored Ticket stays In Progress with a Stalled badge and the failure message', async (t) => {
  const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress') })
  board.emit('session/event', { id: board.agent.id }, {
    type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Provider unavailable' } } },
  })
  board.emit('agent/status', { agent: board.agent, status: 'idle' })
  await board.settleSignals()
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.column, 'in-progress')
  assert.equal(card.attention, 'error')
  assert.equal(card.stalled, true)
  assert.equal(card.attentionMessage, 'Provider unavailable')
})

test('aborted and missing sessions never silently occupy an In Progress WIP slot', async (t) => {
  for (const missingSession of [false, true]) {
    const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress'), missingSession })
    if (!missingSession) {
      board.emit('session/event', { id: board.agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
      board.emit('agent/status', { agent: board.agent, status: 'idle' })
      await board.settleSignals()
    }
    const card = (await board.call('board.list')).tickets[0]
    assert.equal(card.stalled, true)
    assert.equal(card.attention, 'error')
    assert.ok(card.attentionMessage.length > 0)
    assert.equal((await board.call('board.watch.list')).count, 1)
  }
})

test('Resume steers the same Stalled session and clears its badge without changing execution linkage', async (t) => {
  const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress') })
  board.emit('agent/error', { agent: board.agent, error: new Error('Connection lost') })
  await board.settleSignals()
  const before = board.files.get(ticketPath)
  const reply = await board.call('ticket.resume')
  assert.equal(reply.ok, true, reply.error)
  assert.equal(board.messages.length, 1)
  assert.match(board.messages[0].content[0].text, /continue/i)
  assert.equal(board.files.get(ticketPath), before)
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.stalled, false)
  assert.equal(card.sessionId, 'session-review')
  assert.equal((await board.call('ticket.resume')).ok, false)
})

test('Autopilot pins workspace-write without prompts only on Board-spawned execution sessions', async (t) => {
  const autopilotBoard = await openBoard(t, {
    allowCreate: true,
    ticketText: '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\nbase: head\n---\nFix login.\n',
  })
  await autopilotBoard.call('board.settings.update', { wipLimit: 3, autopilot: true })
  const started = await autopilotBoard.call('ticket.move', { column: 'in-progress' })
  assert.equal(started.ok, true, started.error)
  assert.deepEqual(autopilotBoard.created[0].agent.policyEvents, [
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ])
  assert.deepEqual(autopilotBoard.agent.policyEvents, [], 'unowned sessions keep their ambient policy')

  const ambientBoard = await openBoard(t, {
    allowCreate: true,
    ticketText: '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\nbase: head\n---\nFix login.\n',
  })
  const ambientStarted = await ambientBoard.call('ticket.move', { column: 'in-progress' })
  assert.equal(ambientStarted.ok, true, ambientStarted.error)
  assert.deepEqual(ambientBoard.created[0].agent.policyEvents, [])
})

test('Retry fresh disposes the stalled session and starts a new one in the same Worktree and branch', async (t) => {
  const board = await openBoard(t, { allowCreate: true, ticketText: '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\nbase: head\n---\nFix login.\n' })
  await board.call('board.settings.update', { wipLimit: 3, autopilot: true })
  assert.equal((await board.call('ticket.move', { column: 'in-progress' })).ok, true)
  const original = (await board.call('board.list')).tickets[0]
  const old = board.created[0].agent
  old.status = 'idle'
  board.emit('agent/error', { agent: old, error: new Error('Connection lost') })
  await board.settleSignals()
  const reply = await board.call('ticket.retry')
  assert.equal(reply.ok, true, reply.error)
  assert.deepEqual(board.disposed, [old.id])
  assert.equal(board.created.length, 2)
  assert.deepEqual(board.created[1].agent.policyEvents, [
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ])
  const card = (await board.call('board.list')).tickets[0]
  assert.notEqual(card.sessionId, old.id)
  assert.equal(card.worktreePath, original.worktreePath)
  assert.equal(card.branch, original.branch)
  assert.equal(board.created[1].spec.meta.cwd, original.worktreePath)
  assert.equal(card.column, 'in-progress')
  assert.equal(card.stalled, false)
  assert.equal(board.gitCommands.filter((cmd) => cmd.includes("'worktree' 'add'")).length, 1)
  assert.match(board.messages[1].content[0].text, /existing work/i)
})

test('Send back to Ready requires confirmation for unmerged commits before deleting execution', async (t) => {
  const board = await openBoard(t, {
    missingSession: true, ticketText: reviewText.replace('in-review', 'in-progress'),
    runGit: async ({ command }) => ({ exitCode: 0, stderr: { text: '' }, stdout: { text:
      command.includes("'status'") ? '' : command.includes("'--show-toplevel'") ? '/workspace/.dsh-kanban/worktrees/fix-login' :
      command.includes("'symbolic-ref'") ? 'kanban/KAN-101-fix-login' :
      command.includes("'rev-list'") ? '1' : 'review-sha' } }),
  })
  const before = board.files.get(ticketPath)
  const preview = await board.call('ticket.sendBack')
  assert.equal(preview.ok, false)
  assert.equal(preview.confirmationRequired, true)
  assert.equal(preview.unmergedCommits, 1)
  assert.equal(board.files.get(ticketPath), before)
  assert.ok(!board.gitCommands.some((cmd) => cmd.includes("'remove'") || cmd.includes("'update-ref' '-d'")))
  const reply = await board.call('ticket.sendBack', { confirmation: preview.confirmation })
  assert.equal(reply.ok, true, reply.error)
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.column, 'ready')
  assert.equal(card.sessionId, '')
  assert.equal(card.branch, '')
  assert.equal(card.worktreePath, '')
  assert.ok(board.gitCommands.some((cmd) => cmd.includes("'worktree' 'remove'")))
  assert.ok(board.gitCommands.some((cmd) => cmd.includes("'update-ref' '-d'")))
  assert.equal((await board.call('board.watch.list')).count, 0)
})

test('an Agent error followed by idle retains its message and Stalled badge', async (t) => {
  const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress') })
  board.emit('agent/error', { agent: board.agent, error: new Error('Driver crashed') })
  board.emit('agent/status', { agent: board.agent, status: 'idle' })
  await board.settleSignals()
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.stalled, true)
  assert.equal(card.attentionMessage, 'Driver crashed')
})

test('Resume restores a missing persisted session before steering the same identity', async (t) => {
  const board = await openBoard(t, { missingSession: true, ticketText: reviewText.replace('in-review', 'in-progress') })
  const result = await board.call('ticket.resume')
  assert.equal(result.ok, true, result.error)
  assert.equal(result.sessionId, 'session-review')
  assert.equal(board.messages.length, 1)
  assert.equal((await board.call('board.list')).tickets[0].stalled, false)
})

test('dragging a Stalled Ticket to Ready cannot bypass Worktree cleanup', async (t) => {
  const board = await openBoard(t, { missingSession: true, ticketText: reviewText.replace('in-review', 'in-progress') })
  const before = board.files.get(ticketPath)
  const reply = await board.call('ticket.move', { column: 'ready' })
  assert.equal(reply.ok, false)
  assert.match(reply.error, /send-back-required/)
  assert.equal(board.files.get(ticketPath), before)
})

test('Send back uses real Git and preserves dirty work, stale confirmations, and rollback commits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-recovery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  git('commit', '--allow-empty', '-m', 'base')
  const tree = root + '/.dsh-kanban/worktrees/fix-login'
  const branch = 'kanban/KAN-101-fix-login'
  git('worktree', 'add', '-b', branch, tree)
  git('-C', tree, 'commit', '--allow-empty', '-m', 'work')
  let failWrite = false
  let advanceDuringCleanup = false
  const board = await openBoard(t, {
    missingSession: true, ticketText: reviewText.replace('in-review', 'in-progress'),
    beforeWrite: async (_target, text) => {
      if (failWrite && text.includes('column: ready')) { failWrite = false; throw new Error('disk full') }
    },
    runGit: async ({ command }) => {
      const result = spawnSync('bash', ['-c', command.replaceAll('/workspace', root)], { cwd: root, encoding: 'utf8' })
      if (advanceDuringCleanup && command.includes("'worktree' 'remove'") && result.status === 0) {
        advanceDuringCleanup = false
        const next = git('commit-tree', git('rev-parse', branch + '^{tree}'), '-p', git('rev-parse', branch), '-m', 'concurrent commit')
        git('update-ref', 'refs/heads/' + branch, next)
      }
      return { exitCode: result.status, stdout: { text: result.stdout.replaceAll(root, '/workspace') }, stderr: { text: result.stderr } }
    },
  })
  const first = await board.call('ticket.sendBack')
  assert.equal(first.confirmationRequired, true)
  assert.equal(first.unmergedCommits, 1)
  fs.writeFileSync(tree + '/keep.txt', 'unfinished work')
  const dirty = await board.call('ticket.sendBack', { confirmation: first.confirmation })
  assert.match(dirty.error, /worktree-not-clean/)
  assert.equal(fs.readFileSync(tree + '/keep.txt', 'utf8'), 'unfinished work')
  git('-C', tree, 'add', 'keep.txt'); git('-C', tree, 'commit', '-m', 'more work')
  const changed = await board.call('ticket.sendBack', { confirmation: first.confirmation })
  assert.equal(changed.confirmationRequired, true)
  assert.equal(changed.unmergedCommits, 2)
  failWrite = true
  const failure = await board.call('ticket.sendBack', { confirmation: changed.confirmation })
  assert.equal(failure.ok, false)
  assert.match(failure.error, /disk full/)
  assert.equal(fs.readFileSync(tree + '/keep.txt', 'utf8'), 'unfinished work')
  assert.equal(git('rev-list', '--count', 'main..' + branch), '2')
  assert.equal((await board.call('board.list')).tickets[0].column, 'in-progress')
  advanceDuringCleanup = true
  const raced = await board.call('ticket.sendBack', { confirmation: changed.confirmation })
  assert.equal(raced.ok, false, 'a concurrent branch commit must not be deleted')
  assert.equal(git('rev-list', '--count', 'main..' + branch), '3')
  const recheck = await board.call('ticket.sendBack')
  assert.equal(recheck.unmergedCommits, 3)
  const done = await board.call('ticket.sendBack', { confirmation: recheck.confirmation })
  assert.equal(done.ok, true, done.error)
  assert.equal(fs.existsSync(tree), false)
  assert.equal(git('branch', '--list', branch), '')
})

test('Retry fresh refuses a Ticket whose Worktree linkage points outside its assigned directory', async (t) => {
  const board = await openBoard(t, { missingSession: true, allowCreate: true,
    ticketText: reviewText.replace('in-review', 'in-progress').replace('/workspace/.dsh-kanban/worktrees/fix-login', '/tmp/unrelated'),
  })
  const result = await board.call('ticket.retry')
  assert.equal(result.ok, false)
  assert.match(result.error, /unsafe-execution-linkage/)
  assert.equal(board.created.length, 0)
})

test('a resumed Ticket reaches In Review through a valid Git command', async (t) => {
  const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress'),
    runGit: async ({ command }) => ({ exitCode: command.startsWith("'git' ") ? 0 : 127,
      stdout: { text: 'new-commit' }, stderr: { text: 'command not found' } }),
  })
  board.emit('agent/error', { agent: board.agent, error: new Error('Disconnected') })
  await board.settleSignals()
  assert.equal((await board.call('ticket.resume')).ok, true)
  board.emit('session/event', { id: board.agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  board.agent.status = 'idle'
  board.emit('agent/status', { agent: board.agent, status: 'idle' })
  await board.settleSignals()
  assert.equal((await board.call('board.list')).tickets[0].column, 'in-review')
})

test('an idle In Progress Ticket without a completion signal still offers Stalled recovery', async (t) => {
  const board = await openBoard(t, { ticketText: reviewText.replace('in-review', 'in-progress') })
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.stalled, true)
  assert.equal((await board.call('board.watch.list')).count, 1)
})

test('Retry fresh refuses a missing Worktree before spawning a session', async (t) => {
  const board = await openBoard(t, { missingSession: true, allowCreate: true,
    ticketText: reviewText.replace('in-review', 'in-progress'),
    runGit: async () => ({ exitCode: 128, stdout: { text: '' }, stderr: { text: 'Worktree missing' } }),
  })
  const result = await board.call('ticket.retry')
  assert.equal(result.ok, false)
  assert.match(result.error, /Worktree missing/)
  assert.equal(board.created.length, 0)
})

test('a Ticket sent back to Ready can start again without reusing its persisted session identity', async (t) => {
  const board = await openBoard(t, { allowCreate: true,
    ticketText: '---\nid: KAN-101\ntitle: Fix login\ncolumn: ready\nbase: head\n---\nFix login.\n',
    runGit: async ({ command }) => ({ exitCode: 0, stderr: { text: '' }, stdout: { text:
      command.includes("'status'") ? '' : command.includes("'--show-toplevel'") ? '/workspace/.dsh-kanban/worktrees/fix-login' :
      command.includes("'symbolic-ref'") ? 'kanban/KAN-101-fix-login' : command.includes("'rev-list'") ? '0' : 'base-sha' } }),
  })
  assert.equal((await board.call('ticket.move', { column: 'in-progress' })).ok, true)
  const original = board.created[0].agent
  original.status = 'idle'
  assert.equal((await board.call('ticket.sendBack')).ok, true)
  const restarted = await board.call('ticket.move', { column: 'in-progress' })
  assert.equal(restarted.ok, true, restarted.error)
  assert.notEqual(restarted.sessionId, original.id)
})

test('ticket.bounce delivers review comments to the existing session and persists the returned column', async (t) => {
  const board = await openBoard(t)
  const reply = await board.call('ticket.bounce', { comment: 'Fix the timeout at 30 seconds.' })
  assert.equal(reply.ok, true)
  assert.equal(board.agent.status, 'running')
  assert.equal(board.messages.length, 1)
  assert.equal(board.messages[0].role, 'user')
  assert.equal(typeof board.messages[0].id, 'string')
  assert.ok(board.messages[0].content.some((block) =>
    block.type === 'text' && block.text.includes('Fix the timeout at 30 seconds.')))
  const result = await board.call('board.list')
  assert.equal(result.ok, true)
  assert.equal(result.tickets[0].column, 'in-progress')
  assert.equal(result.tickets[0].sessionId, 'session-review')
  assert.equal(result.tickets[0].branch, 'kanban/KAN-101-fix-login')
  assert.equal(result.tickets[0].worktreePath, '/workspace/.dsh-kanban/worktrees/fix-login')
  assert.match(board.files.get(ticketPath), /Fix the timeout at 30 seconds\./)
  assert.match(board.files.get(ticketPath), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
})

test('a bounced session reaches In Review again and accepts another distinct steer message', async (t) => {
  const board = await openBoard(t)
  const comment = '  Keep this example:\n```js\nconst value = "a:b#c\\\\d"\n```\n'
  assert.equal((await board.call('ticket.bounce', { comment })).ok, true)
  assert.equal(board.messages[0].content[0].text, comment)
  board.emit('session/event', { id: board.agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  board.agent.status = 'idle'
  board.emit('agent/status', { agent: board.agent, status: 'idle' })
  await board.settleSignals()
  assert.equal((await board.call('board.list')).tickets[0].column, 'in-review')
  assert.equal((await board.call('ticket.bounce', { comment: 'One more correction.' })).ok, true)
  assert.notEqual(board.messages[0].id, board.messages[1].id)
  const historyLine = board.files.get(ticketPath).split('\n').find((line) => line.startsWith('bounces: '))
  const history = JSON.parse(JSON.parse(historyLine.slice('bounces: '.length)))
  assert.deepEqual(history.map((entry) => entry.comment), [comment, 'One more correction.'])
  assert.ok(history.every((entry) => Number.isFinite(Date.parse(entry.at))))
  assert.equal(board.domains.get('kanban_execution').get('ws-review/KAN-101').baseSha, 'spawn-sha')
})

test('Bounce and a concurrent description edit preserve both history and the new description', async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let firstWrite = true
  const board = await openBoard(t, {
    async beforeWrite() {
      if (!firstWrite) return
      firstWrite = false
      entered.resolve()
      await release.promise
    },
  })
  const bounce = board.call('ticket.bounce', { comment: 'Keep the review history.' })
  await entered.promise
  const edit = board.call('ticket.update', { title: 'Updated title', body: 'Updated description.', blocked: '' })
  await board.settleSignals()
  release.resolve()
  assert.equal((await bounce).ok, true)
  assert.equal((await edit).ok, true)
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.title, 'Updated title')
  assert.equal(card.body, 'Updated description.\n')
  assert.equal(card.column, 'in-progress')
  assert.match(board.files.get(ticketPath), /Keep the review history\./)
})

test('an earlier completed turn cannot return a bounced Ticket to In Review', async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const board = await openBoard(t, {
    ticketText: reviewText.replace('column: in-review', 'column: in-progress'),
    async beforeGit() { entered.resolve(); await release.promise },
  })
  board.emit('session/event', { id: board.agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  board.emit('agent/status', { agent: board.agent, status: 'idle' })
  await entered.promise
  assert.equal((await board.call('ticket.move', { column: 'in-review' })).ok, true)
  assert.equal((await board.call('ticket.bounce', { comment: 'Still needs rework.' })).ok, true)
  release.resolve()
  await board.settleSignals()
  const card = (await board.call('board.list')).tickets[0]
  assert.equal(card.column, 'in-progress')
  assert.equal(card.attention, null)
})

test('moving In Review directly to In Progress requires a Bounce comment', async (t) => {
  const board = await openBoard(t)
  const reply = await board.call('ticket.move', { column: 'in-progress' })
  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'bounce-comment-required')
  assert.equal(board.files.get(ticketPath), reviewText)
  assert.equal(board.messages.length, 0)
})

test('Bounce resumes its existing session at the WIP limit without consuming the waiting queue', async (t) => {
  const board = await openBoard(t)
  await board.call('board.settings.update', { wipLimit: 1 })
  board.files.set('/workspace/.dsh-kanban/tickets/KAN-102-running.md',
    reviewText.replace(/KAN-101/g, 'KAN-102').replace('session-review', 'session-running').replace('column: in-review', 'column: in-progress'))
  const queuedPath = '/workspace/.dsh-kanban/tickets/KAN-103-queued.md'
  const queuedText = '---\nid: KAN-103\ntitle: Waiting\ncolumn: in-progress\nqueued: "2026-07-23T12:00:00.000Z"\n---\nWaiting for a slot.\n'
  board.files.set(queuedPath, queuedText)
  const reply = await board.call('ticket.bounce', { comment: 'Revise this result.' })
  assert.equal(reply.ok, true)
  assert.equal(board.messages.length, 1)
  const tickets = (await board.call('board.list')).tickets
  const bounced = tickets.find((card) => card.id === 'KAN-101')
  assert.equal(bounced.column, 'in-progress')
  assert.equal(bounced.queued, '')
  assert.equal(bounced.sessionId, 'session-review')
  assert.equal(board.files.get(queuedPath), queuedText)
})

test('overlapping Bounce submissions deliver only one review comment', async (t) => {
  const board = await openBoard(t)
  const replies = await Promise.all([
    board.call('ticket.bounce', { comment: 'First correction.' }),
    board.call('ticket.bounce', { comment: 'Duplicate submission.' }),
  ])
  assert.equal(replies[0].ok, true)
  assert.equal(replies[1].ok, false)
  assert.match(replies[1].error, /ticket-not-in-review/)
  assert.equal(board.messages.length, 1)
  assert.equal(board.messages[0].content[0].text, 'First correction.')
  assert.doesNotMatch(board.files.get(ticketPath), /Duplicate submission/)
})

test('the Board watch poll captures an open GitHub PR URL on its Ticket', async (t) => {
  const board = await openBoard(t, {
    missingSession: true,
    runGit(request) {
      const command = request.command
      let text = ''
      if (command === "'git' 'remote'") text = 'origin\n'
      else if (command.includes("'remote' 'get-url' 'origin'")) text = 'git@github.com:owner/repo.git\n'
      else if (command.startsWith("'gh' 'pr' 'view'")) {
        text = '{"url":"https://github.com/owner/repo/pull/7","state":"OPEN","mergedAt":null}'
      }
      return { exitCode: 0, stdout: { text, truncated: false }, stderr: { text: '', truncated: false } }
    },
  })
  const reply = await board.call('board.watch.list')
  assert.equal(reply.ok, true, reply.error)
  assert.match(board.files.get(ticketPath), /reviewUrl: "https:\/\/github.com\/owner\/repo\/pull\/7"/)
  assert.match(board.files.get(ticketPath), /column: in-review/)
})

test('Bounce validation and delivery failures leave the Ticket File unchanged', async (t) => {
  const cases = [
    { args: { comment: ' \n ' }, error: /comment required/ },
    { args: { comment: 42 }, error: /comment required/ },
    { options: { missingSession: true }, error: /session-not-live/ },
    { options: { status: 'running' }, error: /session-not-idle/ },
    { options: { writeError: true }, error: /write failed/ },
    { options: { steerError: true }, error: /delivery failed/ },
    { options: { ticketText: reviewText.replace('column: in-review', 'column: ready') }, error: /ticket-not-in-review/ },
    { options: { ticketText: reviewText.replace('sessionId: session-review', 'sessionId: ""') }, error: /ticket-not-started/ },
    { options: { ticketText: reviewText.replace('column: in-review', 'column: in-review\nbounces: invalid-json') }, error: /invalid-bounce-history/ },
    { args: { file: '../outside.md' }, error: /invalid-ticket-file/ },
    { args: { workspaceId: 'unknown' }, error: /workspace-not-found/ },
  ]
  for (const example of cases) {
    await t.test(String(example.error), async (t) => {
      const board = await openBoard(t, example.options)
      const before = board.files.get(ticketPath)
      const reply = await board.call('ticket.bounce', { comment: 'Fix the timeout.', ...example.args })
      assert.equal(reply.ok, false)
      assert.match(reply.error, example.error)
      assert.equal(board.files.get(ticketPath), before)
      assert.equal(board.messages.length, 0)
    })
  }
})
