const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// Board modernization coverage for issue #18. Uses the same vm harness
// style as plugin/client.test.js: load the shipped lib/client.js artifact,
// inject a fake React and slots registry, render the registered surfaces,
// and assert on the element trees. Shared plugin/client.test.js pins the
// body contracts; this file pins the header hierarchy, columns, card
// surfaces, and state screens that the restyle must keep working.
const WORKSPACES = [{
  workspaceId: 'workspace-a',
  title: 'Design System',
  path: '/home/augustine/Projects/design-system',
  sessionIds: ['session-a'],
}]

// BoardColumn and BoardCard are hook-free pure functions, so a rendered
// Board tree keeps them as descriptors; invoking one expands its subtree.
function expand(element) {
  return element.type(element.props)
}

function ticket(overrides) {
  return {
    id: 'KAN-101',
    file: 'KAN-101-modernize-board.md',
    title: 'Modernize Board layout',
    body: '',
    preview: 'Refresh the header and columns',
    column: 'backlog',
    queued: '',
    blocked: '',
    issue: '',
    reviewUrl: '',
    base: 'remote',
    branch: 'kan-101-modernize-board',
    worktreePath: '',
    sessionId: '',
    attention: null,
    stalled: false,
    attentionMessage: '',
    issueBlockers: [],
    issueComments: [],
    sync: null,
    ...overrides,
  }
}

// The artifact's host.call unwraps Typert replies, so the fake remote
// returns { ok, value } envelopes and Board sees value.
const okList = (tickets, extra = {}) => ({
  ok: true,
  value: { ok: true, tickets, wipLimit: 3, autopilot: false, ...extra },
})

async function openBoard({
  reply,
  workspaces = WORKSPACES,
  currentSessionId = 'session-a',
  settle = true,
  surface = 'overlay',
} = {}) {
  const surfaces = new Map()
  let registration
  let state = []
  let cursor = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: function Fragment() { throw new Error('unexpected Fragment render') },
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => { state[index] = value }]
    },
    useEffect(effect) { effects.push(effect) },
  }
  const slots = {
    inject: (_, setup) => setup(),
    register(meta, render) { surfaces.set(meta.name, render); return () => {} },
  }
  const remote = {
    call: async (method) => {
      if (method === 'board.list') return reply
      if (method === 'board.watch.list') return { ok: true, value: { ok: true, count: 0, tickets: [], syncRevision: 0 } }
      throw new Error('unexpected Host method ' + method)
    },
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const plugin = registration.factory(() => React)
  plugin.apply({
    remote: { $mount: async () => () => {} },
    get: (name) => (name === 'slots' ? slots : name === 'remote.kanban' ? remote : undefined),
    effect: (setup) => setup(),
  })
  const render = (element) => { cursor = 0; effects = []; return element.type(element.props) }
  let board
  if (surface === 'overlay') {
    const button = render(surfaces.get('sidebar.footer.action')({ wide: true }))
    button.props.onClick()
    state = []
    const overlay = render(surfaces.get('shell.overlay')({
      useSessions: (select) => select({ current: currentSessionId }),
      useWorkspaces: (select) => select({ items: workspaces }),
    }))
    assert.equal(overlay.props.className, 'kanban-board-overlay')
    board = overlay.children[0]
  } else {
    const tab = render(surfaces.get('conversation.view')({
      sessionId: currentSessionId,
      useWorkspaces: (select) => select({ items: workspaces }),
    }))
    assert.equal(tab.props.className, 'kanban-board-embedded')
    board = tab.children[0]
  }
  state = []
  const first = render(board)
  if (!settle) return { board, result: first }
  const cleanups = effects.map((effect) => effect())
  await new Promise((resolve) => setImmediate(resolve))
  const result = render(board)
  for (const cleanup of cleanups) if (cleanup) cleanup()
  return { board, result }
}

test('Board header renders clean text with New Ticket primary and Import Issues secondary', async () => {
  const { result } = await openBoard({ reply: okList([ticket()]) })
  const header = result.children[0]
  assert.equal(header.type, 'header')
  assert.equal(header.props.className, 'kanban-board-header')
  assert.equal(header.children[0].props.className, 'kanban-board-name')
  assert.equal(header.children[0].children[0], 'Kanban')
  const workspace = header.children[1]
  assert.equal(workspace.props.className, 'kanban-board-workspace')
  assert.equal(workspace.children[0].props.className, 'kanban-board-workspace-title')
  assert.equal(workspace.children[0].children[0], 'Design System')
  assert.equal(workspace.children[1].props.className, 'kanban-board-workspace-path')
  assert.equal(workspace.children[1].children[0], '/home/augustine/Projects/design-system')
  const actions = header.children.find(
    (child) => child !== null && child.props && child.props.className === 'kanban-board-actions',
  )
  assert.ok(actions, 'header groups its Ticket actions')
  const [importButton, newButton] = actions.children
  assert.equal(importButton.props.className, 'kanban-import-btn kanban-board-action-secondary')
  assert.equal(importButton.children[0], 'Import Issues')
  assert.match(importButton.props.title, /Import open remote Issues/)
  assert.equal(newButton.props.className, 'kanban-new-btn kanban-board-action-primary')
  assert.equal(newButton.children[0], '+ New Ticket')
  const close = header.children.find(
    (child) => child !== null && child.props && child.props.className === 'kanban-close',
  )
  assert.ok(close, 'overlay Board keeps its Close button')
})

test('Board renders the five fixed columns with counts inside the horizontal scroll container', async () => {
  const { result } = await openBoard({ reply: okList([
    ticket({ id: 'KAN-101', column: 'backlog' }),
    ticket({ id: 'KAN-102', file: 'KAN-102-ready.md', column: 'ready' }),
    ticket({ id: 'KAN-103', file: 'KAN-103-running.md', column: 'in-progress', sessionId: 'session-1' }),
    ticket({ id: 'KAN-104', file: 'KAN-104-review.md', column: 'in-review' }),
    ticket({ id: 'KAN-105', file: 'KAN-105-done.md', column: 'done' }),
  ]) })
  const columns = result.children[1]
  assert.equal(columns.props.className, 'kanban-columns')
  // Board renders h('div', props, COLUMNS.map(...)): the fake createElement
  // keeps the mapped array as one child, and each entry is a BoardColumn
  // descriptor that expand() turns into its section element.
  const columnList = columns.children[0]
  assert.equal(columnList.length, 5)
  // columnList comes from the vm realm, so collect expanded sections into a
  // host array before comparing (deepEqual rejects cross-realm prototypes).
  const sections = []
  for (const column of columnList) sections.push(expand(column))
  assert.deepEqual(
    sections.map((section) => section.props.className),
    Array.from({ length: 5 }, () => 'kanban-column'),
  )
  assert.deepEqual(
    sections.map((section) => section.children[0].children[0].children[0]),
    ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done'],
  )
  assert.deepEqual(
    sections.map((section) => section.children[0].children[1].children[0]),
    ['1', '1', '1 / 3', '1', '1'],
  )
})

test('In Progress shows running versus WIP limit and the queued count', async () => {
  const { result } = await openBoard({ reply: okList([
    ticket({ id: 'KAN-103', file: 'KAN-103-running.md', column: 'in-progress', sessionId: 'session-1' }),
    ticket({ id: 'KAN-108', file: 'KAN-108-queued.md', column: 'in-progress', queued: '2026-07-01T09:00:00.000Z' }),
    ticket({ id: 'KAN-109', file: 'KAN-109-queued.md', column: 'in-progress', queued: '2026-07-02T09:00:00.000Z' }),
  ]) })
  const inProgress = expand(result.children[1].children[0][2])
  const count = inProgress.children[0].children[1]
  assert.equal(count.children[0], '1 / 3 · 2 queued')
  assert.equal(count.props.title, 'WIP limit 3')
})

test('Ticket cards render id, title, attention badge, and keep Blocked as a card-level badge', async () => {
  const { result } = await openBoard({ reply: okList([
    ticket({
      id: 'KAN-104',
      file: 'KAN-104-ship.md',
      column: 'in-progress',
      title: 'Ship the Board restyle',
      attention: 'approval',
      blocked: 'Waiting on CI',
      sessionId: 'session-9',
    }),
  ]) })
  const columns = result.children[1]
  const section = expand(columns.children[0][2])
  assert.equal(section.props.className, 'kanban-column')
  const cards = section.children[1]
  assert.equal(cards.props.className, 'kanban-column-cards')
  const card = expand(cards.children[0][0])
  assert.equal(card.props.className, 'kanban-card')
  assert.equal(card.props.draggable, true)
  const head = card.children[0]
  assert.equal(head.props.className, 'kanban-card-head')
  assert.equal(head.children[0].props.className, 'kanban-card-id')
  assert.equal(head.children[0].children[0], 'KAN-104')
  const byClass = (name) => card.children.find(
    (child) => child !== null && child.props && child.props.className === name,
  )
  assert.equal(byClass('kanban-card-title').children[0], 'Ship the Board restyle')
  const attention = byClass('kanban-card-attention kanban-attention-approval')
  assert.equal(attention.children[0], 'Awaiting approval')
  const blocked = byClass('kanban-card-blocked')
  assert.equal(blocked.children[0], 'Blocked — Waiting on CI')
  assert.ok(!section.props.className.includes('blocked'), 'Blocked stays off the column')
  assert.ok(!columns.props.className.includes('blocked'), 'Blocked stays off the columns container')
})

test('Loading and error states keep the kanban-state language and messages', async () => {
  const loading = await openBoard({ reply: okList([]), settle: false })
  assert.equal(loading.result.children[1].props.className, 'kanban-state')
  assert.equal(loading.result.children[1].children[0], 'Reading Ticket Files…')

  const failed = await openBoard({ reply: { ok: false, error: { message: 'Connection unavailable' } } })
  const errorBody = failed.result.children[1]
  assert.equal(errorBody.props.className, 'kanban-state kanban-state-error')
  assert.equal(errorBody.children[0], 'Board unavailable: Connection unavailable')

  const hostFailed = await openBoard({ reply: { ok: true, value: { ok: false, error: 'board-read-failed' } } })
  assert.equal(hostFailed.result.children[1].props.className, 'kanban-state kanban-state-error')
  assert.equal(hostFailed.result.children[1].children[0], 'Board unavailable: board-read-failed')
})

test('Empty Board keeps its title and hint in the same state language', async () => {
  const { result } = await openBoard({ reply: okList([]) })
  const body = result.children[1]
  assert.equal(body.props.className, 'kanban-state')
  assert.equal(body.children[0].props.className, 'kanban-state-title')
  assert.equal(body.children[0].children[0], 'No Tickets yet')
  assert.equal(body.children[1].props.className, 'kanban-state-hint')
})

test('Board without a Workspace keeps the no-workspace state', async () => {
  const { result } = await openBoard({ reply: okList([]), workspaces: [], currentSessionId: undefined })
  const body = result.children[1]
  assert.equal(body.props.className, 'kanban-state')
  assert.equal(body.children[0], 'No active Workspace. Select a Workspace to see its Board.')
})

test('Embedded Board tab renders the same header hierarchy and columns', async () => {
  const { result } = await openBoard({ reply: okList([ticket()]), surface: 'embedded' })
  const header = result.children[0]
  const actions = header.children.find(
    (child) => child !== null && child.props && child.props.className === 'kanban-board-actions',
  )
  assert.ok(actions, 'embedded header keeps the Ticket actions')
  const newButton = actions.children[1]
  assert.equal(newButton.props.className, 'kanban-new-btn kanban-board-action-primary')
  const close = header.children.find(
    (child) => child !== null && child.props && child.props.className === 'kanban-close',
  )
  assert.equal(close, undefined, 'embedded Board has no Close button')
  const columns = result.children[1]
  assert.equal(columns.props.className, 'kanban-columns')
  assert.equal(columns.children[0].length, 5)
})

// A Workspace outside a Git repository is a configuration state, not a Board
// failure: the Board keeps rendering and states the reason on its face.
test('Board names a Workspace that is not a Git repository', async () => {
  const { result } = await openBoard({ reply: okList([ticket()], { repository: false }) })
  const body = result.children[1]
  assert.deepEqual(body.children.map((child) => child.props.className), ['kanban-git-notice', 'kanban-columns'])
  const notice = body.children[0]
  assert.equal(notice.props.role, 'status')
  assert.equal(notice.children[0].props.className, 'kanban-git-notice-title')
  assert.equal(notice.children[0].children[0], 'This Workspace is not a Git repository')
  assert.equal(notice.children[1].props.className, 'kanban-git-notice-hint')
  assert.match(notice.children[1].children[0], /Ticket execution and remote PR\/MR completion need Git/)
})

test('Board stays quiet for a Git Workspace', async () => {
  const { result } = await openBoard({ reply: okList([ticket()], { repository: true }) })
  assert.equal(result.children[1].props.className, 'kanban-columns')
})
