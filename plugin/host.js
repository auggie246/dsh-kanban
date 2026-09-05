// Host half of the kanban Plugin — M2 (issue #6, session watch loop).
//
// `cordis_define` receives plugin/frontmatter.js, plugin/settings.js,
// plugin/execution.js, and plugin/watch.js concatenated before this file.
// Their helpers are in scope. Plain JavaScript only: no imports, no
// TypeScript, and no Node globals.
//
// Write behaviour: every Ticket File write goes through the fs service's
// writeText, which stages the content in a private temp file and publishes
// it with rename — that is the "temp file + rename" atomicity issue #2 asks
// for, provided by the service and not re-implemented here. ticket.create
// additionally passes { kind: 'createIfAbsent' } so a racing creator's file
// is never overwritten.

return {
  inject: ['workspaceRegistry', 'fs', 'storageDomain', 'shell', 'agents', 'agentDefaultModel', 'agentPresets'],
  async apply(ctx) {
    const registry = ctx.workspaceRegistry
    const fs = ctx.fs
    const storageDomain = ctx.storageDomain
    const shell = ctx.shell
    const agents = ctx.agents
    const agentDefaultModel = ctx.agentDefaultModel
    const agentPresets = ctx.agentPresets

    const settingsDomain = await storageDomain.open({
      name: 'kanban_settings',
      version: 1,
      tables: { workspaces: { valueSchema: kanbanSettingsRecordSchema } },
    })
    const settingsTable = settingsDomain.table('workspaces')
    const executionDomain = await storageDomain.open({
      name: 'kanban_execution',
      version: 1,
      tables: { tickets: { valueSchema: kanbanExecutionRecordSchema } },
    })
    const executionTable = executionDomain.table('tickets')
    let settingsAdmissionOpen = true
    let settingsTail = Promise.resolve()

    const enqueueSettings = (operation) => {
      if (!settingsAdmissionOpen) return Promise.reject(new Error('Board settings are stopping'))
      const result = settingsTail.then(operation)
      settingsTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }

    ctx.effect(
      () => async () => {
        settingsAdmissionOpen = false
        await settingsTail
        await executionDomain.close()
        await settingsDomain.close()
      },
      'kanban.settingsDomainClose',
    )

    const settingsView = (workspace, settings) => ({
      workspaceId: String(workspace.id),
      title: workspace.title,
      path: settings.path,
      wipLimit: settings.wipLimit,
    })

    const persistWorkspaceSettings = async (workspaceId, settings) => {
      const current = settingsTable.get(workspaceId)
      if (
        current === undefined ||
        current.path !== settings.path ||
        current.wipLimit !== settings.wipLimit
      ) {
        await settingsTable.put(workspaceId, settings)
      }
      return settings
    }

    const ensureWorkspaceSettings = async (workspace) => {
      const entry = kanbanWorkspaceSettingEntries(
        [workspace],
        (workspaceId) => settingsTable.get(workspaceId),
      )[0]
      return persistWorkspaceSettings(entry.workspaceId, entry.settings)
    }

    const syncWorkspaceSettings = async () => {
      const workspaces = registry.list()
      const entries = kanbanWorkspaceSettingEntries(
        workspaces,
        (workspaceId) => settingsTable.get(workspaceId),
      )
      const liveIds = new Set(entries.map((entry) => entry.workspaceId))
      const result = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        const settings = await persistWorkspaceSettings(entry.workspaceId, entry.settings)
        result.push(settingsView(workspaces[index], settings))
      }
      for (const workspaceId of settingsTable.keys()) {
        if (!liveIds.has(String(workspaceId))) await settingsTable.delete(workspaceId)
      }
      return result
    }

    ctx.on('domain/changed', (change) => {
      if (change.domain !== 'workspace' || change.table !== 'workspaces' || !settingsAdmissionOpen) return
      void enqueueSettings(syncWorkspaceSettings).catch((err) => {
        console.error('kanban settings sync failed: ' + String((err && err.message) || err))
      })
    })

    // Materialize the UUID-to-path mapping for every registered Workspace.
    await enqueueSettings(syncWorkspaceSettings)

    // Only real Ticket File names are ever resolved for read/write; this
    // stops path traversal through crafted `file` arguments.
    const isTicketFileName = (file) => /^kan-\d+-[a-z0-9-]+\.md$/i.test(file)

    const workspaceOf = (args) => {
      const workspaceId = args && typeof args.workspaceId === 'string' ? args.workspaceId : ''
      if (workspaceId === '') return { error: 'workspaceId required' }
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) return { error: 'workspace-not-found' }
      return { workspaceId, workspace }
    }

    const ticketsDir = (workspace) => workspace.path.replace(/\/+$/, '') + '/.dsh-kanban/tickets'

    // Load one existing Ticket File for the update/move methods.
    const readTicket = async (dirPath, file) => {
      if (!isTicketFileName(file)) return { error: 'invalid-ticket-file' }
      const target = await fs.resolve(dirPath + '/' + file)
      const info = await fs.stat(target)
      if (info === undefined || info.type !== 'file') return { error: 'ticket-not-found' }
      const text = await fs.readText(target)
      if (parseTicketFile(file, text) === null) return { error: 'not-a-ticket-file' }
      return { target, text }
    }

    const syncExecutionLinkage = async (workspaceId, card) => {
      const key = workspaceId + '/' + card.id
      const stored = executionTable.get(key)
      if (card.sessionId === '' || card.worktreePath === '' || card.branch === '') {
        if (stored !== undefined) await executionTable.delete(key)
        return
      }
      const linkage = {
        workspaceId,
        ticketId: card.id,
        sessionId: card.sessionId,
        worktreePath: card.worktreePath,
        branch: card.branch,
        // The spawn sha is recorded by ticket execution and cannot be
        // derived from the Ticket File; carry it across re-syncs so the
        // watch loop's commit check survives a linkage rewrite.
        baseSha: stored !== undefined && typeof stored.baseSha === 'string' ? stored.baseSha : '',
      }
      if (
        stored === undefined ||
        stored.sessionId !== linkage.sessionId ||
        stored.worktreePath !== linkage.worktreePath ||
        stored.branch !== linkage.branch
      ) {
        await executionTable.put(key, linkage)
      }
    }

    // Session-watch state (issue #6). Both maps are live-only: they are
    // rebuilt from real events as sessions run, and the durable facts stay
    // in the Ticket Files and the execution linkage table.
    const watchAttention = new Map() // sessionId → 'approval' | 'error' | 'finished'
    const watchLastTurnEnd = new Map() // sessionId → last turn/end reason kind

    // Locate one Ticket File by its Ticket id. The Ticket File — not the
    // linkage record — is the source of truth for the Ticket's column.
    const findTicketByTicketId = async (workspaceId, ticketId) => {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) return undefined
      let dir
      try {
        dir = await fs.resolve(ticketsDir(workspace))
        const info = await fs.stat(dir)
        if (info === undefined || info.type !== 'directory') return undefined
      } catch {
        return undefined
      }
      const entries = await fs.listDir(dir)
      for (const entry of entries) {
        if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
        try {
          const text = await fs.readText(entry.target)
          const card = parseTicketFile(entry.name, text)
          if (card !== null && card.id === ticketId) return { card, text, target: entry.target }
        } catch {
          // An unreadable Ticket File cannot be watched; skip it.
        }
      }
      return undefined
    }

    const watchRunGit = (workdir, args) => {
      const result = shell.run(
        shell.resolve({
          command: args.map((arg) => "'" + String(arg).replace(/'/g, "'\\''") + "'").join(' '),
          workdir,
          timeoutMs: 30000,
          stdoutMaxBytes: 65536,
        }),
      )
      return result.then((run) => {
        if (run.exitCode !== 0) throw new Error(run.stderr.text.trim() || 'git command failed')
        return run.stdout.text.trim()
      })
    }

    // Bind the dynamic Host capabilities to the Board session-watch seam
    // (plugin/watch.js). Every side effect goes through this adapter.
    const watchAdapter = {
      async linkageFor(sessionId) {
        for (const key of executionTable.keys()) {
          const linkage = executionTable.get(key)
          if (linkage !== undefined && linkage.sessionId === sessionId) return linkage
        }
        return undefined
      },
      async linkedTicketColumn(linkage) {
        const found = await findTicketByTicketId(linkage.workspaceId, linkage.ticketId)
        // A stale linkage (frontmatter edited by hand) must not move a
        // Ticket that no longer belongs to this session.
        if (found === undefined || found.card.sessionId !== linkage.sessionId) return ''
        return found.card.column
      },
      branchHasCommits: (linkage) => {
        const workspace = registry.get(linkage.workspaceId)
        if (workspace === undefined) return Promise.resolve(false)
        return kanbanBranchHasCommits(linkage, (args) => watchRunGit(workspace.path, args))
      },
      async moveTicketToInReview(linkage) {
        const found = await findTicketByTicketId(linkage.workspaceId, linkage.ticketId)
        if (found === undefined) return
        const text = kanbanSetAttr(found.text, 'column', 'in-review')
        if (text === null) return
        await fs.writeText(found.target, text)
      },
    }

    // Drive one signal through the watch seam. A watch failure must never
    // break the Host event loop, so everything is contained here.
    const forwardWatchSignal = async (request) => {
      try {
        const { attention } = await kanbanHandleSessionSignal(request, watchAdapter)
        if (attention !== undefined) {
          if (attention === null) watchAttention.delete(request.sessionId)
          else watchAttention.set(request.sessionId, attention)
        }
      } catch (err) {
        console.error('kanban watch: ' + request.signal + ' for ' + request.sessionId + ' failed: ' + String((err && err.message) || err))
      }
    }

    // The session-watch interface: DSH session events in, watch signals out.
    // `approval/asked` and `approval/decided` are log-only audit events on
    // the session log, so observing them never joins the approval waterfall.
    ctx.on('session/event', (session, event) => {
      const sessionId = session && session.id
      if (sessionId === undefined || sessionId === '') return
      if (event.type === 'turn/end') {
        const kind = (event.data && event.data.reason && event.data.reason.kind) || ''
        watchLastTurnEnd.set(sessionId, kind)
        void forwardWatchSignal({ signal: 'turn-end', sessionId, reason: { kind } })
        return
      }
      if (event.type === 'approval/asked') {
        void forwardWatchSignal({ signal: 'approval-asked', sessionId })
      } else if (event.type === 'approval/decided') {
        void forwardWatchSignal({ signal: 'approval-decided', sessionId })
      }
    })

    // agent/status fires exactly on running ↔ idle transitions; `reasonKind`
    // carries the preceding turn's end reason so an idle after a completed
    // turn can auto-move its Ticket. Any queued input re-opens a turn first,
    // so idle genuinely means the loop is done.
    ctx.on('agent/status', ({ agent, status }) => {
      const sessionId = agent && agent.id
      if (sessionId === undefined || sessionId === '') return
      const reasonKind = status === 'idle' ? watchLastTurnEnd.get(sessionId) : undefined
      if (status === 'idle') watchLastTurnEnd.delete(sessionId)
      void forwardWatchSignal({ signal: 'status', sessionId, status, reasonKind })
    })

    ctx.on('agent/error', ({ agent }) => {
      const sessionId = agent && agent.id
      if (sessionId === undefined || sessionId === '') return
      void forwardWatchSignal({ signal: 'agent-error', sessionId })
    })

    // board.list({ workspaceId }) → card data for every Ticket File in the
    // Workspace. Ticket Files stay read-only; this call also repairs their
    // derived execution linkage index. A missing directory is an empty Board,
    // not an error; a single unreadable file is logged and skipped. Cards carry
    // the full body now: the card editor pre-fills from board.list output,
    // which saves a second round trip per opened Ticket.
    ctx.effect(() =>
      harness.handle('board.list', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        try {
          const boardSettings = await enqueueSettings(() => ensureWorkspaceSettings(workspaceLookup.workspace))
          const dir = await fs.resolve(ticketsDir(workspaceLookup.workspace))
          const info = await fs.stat(dir)
          if (info === undefined || info.type !== 'directory') {
            return {
              ok: true,
              workspaceId: workspaceLookup.workspaceId,
              workspaceTitle: workspaceLookup.workspace.title,
              wipLimit: boardSettings.wipLimit,
              tickets: [],
            }
          }
          const entries = await fs.listDir(dir)
          const tickets = []
          for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
            try {
              const text = await fs.readText(entry.target)
              const card = parseTicketFile(entry.name, text)
              if (card !== null) {
                try {
                  await syncExecutionLinkage(workspaceLookup.workspaceId, card)
                } catch (err) {
                  console.error('board.list: execution linkage sync failed for ' + card.id + ': ' + String((err && err.message) || err))
                }
                tickets.push({
                  ...card,
                  file: entry.name,
                  // Live Attention Badge state for the card's session; null
                  // when the session needs nothing.
                  attention: watchAttention.get(card.sessionId) || null,
                })
              }
            } catch (err) {
              console.error('board.list: skipping unreadable Ticket File ' + entry.name + ': ' + String((err && err.message) || err))
            }
          }
          return {
            ok: true,
            workspaceId: workspaceLookup.workspaceId,
            workspaceTitle: workspaceLookup.workspace.title,
            wipLimit: boardSettings.wipLimit,
            tickets,
          }
        } catch (err) {
          return { ok: false, error: 'board-read-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // board.watch.list() → the live Attention Badge aggregate across every
    // registered Workspace's linked Tickets. The sidebar Kanban button polls
    // this while the Board is closed; the reply is owned plain JSON.
    ctx.effect(() =>
      harness.handle('board.watch.list', async () => {
        try {
          const linkages = []
          for (const key of executionTable.keys()) {
            const linkage = executionTable.get(key)
            if (linkage !== undefined) linkages.push(linkage)
          }
          const summary = kanbanWatchSummary(linkages, (sessionId) => watchAttention.get(sessionId))
          return { ok: true, count: summary.count, tickets: summary.tickets }
        } catch (err) {
          return { ok: false, error: 'watch-read-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // board.settings.list() → one durable settings record per registered
    // Workspace. Calling it also repairs any stale UUID-to-path mapping.
    ctx.effect(() =>
      harness.handle('board.settings.list', async () => {
        try {
          return { ok: true, workspaces: await enqueueSettings(syncWorkspaceSettings) }
        } catch (err) {
          return { ok: false, error: 'settings-read-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // board.settings.update({ workspaceId, wipLimit }) → the committed record.
    ctx.effect(() =>
      harness.handle('board.settings.update', async (args) => {
        const workspaceId = args && typeof args.workspaceId === 'string' ? args.workspaceId : ''
        if (workspaceId === '') return { ok: false, error: 'workspaceId required' }
        const wipLimit = kanbanParseWipLimit(args && args.wipLimit)
        if (wipLimit === null) return { ok: false, error: 'wipLimit must be a positive whole number' }
        try {
          const view = await enqueueSettings(async () => {
            const workspace = registry.get(workspaceId)
            if (workspace === undefined) return undefined
            const settings = { path: workspace.path, wipLimit }
            await settingsTable.put(workspaceId, settings)
            return settingsView(workspace, settings)
          })
          if (view === undefined) return { ok: false, error: 'workspace-not-found' }
          return { ok: true, ...view }
        } catch (err) {
          return { ok: false, error: 'settings-write-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.create({ workspaceId, title, body }) → a new Ticket File in the
    // backlog column. The id continues the highest existing KAN number
    // (KAN-101 when the Board is empty); the file name is <id>-<slug>.md.
    ctx.effect(() =>
      harness.handle('ticket.create', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const title = String((args && args.title) || '').trim()
        if (title === '') return { ok: false, error: 'title required' }
        const body = String((args && args.body) || '')
        const base = args && args.base === 'head' ? 'head' : undefined
        const dirPath = ticketsDir(workspaceLookup.workspace)
        try {
          let names = []
          const dir = await fs.resolve(dirPath)
          const info = await fs.stat(dir)
          if (info !== undefined && info.type === 'directory') {
            const entries = await fs.listDir(dir)
            names = entries.filter((entry) => entry.type === 'file').map((entry) => {
              const m = /^(kan-\d+)/i.exec(entry.name)
              return m ? m[1] : null
            })
          }
          const id = kanbanNextId(names)
          const file = id + '-' + kanbanSlug(title) + '.md'
          const text = serializeTicketFile({ id, title, column: 'backlog', issue: '', base }, body)
          const target = await fs.resolve(dirPath + '/' + file)
          await fs.writeText(target, text, { kind: 'createIfAbsent' })
          return { ok: true, id, file }
        } catch (err) {
          return { ok: false, error: 'ticket-create-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.update({ workspaceId, file, title, body, blocked, base }) →
    // rewrites title, blocked, base and body via surgical patches, so every
    // other frontmatter field (issue, branch, linkage, unknown keys)
    // stays byte-identical. An empty blocked value clears the badge.
    ctx.effect(() =>
      harness.handle('ticket.update', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const title = String((args && args.title) || '').trim()
        if (title === '') return { ok: false, error: 'title required' }
        const dirPath = ticketsDir(workspaceLookup.workspace)
        try {
          const loaded = await readTicket(dirPath, String((args && args.file) || ''))
          if (loaded.error !== undefined) return { ok: false, error: loaded.error }
          const blocked = String((args && args.blocked) || '').trim()
          let text = kanbanSetAttr(loaded.text, 'title', title)
          text = kanbanSetAttr(text, 'blocked', blocked === '' ? null : blocked)
          text = kanbanSetAttr(text, 'base', args && args.base === 'head' ? 'head' : null)
          text = kanbanSetBody(text, String((args && args.body) || ''))
          if (text === null) return { ok: false, error: 'not-a-ticket-file' }
          await fs.writeText(loaded.target, text)
          return { ok: true, file: String(args.file) }
        } catch (err) {
          return { ok: false, error: 'ticket-update-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.move({ workspaceId, file, column }) starts Ticket execution only
    // for Ready → In Progress. Other valid moves retain their surgical write.
    ctx.effect(() =>
      harness.handle('ticket.move', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const column = String((args && args.column) || '').trim().toLowerCase()
        if (!KANBAN_COLUMNS.includes(column)) return { ok: false, error: 'invalid-column' }
        const file = String((args && args.file) || '')
        const dirPath = ticketsDir(workspaceLookup.workspace)
        try {
          const loaded = await readTicket(dirPath, file)
          if (loaded.error !== undefined) return { ok: false, error: loaded.error }
          const card = parseTicketFile(file, loaded.text)
          if (card === null) return { ok: false, error: 'not-a-ticket-file' }
          if (column === 'in-progress' && card.column === 'ready') {
            if (card.sessionId !== '') return { ok: false, error: 'ticket-already-started' }
            const slugMatch = /^kan-\d+-([a-z0-9-]+)\.md$/i.exec(file)
            if (slugMatch === null) return { ok: false, error: 'invalid-ticket-file' }
            const linkage = await kanbanStartTicketExecution(
              {
                workspaceId: workspaceLookup.workspaceId,
                workspacePath: workspaceLookup.workspace.path,
                ticketId: card.id,
                ticketSlug: slugMatch[1],
                ticketText: loaded.text,
                baseMode: card.base,
              },
              kanbanHostExecutionAdapter({
                workspace: workspaceLookup.workspace,
                loaded,
                fs,
                shell,
                agents,
                agentDefaultModel,
                agentPresets,
                executionTable,
                setTicketAttr: kanbanSetAttr,
              }),
            )
            return { ok: true, file, column, ...linkage }
          }
          const text = kanbanSetAttr(loaded.text, 'column', column)
          if (text === null) return { ok: false, error: 'not-a-ticket-file' }
          await fs.writeText(loaded.target, text)
          return { ok: true, file, column }
        } catch (err) {
          return { ok: false, error: 'ticket-move-failed: ' + String((err && err.message) || err) }
        }
      }),
    )
  },
}
