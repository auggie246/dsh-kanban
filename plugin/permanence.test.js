const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

test('package exposes a permanent Web Bundle with one kanban Host composition row', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-kanban')
  assert.equal(pkg.main, 'lib/index.mjs')
  assert.deepEqual(pkg.exports, {
    '.': './lib/index.mjs',
    './client': './lib/client.js',
    './typert': './lib/remote.mjs',
    './package.json': './package.json',
  })
  assert.deepEqual(pkg.dsh, {
    bundle: { patch: './cordis.patch.yml' },
    client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' },
  })
  assert.equal(pkg.scripts.prepare, 'npm run build:permanent')
  assert.equal(pkg.scripts['build:permanent'], 'node scripts/build-permanent.mjs')
  assert.ok(pkg.files.includes('lib/'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.match(pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol'], /0\.1\.2/)

  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:\s+\- id: kanban\s+name: ['"]?dsh-kanban['"]?/)
})

test('permanent Host routes browser calls through the registered Board methods', async () => {
  const { createKanbanController } = await import('../lib/remote.mjs')
  const handlers = new Map([
    ['board.list', async (args) => ({ ok: true, workspaceId: args.workspaceId })],
  ])
  const controller = createKanbanController(handlers)

  assert.deepEqual(await controller.call('board.list', { workspaceId: 'workspace-a' }), {
    ok: true,
    workspaceId: 'workspace-a',
  })
  await assert.rejects(() => controller.call('missing.method', {}), /unknown Host method missing\.method/)
})

test('permanent Host keeps the dynamic storageDomain identities', () => {
  const host = fs.readFileSync(path.join(root, 'lib/index.mjs'), 'utf8')
  for (const domain of ['kanban_settings', 'kanban_execution', 'kanban_issue_sync']) {
    assert.equal(host.split(`name: '${domain}'`).length - 1, 1, `${domain} must stay unchanged`)
  }
})

test('permanent browser mount registers the same four Board surfaces', async () => {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8'), {
    window,
    console,
    setInterval,
    clearInterval,
  })
  assert.equal(registration.id, 'dsh-kanban')

  const mounted = registration.factory((name) => {
    assert.equal(name, 'react')
    return { createElement() {}, Fragment: Symbol('Fragment') }
  })
  const surfaces = []
  const slots = {
    inject(name, setup) {
      assert.equal(typeof setup, 'function')
      setup()
    },
    register(meta) {
      surfaces.push(meta)
      return () => {}
    },
  }
  const pendingEffects = []
  let mountedRemote
  const ctx = {
    slots,
    remote: { $mount: async (manifest) => { mountedRemote = manifest; return async () => {} } },
    get(name) {
      if (name === 'slots') return slots
      return undefined
    },
    effect(setup) {
      pendingEffects.push(Promise.resolve(setup()))
    },
  }
  mounted.apply(ctx)
  await Promise.all(pendingEffects)

  assert.deepEqual(JSON.parse(JSON.stringify(surfaces)), [
    { name: 'sidebar.footer.action', id: 'kanban', order: 100, label: 'Kanban' },
    { name: 'shell.overlay', id: 'kanban-board', order: 10, label: 'Kanban Board' },
    { name: 'conversation.view', id: 'kanban-board', order: 20, label: 'Board' },
    { name: 'settings.section', id: 'kanban-settings', order: 30, label: 'Kanban' },
  ])
  const { TYPERT } = await import('../lib/remote.mjs')
  const invocationShape = (invocation) => ({
    id: invocation.id,
    service: invocation.service,
    namespace: invocation.namespace,
    method: invocation.method,
    invocation: invocation.invocation,
    parameters: invocation.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.wire,
      source: parameter.source,
      typeSymbol: parameter.codec.typeSymbol,
    })),
    resultTypeSymbol: invocation.result.typeSymbol,
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(invocationShape(mountedRemote.descriptors[0]))),
    invocationShape(TYPERT.invocations[0]),
  )
})

test('README documents permanent installation, restart, data continuity, and uninstall', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  assert.match(readme, /dsh plugin --profile web add \/path\/to\/dsh-kanban/)
  assert.match(readme, /Restart `dsh web`/)
  assert.match(readme, /kanban_settings/)
  assert.match(readme, /dsh plugin --profile web remove dsh-kanban/)
})

test('permanent Host and browser artifacts match the proven plugin sources', () => {
  const result = spawnSync(process.execPath, ['scripts/build-permanent.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
