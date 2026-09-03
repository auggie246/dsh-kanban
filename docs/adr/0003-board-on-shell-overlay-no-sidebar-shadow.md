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

Amendment (M0, user request, 2026-07-23): the plugin stylesheet also restyles
the shipped foot container — `.hHd-Xa_footerActions{flex-direction:column}` —
so foot actions stack vertically (Cordis pill, Kanban, Settings). This is the
one deliberate bend of the additive-only rule: the foot slot composes entries
in a single horizontal row and no slot can restack them. Accepted because the
failure mode on a shell upgrade is safe: if the hashed class name changes, the
rule stops matching and actions fall back to the shipped row layout — a visual
degradation, never a broken Board. If DSH ever offers a vertical foot or a
second foot slot, delete the rule with no other change.
