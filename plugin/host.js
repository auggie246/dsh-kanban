// Host half of the kanban Plugin — execution, review Bounce, and Stalled recovery.
//
// `cordis_define` receives plugin/frontmatter.js, plugin/settings.js,
// plugin/queue.js, plugin/execution.js, plugin/watch.js, plugin/bounce.js, and
// plugin/completion.js concatenate before this file. Their helpers are in scope. Plain JavaScript only: no
// imports, no TypeScript, and no Node globals.
//
// Write behaviour: every Ticket File write goes through the fs service's
// writeText, which stages the content in a private temp file and publishes
// it with rename — that is the "temp file + rename" atomicity issue #2 asks
// for, provided by the service and not re-implemented here. ticket.create
// additionally passes { kind: 'createIfAbsent' } so a racing creator's file
// is never overwritten.

return {
  inject: ['workspaceRegistry', 'fs', 'storageDomain', 'shell', 'agents', 'agentDefaultModel', 'agentPresets', 'skills'],
  async apply(ctx) {
    const registry = ctx.workspaceRegistry
    const fs = ctx.fs
    const storageDomain = ctx.storageDomain
    const shell = ctx.shell
    const agents = ctx.agents
    const agentDefaultModel = ctx.agentDefaultModel
    const agentPresets = ctx.agentPresets
    const skills = ctx.skills
    // Retain exact factory handles: disposing an Agent scope alone does not
    // unregister its session. Never dispose an unrelated, externally owned Agent.
    const sessionHandles = new Map()
    const rememberSession = (handle) => sessionHandles.set(handle.agent.id, handle)

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
            rememberSession,
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

      if (card.column === 'in-progress' && !kanbanIsQueued(card) && column === 'ready') {
        return { ok: false, error: 'send-back-required' }
      }

      if (card.column === 'in-review' && column !== 'in-review') {
        if (column === 'done') return { ok: false, error: 'accept-required' }
        if (column === 'in-progress') return { ok: false, error: 'bounce-comment-required' }
        return { ok: false, error: 'review-decision-required' }
      }

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
            rememberSession,
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

    // Session-watch state (issue #6). Both maps are live-only: they are
    // rebuilt from real events as sessions run, and the durable facts stay
    // in the Ticket Files and the execution linkage table.
    const watchAttention = new Map() // sessionId → 'approval' | 'error' | 'finished'
    const watchMessages = new Map() // sessionId → owned error message
    const watchLastTurnEnd = new Map() // sessionId → last turn/end reason kind
    const watchRevision = new Map() // sessionId → generation of the current turn
    const invalidateWatch = (sessionId) => {
      watchRevision.set(sessionId, (watchRevision.get(sessionId) || 0) + 1)
      watchLastTurnEnd.delete(sessionId)
      watchAttention.delete(sessionId)
      watchMessages.delete(sessionId)
    }

    const cardAttention = (card) => {
      const attention = watchAttention.get(card.sessionId) || null
      if (card.column !== 'in-progress' || kanbanIsQueued(card)) return attention
      const agent = agents.get(card.sessionId)
      if (!card.sessionId || agent === undefined) return 'error'
      if (agent.status === 'idle' && attention !== 'approval') return 'error'
      return attention
    }

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
          if (card !== null && card.id === ticketId) return { card, text, target: entry.target, file: entry.name }
        } catch {
          // An unreadable Ticket File cannot be watched; skip it.
        }
      }
      return undefined
    }

    const watchRunGit = async (workdir, args) => {
      const result = await kanbanRunHostGit(shell, workdir, args, { stdoutMaxBytes: 65536 })
      return result.text.trim()
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
      async moveTicketToInReview(linkage, revision) {
        // Recheck inside the move tail: a Bounce or a new turn may have
        // invalidated this completion while the branch check was pending.
        return enqueueMove(async () => {
          const found = await findTicketByTicketId(linkage.workspaceId, linkage.ticketId)
          const workspace = registry.get(linkage.workspaceId)
          if (found === undefined || workspace === undefined ||
            found.card.column !== 'in-progress' || found.card.sessionId !== linkage.sessionId ||
            (watchRevision.get(linkage.sessionId) || 0) !== revision) return false
          const result = await moveTicket(
            { workspaceId: linkage.workspaceId, workspace }, found.file, 'in-review',
          )
          return result.ok
        })
      },
    }

    // Drive one signal through the watch seam. A watch failure must never
    // break the Host event loop, so everything is contained here.
    const forwardWatchSignal = async (request) => {
      const revision = watchRevision.get(request.sessionId) || 0
      try {
        const { attention } = await kanbanHandleSessionSignal(request, {
          ...watchAdapter,
          moveTicketToInReview: (linkage) => watchAdapter.moveTicketToInReview(linkage, revision),
        })
        if (attention !== undefined && (watchRevision.get(request.sessionId) || 0) === revision) {
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
        const failure = event.data && event.data.reason && event.data.reason.error
        if (kind === 'error') watchMessages.set(sessionId,
          failure && typeof failure.message === 'string' ? failure.message : 'Agent Session errored.')
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
      if (status === 'running') invalidateWatch(sessionId)
      if (status === 'idle') watchLastTurnEnd.delete(sessionId)
      void forwardWatchSignal({ signal: 'status', sessionId, status, reasonKind })
    })

    ctx.on('agent/error', ({ agent, error }) => {
      const sessionId = agent && agent.id
      if (sessionId === undefined || sessionId === '') return
      invalidateWatch(sessionId)
      watchLastTurnEnd.set(sessionId, 'error')
      watchMessages.set(sessionId, error && typeof error.message === 'string' ? error.message :
        typeof error === 'string' ? error : 'Agent Session errored.')
      void forwardWatchSignal({ signal: 'agent-error', sessionId })
    })

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
          // readBoardCards owns the scan; this view adds each card's live
          // Attention Badge state (issue #6): null when the session needs
          // nothing.
          const tickets = (await readBoardCards(workspaceLookup)).map((card) => ({
            ...card,
            attention: cardAttention(card),
            stalled: card.column === 'in-progress' && cardAttention(card) === 'error',
            attentionMessage: cardAttention(card) === 'error'
              ? watchMessages.get(card.sessionId) || 'Agent Session stopped before completing the Ticket.' : null,
          }))
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
          const tickets = []
          for (const workspace of registry.list()) {
            const workspaceId = String(workspace.id)
            for (const card of await readBoardCards({ workspaceId, workspace })) {
              const attention = cardAttention(card)
              if (attention) tickets.push({ workspaceId, ticketId: card.id, attention })
            }
          }
          tickets.sort((a, b) => a.ticketId.localeCompare(b.ticketId))
          const summary = { count: tickets.length, tickets }
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
          // Share the move tail so a description edit cannot overwrite a
          // concurrent Bounce's column or history with an earlier file read.
          return await enqueueMove(async () => {
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
          })
        } catch (err) {
          return { ok: false, error: 'ticket-update-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    let refinementSequence = 0
    // ticket.refine({ workspaceId, file }) starts a Refinement Session only
    // when the external skill is model-invocable for this Workspace. The Host
    // never writes the Ticket File or creates a Worktree during this action.
    ctx.effect(() =>
      harness.handle('ticket.refine', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const file = String((args && args.file) || '')
        let handle
        try {
          const loaded = await readTicket(ticketsDir(workspaceLookup.workspace), file)
          if (loaded.error !== undefined) return { ok: false, error: loaded.error }
          const card = parseTicketFile(file, loaded.text)
          if (card === null) return { ok: false, error: 'not-a-ticket-file' }
          if (card.column !== 'backlog') return { ok: false, error: 'ticket-not-in-backlog' }

          const catalog = await skills.list({ cwd: workspaceLookup.workspace.path })
          const available = catalog.some((skill) =>
            skill.name === 'grill-with-docs' && skill.invocation && skill.invocation.modelInvocable === true)
          if (!available) {
            return {
              ok: false,
              error: 'Install the external `grill-with-docs` skill with model invocation enabled before starting a Refinement Session.',
            }
          }

          const workspacePath = workspaceLookup.workspace.path.replace(/\/+$/, '')
          const sessionId = ('kanban-refine-' + workspaceLookup.workspaceId + '-' + card.id + '-' +
            Date.now() + '-' + (++refinementSequence)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
          const selection = agentDefaultModel.currentSelection()
          const preset = await agentPresets.resolve()
          handle = await agents.create({
            sessionId,
            meta: { cwd: workspacePath, agentPreset: preset.id },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => agentPresets.mount(agentCtx, preset.id),
          })
          rememberSession(handle)
          await handle.agent.whenIdle()
          const brief = [
            'Refine ' + card.id + ' by using the external `grill-with-docs` skill.',
            '',
            'First, call the `skill` tool with `grill-with-docs`. Follow its instructions completely.',
            'Interview the user to extract the goal, context, and acceptance criteria.',
            '',
            'Refinement rules:',
            '- Work in the plain Workspace `' + workspacePath + '`.',
            '- Read and write only the Ticket File `' + loaded.target + '`.',
            '- Do not create, edit, rename, or delete any other file.',
            '- Preserve the Ticket File frontmatter exactly.',
            '- The Ticket must remain in Backlog. Only the user may move it to Ready.',
            '- Do not create or use a Worktree, branch, or commit.',
            '- After the interview, write the enriched goal, context, and acceptance criteria into the Ticket File body.',
            '- Keep the markdown human-readable so the user can review its diff before moving the Ticket.',
            '',
            'Current Ticket File:',
            '',
            loaded.text,
          ].join('\n')
          handle.agent.followup({
            id: 'kanban-refine-brief-' + sessionId,
            role: 'user',
            content: [{ type: 'text', text: brief }],
            source: { kind: 'plugin', plugin: 'dsh-kanban' },
          })
          return { ok: true, sessionId }
        } catch (err) {
          if (handle !== undefined) {
            try { await handle.dispose() } catch {}
            if (handle.agent) sessionHandles.delete(handle.agent.id)
          }
          return { ok: false, error: 'ticket-refine-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    const completionGit = (workspace) => (args, allowed = [0]) =>
      kanbanRunHostGit(shell, workspace.path, args, { allowedExitCodes: allowed })
    ctx.effect(() => harness.handle('ticket.review', async (args) => {
      const lookup = workspaceOf(args)
      if (!lookup.workspace) return { ok: false, error: lookup.error }
      try {
        return await enqueueMove(async () => {
          const file = String((args && args.file) || '')
          const loaded = await readTicket(ticketsDir(lookup.workspace), file)
          if (loaded.error) throw new Error(loaded.error)
          return { ok: true, ...await kanbanLocalReview({ file, text: loaded.text, workspacePath: lookup.workspace.path }, completionGit(lookup.workspace)) }
        })
      } catch (error) { return { ok: false, error: 'ticket-review-failed: ' + String(error.message || error) } }
    }))

    ctx.effect(() => harness.handle('ticket.accept', async (args) => {
      const lookup = workspaceOf(args)
      if (!lookup.workspace) return { ok: false, error: lookup.error }
      try {
        return await enqueueMove(async () => {
          const file = String((args && args.file) || '')
          const loaded = await readTicket(ticketsDir(lookup.workspace), file)
          if (loaded.error) throw new Error(loaded.error)
          const card = parseTicketFile(file, loaded.text)
          const agent = agents.get(card.sessionId)
          let handle
          if (agent !== undefined) {
            if (agent.status !== 'idle') throw new Error('session-not-idle')
            handle = sessionHandles.get(card.sessionId)
            if (!handle || handle.agent !== agent) throw new Error('session-not-owned-by-board')
          }
          const result = await kanbanAcceptLocalTicket({ file, text: loaded.text, workspacePath: lookup.workspace.path, review: args.review }, {
            git: completionGit(lookup.workspace),
            persistTicket: (text) => fs.writeText(loaded.target, text),
            async releaseSession() {
              if (!handle) return
              await handle.dispose()
              sessionHandles.delete(card.sessionId)
            },
          })
          await executionTable.delete(lookup.workspaceId + '/' + card.id)
          invalidateWatch(card.sessionId)
          await pumpQueue(lookup).catch(logPumpFailure)
          return { ok: true, ...result }
        })
      } catch (error) { return { ok: false, error: 'ticket-accept-failed: ' + String(error.message || error) } }
    }))

    let recoverySequence = 0
    const recoveryTicket = async (workspaceLookup, file) => {
      const loaded = await readTicket(ticketsDir(workspaceLookup.workspace), file)
      if (loaded.error) throw new Error(loaded.error)
      const card = parseTicketFile(file, loaded.text)
      if (card.column !== 'in-progress' || kanbanIsQueued(card) || cardAttention(card) !== 'error') {
        throw new Error('ticket-not-stalled')
      }
      if (!card.sessionId || !card.branch || !card.worktreePath) throw new Error('ticket-not-started')
      const slug = /^kan-\d+-([a-z0-9-]+)\.md$/i.exec(file)[1]
      const root = workspaceLookup.workspace.path.replace(/\/+$/, '')
      if (card.worktreePath !== root + '/.dsh-kanban/worktrees/' + slug ||
          card.branch !== 'kanban/' + card.id + '-' + slug) throw new Error('unsafe-execution-linkage')
      const agent = agents.get(card.sessionId)
      if (agent !== undefined && agent.status !== 'idle') throw new Error('session-not-idle')
      return { loaded, card, agent }
    }

    ctx.effect(() => harness.handle('ticket.resume', async (args) => {
      const lookup = workspaceOf(args)
      if (!lookup.workspace) return { ok: false, error: lookup.error }
      try {
        return await enqueueMove(async () => {
          let { card, agent } = await recoveryTicket(lookup, String((args && args.file) || ''))
          if (!agent) {
            const handle = await agents.resume({
              resumeSessionId: card.sessionId,
              setup: (agentCtx) => agentPresets.mount(agentCtx, agentCtx.agent.session.header.agentPreset),
            })
            rememberSession(handle)
            try {
              await handle.agent.whenIdle()
              if (handle.agent.session.header.cwd !== card.worktreePath) throw new Error('session-worktree-mismatch')
              agent = handle.agent
            } catch (error) {
              await handle.dispose()
              sessionHandles.delete(card.sessionId)
              throw error
            }
          }
          if (agents.get(card.sessionId) !== agent || agent.status !== 'idle') throw new Error('session-not-idle')
          agent.steer({
            id: 'kanban-resume-' + card.sessionId + '-' + Date.now() + '-' + (++recoverySequence),
            role: 'user', content: [{ type: 'text', text: 'Continue the Ticket from where you stopped. Keep existing work and commit the completed result.' }],
          })
          invalidateWatch(card.sessionId)
          return { ok: true, sessionId: card.sessionId }
        })
      } catch (err) {
        return { ok: false, error: 'ticket-resume-failed: ' + String((err && err.message) || err) }
      }
    }))

    ctx.effect(() => harness.handle('ticket.retry', async (args) => {
      const lookup = workspaceOf(args)
      if (!lookup.workspace) return { ok: false, error: lookup.error }
      try {
        return await enqueueMove(async () => {
          const file = String((args && args.file) || '')
          const { loaded, card, agent } = await recoveryTicket(lookup, file)
          const git = (args) => watchRunGit(lookup.workspace.path, ['-C', card.worktreePath, ...args])
          if (await git(['rev-parse', '--show-toplevel']) !== card.worktreePath ||
              await git(['symbolic-ref', '--short', 'HEAD']) !== card.branch) throw new Error('worktree-linkage-mismatch')
          if (agent && (agents.get(card.sessionId) !== agent || agent.status !== 'idle')) throw new Error('session-not-idle')
          if (agent) {
            const handle = sessionHandles.get(card.sessionId)
            if (!handle || handle.agent !== agent) throw new Error('session-not-owned-by-board')
            await handle.dispose()
            sessionHandles.delete(card.sessionId)
          }
          invalidateWatch(card.sessionId)
          const adapter = kanbanHostExecutionAdapter({
            workspace: lookup.workspace, loaded, fs, shell, agents, rememberSession,
            agentDefaultModel, agentPresets, executionTable, setTicketAttr: kanbanSetAttr,
          })
          const sessionId = 'kanban-retry-' + card.id.toLowerCase() + '-' + Date.now() + '-' + (++recoverySequence)
          const key = lookup.workspaceId + '/' + card.id
          const previous = executionTable.get(key)
          let session
          try {
            session = await adapter.createSession({ sessionId, cwd: card.worktreePath })
            await adapter.persistTicket(kanbanSetAttr(loaded.text, 'sessionId', sessionId))
            await adapter.persistLinkage(key, {
              workspaceId: lookup.workspaceId, ticketId: card.id, sessionId,
              branch: card.branch, worktreePath: card.worktreePath, baseSha: previous ? previous.baseSha : '',
            })
            await adapter.followup(session,
              'Continue the Ticket. Inspect and preserve existing work in this Worktree before making changes.\n\n' +
              kanbanExecutionBrief(loaded.text, card.branch, lookup.workspace.path, card.worktreePath))
            return { ok: true, sessionId }
          } catch (error) {
            const failures = []
            for (const operation of [
              () => session && adapter.disposeSession(session),
              () => adapter.persistTicket(loaded.text),
              () => previous ? adapter.persistLinkage(key, previous) : adapter.deleteLinkage(key),
            ]) {
              try { await operation() } catch (failure) { failures.push(String(failure.message || failure)) }
            }
            watchAttention.set(card.sessionId, 'error')
            watchMessages.set(card.sessionId, 'Retry fresh failed: ' + String(error.message || error))
            throw new Error(String(error.message || error) + (failures.length ? '; rollback failed: ' + failures.join('; ') : ''))
          }
        })
      } catch (err) {
        return { ok: false, error: 'ticket-retry-failed: ' + String((err && err.message) || err) }
      }
    }))

    const cleanupConfirmations = new Map()
    ctx.effect(() => harness.handle('ticket.sendBack', async (args) => {
      const lookup = workspaceOf(args)
      if (!lookup.workspace) return { ok: false, error: lookup.error }
      try {
        return await enqueueMove(async () => {
          const file = String((args && args.file) || '')
          const { loaded, card, agent } = await recoveryTicket(lookup, file)
          const root = lookup.workspace.path.replace(/\/+$/, '')
          const handle = agent && sessionHandles.get(card.sessionId)
          if (agent && (!handle || handle.agent !== agent)) throw new Error('session-not-owned-by-board')
          const git = (args) => watchRunGit(root, args)
          const worktree = ['-C', card.worktreePath]
          if (await git([...worktree, 'rev-parse', '--show-toplevel']) !== card.worktreePath ||
              await git([...worktree, 'symbolic-ref', '--short', 'HEAD']) !== card.branch) throw new Error('worktree-linkage-mismatch')
          if (await git([...worktree, 'status', '--porcelain', '--untracked-files=all', '--ignored']) !== '') {
            throw new Error('worktree-not-clean: preserve or remove uncommitted and ignored files before sending back')
          }
          const head = await git(['rev-parse', '--verify', 'refs/heads/' + card.branch])
          const base = await git(['rev-parse', '--verify', 'HEAD'])
          const unmergedCommits = Number(await git(['rev-list', '--count', base + '..' + head]))
          if (!Number.isSafeInteger(unmergedCommits) || unmergedCommits < 0) throw new Error('invalid-commit-count')
          const key = lookup.workspaceId + '/' + card.id
          const snapshot = [card.sessionId, card.branch, card.worktreePath, head, base].join('\n')
          const pending = cleanupConfirmations.get(key)
          if (unmergedCommits > 0 && (!pending || pending.snapshot !== snapshot || args.confirmation !== pending.token)) {
            const token = 'cleanup-' + Date.now() + '-' + (++recoverySequence)
            cleanupConfirmations.set(key, { token, snapshot })
            return { ok: false, confirmationRequired: true, confirmation: token, unmergedCommits,
              error: 'Delete ' + unmergedCommits + ' commits not merged into Workspace HEAD, and remove the Worktree?' }
          }
          if (agent && (agents.get(card.sessionId) !== agent || agent.status !== 'idle')) throw new Error('session-not-idle')
          if (handle) { await handle.dispose(); sessionHandles.delete(card.sessionId) }
          invalidateWatch(card.sessionId)
          const previous = executionTable.get(key)
          let removed = false
          let branchDeleted = false
          let text = loaded.text
          for (const [name, value] of [['column', 'ready'], ['sessionId', null], ['worktreePath', null], ['branch', null], ['queued', null]]) {
            text = kanbanSetAttr(text, name, value)
          }
          try {
            await git(['worktree', 'remove', card.worktreePath])
            removed = true
            // Delete only the exact confirmed head; a concurrent commit fails closed.
            await git(['update-ref', '-d', 'refs/heads/' + card.branch, head])
            branchDeleted = true
            await fs.writeText(loaded.target, text)
            await executionTable.delete(key)
          } catch (error) {
            const failures = []
            const restore = async (operation) => {
              try { await operation() } catch (failure) { failures.push(String(failure.message || failure)) }
            }
            if (branchDeleted) await restore(() => git(['branch', card.branch, head]))
            if (removed) await restore(() => git(['worktree', 'add', card.worktreePath, card.branch]))
            await restore(() => fs.writeText(loaded.target, loaded.text))
            if (previous) await restore(() => executionTable.put(key, previous))
            watchAttention.set(card.sessionId, 'error')
            watchMessages.set(card.sessionId, 'Send back failed: ' + String(error.message || error))
            throw new Error(String(error.message || error) + (failures.length ? '; rollback failed: ' + failures.join('; ') : ''))
          }
          cleanupConfirmations.delete(key)
          await pumpQueue(lookup).catch(logPumpFailure)
          return { ok: true, column: 'ready' }
        })
      } catch (err) {
        return { ok: false, error: 'ticket-send-back-failed: ' + String((err && err.message) || err) }
      }
    }))

    let bounceSequence = 0
    ctx.effect(() =>
      harness.handle('ticket.bounce', async (args) => {
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const file = String((args && args.file) || '')
        try {
          return await enqueueMove(async () => {
            const loaded = await readTicket(ticketsDir(workspaceLookup.workspace), file)
            if (loaded.error !== undefined) return { ok: false, error: loaded.error }
            const at = new Date().toISOString()
            const result = await kanbanBounceTicket(
              { file, ticketText: loaded.text, comment: args && args.comment, at },
              {
                liveAgent: (sessionId) => agents.get(sessionId),
                persistTicket: (text) => fs.writeText(loaded.target, text),
                steer(agent, comment) {
                  agent.steer({
                    id: 'kanban-bounce-' + agent.id + '-' + at + '-' + (++bounceSequence),
                    role: 'user',
                    content: [{ type: 'text', text: comment }],
                  })
                  invalidateWatch(agent.id)
                },
              },
            )
            return { ok: true, ...result }
          })
        } catch (err) {
          return { ok: false, error: 'ticket-bounce-failed: ' + String((err && err.message) || err) }
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
