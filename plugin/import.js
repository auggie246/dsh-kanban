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
  module.exports = { kanbanIssueImportAdapter, kanbanIssueLinkKey, kanbanMarkImportedIssues }
}
