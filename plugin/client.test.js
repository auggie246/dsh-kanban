const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// Exercise the shipped browser artifact through its registered button and overlay.
async function openBoard(remoteResult) {
  const surfaces = new Map()
  let registration
  let state = []
  let cursor = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
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
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  const plugin = registration.factory(() => React)
  plugin.apply({
    remote: { $mount: async () => () => {} },
    get: (name) => name === 'slots' ? slots : name === 'remote.kanban' ? {
      call: async (method) => { assert.equal(method, 'board.list'); return remoteResult },
    } : undefined,
    effect: (setup) => setup(),
  })
  const render = (element) => { cursor = 0; effects = []; return element.type(element.props) }
  const button = render(surfaces.get('sidebar.footer.action')({ wide: true }))
  button.props.onClick()
  state = []
  const overlay = render(surfaces.get('shell.overlay')({
    useSessions: (select) => select({ current: 'session-a' }),
    useWorkspaces: (select) => select({ items: [{
      workspaceId: 'workspace-a', title: 'Workspace', path: '/workspace', sessionIds: ['session-a'],
    }] }),
  }))
  assert.equal(overlay.props.className, 'kanban-board-overlay')
  state = []
  const board = overlay.children[0]
  render(board)
  const cleanups = effects.map((effect) => effect())
  await new Promise((resolve) => setImmediate(resolve))
  const result = render(board)
  for (const cleanup of cleanups) if (cleanup) cleanup()
  return result.children[1]
}

test('Kanban click renders Board columns after a successful Typert reply', async () => {
  const body = await openBoard({ ok: true, value: { ok: true, tickets: [{ id: 'KAN-101', column: 'backlog' }], wipLimit: 3 } })
  assert.equal(body.props.className, 'kanban-columns', JSON.stringify(body))
  assert.equal(body.children[0].length, 5)
})

test('Kanban shows an empty Board when the Workspace has no Ticket Files', async () => {
  const body = await openBoard({ ok: true, value: { ok: true, tickets: [], wipLimit: 3 } })
  assert.equal(body.children[0].children[0], 'No Tickets yet')
})

test('Kanban displays Typert failures instead of staying on the loading message', async () => {
  const body = await openBoard({ ok: false, error: { message: 'Connection unavailable' } })
  assert.equal(body.props.className, 'kanban-state kanban-state-error')
  assert.equal(body.children[0], 'Board unavailable: Connection unavailable')
})

test('Kanban displays Board failures from successful Typert replies', async () => {
  const body = await openBoard({ ok: true, value: { ok: false, error: 'board-read-failed' } })
  assert.equal(body.children[0], 'Board unavailable: board-read-failed')
})
