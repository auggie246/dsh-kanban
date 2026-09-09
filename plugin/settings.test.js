const test = require('node:test')
const assert = require('node:assert/strict')
const {
  KANBAN_DEFAULT_WIP_LIMIT,
  kanbanParseWipLimit,
  kanbanSettingsRecordSchema,
  kanbanWorkspaceSettingEntries,
  kanbanWorkspaceSettings,
} = require('./settings.js')

test('new Workspace settings map its UUID to its path with safe defaults', () => {
  assert.equal(KANBAN_DEFAULT_WIP_LIMIT, 3)
  assert.deepEqual(
    kanbanWorkspaceSettings(
      { workspaceId: 'workspace-a', path: '/repos/alpha' },
      undefined,
    ),
    { path: '/repos/alpha', wipLimit: 3, autopilot: false },
  )
})

test('durable settings migrate records created before Autopilot', () => {
  assert.deepEqual(
    kanbanSettingsRecordSchema.parse({ path: '/repos/alpha', wipLimit: 3 }),
    { path: '/repos/alpha', wipLimit: 3, autopilot: false },
  )
})

test('Workspace settings preserve an enabled Autopilot value', () => {
  assert.deepEqual(
    kanbanWorkspaceSettings(
      { workspaceId: 'workspace-a', path: '/repos/alpha' },
      { path: '/repos/alpha', wipLimit: 4, autopilot: true },
    ),
    { path: '/repos/alpha', wipLimit: 4, autopilot: true },
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
    { path: '/repos/current', wipLimit: 3, autopilot: false },
  )
})

test('settings entries preserve distinct UUID-to-path mappings for two Workspaces', () => {
  const stored = {
    'uuid-beta': { path: '/repos/old-beta', wipLimit: 5, autopilot: true },
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
      { workspaceId: 'uuid-alpha', settings: { path: '/repos/alpha', wipLimit: 3, autopilot: false } },
      { workspaceId: 'uuid-beta', settings: { path: '/repos/beta', wipLimit: 5, autopilot: true } },
    ],
  )
})
