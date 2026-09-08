const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function openImportBoard(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-import-'))
  const ticketsDir = path.join(root, '.dsh-kanban', 'tickets')
  fs.mkdirSync(ticketsDir, { recursive: true })
  if (options.existing !== false) {
    fs.writeFileSync(path.join(ticketsDir, 'KAN-101-existing.md'), [
      '---',
      'id: KAN-101',
      'title: Existing',
      'column: backlog',
      'issue: "https://github.com/o/r/issues/12"',
      '---',
      'Already imported.',
      '',
    ].join('\n'))
  }

  const workspace = { id: 'workspace-import', title: 'Import Workspace', path: root }
  const methods = new Map()
  const disposers = []
  const commands = []
  const issueRows = options.issueRows || [
    { number: 12, title: 'Existing remote Issue', body: 'Existing body.', url: 'https://github.com/o/r/issues/12' },
    { number: 13, title: 'Fix: import flow', body: 'Build the importer.\n\n- Keep links.', url: 'https://github.com/o/r/issues/13' },
  ]
  const remote = options.remote === undefined ? 'git@github.com:o/r.git' : options.remote
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
      writeText: async (target, text, writeOptions) => {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (writeOptions && writeOptions.kind === 'createIfAbsent' && fs.existsSync(target)) {
          throw new Error('already exists')
        }
        fs.writeFileSync(target, text)
      },
      listDir: async (target) => fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        target: path.join(target, entry.name),
      })),
    },
    storageDomain: {
      async open() {
        const rows = new Map()
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
          return {
            exitCode: options.gitRemoteExit || 0,
            stdout: { text: remote === '' ? '' : 'origin\n' },
            stderr: { text: options.gitRemoteExit ? 'fatal: not a git repository' : '' },
          }
        }
        if (request.command === "'git' 'remote' 'get-url' 'origin'") {
          return { exitCode: remote === '' ? 2 : 0, stdout: { text: remote + (remote === '' ? '' : '\n') }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'gh' 'issue' 'list'")) {
          return { exitCode: 0, stdout: { text: JSON.stringify(issueRows) }, stderr: { text: '' } }
        }
        throw new Error('unexpected command: ' + request.command)
      },
    },
    agents: { get: () => undefined, create: async () => { throw new Error('must not create an Agent Session') } },
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
    root,
    ticketsDir,
    commands,
    async call(name, args = {}) {
      assert.equal(typeof methods.get(name), 'function', name + ' must be registered')
      return methods.get(name)({ workspaceId: workspace.id, ...args })
    },
  }
}

test('Issue import lists open Issues and marks already-linked Issues as imported', async (t) => {
  const board = await openImportBoard(t)

  const reply = await board.call('issue.import.list')

  assert.equal(reply.ok, true, reply.error)
  assert.equal(reply.platform, 'github')
  assert.deepEqual(reply.issues.map((issue) => [issue.number, issue.imported]), [[12, true], [13, false]])
})

test('Issue import creates selected available Issues as well-formed Backlog Ticket Files', async (t) => {
  const board = await openImportBoard(t)

  const reply = await board.call('issue.import.create', { numbers: [12, 13] })

  assert.equal(reply.ok, true, reply.error)
  assert.deepEqual(reply.skipped, [12])
  assert.deepEqual(reply.imported.map((entry) => entry.number), [13])
  const listed = await board.call('board.list')
  const imported = listed.tickets.find((ticket) => ticket.issue === 'https://github.com/o/r/issues/13')
  assert.equal(imported.id, 'KAN-102')
  assert.equal(imported.title, 'Fix: import flow')
  assert.equal(imported.column, 'backlog')
  assert.equal(imported.body, 'Build the importer.\n\n- Keep links.\n')
  assert.equal(imported.file, 'KAN-102-fix-import-flow.md')

  const second = await board.call('issue.import.create', { numbers: [13] })
  assert.deepEqual(second.imported, [])
  assert.deepEqual(second.skipped, [13])
})

test('Issue import is a no-op with a clear message when no supported remote exists', async (t) => {
  const board = await openImportBoard(t, { remote: '', existing: false, gitRemoteExit: 128 })

  const listed = await board.call('issue.import.list')
  const imported = await board.call('issue.import.create', { numbers: [12] })

  assert.equal(listed.ok, true)
  assert.equal(listed.platform, 'none')
  assert.deepEqual(listed.issues, [])
  assert.match(listed.message, /No GitHub or GitLab remote/)
  assert.equal(imported.ok, true)
  assert.deepEqual(imported.imported, [])
  assert.match(imported.message, /No GitHub or GitLab remote/)
  assert.equal(fs.readdirSync(board.ticketsDir).length, 0)
  assert.equal(board.commands.some((command) => command.startsWith("'gh' ") || command.startsWith("'glab' ")), false)
})
