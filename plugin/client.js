// Client half of the kanban Plugin — M0 (issue #1, read-only Board).
//
// Registers two additive Slots: the Kanban button at the sidebar foot
// (`sidebar.footer.action`) and the full-page Board (`shell.overlay`).
// Plain JavaScript with React.createElement only: no imports, no JSX.

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const h = React.createElement

    // The two Slots are separate registrations; this tiny store is the
    // shared open/closed state between the button and the overlay.
    const openState = { open: false, listeners: new Set() }
    const notifyOpen = () => {
      for (const listener of Array.from(openState.listeners)) listener()
    }
    const setOpen = (next) => {
      if (openState.open === next) return
      openState.open = next
      notifyOpen()
    }
    const useOpen = () => {
      const [value, setValue] = React.useState(openState.open)
      React.useEffect(() => {
        const listener = () => setValue(openState.open)
        openState.listeners.add(listener)
        return () => {
          openState.listeners.delete(listener)
        }
      }, [])
      return value
    }

    // Mirror of KANBAN_COLUMNS in plugin/frontmatter.js — keep in lockstep.
    const COLUMNS = [
      { key: 'backlog', label: 'Backlog' },
      { key: 'ready', label: 'Ready' },
      { key: 'in-progress', label: 'In Progress' },
      { key: 'in-review', label: 'In Review' },
      { key: 'done', label: 'Done' },
    ]

    function BoardButton(owner) {
      return h(
        'button',
        {
          className: 'kanban-sidebar-btn',
          type: 'button',
          onClick: () => setOpen(true),
          title: 'Open the Board for the current Workspace',
        },
        owner && owner.wide === false ? 'K' : 'Kanban',
      )
    }

    function BoardCard(props) {
      return h(
        'div',
        { className: 'kanban-card' },
        h('div', { className: 'kanban-card-head' }, h('span', { className: 'kanban-card-id' }, props.card.id)),
        h('div', { className: 'kanban-card-title' }, props.card.title),
        props.card.preview === ''
          ? null
          : h('div', { className: 'kanban-card-preview' }, props.card.preview),
      )
    }

    function BoardColumn(props) {
      return h(
        'section',
        { className: 'kanban-column', key: props.column.key },
        h(
          'div',
          { className: 'kanban-column-head' },
          h('span', { className: 'kanban-column-label' }, props.column.label),
          h('span', { className: 'kanban-column-count' }, String(props.cards.length)),
        ),
        h(
          'div',
          { className: 'kanban-column-cards' },
          props.cards.map((card) => h(BoardCard, { key: card.id, card })),
        ),
      )
    }

    function BoardOverlay(props) {
      const open = useOpen()
      const workspace = props.useWorkspaces((snapshot) => {
        const id = snapshot.recentWorkspaceId
        if (id === undefined) return undefined
        return snapshot.items.find((item) => item.workspaceId === id)
      })
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const workspaceId = workspace === undefined ? undefined : workspace.workspaceId

      // Closing and re-opening re-reads the Ticket Files from the repo.
      React.useEffect(() => {
        if (!open || workspaceId === undefined) return undefined
        let cancelled = false
        setLoading(true)
        setError(null)
        host.call('board.list', { workspaceId }).then(
          (reply) => {
            if (cancelled) return
            setLoading(false)
            if (reply && reply.ok) {
              setResult(reply)
            } else {
              setResult(null)
              setError((reply && reply.error) || 'board.list failed')
            }
          },
          (err) => {
            if (cancelled) return
            setLoading(false)
            setResult(null)
            setError(String((err && err.message) || err))
          },
        )
        return () => {
          cancelled = true
        }
      }, [open, workspaceId])

      if (!open) return null

      const tickets = result === null ? [] : result.tickets
      let body
      if (workspaceId === undefined) {
        body = h(
          'div',
          { className: 'kanban-state' },
          'No active Workspace. Select a Workspace to see its Board.',
        )
      } else if (loading) {
        body = h('div', { className: 'kanban-state' }, 'Reading Ticket Files…')
      } else if (error !== null) {
        body = h('div', { className: 'kanban-state kanban-state-error' }, 'Board unavailable: ' + error)
      } else if (tickets.length === 0) {
        body = h(
          'div',
          { className: 'kanban-state' },
          h('div', { className: 'kanban-state-title' }, 'No Tickets yet'),
          h(
            'div',
            { className: 'kanban-state-hint' },
            'Tickets live as markdown Ticket Files in .dsh-kanban/tickets/ inside this Workspace. ' +
              'Write one with frontmatter (id, title, column) and reopen the Board to see your first Ticket.',
          ),
        )
      } else {
        body = h(
          'div',
          { className: 'kanban-columns' },
          COLUMNS.map((column) =>
            h(BoardColumn, {
              key: column.key,
              column,
              cards: tickets.filter((ticket) => ticket.column === column.key),
            }),
          ),
        )
      }

      return h(
        'div',
        {
          className: 'kanban-board',
          tabIndex: -1,
          ref: (el) => {
            if (el) el.focus()
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') setOpen(false)
          },
        },
        h(
          'header',
          { className: 'kanban-board-header' },
          h('span', { className: 'kanban-board-name' }, '▦ Kanban'),
          workspace === undefined
            ? null
            : h('span', { className: 'kanban-board-workspace' }, workspace.title + ' — ' + workspace.path),
          h(
            'button',
            {
              className: 'kanban-close',
              type: 'button',
              onClick: () => setOpen(false),
              title: 'Close the Board (Esc)',
            },
            'Close',
          ),
        ),
        body,
      )
    }

    slots.inject('sidebar.footer.action', () =>
      slots.register(
        { name: 'sidebar.footer.action', id: 'kanban', order: 100, label: 'Kanban' },
        (owner) => h(BoardButton, owner),
      ),
    )
    slots.inject('shell.overlay', () =>
      slots.register(
        { name: 'shell.overlay', id: 'kanban-board', order: 10, label: 'Kanban Board' },
        (slotProps) => h(BoardOverlay, slotProps),
      ),
    )

    styles.insert([
      // sidebar.footer.action composes its entries in one horizontal row
      // shared with other occupants: flex:none stops this button from
      // shrinking or pushing siblings out of the narrow foot area.
      '.kanban-sidebar-btn{display:inline-flex;flex:none;align-items:center;justify-content:flex-start;gap:6px;',
      'padding:4px 10px;width:100%;max-width:100%;box-sizing:border-box;text-align:left;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
      '.kanban-sidebar-btn:hover{background:var(--dsw-alias-bg-layer-1);}',
      // Stack the foot actions vertically: Cordis pill, then Kanban, then
      // the Settings row below. This one rule selects the owner container,
      // not our own node; it is deliberately minimal and explicitly coupled
      // to the shipped sidebar build. If the hashed class name changes on a
      // DSH upgrade, the rule stops matching and the actions fall back to a
      // horizontal row — degradation is visual only.
      '.hHd-Xa_footerActions{flex-direction:column;align-items:stretch;gap:6px;}',
      '.hHd-Xa_collapsed .hHd-Xa_footerActions{align-items:center;}',
      '.kanban-board{position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'pointer-events:auto;outline:none;}',
      '.kanban-board-header{display:flex;align-items:center;gap:12px;padding:12px 20px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.kanban-board-name{font-size:15px;font-weight:600;}',
      '.kanban-board-workspace{flex:1;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.kanban-close{padding:4px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
      'background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
      '.kanban-close:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.kanban-columns{flex:1;display:flex;gap:12px;padding:16px 20px;overflow-x:auto;}',
      '.kanban-column{flex:1 1 0;min-width:220px;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}',
      '.kanban-column-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.kanban-column-label{font-size:12px;font-weight:600;text-transform:uppercase;',
      'letter-spacing:.04em;color:var(--dsw-alias-label-secondary);}',
      '.kanban-column-count{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:1px 8px;}',
      '.kanban-column-cards{flex:1;display:flex;flex-direction:column;gap:8px;padding:10px;overflow-y:auto;}',
      '.kanban-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;padding:10px;}',
      '.kanban-card-head{margin-bottom:4px;}',
      '.kanban-card-id{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);}',
      '.kanban-card-title{font-size:13px;font-weight:500;margin-bottom:4px;}',
      '.kanban-card-preview{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:8px;padding:40px;text-align:center;}',
      '.kanban-state-title{font-size:15px;font-weight:600;}',
      '.kanban-state-hint{max-width:420px;font-size:13px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-state-error{color:var(--dsw-alias-state-error-primary);',
      'font-size:13px;white-space:pre-wrap;}',
    ].join('\n'))
  },
}
