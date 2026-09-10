const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// Exercise the shipped browser artifact's sidebar button (issue #17): the
// icon + label redesign, its collapsed variant, the Attention Badge
// aggregate, the click wiring into the shell.overlay Board, and the
// unchanged slot registration.

function makeReactStub() {
  const react = { state: [], cursor: 0, effects: [] }
  react.createElement = (type, props, ...children) => ({ type, props: props || {}, children })
  react.useState = (initial) => {
    const index = react.cursor++
    if (!(index in react.state)) react.state[index] = initial
    return [react.state[index], (value) => { react.state[index] = value }]
  }
  react.useEffect = (effect) => { react.effects.push(effect) }
  react.render = (element) => {
    react.cursor = 0
    react.effects = []
    return element.type(element.props)
  }
  react.runEffects = async () => {
    const pending = react.effects
    react.effects = []
    const cleanups = pending.map((effect) => effect())
    try {
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      for (const cleanup of cleanups) if (cleanup) cleanup()
    }
  }
  return react
}

function loadButtonHarness({ wide = true, watchCount = 0 } = {}) {
  let registration
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    setInterval,
    clearInterval,
  })
  const react = makeReactStub()
  const surfaces = new Map()
  const metas = []
  const slots = {
    inject: (_, setup) => setup(),
    register(meta, render) { metas.push(meta); surfaces.set(meta.name, render); return () => {} },
  }
  const remote = {
    call: async (method) => {
      assert.equal(method, 'board.watch.list')
      return { ok: true, value: { ok: true, count: watchCount, tickets: [], syncRevision: 0 } }
    },
  }
  const plugin = registration.factory(() => react)
  plugin.apply({
    remote: { $mount: async () => () => {} },
    get: (name) => (name === 'slots' ? slots : name === 'remote.kanban' ? remote : undefined),
    effect: (setup) => setup(),
  })
  return { react, surfaces, metas }
}

test('Kanban sidebar button renders a board icon beside the Kanban label', () => {
  const { react, surfaces } = loadButtonHarness({ wide: true })
  const button = react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  assert.equal(button.type, 'button')
  assert.match(String(button.props.className), /kanban-sidebar-btn/)
  assert.doesNotMatch(String(button.props.className), /kanban-sidebar-btn-collapsed/)
  const icon = button.children.find((child) => child !== null && child !== undefined && child.type === 'svg')
  assert.ok(icon, 'expanded button must embed the inline board icon')
  assert.equal(icon.props['aria-hidden'], true)
  assert.equal(icon.children.length, 3, 'board icon draws its three column bars')
  const label = button.children.find(
    (child) => child !== null && child !== undefined && child.type === 'span' && child.props.className === 'kanban-sidebar-label',
  )
  assert.ok(label, 'expanded button must render the Kanban label element')
  assert.deepEqual(label.children, ['Kanban'])
})

test('Collapsed Kanban sidebar button renders the icon with an accessible Kanban name', () => {
  const { react, surfaces } = loadButtonHarness({ wide: false })
  const button = react.render(surfaces.get('sidebar.footer.action')({ wide: false }))
  assert.match(String(button.props.className), /kanban-sidebar-btn-collapsed/)
  const texts = button.children.filter((child) => typeof child === 'string')
  assert.deepEqual(texts, [], 'collapsed button must not fall back to a K text glyph')
  assert.ok(button.children.some((child) => child !== null && child !== undefined && child.type === 'svg'), 'collapsed button keeps the board icon')
  assert.equal(button.props['aria-label'], 'Kanban')
  assert.equal(button.props.title, 'Kanban')
})

test('Kanban sidebar button shows no attention badge when the watch count is zero', async () => {
  const { react, surfaces } = loadButtonHarness({ wide: true, watchCount: 0 })
  react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  await react.runEffects()
  const button = react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  const isBadge = (child) =>
    child !== null && child !== undefined && child.type === 'span' && child.props.className === 'kanban-sidebar-attention'
  const badge = button.children.find(isBadge)
  assert.equal(badge, undefined)
})

test('Kanban sidebar button surfaces the attention count when sessions need attention', async () => {
  const { react, surfaces } = loadButtonHarness({ wide: true, watchCount: 3 })
  react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  await react.runEffects()
  const button = react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  const badge = button.children.find(
    (child) => child !== null && child !== undefined && child.type === 'span' && child.props.className === 'kanban-sidebar-attention',
  )
  assert.ok(badge, 'a nonzero watch count must render the attention badge')
  assert.deepEqual(badge.children, ['3'])
  assert.match(String(badge.props.title), /3 Ticket sessions need attention/)
})

test('Kanban sidebar button click still opens the Board overlay', () => {
  const { react, surfaces } = loadButtonHarness({ wide: true })
  const overlayProps = {
    useSessions: (select) => select({ current: undefined }),
    useWorkspaces: (select) => select({ items: [], recentWorkspaceId: undefined }),
  }
  const button = react.render(surfaces.get('sidebar.footer.action')({ wide: true }))
  react.state.length = 0
  assert.equal(react.render(surfaces.get('shell.overlay')(overlayProps)), null)
  button.props.onClick()
  react.state.length = 0
  const overlay = react.render(surfaces.get('shell.overlay')(overlayProps))
  assert.equal(overlay.props.className, 'kanban-board-overlay')
})

test('Kanban sidebar registration keeps its slot metadata', () => {
  const { metas } = loadButtonHarness({ wide: true })
  // Copy the primitive fields out first: the metadata objects come from the
  // vm realm, so deepStrictEqual would compare their foreign prototypes.
  const registered = metas.map((meta) => ({ name: meta.name, id: meta.id, order: meta.order, label: meta.label }))
  assert.deepEqual(registered, [
    { name: 'sidebar.footer.action', id: 'kanban', order: 100, label: 'Kanban' },
    { name: 'shell.overlay', id: 'kanban-board', order: 10, label: 'Kanban Board' },
    { name: 'conversation.view', id: 'kanban-board', order: 20, label: 'Board' },
    { name: 'settings.section', id: 'kanban-settings', order: 30, label: 'Kanban' },
  ])
})
