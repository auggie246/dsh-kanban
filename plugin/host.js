// Host half of the kanban Plugin — M0 (issue #1, read-only Board).
//
// `cordis_define` receives plugin/frontmatter.js concatenated in front of
// this file, so parseTicketFile is already in scope below. Plain
// JavaScript only: no imports, no TypeScript, no Node globals.

return {
  apply(ctx) {
    const registry = ctx.get('workspaceRegistry')
    const fs = ctx.get('fs')

    // board.list({ workspaceId }) → card data for every Ticket File in the
    // Workspace. Read-only: a missing directory is an empty Board, not an
    // error; a single unreadable file is logged and skipped.
    ctx.effect(() =>
      harness.handle('board.list', async (args) => {
        if (registry === undefined || fs === undefined) {
          return { ok: false, error: 'host services unavailable' }
        }
        const workspaceId = args && typeof args.workspaceId === 'string' ? args.workspaceId : ''
        if (workspaceId === '') return { ok: false, error: 'workspaceId required' }
        const workspace = registry.get(workspaceId)
        if (workspace === undefined) return { ok: false, error: 'workspace-not-found' }
        const base = workspace.path.replace(/\/+$/, '')
        try {
          const dir = await fs.resolve(base + '/.dsh-kanban/tickets')
          const info = await fs.stat(dir)
          if (info === undefined || info.type !== 'directory') {
            return { ok: true, workspaceId, workspaceTitle: workspace.title, tickets: [] }
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
          return { ok: true, workspaceId, workspaceTitle: workspace.title, tickets }
        } catch (err) {
          return { ok: false, error: 'board-read-failed: ' + String((err && err.message) || err) }
        }
      }),
    )
  },
}
