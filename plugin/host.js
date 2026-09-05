// Host half of the kanban Plugin — M1 (issue #4, Ticket execution).
//
// `cordis_define` receives plugin/frontmatter.js, plugin/settings.js,
// plugin/queue.js, and plugin/execution.js concatenated before this file.
// Their helpers are in scope.
// Plain JavaScript only: no imports, no TypeScript, and no Node globals.
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

    let moveAdmissionOpen = true
    let moveTail = Promise.resolve()

    // Ticket moves mutate shared WIP queue state. One tail serializes every
    // ticket.move, so two overlapping drops cannot both win the last slot.
    // Moves are human-paced, so waiting behind an auto-spawn is acceptable.
    const enqueueMove = (operation) => {
      if (!moveAdmissionOpen) return Promise.reject(new Error('Board ticket moves are stopping'))
      const result = moveTail.then(operation)
      moveTail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }

    ctx.effect(
      () => async () => {
        settingsAdmissionOpen = false
        moveAdmissionOpen = false
        await settingsTail
        await moveTail
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

    // The durable WIP limit for one Workspace as stored right now; moves and
    // the queue pump read it without repairing the settings record.
    const wipLimitFor = (workspaceLookup) => {
      const stored = settingsTable.get(workspaceLookup.workspaceId)
      return kanbanWorkspaceSettings(workspaceLookup.workspace, stored).wipLimit
    }

    // Scan a Workspace's Ticket Files into card data, repairing each card's
    // derived execution linkage while reading. A missing directory is an
    // empty Board, not an error; a single unreadable file is logged and
    // skipped. Shared by board.list, queue admission, and the queue pump.
    const readBoardCards = async (workspaceLookup) => {
      const dir = await fs.resolve(ticketsDir(workspaceLookup.workspace))
      const info = await fs.stat(dir)
      if (info === undefined || info.type !== 'directory') return []
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
              console.error('kanban: execution linkage sync failed for ' + card.id + ': ' + String((err && err.message) || err))
            }
            tickets.push({ ...card, file: entry.name })
          }
        } catch (err) {
          console.error('kanban: skipping unreadable Ticket File ' + entry.name + ': ' + String((err && err.message) || err))
        }
      }
      return tickets
    }

    // pumpQueue auto-spawns queued Tickets while slots are free: the earliest
    // queued Ticket per free slot, re-reading the Board after each spawn. It
    // runs after any move that can free a slot or grow the queue. A failed
    // spawn leaves the Ticket queued (kanbanStartTicketExecution rolls back)
    // and the next move retries, so callers only log pump failures.
    const pumpQueue = async (workspaceLookup) => {
      const dirPath = ticketsDir(workspaceLookup.workspace)
      for (;;) {
        const tickets = await readBoardCards(workspaceLookup)
        const plan = kanbanQueuePlan({ tickets, wipLimit: wipLimitFor(workspaceLookup) })
        if (plan === undefined) return
        const slugMatch = /^kan-\d+-([a-z0-9-]+)\.md$/i.exec(plan.file)
        if (slugMatch === null) return
        const loaded = await readTicket(dirPath, plan.file)
        if (loaded.error !== undefined) return
        const card = parseTicketFile(plan.file, loaded.text)
        if (card === null || !kanbanIsQueued(card)) return
        await kanbanStartTicketExecution(
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
      }
    }

    const logPumpFailure = (err) => {
      console.error('kanban: queue pump failed, queued Tickets keep their state: ' + String((err && err.message) || err))
    }

    // moveTicket runs serialized behind enqueueMove. Ready → In Progress is
    // the only move that spawns execution (ADR-0001), so it is also the only
    // move the WIP queue gates: past the limit, or when queued Tickets
    // already wait, the Ticket queues instead of spawning. Every other move
    // stays the surgical column write; a Ticket leaving In Progress drops
    // its queue marker, so dragging a queued Ticket to Ready dequeues it
    // with no session spawned. After any move that can free a slot, the
    // pump auto-spawns the earliest queued Ticket.
    const moveTicket = async (workspaceLookup, file, column) => {
      const dirPath = ticketsDir(workspaceLookup.workspace)
      const loaded = await readTicket(dirPath, file)
      if (loaded.error !== undefined) return { ok: false, error: loaded.error }
      const card = parseTicketFile(file, loaded.text)
      if (card === null) return { ok: false, error: 'not-a-ticket-file' }

      // A queued Ticket dropped on In Progress again is already in line.
      if (column === 'in-progress' && kanbanIsQueued(card)) {
        return { ok: true, file, column, queued: true }
      }

      if (column === 'in-progress' && card.column === 'ready') {
        if (card.sessionId !== '') return { ok: false, error: 'ticket-already-started' }
        const tickets = await readBoardCards(workspaceLookup)
        const admission = kanbanQueueAdmission({ tickets, wipLimit: wipLimitFor(workspaceLookup) })
        if (admission.action === 'queue') {
          let queuedText = kanbanSetAttr(loaded.text, 'column', column)
          queuedText = kanbanSetAttr(queuedText, 'queued', new Date().toISOString())
          if (queuedText === null) return { ok: false, error: 'not-a-ticket-file' }
          await fs.writeText(loaded.target, queuedText)
          // The queue head may now have a free slot (issue #5 keeps the
          // queue strictly FIFO — the moved Ticket never jumps it).
          await pumpQueue(workspaceLookup).catch(logPumpFailure)
          return { ok: true, file, column, queued: true }
        }
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

      let text = kanbanSetAttr(loaded.text, 'column', column)
      if (kanbanIsQueued(card)) text = kanbanSetAttr(text, 'queued', null)
      if (text === null) return { ok: false, error: 'not-a-ticket-file' }
      await fs.writeText(loaded.target, text)
      await pumpQueue(workspaceLookup).catch(logPumpFailure)
      return { ok: true, file, column }
    }

    // board.list({ workspaceId }) → card data for every Ticket File in the
    // Workspace. Ticket Files stay read-only. A missing directory is an
    // empty Board, not an error; a single unreadable file is logged and
    // skipped. Cards carry the full body now: the card editor pre-fills from
    // board.list output, which saves a second round trip per opened Ticket.
    ctx.effect(() =>
      harness.handle('board.list', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        try {
          const boardSettings = await enqueueSettings(() => ensureWorkspaceSettings(workspaceLookup.workspace))
          const tickets = await readBoardCards(workspaceLookup)
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

    // ticket.move({ workspaceId, file, column }) moves a Ticket and drives
    // the WIP queue: over-limit Ready → In Progress enqueues, moves that
    // free a slot auto-spawn the earliest queued Ticket, and a queued
    // Ticket moved anywhere drops its queue marker (manual dequeue is the
    // move back to Ready). Moves serialize behind one tail.
    ctx.effect(() =>
      harness.handle('ticket.move', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const column = String((args && args.column) || '').trim().toLowerCase()
        if (!KANBAN_COLUMNS.includes(column)) return { ok: false, error: 'invalid-column' }
        const file = String((args && args.file) || '')
        try {
          return await enqueueMove(() => moveTicket(workspaceLookup, file, column))
        } catch (err) {
          return { ok: false, error: 'ticket-move-failed: ' + String((err && err.message) || err) }
        }
      }),
    )
  },
}
