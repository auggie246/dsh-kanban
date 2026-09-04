// Board settings model — pure functions.
//
// This file is the tested seam for per-Workspace settings. Dynamic Host
// Packages concatenate it before plugin/host.js, so declarations stay plain
// JavaScript and top-level.

const KANBAN_DEFAULT_WIP_LIMIT = 3

function kanbanParseWipLimit(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function kanbanWorkspaceSettings(workspace, stored) {
  const storedLimit = stored === undefined ? null : kanbanParseWipLimit(stored.wipLimit)
  return {
    path: workspace.path,
    wipLimit: storedLimit === null ? KANBAN_DEFAULT_WIP_LIMIT : storedLimit,
  }
}

function kanbanWorkspaceSettingEntries(workspaces, storedFor) {
  return workspaces.map((workspace) => {
    const workspaceId = String(workspace.id)
    return {
      workspaceId,
      settings: kanbanWorkspaceSettings(workspace, storedFor(workspaceId)),
    }
  })
}

// storageDomain calls valueSchema.parse at the durable boundary. Dynamic Host
// Packages cannot import zod, so this small schema implements that exact face.
// It returns owned data and rejects malformed durable records.
const kanbanSettingsRecordSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Board Workspace settings must be an object')
    }
    if (typeof value.path !== 'string' || value.path === '') {
      throw new Error('Board Workspace settings require a path')
    }
    if (typeof value.wipLimit !== 'number' || kanbanParseWipLimit(value.wipLimit) === null) {
      throw new Error('Board Workspace settings require a positive whole-number WIP limit')
    }
    return { path: value.path, wipLimit: value.wipLimit }
  },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KANBAN_DEFAULT_WIP_LIMIT,
    kanbanParseWipLimit,
    kanbanWorkspaceSettingEntries,
    kanbanWorkspaceSettings,
  }
}
