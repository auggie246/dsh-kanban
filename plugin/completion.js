// Local and remote completion orchestration, called through Board RPCs.
// Concatenate after frontmatter.js and before host.js. Plain JavaScript only.

// Detect the supported remote used for completion. `origin` wins when several
// supported remotes exist, because Ticket branches are normally pushed there.
async function kanbanDetectRemote(git) {
  const names = String((await git(['remote'])).text || '').split(/\r?\n/)
    .map((name) => name.trim()).filter((name) => name !== '')
  const ordered = names.includes('origin') ? ['origin', ...names.filter((name) => name !== 'origin')] : names
  for (const remote of ordered) {
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) continue
    const result = await git(['remote', 'get-url', remote], [0, 2, 128])
    if (result.exitCode !== 0) continue
    const url = String(result.text || '').trim()
    const host = url.toLowerCase()
    if (/(^|[/:@])github\.com[/:]/.test(host)) return { platform: 'github', remote, url }
    if (/(^|[/:@])gitlab\.com[/:]/.test(host)) return { platform: 'gitlab', remote, url }
  }
  return { platform: 'none', remote: '', url: '' }
}

// Bind one supported platform CLI to the shared remote-completion interface.
// A missing PR/MR is ordinary while an Agent Session is still finishing.
function kanbanRemotePlatformAdapter(remote, command) {
  if (!remote || (remote.platform !== 'github' && remote.platform !== 'gitlab')) {
    throw new Error('unsupported-remote-platform')
  }
  return {
    async review(branch) {
      const args = remote.platform === 'github'
        ? ['gh', 'pr', 'view', branch, '--json', 'url,state,mergedAt,headRefName']
        : ['glab', 'mr', 'view', branch, '--output', 'json']
      const result = await command(args, [0, 1])
      if (!result || result.exitCode !== 0 || String(result.text || '').trim() === '') return null
      let value
      try { value = JSON.parse(result.text) } catch { throw new Error(remote.platform + '-review-invalid-json') }
      const url = String(remote.platform === 'github' ? value.url : value.web_url || '')
      let state = String(value.state || '').toLowerCase()
      if (state === 'opened') state = 'open'
      if (url === '') throw new Error(remote.platform + '-review-url-missing')
      const merged = state === 'merged' || Boolean(remote.platform === 'github' ? value.mergedAt : value.merged_at)
      return { url, state: merged ? 'merged' : state, merged }
    },
  }
}

function kanbanRemotePollDelay(attempt) {
  return Math.min(300000, 15000 * (2 ** Math.max(0, Number(attempt) || 0)))
}

async function kanbanCompleteRemoteTicket(request, adapter) {
  const card = adapter.parseTicketFile(request.file, request.text)
  if (!card || card.column !== 'in-review') throw new Error('ticket-not-in-review')
  const slug = /^kan-\d+-([a-z0-9-]+)\.md$/i.exec(request.file)
  const root = request.workspacePath.replace(/\/+$/, '')
  if (!slug || card.branch !== 'kanban/' + card.id + '-' + slug[1] ||
      card.worktreePath !== root + '/.dsh-kanban/worktrees/' + slug[1]) throw new Error('unsafe-execution-linkage')
  const review = await adapter.review(card.branch)
  if (review === null) return { reviewUrl: card.reviewUrl, state: 'missing', merged: false }
  let text = adapter.setTicketAttr(request.text, 'reviewUrl', review.url)
  if (text === null) throw new Error('not-a-ticket-file')
  if (card.reviewUrl !== review.url) await adapter.persistTicket(text)
  if (!review.merged) return { reviewUrl: review.url, state: review.state, merged: false }

  const worktrees = await adapter.git(['worktree', 'list', '--porcelain'])
  const entries = worktrees.text.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => block.split(/\r?\n/))
  const assigned = entries.find((lines) => lines.includes('worktree ' + card.worktreePath))
  const expectedBranch = 'branch refs/heads/' + card.branch
  if (assigned && !assigned.includes(expectedBranch)) throw new Error('worktree-branch-mismatch')
  if (entries.some((lines) => lines !== assigned && lines.includes(expectedBranch))) throw new Error('ticket-branch-checked-out-elsewhere')
  if (assigned) {
    const dirty = await adapter.git(['-C', card.worktreePath, 'status', '--porcelain', '--untracked-files=all', '--ignored'])
    if (dirty.text !== '') throw new Error('worktree-not-clean: preserve uncommitted and ignored files first')
  }
  const branch = await adapter.git(['rev-parse', '--verify', 'refs/heads/' + card.branch], [0, 128])
  const branchPresent = branch.exitCode === 0
  const head = branchPresent ? branch.text.trim() : ''
  await adapter.releaseSession()
  if (assigned) await adapter.git(['worktree', 'remove', card.worktreePath])
  if (branchPresent) await adapter.git(['update-ref', '-d', 'refs/heads/' + card.branch, head])
  for (const [key, value] of [['column', 'done'], ['branch', null], ['worktreePath', null], ['sessionId', null]]) {
    text = adapter.setTicketAttr(text, key, value)
  }
  await adapter.persistTicket(text)
  return { reviewUrl: review.url, state: 'merged', merged: true }
}

async function kanbanAcceptLocalTicket(request, adapter) {
  const review = await kanbanLocalReview(request, adapter.git)
  const expected = request.review
  if (!expected || ['baseBranch', 'baseSha', 'head', 'branchPresent', 'worktreePresent', 'cleanupPending', 'recordedMergeSha'].some((key) => expected[key] !== review[key])) throw new Error('review-changed: review the current diff before accepting')
  if (!review.canAccept) throw new Error(review.conflict || 'merge-conflict')
  const card = parseTicketFile(request.file, request.text)
  if ((await adapter.git(['symbolic-ref', '--short', 'HEAD'])).text.trim() !== review.baseBranch) throw new Error('base-not-checked-out: switch to ' + review.baseBranch)
  if ((await adapter.git(['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).dsh-kanban', ':(exclude).gitignore'])).text !== '') throw new Error('workspace-not-clean: commit or preserve local changes first')
  if (review.worktreePresent && (await adapter.git(['-C', card.worktreePath, 'status', '--porcelain', '--untracked-files=all', '--ignored'])).text !== '') throw new Error('worktree-not-clean: preserve uncommitted and ignored files first')
  if ((await adapter.git(['rev-parse', 'HEAD'])).text.trim() !== review.baseSha) throw new Error('review-changed: Base Branch changed before merge')
  if (!review.cleanupPending) await adapter.git(['merge', '--ff', '--no-edit', review.head])
  const currentBaseSha = (await adapter.git(['rev-parse', 'HEAD'])).text.trim()
  const mergeSha = review.cleanupPending && card.mergeSha !== '' ? card.mergeSha : currentBaseSha
  let text = kanbanSetAttr(request.text, 'mergeSha', mergeSha)
  await adapter.persistTicket(text)
  await adapter.releaseSession()
  if (review.worktreePresent) await adapter.git(['worktree', 'remove', card.worktreePath])
  if (review.branchPresent) await adapter.git(['update-ref', '-d', 'refs/heads/' + card.branch, review.head])
  for (const [key, value] of [['column', 'done'], ['branch', null], ['worktreePath', null], ['sessionId', null]]) text = kanbanSetAttr(text, key, value)
  await adapter.persistTicket(text)
  return { mergeSha, column: 'done' }
}

async function kanbanLocalReview(request, git) {
  if ((await git(['remote'])).text.trim() !== '') throw new Error('local-completion-only: Workspace has a remote')
  const card = parseTicketFile(request.file, request.text)
  if (!card || card.column !== 'in-review') throw new Error('ticket-not-in-review')
  const slug = /^kan-\d+-([a-z0-9-]+)\.md$/i.exec(request.file)
  if (!slug || card.branch !== 'kanban/' + card.id + '-' + slug[1] ||
      card.worktreePath !== request.workspacePath.replace(/\/+$/, '') + '/.dsh-kanban/worktrees/' + slug[1]) throw new Error('unsafe-execution-linkage')
  const attrs = kanbanParseFrontmatter(request.text).attrs
  const baseBranch = String(attrs.baseBranch || '').trim()
  if (baseBranch === '') throw new Error('base-branch-missing: restart the Ticket to record its Base Branch')
  const baseSha = (await git(['rev-parse', '--verify', 'refs/heads/' + baseBranch])).text.trim()
  const branchResult = await git(['rev-parse', '--verify', 'refs/heads/' + card.branch], [0, 128])
  const branchPresent = branchResult.exitCode === 0
  const head = branchPresent ? branchResult.text.trim() : card.mergeSha
  if (head === '') throw new Error('ticket-branch-not-found')
  const merged = await git(['merge-base', '--is-ancestor', head, baseSha], [0, 1])
  const cleanupPending = merged.exitCode === 0
  const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', baseSha + '...' + head, '--'])
  const merge = cleanupPending ? { exitCode: 0, text: '' } : await git(['merge-tree', '--write-tree', baseSha, head], [0, 1])
  const conflict = merge.exitCode === 1 ? merge.text : null
  const worktrees = await git(['worktree', 'list', '--porcelain'])
  const entries = worktrees.text.trim().split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/))
  const assigned = entries.find((lines) => lines.includes('worktree ' + card.worktreePath))
  const expectedBranch = 'branch refs/heads/' + card.branch
  if (assigned && !assigned.includes(expectedBranch)) throw new Error('worktree-branch-mismatch')
  if (entries.some((lines) => lines !== assigned && lines.includes(expectedBranch))) throw new Error('ticket-branch-checked-out-elsewhere')
  const worktreePresent = assigned !== undefined
  if (!worktreePresent && !cleanupPending) throw new Error('ticket-worktree-not-found')
  return { baseBranch, baseSha, head, branchPresent, worktreePresent, cleanupPending,
    recordedMergeSha: card.mergeSha,
    diff: diff.text, truncated: diff.truncated, conflict,
    canAccept: conflict === null }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    kanbanDetectRemote,
    kanbanRemotePlatformAdapter,
    kanbanCompleteRemoteTicket,
    kanbanRemotePollDelay,
    kanbanAcceptLocalTicket,
    kanbanLocalReview,
  }
}
