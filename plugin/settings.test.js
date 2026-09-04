const test = require('node:test')
const assert = require('node:assert/strict')
const {
  KANBAN_DEFAULT_WIP_LIMIT,
  kanbanParseWipLimit,
  kanbanWorkspaceSettingEntries,
  kanbanWorkspaceSettings,
} = require('./settings.js')

test('new Workspace settings map its UUID to its current path and default WIP limit', () => {
  assert.equal(KANBAN_DEFAULT_WIP_LIMIT, 3)
  assert.deepEqual(
    kanbanWorkspaceSettings(
      { workspaceId: 'workspace-a', path: '/repos/alpha' },
      undefined,
    ),
    { path: '/repos/alpha', wipLimit: 3 },
  )
})

test('WIP limits are positive whole numbers', () => {
  assert.equal(kanbanParseWipLimit(1), 1)
  assert.equal(kanbanParseWipLimit('12'), 12)
  assert.equal(kanbanParseWipLimit(0), null)
  assert.equal(kanbanParseWipLimit('2.5'), null)
  assert.equal(kanbanParseWipLimit('many'), null)
})

test('Workspace settings repair an invalid value and refresh the path mapping', () => {
  assert.deepEqual(
    kanbanWorkspaceSettings(
      { workspaceId: 'workspace-b', path: '/repos/current' },
      { path: '/repos/old', wipLimit: 0 },
    ),
    { path: '/repos/current', wipLimit: 3 },
  )
})

test('settings entries preserve distinct UUID-to-path mappings for two Workspaces', () => {
  const stored = {
    'uuid-beta': { path: '/repos/old-beta', wipLimit: 5 },
  }
  assert.deepEqual(
    kanbanWorkspaceSettingEntries(
      [
        { id: 'uuid-alpha', path: '/repos/alpha' },
        { id: 'uuid-beta', path: '/repos/beta' },
      ],
      (workspaceId) => stored[workspaceId],
    ),
    [
      { workspaceId: 'uuid-alpha', settings: { path: '/repos/alpha', wipLimit: 3 } },
      { workspaceId: 'uuid-beta', settings: { path: '/repos/beta', wipLimit: 5 } },
    ],
  )
})
