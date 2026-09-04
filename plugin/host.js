// Host half of the kanban Plugin — M0 (issue #2, editable Board).
//
// `cordis_define` receives plugin/frontmatter.js concatenated in front of
// this file, so parseTicketFile, kanbanSlug, kanbanNextId,
// serializeTicketFile, kanbanSetAttr, kanbanSetBody and KANBAN_COLUMNS are
// already in scope below. Plain JavaScript only: no imports, no TypeScript,
// no Node globals.
//
// Write behaviour: every Ticket File write goes through the fs service's
// writeText, which stages the content in a private temp file and publishes
// it with rename — that is the "temp file + rename" atomicity issue #2 asks
// for, provided by the service and not re-implemented here. ticket.create
// additionally passes { kind: 'createIfAbsent' } so a racing creator's file
// is never overwritten.

return {
  apply(ctx) {
    const registry = ctx.get('workspaceRegistry')
    const fs = ctx.get('fs')

    const unavailable = () => ({ ok: false, error: 'host services unavailable' })

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

    // board.list({ workspaceId }) → card data for every Ticket File in the
    // Workspace. Read-only: a missing directory is an empty Board, not an
    // error; a single unreadable file is logged and skipped. Cards carry
    // the full body now: the card editor pre-fills from board.list output,
    // which saves a second round trip per opened Ticket.
    ctx.effect(() =>
      harness.handle('board.list', async (args) => {
        if (registry === undefined || fs === undefined) return unavailable()
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        try {
          const dir = await fs.resolve(ticketsDir(workspaceLookup.workspace))
          const info = await fs.stat(dir)
          if (info === undefined || info.type !== 'directory') {
            return { ok: true, workspaceId: workspaceLookup.workspaceId, workspaceTitle: workspaceLookup.workspace.title, tickets: [] }
          }
          const entries = await fs.listDir(dir)
          const tickets = []
          for (const entry of entries) {
            if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
            try {
              const text = await fs.readText(entry.target)
              const card = parseTicketFile(entry.name, text)
              if (card !== null) tickets.push({ ...card, file: entry.name })
            } catch (err) {
              console.error('board.list: skipping unreadable Ticket File ' + entry.name + ': ' + String((err && err.message) || err))
            }
          }
          return { ok: true, workspaceId: workspaceLookup.workspaceId, workspaceTitle: workspaceLookup.workspace.title, tickets }
        } catch (err) {
          return { ok: false, error: 'board-read-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.create({ workspaceId, title, body }) → a new Ticket File in the
    // backlog column. The id continues the highest existing KAN number
    // (KAN-101 when the Board is empty); the file name is <id>-<slug>.md.
    ctx.effect(() =>
      harness.handle('ticket.create', async (args) => {
        if (registry === undefined || fs === undefined) return unavailable()
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const title = String((args && args.title) || '').trim()
        if (title === '') return { ok: false, error: 'title required' }
        const body = String((args && args.body) || '')
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
          const text = serializeTicketFile({ id, title, column: 'backlog', issue: '' }, body)
          const target = await fs.resolve(dirPath + '/' + file)
          await fs.writeText(target, text, { kind: 'createIfAbsent' })
          return { ok: true, id, file }
        } catch (err) {
          return { ok: false, error: 'ticket-create-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.update({ workspaceId, file, title, body, blocked }) → rewrites
    // title, blocked and body via surgical patches, so every other
    // frontmatter field (issue, branch, worktree, session, unknown keys)
    // stays byte-identical. An empty blocked value clears the badge.
    ctx.effect(() =>
      harness.handle('ticket.update', async (args) => {
        if (registry === undefined || fs === undefined) return unavailable()
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
          text = kanbanSetBody(text, String((args && args.body) || ''))
          if (text === null) return { ok: false, error: 'not-a-ticket-file' }
          await fs.writeText(loaded.target, text)
          return { ok: true, file: String(args.file) }
        } catch (err) {
          return { ok: false, error: 'ticket-update-failed: ' + String((err && err.message) || err) }
        }
      }),
    )

    // ticket.move({ workspaceId, file, column }) → rewrites only the column
    // frontmatter field; body and every other key stay byte-identical.
    ctx.effect(() =>
      harness.handle('ticket.move', async (args) => {
        if (registry === undefined || fs === undefined) return unavailable()
        const workspaceLookup = workspaceOf(args)
        if (workspaceLookup.workspace === undefined) return { ok: false, error: workspaceLookup.error }
        const column = String((args && args.column) || '').trim().toLowerCase()
        if (!KANBAN_COLUMNS.includes(column)) return { ok: false, error: 'invalid-column' }
        const dirPath = ticketsDir(workspaceLookup.workspace)
        try {
          const loaded = await readTicket(dirPath, String((args && args.file) || ''))
          if (loaded.error !== undefined) return { ok: false, error: loaded.error }
          const text = kanbanSetAttr(loaded.text, 'column', column)
          if (text === null) return { ok: false, error: 'not-a-ticket-file' }
          await fs.writeText(loaded.target, text)
          return { ok: true, file: String(args.file), column }
        } catch (err) {
          return { ok: false, error: 'ticket-move-failed: ' + String((err && err.message) || err) }
        }
      }),
    )
  },
}
