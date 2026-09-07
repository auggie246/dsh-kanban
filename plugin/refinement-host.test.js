const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function openRefinementBoard(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-refinement-'))
  const file = 'KAN-101-refine-login.md'
  const ticketPath = path.join(root, '.dsh-kanban', 'tickets', file)
  const ticketText = options.ticketText || '---\nid: KAN-101\ntitle: Refine login\ncolumn: backlog\n---\nLogin sometimes fails.\n'
  fs.mkdirSync(path.dirname(ticketPath), { recursive: true })
  fs.writeFileSync(ticketPath, ticketText)

  const workspace = { id: 'workspace-refinement', title: 'Refinement Workspace', path: root }
  const methods = new Map()
  const disposers = []
  const created = []
  const messages = []
  const skillLookups = []
  const writes = []
  const skills = options.skills || []
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
      writeText: async (target, text) => {
        writes.push({ target, text })
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
      run: async () => { throw new Error('Refinement must not run Git') },
    },
    agents: {
      get: () => undefined,
      async create(spec) {
        created.push(spec)
        const agent = {
          id: spec.sessionId,
          status: 'idle',
          whenIdle: async () => {},
          followup(message) {
            messages.push(message)
            agent.status = 'running'
          },
        }
        return { agent, dispose: async () => {} }
      },
    },
    skills: {
      async list(lookup) {
        skillLookups.push(lookup)
        return skills
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agentPresets: { resolve: async () => ({ id: 'test' }), mount: async () => {} },
    on: () => {},
    effect(setup) {
      const dispose = setup()
      if (dispose) disposers.push(dispose)
    },
  }
  const names = ['frontmatter', 'settings', 'queue', 'execution', 'watch', 'bounce', 'completion', 'host']
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
    file,
    ticketPath,
    ticketText,
    created,
    messages,
    skillLookups,
    writes,
    async call(args = {}) {
      assert.equal(typeof methods.get('ticket.refine'), 'function', 'ticket.refine must be registered')
      return methods.get('ticket.refine')({ workspaceId: workspace.id, file, ...args })
    },
  }
}

test('Refine explains the grill-with-docs dependency and does not spawn when the skill is absent', async (t) => {
  const board = await openRefinementBoard(t)
  const before = fs.readFileSync(board.ticketPath, 'utf8')

  const reply = await board.call()

  assert.equal(reply.ok, false)
  assert.match(reply.error, /grill-with-docs/)
  assert.match(reply.error, /install/i)
  assert.deepEqual(board.skillLookups, [{ cwd: board.root }])
  assert.equal(board.created.length, 0)
  assert.equal(fs.readFileSync(board.ticketPath, 'utf8'), before)
})

test('Refine starts one Agent Session in the plain Workspace for only the Backlog Ticket File', async (t) => {
  const board = await openRefinementBoard(t, {
    skills: [{
      name: 'grill-with-docs',
      description: 'Interview the user and write a plan.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-dsh',
      provider: 'skill-filesystem',
    }],
  })
  const before = fs.readFileSync(board.ticketPath, 'utf8')

  const reply = await board.call()

  assert.equal(reply.ok, true, reply.error)
  assert.equal(typeof reply.sessionId, 'string')
  assert.equal(board.created.length, 1)
  assert.equal(board.created[0].sessionId, reply.sessionId)
  assert.equal(board.created[0].meta.cwd, board.root)
  assert.equal(board.created[0].meta.agentPreset, 'test')
  assert.deepEqual(board.created[0].agentOptions, { provider: 'test', model: 'test' })
  assert.equal(board.messages.length, 1)
  const brief = board.messages[0].content[0].text
  assert.match(brief, /grill-with-docs/)
  assert.match(brief, /interview the user/i)
  assert.match(brief, /goal, context, and acceptance criteria/i)
  assert.match(brief, new RegExp(board.ticketPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(brief, /only (?:the|this) Ticket File/i)
  assert.match(brief, /must remain in Backlog/i)
  assert.doesNotMatch(brief, /Worktree `|worktree\/|worktree\\/i)
  assert.equal(board.writes.length, 0)
  assert.equal(fs.readFileSync(board.ticketPath, 'utf8'), before)
  assert.equal(fs.existsSync(path.join(board.root, '.dsh-kanban', 'worktrees')), false)
})
