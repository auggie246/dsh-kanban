// Remote Issue integration helpers. Concatenate after completion.js and
// before host.js. Plain JavaScript only.

function kanbanIssueImportAdapter(remote, command) {
  if (!remote || (remote.platform !== 'github' && remote.platform !== 'gitlab')) {
    throw new Error('unsupported-remote-platform')
  }
  const parsePage = (text) => {
    let values
    try { values = JSON.parse(String(text || '')) } catch { throw new Error(remote.platform + '-issues-invalid-json') }
    if (!Array.isArray(values)) throw new Error(remote.platform + '-issues-invalid-response')
    return values
  }
  const normalize = remote.platform === 'github'
    ? (values) => values.map((value) => ({
        number: Number(value.number),
        title: String(value.title || ''),
        body: String(value.body || ''),
        url: String(value.url || ''),
      }))
    : (values) => values.map((value) => ({
        number: Number(value.iid),
        title: String(value.title || ''),
        body: String(value.description || ''),
        url: String(value.web_url || ''),
      }))
  return {
    async listOpen() {
      if (remote.platform === 'github') {
        const result = await command([
          'gh', 'issue', 'list', '--repo', remote.repo, '--state', 'open', '--limit', '1000',
          '--json', 'number,title,body,url',
        ])
        return normalize(parsePage(result.text))
      }
      const issues = []
      for (let page = 1;; page += 1) {
        const result = await command([
          'glab', 'issue', 'list', '--repo', remote.url || remote.repo, '--page', String(page),
          '--per-page', '100', '--output', 'json',
        ])
        const values = parsePage(result.text)
        issues.push(...normalize(values))
        if (values.length < 100) return issues
      }
    },
  }
}

// Bind one supported platform CLI to Board-owned Issue label writes.
function kanbanIssueSyncAdapter(remote, command) {
  if (!remote || (remote.platform !== 'github' && remote.platform !== 'gitlab')) {
    throw new Error('unsupported-remote-platform')
  }
  const issueNumber = (issueUrl) => {
    const pattern = remote.platform === 'github' ? /\/issues\/(\d+)(?:[/?#]|$)/ : /\/-\/issues\/(\d+)(?:[/?#]|$)/
    const match = pattern.exec(String(issueUrl || ''))
    if (match === null) throw new Error(remote.platform + '-issue-url-invalid')
    return match[1]
  }
  const labelNames = (values) => values.map((label) =>
    String(typeof label === 'string' ? label : label && label.name || '')).filter((label) => label !== '')
  const parseJson = (text, kind) => {
    try { return JSON.parse(String(text || '')) } catch { throw new Error(remote.platform + '-' + kind + '-invalid-json') }
  }
  const ensureLabel = async (target) => {
    if (remote.platform === 'github') {
      const values = parseJson((await command([
        'gh', 'label', 'list', '--repo', remote.repo, '--search', target, '--limit', '100', '--json', 'name',
      ])).text, 'labels')
      if (!Array.isArray(values)) throw new Error('github-labels-invalid-response')
      if (!labelNames(values).includes(target)) await command(['gh', 'label', 'create', target, '--repo', remote.repo])
      return
    }
    for (let page = 1;; page += 1) {
      const values = parseJson((await command([
        'glab', 'label', 'list', '--repo', remote.repo, '--output', 'json',
        '--page', String(page), '--per-page', '100',
      ])).text, 'labels')
      if (!Array.isArray(values)) throw new Error('gitlab-labels-invalid-response')
      if (labelNames(values).includes(target)) return
      if (values.length < 100) {
        await command(['glab', 'label', 'create', '--name', target, '--repo', remote.repo])
        return
      }
    }
  }
  const project = remote.repo.split('/').slice(1).join('/')
  const normalizeState = (state) => {
    const value = String(state || '').toLowerCase()
    return value === 'opened' ? 'open' : value
  }
  const normalizeComment = (comment) => ({
    id: String(comment && comment.id || ''),
    author: String(comment && comment.author && (comment.author.login || comment.author.username) || ''),
    body: String(comment && comment.body || ''),
    url: String(comment && (comment.url || comment.web_url) || ''),
    createdAt: String(comment && (comment.createdAt || comment.created_at) || ''),
  })
  const normalizeBlocker = (issue) => ({
    id: String(issue && issue.id || ''),
    number: Number(issue && (issue.number || issue.iid)),
    title: String(issue && issue.title || ''),
    url: String(issue && (issue.url || issue.web_url) || ''),
    state: normalizeState(issue && issue.state),
  })
  return {
    async read(issueUrl) {
      const number = issueNumber(issueUrl)
      if (remote.platform === 'github') {
        const issue = parseJson((await command([
          'gh', 'issue', 'view', issueUrl, '--repo', remote.repo,
          '--json', 'title,body,state,comments,labels,blockedBy',
        ])).text, 'issue')
        if (!issue || !Array.isArray(issue.comments) || !Array.isArray(issue.labels) ||
            !issue.blockedBy || !Array.isArray(issue.blockedBy.nodes)) {
          throw new Error('github-issue-invalid-response')
        }
        return {
          title: String(issue.title || ''),
          body: String(issue.body || ''),
          state: normalizeState(issue.state),
          labels: labelNames(issue.labels),
          comments: issue.comments.map(normalizeComment),
          blockers: issue.blockedBy.nodes.map(normalizeBlocker),
        }
      }
      const root = 'projects/' + encodeURIComponent(project) + '/issues/' + number
      const issue = parseJson((await command(['glab', 'api', root])).text, 'issue')
      const notes = parseJson((await command(['glab', 'api', root + '/notes', '--paginate'])).text, 'issue-comments')
      const links = parseJson((await command(['glab', 'api', root + '/links', '--paginate'])).text, 'issue-links')
      if (!issue || !Array.isArray(issue.labels) || !Array.isArray(notes) || !Array.isArray(links)) {
        throw new Error('gitlab-issue-invalid-response')
      }
      return {
        title: String(issue.title || ''),
        body: String(issue.description || ''),
        state: normalizeState(issue.state),
        labels: labelNames(issue.labels),
        comments: notes.filter((note) => note && note.system !== true).map(normalizeComment),
        blockers: links.filter((link) => link && link.link_type === 'is_blocked_by').map(normalizeBlocker),
      }
    },
    async setColumn(issueUrl, column) {
      const target = 'kanban:' + String(column || '')
      const number = issueNumber(issueUrl)
      await ensureLabel(target)
      const viewArgs = remote.platform === 'github'
        ? ['gh', 'issue', 'view', issueUrl, '--repo', remote.repo, '--json', 'labels,state']
        : ['glab', 'issue', 'view', number, '--repo', remote.repo, '--output', 'json']
      const issue = parseJson((await command(viewArgs)).text, 'issue')
      if (!issue || !Array.isArray(issue.labels)) throw new Error(remote.platform + '-issue-invalid-response')
      const labels = labelNames(issue.labels)
      const stale = labels.filter((label) => label.startsWith('kanban:') && label !== target)
      const hasTarget = labels.includes(target)
      if (!hasTarget || stale.length > 0) {
        const editArgs = remote.platform === 'github'
          ? ['gh', 'issue', 'edit', issueUrl, '--repo', remote.repo]
          : ['glab', 'issue', 'update', number, '--repo', remote.repo]
        if (!hasTarget) editArgs.push(remote.platform === 'github' ? '--add-label' : '--label', target)
        if (stale.length > 0) {
          editArgs.push(remote.platform === 'github' ? '--remove-label' : '--unlabel', stale.join(','))
        }
        await command(editArgs)
      }
      if (column !== 'done' && normalizeState(issue.state) === 'closed') {
        await command(remote.platform === 'github'
          ? ['gh', 'issue', 'reopen', issueUrl, '--repo', remote.repo]
          : ['glab', 'issue', 'reopen', number, '--repo', remote.repo])
      }
    },
    async complete(issueUrl, reviewUrl) {
      const number = issueNumber(issueUrl)
      const reference = String(reviewUrl || '').trim()
      if (reference === '') throw new Error('completion-review-url-required')
      const marker = '<!-- dsh-kanban-completion:' + reference + ' -->'
      const message = 'Completed by merged PR/MR: ' + reference + '\n\n' + marker
      if (remote.platform === 'github') {
        const value = parseJson((await command([
          'gh', 'issue', 'view', issueUrl, '--repo', remote.repo, '--json', 'state,comments',
        ])).text, 'issue')
        if (!value || !Array.isArray(value.comments)) throw new Error('github-issue-invalid-response')
        const hasComment = value.comments.some((comment) => String(comment && comment.body || '').includes(marker))
        const open = String(value.state || '').toLowerCase() !== 'closed'
        if (!hasComment && open) {
          await command(['gh', 'issue', 'close', issueUrl, '--repo', remote.repo, '--comment', message])
          return
        }
        if (!hasComment) await command(['gh', 'issue', 'comment', issueUrl, '--repo', remote.repo, '--body', message])
        if (open) await command(['gh', 'issue', 'close', issueUrl, '--repo', remote.repo])
        return
      }
      const issue = parseJson((await command([
        'glab', 'issue', 'view', number, '--repo', remote.repo, '--output', 'json',
      ])).text, 'issue')
      const notes = parseJson((await command([
        'glab', 'api', 'projects/' + encodeURIComponent(project) + '/issues/' + number + '/notes', '--paginate',
      ])).text, 'issue-comments')
      if (!Array.isArray(notes)) throw new Error('gitlab-issue-comments-invalid-response')
      if (!notes.some((note) => String(note && note.body || '').includes(marker))) {
        await command(['glab', 'issue', 'note', number, '--repo', remote.repo, '--message', message])
      }
      if (String(issue && issue.state || '').toLowerCase() !== 'closed') {
        await command(['glab', 'issue', 'close', number, '--repo', remote.repo])
      }
    },
  }
}

const kanbanIssueSyncRecordSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Issue sync record must be an object')
    }
    const comments = Array.isArray(value.comments) ? value.comments : []
    const blockers = Array.isArray(value.blockers) ? value.blockers : []
    if (typeof value.issue !== 'string' || typeof value.error !== 'string' ||
        typeof value.lastAttemptAt !== 'string' || typeof value.lastSuccessAt !== 'string' ||
        comments.some((entry) => !entry || typeof entry.body !== 'string') ||
        blockers.some((entry) => !entry || typeof entry.title !== 'string' || typeof entry.state !== 'string')) {
      throw new Error('Issue sync record is malformed')
    }
    return {
      issue: value.issue,
      comments: comments.map((entry) => ({
        id: String(entry.id || ''), author: String(entry.author || ''), body: entry.body,
        url: String(entry.url || ''), createdAt: String(entry.createdAt || ''),
      })),
      blockers: blockers.map((entry) => ({
        id: String(entry.id || ''), number: Number(entry.number), title: entry.title,
        url: String(entry.url || ''), state: entry.state,
      })),
      error: value.error,
      lastAttemptAt: value.lastAttemptAt,
      lastSuccessAt: value.lastSuccessAt,
    }
  },
}

function kanbanIssueLinkKey(value) {
  return String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
}

function kanbanMarkImportedIssues(issues, tickets) {
  const linked = new Set((tickets || []).map((ticket) => kanbanIssueLinkKey(ticket.issue)).filter(Boolean))
  return (issues || []).map((issue) => ({
    ...issue,
    imported: linked.has(kanbanIssueLinkKey(issue.url)),
  }))
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { kanbanIssueImportAdapter, kanbanIssueSyncAdapter, kanbanIssueLinkKey, kanbanMarkImportedIssues }
}
