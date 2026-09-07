// Ticket execution module — pure orchestration behind one tested interface.
//
// Dynamic Host Packages concatenate this file before plugin/host.js. The
// production Host supplies adapters for Git, files, Agent Sessions, and
// storageDomain. Tests supply adapters at the same seam.

const KANBAN_WORKTREE_IGNORE = '.dsh-kanban/worktrees/'

function kanbanExecutionInput(request) {
  if (request === null || typeof request !== 'object') throw new Error('Ticket execution request required')
  const workspaceId = String(request.workspaceId || '').trim()
  const workspacePath = String(request.workspacePath || '').replace(/\/+$/, '')
  const ticketId = String(request.ticketId || '').trim().toUpperCase()
  const ticketSlug = String(request.ticketSlug || '').trim().toLowerCase()
  const ticketText = String(request.ticketText || '')
  const baseMode = request.baseMode === 'head' ? 'head' : 'remote'
  if (workspaceId === '') throw new Error('Ticket execution requires a Workspace id')
  if (workspacePath === '') throw new Error('Ticket execution requires a Workspace path')
  if (!/^KAN-\d+$/.test(ticketId)) throw new Error('Ticket execution requires a KAN id')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ticketSlug) || ticketSlug.length > 40) {
    throw new Error('Ticket execution requires a valid Ticket slug')
  }
  return { workspaceId, workspacePath, ticketId, ticketSlug, ticketText, baseMode }
}

function kanbanEnsureIgnoreLine(text, line) {
  const lines = String(text || '').split(/\r?\n/)
  if (lines.includes(line) || (line === KANBAN_WORKTREE_IGNORE && lines.includes('.dsh-kanban/'))) return String(text || '')
  let next = String(text || '')
  if (next !== '' && !next.endsWith('\n')) next += '\n'
  return next + line + '\n'
}

function kanbanExecutionBrief(ticketText, branch, workspacePath, worktreePath, remote) {
  const rules = [
    '- Work only on branch `' + branch + '`.',
    '- Work only inside the Worktree `' + worktreePath + '`.',
    '- Never touch the main checkout `' + workspacePath + '`.',
    '- Commit completed work to `' + branch + '`.',
  ]
  if (remote && (remote.platform === 'github' || remote.platform === 'gitlab')) {
    rules.push('- Push the Ticket branch with `git push -u ' + remote.remote + ' ' + branch + '`.')
    rules.push(remote.platform === 'github'
      ? '- Create its GitHub PR with `gh pr create` after pushing.'
      : '- Create its GitLab MR with `glab mr create` after pushing.')
    const match = /^\s*issue:\s*["']?([^\s"']+)["']?\s*$/mi.exec(String(ticketText || ''))
    if (match) rules.push('- Reference the linked Issue `' + match[1] + '` in the PR/MR description.')
  }
  return [
    'Complete the Ticket below.',
    '',
    'Board rules:',
    ...rules,
    '',
    'Ticket File:',
    '',
    ticketText,
  ].join('\n')
}

// One Host command boundary shared by Git and remote platform CLIs.
async function kanbanRunHostCommand(shell, workdir, args, options = {}) {
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'"
  const result = await shell.run(shell.resolve({
    command: args.map(quote).join(' '),
    workdir,
    timeoutMs: options.timeoutMs || 30000,
    stdoutMaxBytes: options.stdoutMaxBytes || 262144,
  }))
  const allowed = options.allowedExitCodes || [0]
  if (!allowed.includes(result.exitCode)) {
    throw new Error(result.stderr.text.trim() || result.stdout.text.trim() || 'command failed')
  }
  return { exitCode: result.exitCode, text: result.stdout.text, truncated: result.stdout.truncated === true }
}

// One Host Git boundary shared by execution, watching, and completion.
function kanbanRunHostGit(shell, workdir, args, options = {}) {
  return kanbanRunHostCommand(shell, workdir, ['git', ...args], options)
}

// Bind the dynamic Host capabilities to the Ticket execution interface.
function kanbanHostExecutionAdapter(deps) {
  const workspacePath = deps.workspace.path.replace(/\/+$/, '')
  const runGit = async (args) => {
    const result = await kanbanRunHostGit(deps.shell, deps.workspace.path, args, { timeoutMs: 120000 })
    return result.text.trim()
  }
  return {
    runGit,
    detectRemote: () => kanbanDetectRemote((args, allowed = [0]) =>
      kanbanRunHostGit(deps.shell, deps.workspace.path, args, { allowedExitCodes: allowed, timeoutMs: 30000 })),
    async readIgnore() {
      const target = await deps.fs.resolve(workspacePath + '/.gitignore')
      const info = await deps.fs.stat(target)
      if (info === undefined) return ''
      if (info.type !== 'file') throw new Error('.gitignore is not a file')
      return deps.fs.readText(target)
    },
    async writeIgnore(text) {
      const target = await deps.fs.resolve(workspacePath + '/.gitignore')
      await deps.fs.writeText(target, text)
    },
    setTicketAttr: deps.setTicketAttr,
    persistTicket: (text) => deps.fs.writeText(deps.loaded.target, text),
    persistLinkage: (key, linkage) => deps.executionTable.put(key, linkage),
    deleteLinkage: (key) => deps.executionTable.delete(key),
    async createSession(spec) {
      const selection = deps.agentDefaultModel.currentSelection()
      const preset = await deps.agentPresets.resolve()
      const handle = await deps.agents.create({
        sessionId: spec.sessionId,
        meta: { cwd: spec.cwd, agentPreset: preset.id },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => deps.agentPresets.mount(agentCtx, preset.id),
      })
      if (deps.rememberSession) deps.rememberSession(handle)
      await handle.agent.whenIdle()
      return { id: handle.agent.id, agent: handle.agent, dispose: () => handle.dispose() }
    },
    disposeSession: (session) => session.dispose(),
    async followup(session, brief) {
      session.agent.followup({
        id: 'kanban-brief-' + session.id,
        role: 'user',
        content: [{ type: 'text', text: brief }],
        source: { kind: 'plugin', plugin: 'dsh-kanban' },
      })
    },
  }
}

async function kanbanRemoteDefault(adapter) {
  const remotes = String(await adapter.runGit(['remote']))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (remotes.length === 0) throw new Error('Workspace has no git remote')
  const remote = remotes[0]
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Workspace git remote name is unsafe')
  const prefix = remote + '/'
  let branch
  try {
    const symbolic = String(
      await adapter.runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/' + remote + '/HEAD']),
    ).trim()
    if (symbolic.startsWith(prefix) && symbolic.length > prefix.length) branch = symbolic.slice(prefix.length)
  } catch {
    // A remote can declare HEAD without a local refs/remotes/<name>/HEAD.
  }
  if (branch === undefined) {
    const description = String(await adapter.runGit(['remote', 'show', remote]))
    const match = /^\s*HEAD branch:\s*(\S+)\s*$/m.exec(description)
    if (match !== null) branch = match[1]
  }
  if (branch === undefined) throw new Error('Workspace remote default branch is unavailable')
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new Error('Workspace remote default branch is unsafe')
  }
  await adapter.runGit(['fetch', '--quiet', remote, branch])
  return remote + '/' + branch
}

let kanbanExecutionSequence = 0

async function kanbanStartTicketExecution(request, adapter) {
  const input = kanbanExecutionInput(request)
  const branch = 'kanban/' + input.ticketId + '-' + input.ticketSlug
  const relativeWorktreePath = '.dsh-kanban/worktrees/' + input.ticketSlug
  const worktreePath = input.workspacePath + '/' + relativeWorktreePath
  // A released Ticket can start again; its earlier session stays persisted.
  const sessionId = ('kanban-' + input.workspaceId + '-' + input.ticketId + '-' + Date.now() + '-' + (++kanbanExecutionSequence))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
  const linkageKey = input.workspaceId + '/' + input.ticketId
  const linkage = {
    workspaceId: input.workspaceId,
    ticketId: input.ticketId,
    sessionId,
    worktreePath,
    branch,
    // The commit the branch spawns from; the watch loop compares the branch
    // head against it to decide whether the branch has commits.
    baseSha: '',
  }
  let linkedTicketText = input.ticketText
  const linkedAttrs = [
    ['column', 'in-progress'],
    ['branch', branch],
    ['worktreePath', worktreePath],
    ['sessionId', sessionId],
    // Spawning clears the issue #5 queue marker; removing an absent key is a
    // no-op, so non-queued starts keep their text byte-identical here.
    ['queued', null],
  ]
  for (const [key, value] of linkedAttrs) {
    linkedTicketText = adapter.setTicketAttr(linkedTicketText, key, value)
    if (linkedTicketText === null) throw new Error('Ticket File frontmatter is invalid')
  }

  const ignore = await adapter.readIgnore()
  const nextIgnore = kanbanEnsureIgnoreLine(ignore, KANBAN_WORKTREE_IGNORE)
  if (nextIgnore !== ignore) await adapter.writeIgnore(nextIgnore)
  const localOnly = String(await adapter.runGit(['remote'])).trim() === ''
  const completionRemote = typeof adapter.detectRemote === 'function'
    ? await adapter.detectRemote() : { platform: 'none', remote: '', url: '' }
  const baseRef = input.baseMode === 'head' || localOnly ? 'HEAD' : await kanbanRemoteDefault(adapter)
  if (localOnly) {
    const baseBranch = String(await adapter.runGit(['symbolic-ref', '--short', 'HEAD'])).trim()
    linkedTicketText = adapter.setTicketAttr(linkedTicketText, 'baseBranch', baseBranch)
  }
  linkage.baseSha = await adapter.runGit(['rev-parse', baseRef])
  let worktreeCreated = false
  let session
  let ticketPersisted = false
  let linkagePersisted = false
  try {
    await adapter.runGit(['worktree', 'add', '-b', branch, relativeWorktreePath, baseRef])
    worktreeCreated = true
    session = await adapter.createSession({ sessionId, cwd: worktreePath })
    await adapter.persistTicket(linkedTicketText)
    ticketPersisted = true
    await adapter.persistLinkage(linkageKey, linkage)
    linkagePersisted = true
    await adapter.followup(session, kanbanExecutionBrief(input.ticketText, branch, input.workspacePath, worktreePath, completionRemote))
    return linkage
  } catch (error) {
    const cleanupErrors = []
    const clean = async (operation) => {
      try {
        await operation()
      } catch (cleanupError) {
        cleanupErrors.push(String((cleanupError && cleanupError.message) || cleanupError))
      }
    }
    if (ticketPersisted) await clean(() => adapter.persistTicket(input.ticketText))
    if (linkagePersisted) await clean(() => adapter.deleteLinkage(linkageKey))
    if (session !== undefined) await clean(() => adapter.disposeSession(session))
    if (worktreeCreated) {
      await clean(() => adapter.runGit(['worktree', 'remove', '--force', relativeWorktreePath]))
      await clean(() => adapter.runGit(['branch', '-D', branch]))
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        String((error && error.message) || error) + '; rollback failed: ' + cleanupErrors.join('; '),
      )
    }
    throw error
  }
}

const kanbanExecutionRecordSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Ticket execution linkage must be an object')
    }
    const fields = ['workspaceId', 'ticketId', 'sessionId', 'worktreePath', 'branch']
    for (const field of fields) {
      if (typeof value[field] !== 'string' || value[field] === '') {
        throw new Error('Ticket execution linkage requires ' + field)
      }
    }
    return {
      workspaceId: value.workspaceId,
      ticketId: value.ticketId,
      sessionId: value.sessionId,
      worktreePath: value.worktreePath,
      branch: value.branch,
      // Optional: linkage records stored before the watch loop (issue #6)
      // carry no spawn sha; the watch loop treats a missing one as no commits.
      baseSha: typeof value.baseSha === 'string' ? value.baseSha : '',
    }
  },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KANBAN_WORKTREE_IGNORE,
    kanbanEnsureIgnoreLine,
    kanbanExecutionBrief,
    kanbanStartTicketExecution,
  }
}
