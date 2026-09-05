// Client half of the kanban Plugin — M2 (issue #6, attention badges).
//
// Registers four additive Slots: sidebar button, full-page Board overlay,
// per-session Board tab, and per-Workspace Board settings.
// Plain JavaScript with React.createElement only: no imports, no JSX, no
// window/document.
//
// Ticket edits and Board settings persist only through Host JSON methods.
// After each successful write, every mounted Board reloads its Workspace.
// The Host derives Attention Badge state from real session events; the
// client polls the small board.watch.list aggregate and re-reads the Board
// when it changes.

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const sessions = ctx.get('sessions')

    const h = React.createElement

    const useStoreValue = (store) => {
      const [value, setValue] = React.useState(store.value)
      React.useEffect(() => {
        const listener = () => setValue(store.value)
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      }, [store])
      return value
    }
    const publishStoreValue = (store, next) => {
      if (store.value === next) return
      store.value = next
      for (const listener of Array.from(store.listeners)) listener()
    }

    // Shared open state connects the sidebar button to the overlay Slot.
    const openState = { value: false, listeners: new Set() }
    const setOpen = (next) => publishStoreValue(openState, next)
    const useOpen = () => useStoreValue(openState)

    // Mirror of KANBAN_COLUMNS in plugin/frontmatter.js — keep in lockstep.
    const COLUMNS = [
      { key: 'backlog', label: 'Backlog' },
      { key: 'ready', label: 'Ready' },
      { key: 'in-progress', label: 'In Progress' },
      { key: 'in-review', label: 'In Review' },
      { key: 'done', label: 'Done' },
    ]

    // Every mounted Board reads Ticket Files and settings again after any
    // surface commits a change. This keeps overlay and tab views aligned.
    const boardChanges = { value: 0, listeners: new Set() }
    const notifyBoardChange = () => publishStoreValue(boardChanges, boardChanges.value + 1)
    const useBoardVersion = () => useStoreValue(boardChanges)

    // Live session-watch state (issue #6). watchSummary holds the last
    // board.watch.list reply; watchChanges bumps when it changes so mounted
    // Boards re-read their cards. The poll lives in the sidebar button,
    // which stays mounted while the Board is closed.
    const ATTENTION_LABELS = {
      approval: 'Awaiting approval',
      error: 'Errored',
      finished: 'Finished',
    }
    const WATCH_POLL_MS = 5000
    const watchSummary = { value: { count: 0, tickets: [] }, listeners: new Set() }
    const watchChanges = { value: 0, listeners: new Set() }
    const useWatchVersion = () => useStoreValue(watchChanges)

    const useWatchPoll = () => {
      React.useEffect(() => {
        let stopped = false
        let lastJson = JSON.stringify(watchSummary.value)
        const poll = () => {
          host.call('board.watch.list', {}).then(
            (reply) => {
              if (stopped || !reply || !reply.ok) return
              const next = {
                count: typeof reply.count === 'number' ? reply.count : 0,
                tickets: Array.isArray(reply.tickets) ? reply.tickets : [],
              }
              const json = JSON.stringify(next)
              if (json === lastJson) return
              lastJson = json
              publishStoreValue(watchSummary, next)
              publishStoreValue(watchChanges, watchChanges.value + 1)
            },
            () => {
              // The watch aggregate is advisory; a failed poll retries on
              // the next interval.
            },
          )
        }
        poll()
        const timer = setInterval(poll, WATCH_POLL_MS)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [])
    }

    function BoardButton(owner) {
      useWatchPoll()
      const watch = useStoreValue(watchSummary)
      return h(
        'button',
        {
          className: 'kanban-sidebar-btn',
          type: 'button',
          onClick: () => setOpen(true),
          title: 'Open the Board for the current Workspace',
        },
        owner && owner.wide === false ? 'K' : 'Kanban',
        watch.count > 0
          ? h(
              'span',
              {
                className: 'kanban-sidebar-attention',
                title:
                  String(watch.count) +
                  ' Ticket ' +
                  (watch.count === 1 ? 'session needs' : 'sessions need') +
                  ' attention',
              },
              String(watch.count),
            )
          : null,
      )
    }

    const sessionLinkLabel = (card) => {
      if (card.attention !== null && card.attention !== undefined && ATTENTION_LABELS[card.attention] !== undefined) {
        return 'Agent Session ' + ATTENTION_LABELS[card.attention].toLowerCase()
      }
      return card.column === 'in-progress' ? 'Agent Session running' : 'Open Agent Session'
    }

    function BoardCard(props) {
      const card = props.card
      return h(
        'div',
        {
          className: 'kanban-card',
          draggable: true,
          onClick: () => props.onEdit(card),
          onDragStart: (event) => {
            if (event.dataTransfer) event.dataTransfer.setData('text/plain', card.file)
            props.onDragStart(card.file)
          },
          onDragEnd: props.onDragEnd,
        },
        h('div', { className: 'kanban-card-head' }, h('span', { className: 'kanban-card-id' }, card.id)),
        h('div', { className: 'kanban-card-title' }, card.title),
        card.preview === '' ? null : h('div', { className: 'kanban-card-preview' }, card.preview),
        card.blocked === ''
          ? null
          : h('div', { className: 'kanban-card-blocked', title: card.blocked }, 'Blocked — ' + card.blocked),
        card.attention === null || card.attention === undefined || ATTENTION_LABELS[card.attention] === undefined
          ? null
          : h(
              'div',
              {
                className: 'kanban-card-attention kanban-attention-' + card.attention,
                title: ATTENTION_LABELS[card.attention],
              },
              ATTENTION_LABELS[card.attention],
            ),
        card.sessionId === ''
          ? null
          : h(
              'a',
              {
                className: 'kanban-card-session',
                href: '#',
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.onOpenSession(card.sessionId)
                },
              },
              sessionLinkLabel(card),
            ),
      )
    }

    function BoardColumn(props) {
      return h(
        'section',
        {
          className: 'kanban-column' + (props.dragOver ? ' kanban-column-dragover' : ''),
          key: props.column.key,
          onDragOver: (event) => props.onDragOver(event, props.column.key),
          onDragLeave: () => props.onDragLeave(props.column.key),
          onDrop: (event) => props.onDrop(event, props.column.key),
        },
        h(
          'div',
          { className: 'kanban-column-head' },
          h('span', { className: 'kanban-column-label' }, props.column.label),
          h(
            'span',
            {
              className: 'kanban-column-count',
              title: props.column.key === 'in-progress' ? 'WIP limit ' + String(props.wipLimit) : undefined,
            },
            props.column.key === 'in-progress'
              ? String(props.cards.length) + ' / ' + String(props.wipLimit)
              : String(props.cards.length),
          ),
        ),
        h(
          'div',
          { className: 'kanban-column-cards' },
          props.cards.map((card) =>
            h(BoardCard, {
              key: card.id,
              card,
              onEdit: props.onEditCard,
              onDragStart: props.onDragStartCard,
              onDragEnd: props.onDragEndCard,
              onOpenSession: props.onOpenSession,
            }),
          ),
        ),
      )
    }

    // Create/edit dialog for one Ticket. Edit mode pre-fills from the card;
    // an empty Blocked field clears the badge. The file name is not renamed
    // on title edits (the slug is fixed at creation).
    function TicketDialog(props) {
      const editing = props.mode === 'edit'
      const [title, setTitle] = React.useState(editing ? props.card.title : '')
      const [body, setBody] = React.useState(editing ? props.card.body : '')
      const [blocked, setBlocked] = React.useState(editing ? props.card.blocked : '')
      const [base, setBase] = React.useState(editing ? props.card.base : 'remote')
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)

      const save = () => {
        if (title.trim() === '') {
          setError('Title is required.')
          return
        }
        setSaving(true)
        setError(null)
        const method = editing ? 'ticket.update' : 'ticket.create'
        const payload = { workspaceId: props.workspaceId, title: title.trim(), body, base }
        if (editing) {
          payload.file = props.card.file
          payload.blocked = blocked.trim()
        }
        host.call(method, payload).then(
          (reply) => {
            setSaving(false)
            if (reply && reply.ok) {
              props.onSaved()
            } else {
              setError((reply && reply.error) || method + ' failed')
            }
          },
          (err) => {
            setSaving(false)
            setError(String((err && err.message) || err))
          },
        )
      }

      return h(
        'div',
        {
          className: 'kanban-dialog-backdrop',
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              if (!saving) props.onCancel()
            }
          },
        },
        h(
          'div',
          { className: 'kanban-dialog' },
          h('div', { className: 'kanban-dialog-title' }, editing ? 'Edit ' + props.card.id : 'New Ticket'),
          h(
            'label',
            { className: 'kanban-field' },
            h('span', { className: 'kanban-field-label' }, 'Title'),
            h('input', {
              className: 'kanban-input',
              type: 'text',
              value: title,
              autoFocus: true,
              onChange: (event) => setTitle(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'kanban-field' },
            h('span', { className: 'kanban-field-label' }, 'Body'),
            h('textarea', {
              className: 'kanban-textarea',
              value: body,
              placeholder: 'Goal, context, acceptance criteria — markdown.',
              onChange: (event) => setBody(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'kanban-field' },
            h('span', { className: 'kanban-field-label' }, 'Worktree base'),
            h(
              'select',
              {
                className: 'kanban-input',
                value: base,
                onChange: (event) => setBase(event.target.value),
              },
              h('option', { value: 'remote' }, 'Remote default branch'),
              h('option', { value: 'head' }, 'Local HEAD'),
            ),
          ),
          editing
            ? h(
                'label',
                { className: 'kanban-field' },
                h('span', { className: 'kanban-field-label' }, 'Blocked reason (empty clears the badge)'),
                h('input', {
                  className: 'kanban-input',
                  type: 'text',
                  value: blocked,
                  onChange: (event) => setBlocked(event.target.value),
                }),
              )
            : null,
          error === null ? null : h('div', { className: 'kanban-dialog-error' }, error),
          h(
            'div',
            { className: 'kanban-dialog-actions' },
            h(
              'button',
              { className: 'kanban-btn', type: 'button', disabled: saving, onClick: props.onCancel },
              'Cancel',
            ),
            h(
              'button',
              { className: 'kanban-btn kanban-btn-primary', type: 'button', disabled: saving, onClick: save },
              saving ? 'Saving…' : editing ? 'Save' : 'Create',
            ),
          ),
        ),
      )
    }

    // Warning shown when a drop into In Progress would pass the WIP limit.
    // The move is still allowed — issue #2 asks for a warning, not a queue.
    function WipWarning(props) {
      return h(
        'div',
        {
          className: 'kanban-dialog-backdrop',
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              props.onCancel()
            }
          },
        },
        h(
          'div',
          { className: 'kanban-dialog' },
          h('div', { className: 'kanban-dialog-title' }, 'WIP limit reached'),
          h(
            'div',
            { className: 'kanban-dialog-text' },
            'In Progress already holds ' +
              String(props.count) +
              ' Tickets (WIP limit ' +
              String(props.wipLimit) +
              '). Move anyway?',
          ),
          h(
            'div',
            { className: 'kanban-dialog-actions' },
            h('button', { className: 'kanban-btn', type: 'button', onClick: props.onCancel }, 'Cancel'),
            h(
              'button',
              { className: 'kanban-btn kanban-btn-primary', type: 'button', autoFocus: true, onClick: props.onConfirm },
              'Move anyway',
            ),
          ),
        ),
      )
    }

    function Board(props) {
      const workspace = props.workspace
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [dialog, setDialog] = React.useState(null) // {mode:'create'} | {mode:'edit', card}
      const [dragFile, setDragFile] = React.useState(null)
      const [dragOverColumn, setDragOverColumn] = React.useState(null)
      const [pendingMove, setPendingMove] = React.useState(null) // {file, column, count}
      const [moveError, setMoveError] = React.useState(null)
      const boardVersion = useBoardVersion()
      const watchVersion = useWatchVersion()
      const workspaceId = workspace === undefined ? undefined : workspace.workspaceId

      React.useEffect(() => {
        if (workspaceId === undefined) return undefined
        let cancelled = false
        setResult(null)
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
      }, [workspaceId, boardVersion, watchVersion])

      const tickets = result === null ? [] : result.tickets
      const wipLimit = result === null ? null : result.wipLimit

      const doMove = (file, column) => {
        setPendingMove(null)
        setMoveError(null)
        host.call('ticket.move', { workspaceId, file, column }).then(
          (reply) => {
            if (reply && reply.ok) {
              notifyBoardChange()
            } else {
              setMoveError((reply && reply.error) || 'ticket.move failed')
            }
          },
          (err) => setMoveError(String((err && err.message) || err)),
        )
      }

      const requestMove = (file, column) => {
        const card = tickets.find((ticket) => ticket.file === file)
        if (card === undefined || card.column === column) return
        if (column === 'in-progress') {
          const count = tickets.filter((ticket) => ticket.column === 'in-progress').length
          if (count >= wipLimit) {
            setPendingMove({ file, column, count })
            return
          }
        }
        doMove(file, column)
      }

      let body
      if (workspaceId === undefined) {
        body = h(
          'div',
          { className: 'kanban-state' },
          'No active Workspace. Select a Workspace to see its Board.',
        )
      } else if (result === null) {
        body = h('div', { className: 'kanban-state' }, 'Reading Ticket Files…')
      } else if (error !== null) {
        body = h('div', { className: 'kanban-state kanban-state-error' }, 'Board unavailable: ' + error)
      } else {
        body = h(
          'div',
          { className: 'kanban-columns' },
          COLUMNS.map((column) =>
            h(BoardColumn, {
              key: column.key,
              column,
              cards: tickets.filter((ticket) => ticket.column === column.key),
              dragOver: dragOverColumn === column.key,
              wipLimit,
              onEditCard: (card) => setDialog({ mode: 'edit', card }),
              onDragStartCard: (file) => setDragFile(file),
              onDragEndCard: () => {
                setDragFile(null)
                setDragOverColumn(null)
              },
              onOpenSession: (sessionId) => {
                if (sessions === undefined) return
                setOpen(false)
                sessions.open(sessionId)
              },
              onDragOver: (event, key) => {
                if (dragFile === null) return
                event.preventDefault()
                if (dragOverColumn !== key) setDragOverColumn(key)
              },
              onDragLeave: (key) => {
                if (dragOverColumn === key) setDragOverColumn(null)
              },
              onDrop: (event, key) => {
                event.preventDefault()
                const file = dragFile
                setDragFile(null)
                setDragOverColumn(null)
                if (file !== null) requestMove(file, key)
              },
            }),
          ),
        )
        if (tickets.length === 0 && !loading) {
          body = h(
            'div',
            { className: 'kanban-state' },
            h('div', { className: 'kanban-state-title' }, 'No Tickets yet'),
            h(
              'div',
              { className: 'kanban-state-hint' },
              'Use New Ticket above to write your first Ticket File into .dsh-kanban/tickets/.',
            ),
          )
        }
        if (moveError !== null) {
          body = h(React.Fragment, null, body, h('div', { className: 'kanban-move-error' }, 'Move failed: ' + moveError))
        }
      }

      return h(
        'div',
        {
          className: 'kanban-board',
          tabIndex: props.onClose === undefined ? undefined : -1,
          autoFocus: props.onClose !== undefined,
          onKeyDown: props.onClose === undefined
            ? undefined
            : (event) => {
                if (event.key === 'Escape') props.onClose()
              },
        },
        h(
          'header',
          { className: 'kanban-board-header' },
          h('span', { className: 'kanban-board-name' }, '▦ Kanban'),
          workspace === undefined
            ? null
            : h('span', { className: 'kanban-board-workspace' }, workspace.title + ' — ' + workspace.path),
          workspaceId === undefined
            ? null
            : h(
                'button',
                {
                  className: 'kanban-new-btn',
                  type: 'button',
                  onClick: () => setDialog({ mode: 'create' }),
                  title: 'Create a Ticket in the Backlog',
                },
                '+ New Ticket',
              ),
          props.onClose === undefined
            ? null
            : h(
                'button',
                {
                  className: 'kanban-close',
                  type: 'button',
                  onClick: props.onClose,
                  title: 'Close the Board (Esc)',
                },
                'Close',
              ),
        ),
        body,
        dialog === null
          ? null
          : h(TicketDialog, {
              mode: dialog.mode,
              card: dialog.card,
              workspaceId,
              onCancel: () => setDialog(null),
              onSaved: () => {
                setDialog(null)
                notifyBoardChange()
              },
            }),
        pendingMove === null
          ? null
          : h(WipWarning, {
              count: pendingMove.count,
              wipLimit,
              onCancel: () => setPendingMove(null),
              onConfirm: () => doMove(pendingMove.file, pendingMove.column),
            }),
      )
    }

    function BoardOverlay(props) {
      const open = useOpen()
      const currentSessionId = props.useSessions((snapshot) => snapshot.current)
      const workspace = props.useWorkspaces((snapshot) => {
        if (currentSessionId !== undefined) {
          const currentWorkspace = snapshot.items.find((item) => item.sessionIds.includes(currentSessionId))
          if (currentWorkspace !== undefined) return currentWorkspace
        }
        const id = snapshot.recentWorkspaceId
        if (id === undefined) return undefined
        return snapshot.items.find((item) => item.workspaceId === id)
      })
      if (!open) return null
      const workspaceId = workspace === undefined ? 'none' : workspace.workspaceId
      return h(
        'div',
        { className: 'kanban-board-overlay' },
        h(Board, { key: workspaceId, workspace, onClose: () => setOpen(false) }),
      )
    }

    function ConversationBoard(props) {
      const workspace = props.useWorkspaces((snapshot) =>
        snapshot.items.find((item) => item.sessionIds.includes(props.sessionId)),
      )
      const workspaceId = workspace === undefined ? 'none' : workspace.workspaceId
      return h(
        'div',
        { className: 'kanban-board-embedded' },
        h(Board, { key: workspaceId, workspace }),
      )
    }

    function BoardSettings(props) {
      const workspaces = props.useWorkspaces((snapshot) => snapshot.items)
      const workspaceKey = workspaces
        .map((workspace) => workspace.workspaceId + ':' + workspace.title + ':' + workspace.path)
        .join('|')
      const boardVersion = useBoardVersion()
      const [rows, setRows] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [savingId, setSavingId] = React.useState(null)
      const [savedId, setSavedId] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        setError(null)
        host.call('board.settings.list', {}).then(
          (reply) => {
            if (cancelled) return
            if (reply && reply.ok) {
              setRows(reply.workspaces)
            } else {
              setRows(null)
              setError((reply && reply.error) || 'board.settings.list failed')
            }
          },
          (err) => {
            if (cancelled) return
            setRows(null)
            setError(String((err && err.message) || err))
          },
        )
        return () => {
          cancelled = true
        }
      }, [workspaceKey, boardVersion])

      const updateDraft = (workspaceId, value) => {
        setSavedId(null)
        setRows((current) =>
          current.map((row) => (row.workspaceId === workspaceId ? { ...row, wipLimit: value } : row)),
        )
      }

      const save = (row) => {
        setSavingId(row.workspaceId)
        setSavedId(null)
        setError(null)
        host.call('board.settings.update', {
          workspaceId: row.workspaceId,
          wipLimit: row.wipLimit,
        }).then(
          (reply) => {
            setSavingId(null)
            if (reply && reply.ok) {
              setSavedId(row.workspaceId)
              notifyBoardChange()
            } else {
              setError((reply && reply.error) || 'board.settings.update failed')
            }
          },
          (err) => {
            setSavingId(null)
            setError(String((err && err.message) || err))
          },
        )
      }

      let content
      if (rows === null && error === null) {
        content = h('div', { className: 'kanban-settings-state' }, 'Loading Workspace settings…')
      } else if (rows === null) {
        content = null
      } else if (rows.length === 0) {
        content = h('div', { className: 'kanban-settings-state' }, 'No registered Workspaces.')
      } else {
        content = h(
          'div',
          { className: 'kanban-settings-list' },
          rows.map((row) =>
            h(
              'div',
              { className: 'kanban-settings-row', key: row.workspaceId },
              h(
                'div',
                { className: 'kanban-settings-workspace' },
                h('div', { className: 'kanban-settings-title' }, row.title),
                h('div', { className: 'kanban-settings-path' }, row.path),
              ),
              h(
                'label',
                { className: 'kanban-settings-limit' },
                h('span', null, 'In Progress WIP limit'),
                h('input', {
                  className: 'kanban-input kanban-settings-input',
                  type: 'number',
                  min: 1,
                  step: 1,
                  value: row.wipLimit,
                  onChange: (event) => updateDraft(row.workspaceId, event.target.value),
                }),
              ),
              h(
                'button',
                {
                  className: 'kanban-btn kanban-btn-primary',
                  type: 'button',
                  disabled: savingId !== null,
                  onClick: () => save(row),
                },
                savingId === row.workspaceId ? 'Saving…' : savedId === row.workspaceId ? 'Saved' : 'Save',
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'kanban-settings' },
        h('h2', { className: 'kanban-settings-heading' }, 'Kanban'),
        h(
          'p',
          { className: 'kanban-settings-description' },
          'Each Workspace keeps its own In Progress WIP limit.',
        ),
        error === null ? null : h('div', { className: 'kanban-dialog-error' }, error),
        content,
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
    slots.inject('conversation.view', () =>
      slots.register(
        { name: 'conversation.view', id: 'kanban-board', order: 20, label: 'Board' },
        (slotProps) => h(ConversationBoard, slotProps),
      ),
    )
    slots.inject('settings.section', () =>
      slots.register(
        { name: 'settings.section', id: 'kanban-settings', order: 30, label: 'Kanban' },
        (slotProps) => h(BoardSettings, slotProps),
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
      // Aggregate Attention Badge count on the sidebar button (issue #6).
      '.kanban-sidebar-attention{margin-left:auto;min-width:18px;padding:0 5px;text-align:center;',
      'font-size:11px;font-weight:700;border-radius:9px;color:var(--dsw-alias-state-warn-primary);',
      'border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-base);}',
      // Stack the foot actions vertically: Cordis pill, then Kanban, then
      // the Settings row below. This one rule selects the owner container,
      // not our own node; it is deliberately minimal and explicitly coupled
      // to the shipped sidebar build. If the hashed class name changes on a
      // DSH upgrade, the rule stops matching and the actions fall back to a
      // horizontal row — degradation is visual only.
      '.hHd-Xa_footerActions{flex-direction:column;align-items:stretch;gap:6px;}',
      '.hHd-Xa_collapsed .hHd-Xa_footerActions{align-items:center;}',
      '.kanban-board-overlay{position:fixed;inset:0;z-index:90;display:flex;pointer-events:auto;}',
      '.kanban-board-embedded{height:100%;min-height:0;display:flex;}',
      '.kanban-board{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);outline:none;}',
      '.kanban-board-header{display:flex;align-items:center;gap:12px;padding:12px 20px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.kanban-board-name{font-size:15px;font-weight:600;}',
      '.kanban-board-workspace{flex:1;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.kanban-close,.kanban-new-btn{padding:4px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
      'background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
      '.kanban-close:hover,.kanban-new-btn:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.kanban-new-btn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.kanban-columns{flex:1;display:flex;gap:12px;padding:16px 20px;overflow-x:auto;}',
      '.kanban-column{flex:1 1 0;min-width:220px;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}',
      '.kanban-column-dragover{border-color:var(--dsw-alias-brand-primary);}',
      '.kanban-column-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.kanban-column-label{font-size:12px;font-weight:600;text-transform:uppercase;',
      'letter-spacing:.04em;color:var(--dsw-alias-label-secondary);}',
      '.kanban-column-count{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:1px 8px;}',
      '.kanban-column-cards{flex:1;display:flex;flex-direction:column;gap:8px;padding:10px;overflow-y:auto;}',
      '.kanban-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;padding:10px;cursor:grab;}',
      '.kanban-card-head{margin-bottom:4px;}',
      '.kanban-card-id{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);}',
      '.kanban-card-title{font-size:13px;font-weight:500;margin-bottom:4px;}',
      '.kanban-card-preview{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-card-session{display:inline-block;margin-top:7px;font-size:11px;font-weight:600;',
      'color:var(--dsw-alias-brand-primary);text-decoration:none;}',
      '.kanban-card-session:hover{text-decoration:underline;}',
      '.kanban-card-blocked{display:block;max-width:100%;margin-top:6px;padding:1px 6px;font-size:11px;font-weight:600;',
      'color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);',
      'border-radius:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // Attention Badge on a card: the session awaits approval, errored, or
      // finished (issue #6). One state color per badge kind.
      '.kanban-card-attention{display:block;max-width:100%;margin-top:6px;padding:1px 6px;font-size:11px;font-weight:600;',
      'border-radius:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid transparent;}',
      '.kanban-attention-approval{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
      '.kanban-attention-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.kanban-attention-finished{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
      '.kanban-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:8px;padding:40px;text-align:center;}',
      '.kanban-state-title{font-size:15px;font-weight:600;}',
      '.kanban-state-hint{max-width:420px;font-size:13px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-state-error{color:var(--dsw-alias-state-error-primary);',
      'font-size:13px;white-space:pre-wrap;}',
      '.kanban-move-error{position:absolute;right:20px;bottom:16px;padding:6px 12px;font-size:12px;',
      'color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;}',
      '.kanban-dialog-backdrop{position:fixed;inset:0;z-index:100;display:flex;align-items:center;',
      'justify-content:center;background:rgba(0,0,0,.4);pointer-events:auto;}',
      '.kanban-dialog{width:560px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;gap:12px;',
      'padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:10px;overflow-y:auto;}',
      '.kanban-dialog-title{font-size:15px;font-weight:600;}',
      '.kanban-dialog-text{font-size:13px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-dialog-error{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;}',
      '.kanban-field{display:flex;flex-direction:column;gap:4px;}',
      '.kanban-field-label{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-input,.kanban-textarea{padding:6px 8px;font-size:13px;font-family:inherit;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;}',
      '.kanban-textarea{height:160px;resize:vertical;}',
      '.kanban-dialog-actions{display:flex;justify-content:flex-end;gap:8px;}',
      '.kanban-btn{padding:4px 12px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.kanban-btn:disabled{opacity:.5;cursor:default;}',
      '.kanban-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.kanban-settings{display:flex;flex-direction:column;gap:12px;padding:4px 0 24px;}',
      '.kanban-settings-heading{margin:0;font-size:18px;}',
      '.kanban-settings-description,.kanban-settings-state{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-settings-list{display:flex;flex-direction:column;gap:8px;}',
      '.kanban-settings-row{display:flex;align-items:center;gap:16px;padding:12px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.kanban-settings-workspace{flex:1;min-width:0;}',
      '.kanban-settings-title{font-size:13px;font-weight:600;}',
      '.kanban-settings-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.kanban-settings-limit{display:flex;align-items:center;gap:8px;font-size:12px;}',
      '.kanban-settings-input{width:72px;}',
    ].join('\n'))
  },
}
