const test = require('node:test')
const assert = require('node:assert/strict')
const {
  kanbanIssueImportAdapter,
  kanbanMarkImportedIssues,
} = require('./import.js')

test('GitHub and GitLab open Issue lists become one shared Issue shape', async () => {
  const calls = []
  const command = async (args) => {
    calls.push(args)
    if (args[0] === 'gh') {
      return {
        text: JSON.stringify([
          { number: 12, title: 'GitHub title', body: 'GitHub body', url: 'https://github.com/o/r/issues/12' },
        ]),
      }
    }
    return {
      text: JSON.stringify([
        { iid: 34, title: 'GitLab title', description: 'GitLab body', web_url: 'https://gitlab.com/g/r/-/issues/34' },
      ]),
    }
  }

  const github = kanbanIssueImportAdapter(
    { platform: 'github', repo: 'github.com/o/r' },
    command,
  )
  const gitlab = kanbanIssueImportAdapter(
    { platform: 'gitlab', repo: 'gitlab.com/g/r', url: 'https://gitlab.com/g/r.git' },
    command,
  )

  assert.deepEqual(await github.listOpen(), [{
    number: 12,
    title: 'GitHub title',
    body: 'GitHub body',
    url: 'https://github.com/o/r/issues/12',
  }])
  assert.deepEqual(await gitlab.listOpen(), [{
    number: 34,
    title: 'GitLab title',
    body: 'GitLab body',
    url: 'https://gitlab.com/g/r/-/issues/34',
  }])
  assert.deepEqual(calls, [
    ['gh', 'issue', 'list', '--repo', 'github.com/o/r', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,url'],
    ['glab', 'issue', 'list', '--repo', 'https://gitlab.com/g/r.git', '--page', '1', '--per-page', '100', '--output', 'json'],
  ])
})

test('GitLab Issue listing reads every page of open Issues', async () => {
  const calls = []
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    iid: index + 1,
    title: 'Issue ' + String(index + 1),
    description: '',
    web_url: 'https://gitlab.com/g/r/-/issues/' + String(index + 1),
  }))
  const command = async (args) => {
    calls.push(args)
    return { text: JSON.stringify(args.includes('2') ? [{
      iid: 101,
      title: 'Issue 101',
      description: '',
      web_url: 'https://gitlab.com/g/r/-/issues/101',
    }] : firstPage) }
  }
  const adapter = kanbanIssueImportAdapter({
    platform: 'gitlab', repo: 'gitlab.com/g/r', url: 'git@gitlab.com:g/r.git',
  }, command)

  const issues = await adapter.listOpen()

  assert.equal(issues.length, 101)
  assert.deepEqual(calls.map((args) => args[args.indexOf('--page') + 1]), ['1', '2'])
})

test('Issue import marks linked Issues as imported without hiding them', () => {
  const issues = [
    { number: 12, title: 'Imported', body: '', url: 'https://github.com/o/r/issues/12' },
    { number: 13, title: 'Available', body: '', url: 'https://github.com/o/r/issues/13' },
  ]
  const tickets = [{ issue: 'https://github.com/o/r/issues/12/?utm_source=board#top' }]

  assert.deepEqual(kanbanMarkImportedIssues(issues, tickets), [
    { ...issues[0], imported: true },
    { ...issues[1], imported: false },
  ])
})
