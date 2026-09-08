const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function openSyncBoard(t, platform, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-sync-'))
  const ticketsDir = path.join(root, '.dsh-kanban', 'tickets')
  const file = 'KAN-101-linked.md'
  const issue = platform === 'github'
    ? 'https://github.com/o/r/issues/12'
    : 'https://gitlab.com/g/r/-/issues/12'
  const repo = platform === 'github' ? 'github.com/o/r' : 'gitlab.com/g/r'
  const remoteUrl = platform === 'github' ? 'git@github.com:o/r.git' : 'git@gitlab.com:g/r.git'
  const column = options.column || 'backlog'
  const targetColumn = options.targetColumn || 'ready'
  const branch = 'kanban/KAN-101-linked'
  const worktreePath = path.join(root, '.dsh-kanban', 'worktrees', 'linked')
  const sessionId = 'session-linked'
  fs.mkdirSync(ticketsDir, { recursive: true })
  const linkage = options.execution ? [
    'branch: ' + branch,
    'worktreePath: ' + worktreePath,
    'sessionId: ' + sessionId,
  ] : []
  fs.writeFileSync(path.join(ticketsDir, file), [
    '---',
    'id: KAN-101',
    'title: Linked',
    'column: ' + column,
    'issue: "' + issue + '"',
    ...linkage,
    '---',
    'Move this Ticket.',
    '',
  ].join('\n'))

  const methods = new Map()
  const disposers = []
  const commands = []
  const messages = []
  let remoteLabels = ['bug', 'kanban:' + column, 'kanban:stale']
  const workspace = { id: 'workspace-sync', title: 'Sync Workspace', path: root }
  const expectedLabelList = platform === 'github'
    ? "'gh' 'label' 'list' '--repo' '" + repo + "' '--search' 'kanban:" + targetColumn + "' '--limit' '100' '--json' 'name'"
    : "'glab' 'label' 'list' '--repo' '" + repo + "' '--output' 'json' '--page' '1' '--per-page' '100'"
  const expectedLabelCreate = platform === 'github'
    ? "'gh' 'label' 'create' 'kanban:" + targetColumn + "' '--repo' '" + repo + "'"
    : "'glab' 'label' 'create' '--name' 'kanban:" + targetColumn + "' '--repo' '" + repo + "'"
  const expectedView = platform === 'github'
    ? "'gh' 'issue' 'view' '" + issue + "' '--repo' '" + repo + "' '--json' 'labels'"
    : "'glab' 'issue' 'view' '12' '--repo' '" + repo + "' '--output' 'json'"
  const expectedEdit = platform === 'github'
    ? "'gh' 'issue' 'edit' '" + issue + "' '--repo' '" + repo + "' '--add-label' 'kanban:" + targetColumn + "' '--remove-label' 'kanban:" + column + ",kanban:stale'"
    : "'glab' 'issue' 'update' '12' '--repo' '" + repo + "' '--label' 'kanban:" + targetColumn + "' '--unlabel' 'kanban:" + column + ",kanban:stale'"
  const liveAgent = options.liveAgent ? {
    id: sessionId,
    status: 'idle',
    steer(message) {
      messages.push(message)
      liveAgent.status = 'running'
    },
  } : undefined
  const ctx = {
    workspaceRegistry: {
      list: () => [workspace],
      get: (id) => id === workspace.id ? workspace : undefined,
    },
    fs: {
      resolve: async (target) => target,
      stat: async (target) => fs.existsSync(target)
        ? { type: fs.statSync(target).isDirectory() ? 'directory' : 'file' }
        : undefined,
      readText: async (target) => fs.readFileSync(target, 'utf8'),
      writeText: async (target, text) => fs.writeFileSync(target, text),
      listDir: async (target) => fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        target: path.join(target, entry.name),
      })),
    },
    storageDomain: {
      async open(spec) {
        const rows = new Map()
        if (options.execution && spec.name === 'kanban_execution') {
          rows.set(workspace.id + '/KAN-101', {
            workspaceId: workspace.id,
            ticketId: 'KAN-101',
            sessionId,
            branch,
            worktreePath,
            baseSha: 'base-sha',
          })
        }
        return {
          table: () => ({
            get: (key) => rows.get(key),
            keys: () => rows.keys(),
            put: async (key, value) => rows.set(key, value),
            delete: async (key) => rows.delete(key),
          }),
          close: async () => {},
        }
      },
    },
    shell: {
      resolve: (request) => request,
      async run(request) {
        commands.push(request.command)
        if (request.command === "'git' 'remote'") {
          return { exitCode: 0, stdout: { text: 'origin\n' }, stderr: { text: '' } }
        }
        if (request.command === "'git' 'remote' 'get-url' 'origin'") {
          return { exitCode: 0, stdout: { text: remoteUrl + '\n' }, stderr: { text: '' } }
        }
        if (request.command === expectedLabelList) {
          return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
        }
        if (request.command === expectedLabelCreate) {
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command === expectedView) {
          const labels = platform === 'github'
            ? remoteLabels.map((name) => ({ name }))
            : remoteLabels
          return { exitCode: 0, stdout: { text: JSON.stringify({ labels }) }, stderr: { text: '' } }
        }
        if (request.command === expectedEdit) {
          remoteLabels = remoteLabels.filter((name) => !name.startsWith('kanban:'))
          remoteLabels.push('kanban:' + targetColumn)
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (options.merged && request.command.startsWith("'gh' 'pr' 'view'")) {
          return {
            exitCode: 0,
            stdout: { text: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'MERGED', mergedAt: '2026-08-01T12:00:00Z' }) },
            stderr: { text: '' },
          }
        }
        if (options.execution) {
          let text = ''
          if (request.command.includes("'worktree' 'list'")) {
            text = 'worktree ' + worktreePath + '\nbranch refs/heads/' + branch + '\n'
          } else if (request.command.includes("'--show-toplevel'")) text = worktreePath
          else if (request.command.includes("'symbolic-ref'")) text = branch
          else if (request.command.includes("'rev-list'")) text = '0'
          else if (request.command.includes("'rev-parse' '--verify' 'refs/heads/" + branch + "'")) text = 'ticket-head'
          else if (request.command === "'git' 'rev-parse' '--verify' 'HEAD'") text = 'base-head'
          return { exitCode: 0, stdout: { text }, stderr: { text: '' } }
        }
        throw new Error('unexpected command: ' + request.command)
      },
    },
    agents: {
      get: (id) => liveAgent && id === liveAgent.id ? liveAgent : undefined,
      create: async () => { throw new Error('must not create an Agent Session') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { resolve: async () => ({ id: 'test' }), mount: async () => {} },
    skills: { list: async () => [] },
    on: () => {},
    effect(setup) {
      const dispose = setup()
      if (dispose) disposers.push(dispose)
    },
  }
  const names = ['frontmatter', 'settings', 'queue', 'execution', 'watch', 'bounce', 'completion', 'import', 'host']
  const source = names.map((name) => fs.readFileSync(path.join(__dirname, name + '.js'), 'utf8')).join('\n')
  const plugin = new Function('harness', source)({
    handle(name, handler) {
      methods.set(name, handler)
      return () => methods.delete(name)
    },
  })
  await plugin.apply(ctx)
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    commands,
    expectedLabelList,
    expectedLabelCreate,
    expectedView,
    expectedEdit,
    labels: () => remoteLabels,
    async call(name, args = {}) {
      assert.equal(typeof methods.get(name), 'function', name + ' must be registered')
      return methods.get(name)({ workspaceId: workspace.id, file, ...args })
    },
  }
}

test('moving a linked Ticket writes its one Board column label to GitHub and GitLab', async (t) => {
  for (const platform of ['github', 'gitlab']) {
    await t.test(platform, async (t) => {
      const board = await openSyncBoard(t, platform)

      const reply = await board.call('ticket.move', { column: 'ready' })

      assert.equal(reply.ok, true, reply.error)
      assert.deepEqual(board.labels(), ['bug', 'kanban:ready'])
      assert.deepEqual(board.commands.slice(-4), [
        board.expectedLabelList, board.expectedLabelCreate, board.expectedView, board.expectedEdit,
      ])
      const listed = await board.call('board.list')
      assert.equal(listed.tickets[0].column, 'ready')
    })
  }
})

test('bouncing a linked Ticket writes its In Progress label', async (t) => {
  const board = await openSyncBoard(t, 'github', {
    column: 'in-review', targetColumn: 'in-progress', execution: true, liveAgent: true,
  })

  const reply = await board.call('ticket.bounce', { comment: 'Revise the result.' })

  assert.equal(reply.ok, true, reply.error)
  assert.deepEqual(board.labels(), ['bug', 'kanban:in-progress'])
})

test('sending back a linked Ticket writes its Ready label', async (t) => {
  const board = await openSyncBoard(t, 'github', {
    column: 'in-progress', targetColumn: 'ready', execution: true,
  })

  const reply = await board.call('ticket.sendBack')

  assert.equal(reply.ok, true, reply.error)
  assert.deepEqual(board.labels(), ['bug', 'kanban:ready'])
})

test('merged remote completion writes the linked Ticket Done label', async (t) => {
  const board = await openSyncBoard(t, 'github', {
    column: 'in-review', targetColumn: 'done', execution: true, merged: true,
  })

  const reply = await board.call('board.watch.list')

  assert.equal(reply.ok, true, reply.error)
  assert.deepEqual(board.labels(), ['bug', 'kanban:done'])
})
