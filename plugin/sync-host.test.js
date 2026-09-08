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
  if (options.queuedTicket) {
    fs.writeFileSync(path.join(ticketsDir, 'KAN-102-queued.md'), [
      '---',
      'id: KAN-102',
      'title: Queued linked Ticket',
      'column: in-progress',
      'queued: "2026-08-01T12:00:00.000Z"',
      'issue: "' + issue + '"',
      '---',
      'Wait for a slot.',
      '',
    ].join('\n'))
  }

  const methods = new Map()
  const disposers = []
  const commands = []
  const messages = []
  let remoteLabels = options.remoteLabels
    ? [...options.remoteLabels]
    : ['bug', 'kanban:' + column, 'kanban:stale']
  let issueState = options.issueState || 'open'
  let remoteTitle = options.remoteTitle || 'Remote title'
  let remoteBody = options.remoteBody || 'Remote description.'
  const issueComments = options.remoteComments ? [...options.remoteComments] : []
  const remoteBlockers = options.remoteBlockers ? [...options.remoteBlockers] : []
  let remoteFailure = options.remoteFailure || ''
  const workspace = { id: 'workspace-sync', title: 'Sync Workspace', path: root }
  const expectedLabelList = platform === 'github'
    ? "'gh' 'label' 'list' '--repo' '" + repo + "' '--search' 'kanban:" + targetColumn + "' '--limit' '100' '--json' 'name'"
    : "'glab' 'label' 'list' '--repo' '" + repo + "' '--output' 'json' '--page' '1' '--per-page' '100'"
  const expectedLabelCreate = platform === 'github'
    ? "'gh' 'label' 'create' 'kanban:" + targetColumn + "' '--repo' '" + repo + "'"
    : "'glab' 'label' 'create' '--name' 'kanban:" + targetColumn + "' '--repo' '" + repo + "'"
  const expectedView = platform === 'github'
    ? "'gh' 'issue' 'view' '" + issue + "' '--repo' '" + repo + "' '--json' 'labels,state'"
    : "'glab' 'issue' 'view' '12' '--repo' '" + repo + "' '--output' 'json'"
  const staleLabels = remoteLabels.filter((name) => name.startsWith('kanban:') && name !== 'kanban:' + targetColumn)
  const expectedEdit = platform === 'github'
    ? "'gh' 'issue' 'edit' '" + issue + "' '--repo' '" + repo + "' '--add-label' 'kanban:" + targetColumn + "' '--remove-label' '" + staleLabels.join(',') + "'"
    : "'glab' 'issue' 'update' '12' '--repo' '" + repo + "' '--label' 'kanban:" + targetColumn + "' '--unlabel' '" + staleLabels.join(',') + "'"
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
        if (remoteFailure && (request.command.startsWith("'gh' ") || request.command.startsWith("'glab' "))) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: remoteFailure } }
        }
        if (request.command === expectedLabelList || request.command.startsWith(platform === 'github'
          ? "'gh' 'label' 'list'" : "'glab' 'label' 'list'")) {
          return { exitCode: 0, stdout: { text: '[]' }, stderr: { text: '' } }
        }
        if (request.command === expectedLabelCreate || request.command.startsWith(platform === 'github'
          ? "'gh' 'label' 'create'" : "'glab' 'label' 'create'")) {
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command === expectedView || request.command.startsWith(platform === 'github'
          ? "'gh' 'issue' 'view' '" + issue + "' '--repo' '" + repo + "' '--json' 'labels,state'"
          : "'glab' 'issue' 'view' '12' '--repo' '" + repo + "' '--output' 'json'")) {
          if (options.beforeLabelView) await options.beforeLabelView()
          const labels = platform === 'github'
            ? remoteLabels.map((name) => ({ name }))
            : remoteLabels
          return { exitCode: 0, stdout: { text: JSON.stringify({ labels, state: issueState }) }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'gh' 'issue' 'view'") && request.command.includes("'title,body,state,comments,labels,blockedBy'")) {
          if (remoteFailure) return { exitCode: 1, stdout: { text: '' }, stderr: { text: remoteFailure } }
          return {
            exitCode: 0,
            stdout: { text: JSON.stringify({
              title: remoteTitle,
              body: remoteBody,
              state: issueState.toUpperCase(),
              labels: remoteLabels.map((name) => ({ name })),
              comments: issueComments.map((body, index) => ({
                id: 'comment-' + String(index + 1), body, url: issue + '#issuecomment-' + String(index + 1),
                createdAt: '2026-08-01T12:00:00Z', author: { login: 'reviewer' },
              })),
              blockedBy: { nodes: remoteBlockers, totalCount: remoteBlockers.length },
            }) },
            stderr: { text: '' },
          }
        }
        if (request.command === "'glab' 'api' 'projects/g%2Fr/issues/12'") {
          if (remoteFailure) return { exitCode: 1, stdout: { text: '' }, stderr: { text: remoteFailure } }
          return { exitCode: 0, stdout: { text: JSON.stringify({
            iid: 12, title: remoteTitle, description: remoteBody, state: issueState, labels: remoteLabels, web_url: issue,
          }) }, stderr: { text: '' } }
        }
        if (request.command === "'glab' 'api' 'projects/g%2Fr/issues/12/notes' '--paginate'") {
          return { exitCode: 0, stdout: { text: JSON.stringify(issueComments.map((body, index) => ({
            id: index + 1, body, web_url: issue + '#note_' + String(index + 1), created_at: '2026-08-01T12:00:00Z',
            author: { username: 'reviewer' }, system: false,
          }))) }, stderr: { text: '' } }
        }
        if (request.command === "'glab' 'api' 'projects/g%2Fr/issues/12/links' '--paginate'") {
          return { exitCode: 0, stdout: { text: JSON.stringify(remoteBlockers.map((blocker) => ({
            id: blocker.id, iid: blocker.number, title: blocker.title, web_url: blocker.url,
            state: blocker.state.toLowerCase(), link_type: 'is_blocked_by',
          }))) }, stderr: { text: '' } }
        }
        if (request.command === expectedEdit) {
          remoteLabels = remoteLabels.filter((name) => !name.startsWith('kanban:'))
          remoteLabels.push('kanban:' + targetColumn)
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command.startsWith(platform === 'github' ? "'gh' 'issue' 'edit'" : "'glab' 'issue' 'update'")) {
          const values = [...request.command.matchAll(/'([^']*)'/g)].map((match) => match[1])
          const labelFlag = platform === 'github' ? '--add-label' : '--label'
          const removeFlag = platform === 'github' ? '--remove-label' : '--unlabel'
          const added = values.indexOf(labelFlag)
          const removed = values.indexOf(removeFlag)
          if (removed !== -1) {
            const stale = new Set(values[removed + 1].split(','))
            remoteLabels = remoteLabels.filter((name) => !stale.has(name))
          }
          if (added !== -1 && !remoteLabels.includes(values[added + 1])) remoteLabels.push(values[added + 1])
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'gh' 'issue' 'view'") && request.command.includes("'state,comments'")) {
          return {
            exitCode: 0,
            stdout: { text: JSON.stringify({ state: issueState.toUpperCase(), comments: issueComments.map((body) => ({ body })) }) },
            stderr: { text: '' },
          }
        }
        if (request.command.startsWith("'gh' 'issue' 'close'") && request.command.includes("'--comment'")) {
          assert.match(request.command, /https:\/\/github\.com\/o\/r\/pull\/7/)
          issueComments.push('Completed by merged PR/MR: https://github.com/o/r/pull/7\n\n<!-- dsh-kanban-completion:https://github.com/o/r/pull/7 -->')
          issueState = 'closed'
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'glab' 'issue' 'note'")) {
          assert.match(request.command, /https:\/\/gitlab\.com\/g\/r\/-\/merge_requests\/7/)
          issueComments.push('Completed by merged PR/MR: https://gitlab.com/g/r/-/merge_requests/7\n\n<!-- dsh-kanban-completion:https://gitlab.com/g/r/-/merge_requests/7 -->')
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'glab' 'issue' 'close'")) {
          issueState = 'closed'
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (request.command.startsWith("'gh' 'issue' 'reopen'") || request.command.startsWith("'glab' 'issue' 'reopen'")) {
          issueState = 'open'
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (options.merged && request.command.startsWith("'gh' 'pr' 'view'")) {
          return {
            exitCode: 0,
            stdout: { text: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'MERGED', mergedAt: '2026-08-01T12:00:00Z' }) },
            stderr: { text: '' },
          }
        }
        if (options.merged && request.command.startsWith("'glab' 'mr' 'view'")) {
          return {
            exitCode: 0,
            stdout: { text: JSON.stringify({ web_url: 'https://gitlab.com/g/r/-/merge_requests/7', state: 'merged', merged_at: '2026-08-01T12:00:00Z' }) },
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
    issueState: () => issueState,
    issueComments: () => issueComments,
    recoverRemote: () => { remoteFailure = '' },
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
      assert.equal(listed.tickets[0].sync.status, 'ok')
    })
  }
})

test('periodic pull applies remote text and comments while Board state wins', async (t) => {
  for (const platform of ['github', 'gitlab']) {
    await t.test(platform, async (t) => {
      const board = await openSyncBoard(t, platform, {
        column: 'ready', targetColumn: 'ready',
        remoteTitle: 'Remote title changed',
        remoteBody: 'Remote description changed.',
        remoteComments: ['Remote review comment.'],
        remoteLabels: ['bug', 'kanban:done'],
        issueState: 'closed',
      })

      const watched = await board.call('board.watch.list')
      const card = (await board.call('board.list')).tickets[0]

      assert.equal(watched.ok, true, watched.error)
      assert.ok(watched.syncRevision > 0)
      assert.equal(card.title, 'Remote title changed')
      assert.equal(card.body, 'Remote description changed.\n')
      assert.equal(card.column, 'ready')
      assert.equal(card.issueComments[0].body, 'Remote review comment.')
      assert.deepEqual(board.labels(), ['bug', 'kanban:ready'])
      assert.equal(board.issueState(), 'open')

      const updated = await board.call('ticket.update', {
        title: 'Local overwrite', body: 'Local overwrite.', blocked: '', base: 'remote',
      })
      const afterUpdate = (await board.call('board.list')).tickets[0]
      assert.equal(updated.ok, true, updated.error)
      assert.equal(afterUpdate.title, 'Remote title changed')
      assert.equal(afterUpdate.body, 'Remote description changed.\n')
      assert.equal(afterUpdate.column, 'ready')
    })
  }
})

test('a periodic pull cannot restore a stale label after a concurrent Ticket move', async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let labelViews = 0
  const board = await openSyncBoard(t, 'github', {
    column: 'backlog', targetColumn: 'ready', remoteLabels: ['bug', 'kanban:stale'],
    async beforeLabelView() {
      labelViews += 1
      if (labelViews === 1) {
        entered.resolve()
        await release.promise
      }
    },
  })

  const pull = board.call('board.watch.list')
  await entered.promise
  const move = board.call('ticket.move', { column: 'ready' })
  release.resolve()
  const [, moved] = await Promise.all([pull, move])

  assert.equal(moved.ok, true, moved.error)
  assert.deepEqual(board.labels(), ['bug', 'kanban:ready'])
})

test('sync failures appear on the Ticket without blocking Board moves and clear after retry', async (t) => {
  for (const failure of ['network offline', 'authentication required']) {
    await t.test(failure, async (t) => {
      const board = await openSyncBoard(t, 'github', { remoteFailure: failure })

      const moved = await board.call('ticket.move', { column: 'ready' })
      const failed = (await board.call('board.list')).tickets[0]

      assert.equal(moved.ok, true, moved.error)
      assert.equal(failed.column, 'ready')
      assert.equal(failed.sync.status, 'error')
      assert.match(failed.sync.error, new RegExp(failure))

      board.recoverRemote()
      const retried = await board.call('ticket.move', { column: 'ready' })
      const recovered = (await board.call('board.list')).tickets[0]
      assert.equal(retried.ok, true, retried.error)
      assert.equal(recovered.sync.status, 'ok')
      assert.equal(recovered.sync.error, '')
      assert.deepEqual(board.labels(), ['bug', 'kanban:ready'])
    })
  }
})

test('an open native blocker appears on the Ticket and prevents In Progress', async (t) => {
  for (const platform of ['github', 'gitlab']) {
    await t.test(platform, async (t) => {
      const blockerUrl = platform === 'github'
        ? 'https://github.com/o/r/issues/99'
        : 'https://gitlab.com/g/r/-/issues/99'
      const board = await openSyncBoard(t, platform, {
        column: 'ready', targetColumn: 'ready',
        remoteBlockers: [{ id: 'blocker-99', number: 99, title: 'Open dependency', url: blockerUrl, state: 'OPEN' }],
      })

      const reply = await board.call('ticket.move', { column: 'in-progress' })
      const card = (await board.call('board.list')).tickets[0]

      assert.deepEqual(card.issueBlockers, [{
        id: 'blocker-99', number: 99, title: 'Open dependency', url: blockerUrl, state: 'open',
      }])
      assert.equal(reply.ok, false)
      assert.equal(reply.error, 'issue-blocked')
      assert.deepEqual(reply.blockers, card.issueBlockers)
      assert.equal((await board.call('board.list')).tickets[0].column, 'ready')
    })
  }
})

test('a queued Ticket that gains a native blocker returns to Ready instead of starting', async (t) => {
  const board = await openSyncBoard(t, 'github', {
    queuedTicket: true,
    remoteBlockers: [{
      id: 'blocker-99', number: 99, title: 'Open dependency',
      url: 'https://github.com/o/r/issues/99', state: 'OPEN',
    }],
  })

  const reply = await board.call('ticket.move', { column: 'ready' })
  const queued = (await board.call('board.list')).tickets.find((card) => card.id === 'KAN-102')

  assert.equal(reply.ok, true, reply.error)
  assert.equal(queued.column, 'ready')
  assert.equal(queued.queued, '')
  assert.equal(queued.issueBlockers.length, 1)
})

test('a linked Ticket cannot start Refinement that edits remote-owned text', async (t) => {
  const board = await openSyncBoard(t, 'github')

  const reply = await board.call('ticket.refine')

  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'linked-ticket-text-owned-by-issue')
})

test('a direct Done move cannot bypass the required completion reference', async (t) => {
  const board = await openSyncBoard(t, 'github', { column: 'ready', targetColumn: 'done' })

  const reply = await board.call('ticket.move', { column: 'done' })

  assert.equal(reply.ok, false)
  assert.equal(reply.error, 'completion-required')
  assert.equal((await board.call('board.list')).tickets[0].column, 'ready')
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

test('merged remote completion labels and closes the linked Issue with its PR or MR reference', async (t) => {
  for (const platform of ['github', 'gitlab']) {
    await t.test(platform, async (t) => {
      const board = await openSyncBoard(t, platform, {
        column: 'in-review', targetColumn: 'done', execution: true, merged: true,
      })

      const reply = await board.call('board.watch.list')

      assert.equal(reply.ok, true, reply.error)
      assert.deepEqual(board.labels(), ['bug', 'kanban:done'])
      assert.equal(board.issueState(), 'closed')
      assert.equal(board.issueComments().length, 1)
      assert.match(board.issueComments()[0], platform === 'github' ? /github\.com\/o\/r\/pull\/7/ : /gitlab\.com\/g\/r\/-\/merge_requests\/7/)
      await board.call('board.watch.list')
      assert.equal(board.issueComments().length, 1)
      assert.equal((await board.call('board.list')).tickets[0].sync.status, 'ok')
    })
  }
})
