const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

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
  const agent = {
    id: 'session-review',
    status: options.status || 'idle',
    steer(message) {
      if (options.steerError) throw new Error('delivery failed')
      messages.push(message)
      agent.status = 'running'
      emit('agent/status', { agent, status: 'running' })
    },
  }
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
      run: async () => {
        if (options.beforeGit) await options.beforeGit()
        return { exitCode: 0, stdout: { text: 'review-sha\n' }, stderr: { text: '' } }
      },
    },
    agents: {
      get: (id) => !options.missingSession && id === agent.id ? agent : undefined,
      create: () => { throw new Error('Bounce must not create another session') },
    },
    agentDefaultModel: {},
    agentPresets: {},
    effect: (setup) => { const dispose = setup(); if (dispose) disposers.push(dispose) },
    on: (name, callback) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(callback)
    },
  }
  const source = ['frontmatter', 'settings', 'queue', 'execution', 'watch', 'bounce', 'host']
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
    agent, messages, files, domains, emit,
    async call(name, args = {}) {
      assert.equal(typeof methods.get(name), 'function', name + ' must be registered')
      return methods.get(name)({ workspaceId: workspace.id, file, ...args })
    },
    async settleSignals() { await new Promise((resolve) => setImmediate(resolve)) },
  }
}

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
