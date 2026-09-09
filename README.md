# dsh-kanban

A DeepSeek Harness plugin: a workspace-level kanban board acting as an orchestration layer for agent sessions.

`dsh-kanban` gives each DSH Workspace a durable Board for Tickets and Agent Sessions.

## Install

### Dependencies

- DeepSeek Harness `0.1.2-rc.1` or a compatible release
- The DSH Web profile
- Node.js 20 or later
- Git, plus `gh` or `glab` for remote Issue integration

### Permanent mount

1. Install this checkout into the Web profile.

   ```sh
   dsh plugin --profile web add /path/to/dsh-kanban
   ```

2. Stop the current DSH Web process.

   A process restart removes any session-only dynamic definition.

3. Restart `dsh web` and refresh the browser page.

   ```sh
   dsh web
   ```

The package Bundle adds one `kanban` Host composition row automatically.
The package also registers its browser half through the DSH client manifest.
You do not need a `cordis_define` or `cordis_mount` step after later restarts.

> [!NOTE]
> For a GitHub install, use `dsh plugin --profile web add git+https://github.com/auggie246/dsh-kanban.git`.

## Usage

Start DSH Web normally.

```sh
dsh web
```

Use these four Board surfaces:

- Select **Kanban** at the sidebar foot to open the Board overlay.
- Select **Board** in an Agent Session to open its Workspace Board tab.
- Open **Settings → Kanban** to change each Workspace WIP limit and Autopilot setting.
- Use the same Board from either view to manage Ticket Files and Agent Sessions.

Each Workspace stores Ticket Files under `.dsh-kanban/tickets/` in its repository.

## Data continuity

The permanent Host uses the existing `storageDomain` identities without renaming them:

- `kanban_settings` keeps Board-to-Workspace mappings, WIP limits, and Autopilot values.
- `kanban_execution` keeps Ticket execution linkage.
- `kanban_issue_sync` keeps durable Issue projections and Sync Status.

Existing data becomes available when the permanent Host starts.
No copy step changes the stored records.
Ticket Files remain in each Workspace repository.

## Uninstall

Remove the Bundle from the Web profile.

```sh
dsh plugin --profile web remove dsh-kanban
```

Restart `dsh web` and refresh the browser page.
The Host composition row and all four Board surfaces disappear.
Uninstall does not delete Ticket Files or the three `storageDomain` datasets.

## Development

Regenerate the permanent Host and browser artifacts after editing files under `plugin/`.

```sh
npm run build:permanent
npm test
```

`npm test` checks the generated artifacts and all Board behavior tests.
