# Board renders in a shell.overlay; entry points are additive, never shadowed

The DSH client slot tree offers no per-workspace-row hole: `sidebar.workspaces`
is a single-seat slot flagged `shadows-shipped-ui`, so the user's original
sketch (a button beside each workspace name) would require forking the entire
shipped workspace browser (search, session list, dialogs) and tracking shell
updates forever. We instead render the Board as a full-screen layer in
`shell.overlay` (the frame-wide additive slot), open it from a Kanban button
in the additive `sidebar.footer.action` slot, and add a per-session "Board"
tab in `conversation.view` as a shortcut. Board settings live in
`settings.section`. This keeps every integration point additive (replaceRisk:
none on all four seats) so DSH shell upgrades cannot silently break the board,
at the cost of one sidebar click instead of a per-row button.
