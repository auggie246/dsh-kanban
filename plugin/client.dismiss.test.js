const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// Issue #16 regression harness: focus placement, topmost-first Escape
// dismissal, discard confirmation for unsaved Ticket edits, and the
// accessible Close icon. Loads the shipped lib/client.js artifact the same
// way client.test.js does, plus a small fake document so the plugin-level
// document Escape listener can be exercised. window/document are only
// touched inside effects and handlers by the source, so the fake document
// is provided in the vm sandbox and consumed at runtime.

const WORKSPACE = { workspaceId: 'workspace-a', title: 'Workspace', path: '/workspace', sessionIds: ['session-a'] }
const SLOT_PROPS = {
  useSessions: (select) => select({ current: 'session-a' }),
  useWorkspaces: (select) => select({ items: [WORKSPACE] }),
}

const ticket = (overrides) => ({
  id: 'KAN-101', file: 'tickets/KAN-101.md', column: 'in-progress',
  title: 'Typed ticket', body: 'Body', blocked: '', base: 'remote', issue: '',
  reviewUrl: '', sessionId: '', attention: null, stalled: false,
  issueBlockers: [], issueComments: [], sync: { status: 'success' }, preview: '',
  ...overrides,
})

function createEnv(remote) {
  const surfaces = new Map()
  let registration = null
  const state = []
  let cursor = 0
  let effects = []
  const keydownListeners = []
  const activeElementBox = { current: null }
  const documentFake = {
    get activeElement() { return activeElementBox.current },
    set activeElement(value) { activeElementBox.current = value },
    addEventListener(type, listener) { if (type === 'keydown') keydownListeners.push(listener) },
    removeEventListener(type, listener) {
      const index = keydownListeners.indexOf(listener)
      if (index >= 0) keydownListeners.splice(index, 1)
    },
    createElement: () => ({ textContent: '', remove() {} }),
    head: { append() {} },
  }
  const pressEscape = () => {
    let stopped = false
    const event = { key: 'Escape', stopPropagation: () => { stopped = true } }
    for (const listener of Array.from(keydownListeners)) listener(event)
    return stopped
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => {
        state[index] = typeof value === 'function' ? value(state[index]) : value
      }]
    },
    useEffect(effect) { effects.push(effect) },
  }
  const slots = {
    inject: (_, setup) => setup(),
    register(meta, render) { surfaces.set(meta.name, render); return () => {} },
  }
  const calls = []
  const host = {
    call: (method, args = {}) => {
      calls.push({ method, args })
      const reply = remote(method, args, calls)
      if (reply && reply.pending) return new Promise(() => {})
      return Promise.resolve(reply)
    },
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: documentFake,
  })
  const plugin = registration.factory(() => React)
  plugin.apply({
    remote: { $mount: async () => () => {} },
    get: (name) => (name === 'slots' ? slots : name === 'remote.kanban' ? host : undefined),
    effect: (setup) => setup(),
  })
  const render = (element) => { cursor = 0; effects = []; return element.type(element.props) }
  const runEffects = () => effects.splice(0).map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
  // Expands one render pass, attributing each component's effects to a
  // surface group (board, dialog, confirm) so unmount cleanups can be run
  // for exactly the surfaces that went away — what React does automatically.
  const groupOf = (node, parentTag) => {
    if (typeof node.type !== 'function') return parentTag
    const name = node.type.name || ''
    if (name === 'DiscardConfirmDialog') return 'confirm'
    if (parentTag === 'confirm' || parentTag === 'dialog') return parentTag
    if (['TicketDialog', 'IssueImportDialog', 'BounceDialog', 'RecoveryDialog'].includes(name)) return 'dialog'
    return 'board'
  }
  const expand = (node, tag = 'board', groups) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((child) => expand(child, tag, groups))
    if (typeof node.type === 'function') {
      const nextTag = groupOf(node, tag)
      const before = effects.length
      const out = node.type(node.props)
      const pushed = effects.splice(before)
      if (groups) groups[nextTag].push(...pushed)
      return expand(out, nextTag, groups)
    }
    if (node.children !== undefined) return { ...node, children: expand(node.children, tag, groups) }
    return node
  }
  const renderPass = (element) => {
    cursor = 0
    effects = []
    const groups = { board: [], dialog: [], confirm: [] }
    const before = effects.length
    const tree = element.type(element.props)
    groups.board.push(...effects.splice(before))
    const expanded = expand(tree, 'board', groups)
    const runGroup = (list) => list.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
    return { tree: expanded, runGroups: () => ({ board: runGroup(groups.board), dialog: runGroup(groups.dialog), confirm: runGroup(groups.confirm) }) }
  }
  const findAll = (node, predicate, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) findAll(node.children, predicate, out)
    return out
  }
  const byClass = (tree, className) => findAll(tree, (el) =>
    typeof el.props?.className === 'string' && el.props.className.split(/\s+/).includes(className))
  const byText = (tree, text) => findAll(tree, (el) =>
    Array.isArray(el.children) && el.children.length === 1 && el.children[0] === text)
  return { surfaces, state, render, renderPass, runEffects, expand, findAll, byClass, byText, pressEscape, calls, document: documentFake, keydownListeners }
}

const watchReply = { ok: true, value: { ok: true, count: 0, tickets: [], syncRevision: 0 } }
const boardReply = (tickets) => ({ ok: true, value: { ok: true, tickets, wipLimit: 3 } })

const ALL_TICKETS = [
  ticket({}),
  ticket({ id: 'KAN-102', file: 'tickets/KAN-102.md', column: 'in-review', title: 'Review ticket', issue: 'https://github.com/auggie246/dsh-kanban/issues/9' }),
  ticket({ id: 'KAN-103', file: 'tickets/KAN-103.md', column: 'in-progress', title: 'Stalled ticket', stalled: true, attention: 'error' }),
]

const defaultRemote = (method) => {
  if (method === 'board.list') return boardReply(ALL_TICKETS)
  if (method === 'ticket.review') return { ok: true, value: { ok: false, error: 'local-completion-only' } }
  return watchReply
}

// Clicks the sidebar Kanban button, renders the overlay and its Board, and
// returns a session handle. session.pass() renders one full pass (Board
// plus expanded children) and runs the collected effects, mirroring React's
// mount/update cycle.
async function openBoardOverlay(env, remote) {
  const buttonFake = { focusCalls: 0, focus() { this.focusCalls += 1 } }
  env.document.activeElement = buttonFake
  const button = env.render(env.surfaces.get('sidebar.footer.action')({ wide: true }))
  button.props.onClick()
  env.state.length = 0
  const overlayElement = env.surfaces.get('shell.overlay')(SLOT_PROPS)
  const overlay = env.render(overlayElement)
  env.runEffects()
  assert.equal(overlay.props.className, 'kanban-board-overlay')
  env.state.length = 0
  const boardElement = overlay.children[0]
  const session = {
    button, buttonFake, overlayElement, boardElement,
    cleanups: [], prev: { dialog: [], confirm: [] },
    // One full pass: render the Board, expand children, run the collected
    // effects, and run the cleanups of any dialog or confirmation that
    // unmounted since the last pass (React's commit semantics).
    pass() {
      const { tree, runGroups } = env.renderPass(boardElement)
      const ran = runGroups()
      if (session.prev.confirm.length > 0 && env.byClass(tree, 'kanban-dialog-confirm').length === 0) {
        for (const cleanup of session.prev.confirm) cleanup()
      }
      if (session.prev.dialog.length > 0 && env.byClass(tree, 'kanban-dialog-backdrop').length === 0) {
        for (const cleanup of session.prev.dialog) cleanup()
      }
      session.prev = { dialog: ran.dialog, confirm: ran.confirm }
      session.cleanups = ran.board
      return tree
    },
  }
  session.pass()
  await new Promise((resolve) => setImmediate(resolve))
  session.tree = session.pass()
  return session
}

test('opening the Board overlay places focus inside it and the embedded Board does not', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  const root = session.tree
  assert.equal(root.props.className, 'kanban-board')
  assert.equal(root.props.tabIndex, -1)
  assert.equal(root.props.autoFocus, true)

  // The embedded Board (conversation.view) acquires no overlay-close
  // behavior: no close affordance, no focusable root, no Escape handler.
  // It gets its own environment so the overlay's registration above does
  // not answer the press.
  const embeddedEnv = createEnv(defaultRemote)
  const embeddedElement = embeddedEnv.surfaces.get('conversation.view')({ sessionId: 'session-a', useWorkspaces: SLOT_PROPS.useWorkspaces })
  embeddedEnv.state.length = 0
  const embedded = embeddedEnv.expand(embeddedEnv.render(embeddedElement))
  embeddedEnv.runEffects()
  assert.equal(embedded.props.className, 'kanban-board-embedded')
  const embeddedBoard = embedded.children[0]
  assert.equal(embeddedBoard.props.tabIndex, undefined)
  assert.equal(embeddedBoard.props.autoFocus, false)
  assert.equal(embeddedBoard.props.onKeyDown, undefined)
  assert.equal(embeddedEnv.byClass(embeddedBoard, 'kanban-close').length, 0)
  assert.equal(embeddedEnv.pressEscape(), false)
})

test('the Board close control is an icon button with an accessible name', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  const close = env.byClass(session.tree, 'kanban-close')
  assert.equal(close.length, 1)
  assert.equal(close[0].props['aria-label'], 'Close')
  assert.equal(close[0].props.title, 'Close the Board (Esc)')
  assert.equal(close[0].children.length, 1)
  assert.equal(close[0].children[0].type, 'svg')
  assert.equal(env.byText(session.tree, 'Close').length, 0)
})

test('Escape closes the Board overlay without clicking into it, and again after reopen', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  assert.equal(env.pressEscape(), true)
  env.state.length = 0
  const closed = env.render(session.overlayElement)
  assert.equal(closed, null)
  for (const cleanup of session.cleanups) cleanup()

  // Reopening re-registers the dismissal; nothing leaked from the last mount.
  session.button.props.onClick()
  env.state.length = 0
  env.state.length = 0
  const overlay = env.render(session.overlayElement)
  assert.notEqual(overlay, null)
  env.state.length = 0
  const boardElement = overlay.children[0]
  const reopened = env.renderPass(boardElement)
  reopened.runGroups()
  assert.equal(env.pressEscape(), true)
  assert.equal(env.render(session.overlayElement), null)
})

test('Escape closes the topmost dialog first, then the Board overlay', async () => {
  const kinds = [
    {
      name: 'Ticket create dialog',
      open: (tree, e) => e.byClass(tree, 'kanban-new-btn')[0].props.onClick({ stopPropagation() {} }),
    },
    {
      name: 'Ticket edit dialog',
      open: (tree, e) => e.byClass(tree, 'kanban-card')[0].props.onClick({ stopPropagation() {} }),
    },
    {
      name: 'Import dialog',
      open: (tree, e) => e.byClass(tree, 'kanban-import-btn')[0].props.onClick({ stopPropagation() {} }),
    },
    {
      name: 'Bounce dialog',
      open: (tree, e) => e.byClass(tree, 'kanban-card-reject')[0].props.onClick({ stopPropagation() {} }),
    },
    {
      name: 'Recovery dialog',
      open: (tree, e) => e.byText(tree, 'Send back to Ready')[0].props.onClick({ stopPropagation() {} }),
    },
  ]
  for (const kind of kinds) {
    const env = createEnv((method) => {
      if (method === 'issue.import.list') return { ok: true, value: { ok: true, platform: 'github', issues: [{ number: 7, title: 'Issue', url: 'u7', imported: false }] } }
      return defaultRemote(method)
    })
    const session = await openBoardOverlay(env)
    kind.open(session.tree, env)
    const opened = session.pass()
    const backdrops = env.byClass(opened, 'kanban-dialog-backdrop')
    assert.equal(backdrops.length, 1, kind.name + ' should open one dialog')
    assert.equal(env.findAll(opened, (el) => el.props && el.props.autoFocus === true).length >= 1, true, kind.name + ' should place keyboard focus inside')
    assert.equal(env.pressEscape(), true, kind.name + ' should stop propagation')
    const afterDialog = session.pass()
    assert.equal(env.byClass(afterDialog, 'kanban-dialog-backdrop').length, 0, kind.name + ' should close first')
    assert.equal(afterDialog.props.className, 'kanban-board', kind.name + ' must leave the Board open')
    assert.equal(env.pressEscape(), true)
    env.state.length = 0
    assert.equal(env.render(session.overlayElement), null, kind.name + ' Board closes on the next press')
  }
})

test('closing a dialog restores focus to its opener, then the Board restores it to the Kanban button', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  const cardFake = { focusCalls: 0, focus() { this.focusCalls += 1 } }
  env.document.activeElement = cardFake
  env.byClass(session.tree, 'kanban-card')[0].props.onClick()
  session.pass()
  assert.equal(cardFake.focusCalls, 0)
  assert.equal(env.pressEscape(), true)
  assert.equal(cardFake.focusCalls, 1, 'dialog close restores focus to its opener')
  session.pass()
  assert.equal(env.pressEscape(), true)
  assert.equal(session.buttonFake.focusCalls, 1, 'Board close restores focus to the Kanban button')
})

test('a dirty Ticket edit asks for confirmation and Keep editing preserves the edits', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  env.byClass(session.tree, 'kanban-card')[0].props.onClick()
  let tree = session.pass()
  const titleInput = env.findAll(tree, (el) => el.type === 'input' && el.props.value === 'Typed ticket')[0]
  titleInput.props.onChange({ target: { value: 'Rewritten title' } })
  tree = session.pass()

  // Escape on a dirty form opens the discard confirmation instead of closing.
  // The pass above is the re-render React runs between the change event and
  // the next keypress; the dismissal handler reads the fresh dirty state.
  assert.equal(env.pressEscape(), true)
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-confirm').length, 1)
  assert.equal(env.findAll(tree, (el) => el.type === 'input' && el.props.value === 'Rewritten title').length, 1, 'Ticket dialog stays open under the confirmation')

  // A second press answers the confirmation: edits stay, form stays open.
  assert.equal(env.pressEscape(), true)
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-confirm').length, 0)
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 1)
  const keptTitle = env.findAll(tree, (el) => el.type === 'input' && el.props.value === 'Rewritten title')
  assert.equal(keptTitle.length, 1, 'Keep editing preserves the edits')

  // The Cancel button takes the same confirm path; Discard edits closes.
  env.byText(tree, 'Cancel')[0].props.onClick()
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-confirm').length, 1)
  env.byText(tree, 'Discard edits')[0].props.onClick()
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 0, 'Discard edits closes the Ticket dialog')
})

test('an unchanged Ticket form closes immediately without a confirmation', async () => {
  const env = createEnv(defaultRemote)
  const session = await openBoardOverlay(env, defaultRemote)
  env.byClass(session.tree, 'kanban-card')[0].props.onClick()
  let tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 1)
  assert.equal(env.pressEscape(), true)
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 0)
  assert.equal(env.byClass(tree, 'kanban-dialog-confirm').length, 0)
  env.state.length = 0
  assert.equal(env.render(session.overlayElement) !== null, true, 'Board stays open')
})

test('Escape cannot dismiss a Ticket dialog while a save is pending', async () => {
  const env = createEnv((method) => {
    if (method === 'ticket.create') return { pending: true }
    return defaultRemote(method)
  })
  const session = await openBoardOverlay(env, defaultRemote)
  env.byClass(session.tree, 'kanban-new-btn')[0].props.onClick()
  let tree = session.pass()
  const titleInput = env.findAll(tree, (el) => el.type === 'input' && el.props.value === '')[0]
  titleInput.props.onChange({ target: { value: 'Pending ticket' } })
  tree = session.pass()
  env.byClass(tree, 'kanban-btn-primary')[0].props.onClick()
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-btn-primary')[0].children[0], 'Saving…')
  assert.equal(env.pressEscape(), true)
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 1, 'pending save blocks dismissal')
  assert.equal(env.byClass(tree, 'kanban-dialog-confirm').length, 0, 'no discard confirmation while saving')
})

test('Escape cannot dismiss the Import dialog while an import is pending', async () => {
  const env = createEnv((method) => {
    if (method === 'issue.import.list') return { ok: true, value: { ok: true, platform: 'github', issues: [{ number: 7, title: 'Issue', url: 'u7', imported: false }] } }
    if (method === 'issue.import.create') return { pending: true }
    return defaultRemote(method)
  })
  const session = await openBoardOverlay(env, defaultRemote)
  env.byClass(session.tree, 'kanban-import-btn')[0].props.onClick()
  let tree = session.pass()
  await new Promise((resolve) => setImmediate(resolve))
  tree = session.pass()
  const checkbox = env.findAll(tree, (el) => el.type === 'input' && el.props.type === 'checkbox')[0]
  checkbox.props.onChange()
  tree = session.pass()
  env.byClass(tree, 'kanban-btn-primary')[0].props.onClick()
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-btn-primary')[0].children[0], 'Importing…')
  assert.equal(env.pressEscape(), true)
  tree = session.pass()
  assert.equal(env.byClass(tree, 'kanban-dialog-backdrop').length, 1, 'pending import blocks dismissal')
})
