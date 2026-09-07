const test = require('node:test')
const assert = require('node:assert/strict')
const {
  kanbanDetectRemote,
  kanbanRemotePlatformAdapter,
  kanbanCompleteRemoteTicket,
  kanbanRemotePollDelay,
} = require('./completion.js')
const { parseTicketFile, kanbanSetAttr } = require('./frontmatter.js')

function completionAdapter(adapter) {
  return { parseTicketFile, setTicketAttr: kanbanSetAttr, ...adapter }
}

function fakeGit(remotes) {
  return async (args) => {
    if (args[0] === 'remote' && args.length === 1) return { text: Object.keys(remotes).join('\n'), exitCode: 0 }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]]
      return url === undefined ? { text: '', exitCode: 2 } : { text: url + '\n', exitCode: 0 }
    }
    throw new Error('unexpected git: ' + args.join(' '))
  }
}

test('remote detection distinguishes GitHub, GitLab, and no supported remote', async () => {
  assert.deepEqual(await kanbanDetectRemote(fakeGit({ origin: 'git@github.com:owner/repo.git' })), {
    platform: 'github', remote: 'origin', url: 'git@github.com:owner/repo.git',
  })
  assert.deepEqual(await kanbanDetectRemote(fakeGit({ upstream: 'https://gitlab.com/group/repo.git' })), {
    platform: 'gitlab', remote: 'upstream', url: 'https://gitlab.com/group/repo.git',
  })
  assert.deepEqual(await kanbanDetectRemote(fakeGit({ origin: 'ssh://code.example.test/repo.git' })), {
    platform: 'none', remote: '', url: '',
  })
  assert.deepEqual(await kanbanDetectRemote(fakeGit({})), { platform: 'none', remote: '', url: '' })
})

test('remote detection prefers a supported origin over other remotes', async () => {
  const result = await kanbanDetectRemote(fakeGit({ mirror: 'https://gitlab.com/group/mirror.git', origin: 'https://github.com/owner/repo.git' }))
  assert.equal(result.platform, 'github')
  assert.equal(result.remote, 'origin')
})

test('GitHub and GitLab adapters normalize open and merged change requests', async () => {
  const calls = []
  const command = async (args) => {
    calls.push(args)
    if (args[0] === 'gh') return { exitCode: 0, text: '{"url":"https://github.com/o/r/pull/7","state":"MERGED","mergedAt":"2026-01-02T03:04:05Z"}' }
    return { exitCode: 0, text: '{"web_url":"https://gitlab.com/g/r/-/merge_requests/8","state":"opened","merged_at":null}' }
  }
  const github = kanbanRemotePlatformAdapter({ platform: 'github', remote: 'origin' }, command)
  const gitlab = kanbanRemotePlatformAdapter({ platform: 'gitlab', remote: 'upstream' }, command)
  assert.deepEqual(await github.review('kanban/KAN-101-fix'), {
    url: 'https://github.com/o/r/pull/7', state: 'merged', merged: true,
  })
  assert.deepEqual(await gitlab.review('kanban/KAN-102-fix'), {
    url: 'https://gitlab.com/g/r/-/merge_requests/8', state: 'open', merged: false,
  })
  assert.deepEqual(calls, [
    ['gh', 'pr', 'view', 'kanban/KAN-101-fix', '--json', 'url,state,mergedAt,headRefName'],
    ['glab', 'mr', 'view', 'kanban/KAN-102-fix', '--output', 'json'],
  ])
})

test('platform adapters report a missing change request without throwing', async () => {
  const command = async () => ({ exitCode: 1, text: '' })
  const adapter = kanbanRemotePlatformAdapter({ platform: 'github', remote: 'origin' }, command)
  assert.equal(await adapter.review('kanban/KAN-101-fix'), null)
})

test('remote polling backs off to a five-minute ceiling', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(kanbanRemotePollDelay), [15000, 30000, 60000, 120000, 240000, 300000])
})

test('a merged remote change request records its URL and cleans local execution', async () => {
  const original = '---\nid: KAN-101\ntitle: Fix login\ncolumn: in-review\nbranch: kanban/KAN-101-fix-login\nworktreePath: /workspace/.dsh-kanban/worktrees/fix-login\nsessionId: remote-session\n---\nFix login.\n'
  const persisted = []
  const gitCalls = []
  let released = 0
  const result = await kanbanCompleteRemoteTicket({
    file: 'KAN-101-fix-login.md', text: original, workspacePath: '/workspace',
  }, completionAdapter({
    review: async () => ({ url: 'https://github.com/o/r/pull/7', state: 'merged', merged: true }),
    git: async (args) => {
      gitCalls.push(args)
      if (args[0] === 'worktree') return { exitCode: 0, text: 'worktree /workspace/.dsh-kanban/worktrees/fix-login\nbranch refs/heads/kanban/KAN-101-fix-login\n' }
      if (args[0] === '-C') return { exitCode: 0, text: '' }
      if (args[0] === 'rev-parse') return { exitCode: 0, text: 'ticket-head\n' }
      return { exitCode: 0, text: '' }
    },
    persistTicket: async (text) => persisted.push(text),
    releaseSession: async () => { released += 1 },
  }))
  assert.deepEqual(result, { reviewUrl: 'https://github.com/o/r/pull/7', state: 'merged', merged: true })
  assert.equal(released, 1)
  assert.match(persisted[0], /reviewUrl: "https:\/\/github.com\/o\/r\/pull\/7"/)
  assert.match(persisted.at(-1), /column: done/)
  assert.doesNotMatch(persisted.at(-1), /(?:branch|worktreePath|sessionId):/)
  assert.deepEqual(gitCalls.at(-2), ['worktree', 'remove', '/workspace/.dsh-kanban/worktrees/fix-login'])
  assert.deepEqual(gitCalls.at(-1), ['update-ref', '-d', 'refs/heads/kanban/KAN-101-fix-login', 'ticket-head'])
})

test('an open remote change request records its URL without cleaning execution', async () => {
  const original = '---\nid: KAN-101\ncolumn: in-review\nbranch: kanban/KAN-101-fix-login\nworktreePath: /workspace/.dsh-kanban/worktrees/fix-login\nsessionId: remote-session\n---\nFix login.\n'
  const persisted = []
  const result = await kanbanCompleteRemoteTicket({ file: 'KAN-101-fix-login.md', text: original, workspacePath: '/workspace' }, completionAdapter({
    review: async () => ({ url: 'https://gitlab.com/g/r/-/merge_requests/8', state: 'open', merged: false }),
    git: async () => { throw new Error('open review must not clean Git state') },
    persistTicket: async (text) => persisted.push(text),
    releaseSession: async () => { throw new Error('open review must not release the session') },
  }))
  assert.equal(result.merged, false)
  assert.match(persisted[0], /reviewUrl: "https:\/\/gitlab.com\/g\/r\/-\/merge_requests\/8"/)
})
