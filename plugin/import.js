// Remote Issue import helpers. Concatenate after completion.js and before
// host.js. Plain JavaScript only.

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
  const labelsFrom = (text) => {
    const value = parseJson(text, 'issue')
    if (!value || !Array.isArray(value.labels)) throw new Error(remote.platform + '-issue-invalid-response')
    return labelNames(value.labels)
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
  return {
    async setColumn(issueUrl, column) {
      const target = 'kanban:' + String(column || '')
      const number = issueNumber(issueUrl)
      await ensureLabel(target)
      const viewArgs = remote.platform === 'github'
        ? ['gh', 'issue', 'view', issueUrl, '--repo', remote.repo, '--json', 'labels']
        : ['glab', 'issue', 'view', number, '--repo', remote.repo, '--output', 'json']
      const labels = labelsFrom((await command(viewArgs)).text)
      const stale = labels.filter((label) => label.startsWith('kanban:') && label !== target)
      const hasTarget = labels.includes(target)
      if (hasTarget && stale.length === 0) return
      const editArgs = remote.platform === 'github'
        ? ['gh', 'issue', 'edit', issueUrl, '--repo', remote.repo]
        : ['glab', 'issue', 'update', number, '--repo', remote.repo]
      if (!hasTarget) editArgs.push(remote.platform === 'github' ? '--add-label' : '--label', target)
      if (stale.length > 0) {
        editArgs.push(remote.platform === 'github' ? '--remove-label' : '--unlabel', stale.join(','))
      }
      await command(editArgs)
    },
  }
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
