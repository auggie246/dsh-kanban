// Local completion: review and Accept orchestration, called through Board RPCs.
// Concatenate after frontmatter.js and before host.js. Plain JavaScript only.
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
