const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseTicketFile,
  KANBAN_COLUMNS,
  kanbanSlug,
  kanbanNextId,
  serializeTicketFile,
  kanbanSetAttr,
  kanbanSetBody,
} = require('./frontmatter.js')

test('Ticket Files preserve the remote PR or MR URL through description edits', () => {
  const reviewUrl = 'https://github.com/owner/repo/pull/12'
  const text = serializeTicketFile({ id: 'KAN-110', title: 'Remote completion', column: 'in-review', reviewUrl }, 'Finished.\n')
  assert.equal(parseTicketFile('KAN-110-remote-completion.md', text).reviewUrl, reviewUrl)
  const edited = kanbanSetBody(text, 'Updated description.')
  assert.equal(parseTicketFile('KAN-110-remote-completion.md', edited).reviewUrl, reviewUrl)
})

test('Ticket Files preserve the base branch and local merge SHA', () => {
  const mergeSha = 'a'.repeat(40)
  const text = serializeTicketFile({ id: 'KAN-101', title: 'Local completion', column: 'done', baseBranch: 'main', mergeSha }, 'Finished.\n')
  const card = parseTicketFile('KAN-101-local-completion.md', text)
  assert.equal(card.baseBranch, 'main')
  assert.equal(card.mergeSha, mergeSha)
  const edited = kanbanSetBody(text, 'Updated description.')
  assert.equal(parseTicketFile('KAN-101-local-completion.md', edited).mergeSha, mergeSha)
})

test('columns are exactly the five Board columns in order', () => {
  assert.deepEqual(KANBAN_COLUMNS, ['backlog', 'ready', 'in-progress', 'in-review', 'done'])
})

test('parses id, title, column and body preview from a full Ticket File', () => {
  const text = [
    '---',
    'id: KAN-1',
    'title: "Read-only Board overlay"',
    'column: ready',
    'issue: https://github.com/auggie246/dsh-kanban/issues/1',
    '---',
    '',
    '## What to build',
    '',
    'A Kanban button in the sidebar foot opens the Board.',
    'More detail follows.',
    '',
  ].join('\n')
  const card = parseTicketFile('KAN-1-read-only-board.md', text)
  assert.equal(card.id, 'KAN-1')
  assert.equal(card.title, 'Read-only Board overlay')
  assert.equal(card.column, 'ready')
  assert.equal(card.preview, 'A Kanban button in the sidebar foot opens the Board.')
})

test('returns null when the file has no frontmatter fence', () => {
  assert.equal(parseTicketFile('KAN-1-x.md', '# Just a heading\n\nbody'), null)
  assert.equal(parseTicketFile('README.md', 'plain text'), null)
})

test('falls back to the KAN-<n> id in the file name', () => {
  const text = ['---', 'column: backlog', '---', 'body'].join('\n')
  const card = parseTicketFile('kan-7-refinement-flow.md', text)
  assert.equal(card.id, 'KAN-7')
})

test('returns null when neither frontmatter nor file name carries an id', () => {
  const text = ['---', 'column: backlog', '---', 'body'].join('\n')
  assert.equal(parseTicketFile('untitled-note.md', text), null)
})

test('falls back to the first markdown H1 for the title', () => {
  const text = ['---', 'id: KAN-3', 'column: backlog', '---', '', '# Watch loop', '', 'details'].join('\n')
  const card = parseTicketFile('KAN-3-watch-loop.md', text)
  assert.equal(card.title, 'Watch loop')
})

test('normalises an unknown column to backlog', () => {
  const text = ['---', 'id: KAN-4', 'title: x', 'column: sideways', '---', 'b'].join('\n')
  assert.equal(parseTicketFile('KAN-4-x.md', text).column, 'backlog')
})

test('column matching is case-insensitive', () => {
  const text = ['---', 'id: KAN-4', 'title: x', 'column: In-Review', '---', 'b'].join('\n')
  assert.equal(parseTicketFile('KAN-4-x.md', text).column, 'in-review')
})

test('unquotes scalar values', () => {
  const text = ['---', "id: 'KAN-2'", 'title: "Card editing"', 'column: backlog', '---', 'b'].join('\n')
  const card = parseTicketFile('KAN-2-x.md', text)
  assert.equal(card.id, 'KAN-2')
  assert.equal(card.title, 'Card editing')
})

test('preview skips headings and blanks, and truncates at 160 characters', () => {
  const long = 'word '.repeat(60).trim()
  const text = ['---', 'id: KAN-5', 'title: x', 'column: done', '---', '', '## Section', '', long, '',].join('\n')
  const card = parseTicketFile('KAN-5-x.md', text)
  assert.equal(card.preview.length <= 160, true)
  assert.equal(card.preview.endsWith('…'), true)
  assert.equal(card.preview.startsWith('word'), true)
})

test('kanbanSlug makes a lowercase dash slug from the title', () => {
  assert.equal(kanbanSlug('Fix login bug'), 'fix-login-bug')
  assert.equal(kanbanSlug('Hello, World! (v2)'), 'hello-world-v2')
})

test('kanbanSlug falls back to ticket for an empty title', () => {
  assert.equal(kanbanSlug(''), 'ticket')
  assert.equal(kanbanSlug('!!!'), 'ticket')
})

test('kanbanSlug truncates at 40 characters without a trailing dash', () => {
  const slug = kanbanSlug('a very long ticket title that keeps on going and going')
  assert.equal(slug.length <= 40, true)
  assert.equal(slug.endsWith('-'), false)
})

test('kanbanNextId starts at KAN-101 on an empty Board', () => {
  assert.equal(kanbanNextId([]), 'KAN-101')
})

test('kanbanNextId continues above the highest existing id', () => {
  assert.equal(kanbanNextId(['KAN-101', 'KAN-103', 'KAN-102']), 'KAN-104')
})

test('kanbanNextId never goes below KAN-101', () => {
  assert.equal(kanbanNextId(['KAN-1']), 'KAN-101')
  assert.equal(kanbanNextId(['KAN-99']), 'KAN-101')
})

test('kanbanNextId ignores non-KAN names', () => {
  assert.equal(kanbanNextId(['README.md', 'notes', null, undefined]), 'KAN-101')
})

test('serializeTicketFile writes keys in canonical order and plain scalars', () => {
  const text = serializeTicketFile(
    { id: 'KAN-104', title: 'Watch loop', column: 'ready' },
    '# Watch loop\n\nBody.\n',
  )
  assert.equal(
    text,
    '---\nid: KAN-104\ntitle: Watch loop\ncolumn: ready\n---\n# Watch loop\n\nBody.\n',
  )
})

test('serializeTicketFile writes an empty issue as a quoted empty scalar', () => {
  const text = serializeTicketFile(
    { id: 'KAN-2', title: 'x', column: 'backlog', blocked: 'Waiting on review', issue: '' },
    'b\n',
  )
  assert.equal(
    text,
    '---\nid: KAN-2\ntitle: x\ncolumn: backlog\nblocked: Waiting on review\nissue: ""\n---\nb\n',
  )
})

test('serializeTicketFile drops keys outside the documented frontmatter set', () => {
  const text = serializeTicketFile(
    { id: 'KAN-2', title: 'x', column: 'backlog', mood: 'experimental' },
    'b',
  )
  assert.equal(text, '---\nid: KAN-2\ntitle: x\ncolumn: backlog\n---\nb\n')
})

test('serializeTicketFile folds newlines inside a scalar into spaces', () => {
  const text = serializeTicketFile(
    { id: 'KAN-1', title: 'x', column: 'backlog', blocked: 'line one\nline two' },
    'b',
  )
  assert.equal(text.includes('blocked: line one line two\n'), true)
})

test('serializeTicketFile output parses back to the same card', () => {
  const attrs = { id: 'KAN-7', title: 'Card editing', column: 'in-progress', blocked: 'reason' }
  const body = '# Card editing\n\nGoal\n\nContext\n'
  const card = parseTicketFile('KAN-7-card-editing.md', serializeTicketFile(attrs, body))
  assert.equal(card.id, 'KAN-7')
  assert.equal(card.title, 'Card editing')
  assert.equal(card.column, 'in-progress')
  assert.equal(card.body, body)
})

test('serializeTicketFile ensures the body ends with one newline', () => {
  const text = serializeTicketFile({ id: 'KAN-1', title: 'x', column: 'backlog' }, 'no trailing newline')
  assert.equal(text.endsWith('no trailing newline\n'), true)
})

test('serializeTicketFile quotes scalars containing YAML-breaking characters', () => {
  const text = serializeTicketFile({ id: 'KAN-1', title: 'Fix: login flow', column: 'backlog' }, 'b')
  assert.equal(text, '---\nid: KAN-1\ntitle: "Fix: login flow"\ncolumn: backlog\n---\nb\n')
})

test('serializeTicketFile escapes quotes and backslashes in blocked reasons', () => {
  const text = serializeTicketFile(
    { id: 'KAN-1', title: 'x', column: 'backlog', blocked: 'He said "no"' },
    'b',
  )
  assert.equal(text.includes('blocked: "He said \\"no\\""\n'), true)
})

test('parser unescapes quotes and backslashes in double-quoted values', () => {
  const text = '---\nid: KAN-1\ntitle: "He said \\"no\\""\ncolumn: backlog\nblocked: "at C:\\\\temp"\n---\nb'
  const card = parseTicketFile('KAN-1-x.md', text)
  assert.equal(card.title, 'He said "no"')
  assert.equal(card.blocked, 'at C:\\temp')
})

test('kanbanSetAttr rewrites only the target line, body stays byte-identical', () => {
  const before = '---\nid: KAN-3\ntitle: Watch loop\ncolumn: ready\nissue: x\n---\n# Body\n\ncolumn: not frontmatter\n'
  const after = '---\nid: KAN-3\ntitle: Watch loop\ncolumn: in-progress\nissue: x\n---\n# Body\n\ncolumn: not frontmatter\n'
  assert.equal(kanbanSetAttr(before, 'column', 'in-progress'), after)
})

test('kanbanSetAttr inserts a missing key before the closing fence', () => {
  const before = '---\nid: KAN-1\ntitle: x\n---\nbody\n'
  const after = '---\nid: KAN-1\ntitle: x\nblocked: reason\n---\nbody\n'
  assert.equal(kanbanSetAttr(before, 'blocked', 'reason'), after)
})

test('kanbanSetAttr removes the key when the value is empty or null', () => {
  const before = '---\nid: KAN-1\ncolumn: ready\nblocked: reason\n---\nbody\n'
  const after = '---\nid: KAN-1\ncolumn: ready\n---\nbody\n'
  assert.equal(kanbanSetAttr(before, 'blocked', ''), after)
  assert.equal(kanbanSetAttr(before, 'blocked', null), after)
})

test('kanbanSetAttr returns null when the text has no frontmatter', () => {
  assert.equal(kanbanSetAttr('no fence here', 'column', 'done'), null)
})

test('kanbanSetAttr preserves CRLF line endings in the frontmatter', () => {
  const before = '---\r\nid: KAN-3\r\ntitle: x\r\ncolumn: ready\r\n---\r\nbody line\r\n'
  const after = '---\r\nid: KAN-3\r\ntitle: x\r\ncolumn: done\r\n---\r\nbody line\r\n'
  assert.equal(kanbanSetAttr(before, 'column', 'done'), after)
})

test('kanbanSetBody preserves CRLF line endings in the frontmatter', () => {
  const before = '---\r\nid: KAN-3\r\ntitle: x\r\n---\r\nold\r\n'
  const after = '---\r\nid: KAN-3\r\ntitle: x\r\n---\r\nnew\n'
  assert.equal(kanbanSetBody(before, 'new'), after)
})

test('kanbanSetBody replaces everything after the closing fence', () => {
  const before = '---\nid: KAN-1\ntitle: x\n---\nold body\nmore old\n'
  const after = '---\nid: KAN-1\ntitle: x\n---\nnew body\n'
  assert.equal(kanbanSetBody(before, 'new body'), after)
})

test('kanbanSetBody leaves the frontmatter byte-identical', () => {
  const before = '---\nid: KAN-1\nblocked: "a \\"b\\" c"\n---\nx\n'
  const after = kanbanSetBody(before, 'y')
  assert.equal(after.startsWith('---\nid: KAN-1\nblocked: "a \\"b\\" c"\n---\ny\n'), true)
})

test('kanbanSetBody returns null when the text has no frontmatter', () => {
  assert.equal(kanbanSetBody('no fence', 'body'), null)
})

test('preview is empty when the body has no prose', () => {
  const text = ['---', 'id: KAN-6', 'title: x', 'column: backlog', '---', '', '# Only headings', ''].join('\n')
  assert.equal(parseTicketFile('KAN-6-x.md', text).preview, '')
})

// Issue #5: the queued marker. `queued` records the UTC instant a Ticket was
// queued past the WIP limit; absent or empty means not queued.

test('parseTicketFile surfaces the queued instant from a quoted scalar', () => {
  const text = [
    '---',
    'id: KAN-103',
    'title: x',
    'column: in-progress',
    'queued: "2026-07-14T09:30:00.000Z"',
    '---',
    'b',
  ].join('\n')
  const card = parseTicketFile('KAN-103-x.md', text)
  assert.equal(card.queued, '2026-07-14T09:30:00.000Z')
})

test('parseTicketFile reports an empty queued value when the key is absent', () => {
  const text = ['---', 'id: KAN-103', 'title: x', 'column: ready', '---', 'b'].join('\n')
  assert.equal(parseTicketFile('KAN-103-x.md', text).queued, '')
})

test('serializeTicketFile writes queued in canonical order after column', () => {
  const text = serializeTicketFile(
    { id: 'KAN-103', title: 'x', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' },
    'b\n',
  )
  assert.equal(
    text,
    '---\nid: KAN-103\ntitle: x\ncolumn: in-progress\nqueued: "2026-07-14T09:30:00.000Z"\n---\nb\n',
  )
})

test('serializeTicketFile output with queued parses back to the same card', () => {
  const attrs = { id: 'KAN-103', title: 'x', column: 'in-progress', queued: '2026-07-14T09:30:00.000Z' }
  const card = parseTicketFile('KAN-103-x.md', serializeTicketFile(attrs, 'b\n'))
  assert.equal(card.queued, '2026-07-14T09:30:00.000Z')
})

test('kanbanSetAttr queues a Ticket with the quoted instant', () => {
  const before = '---\nid: KAN-103\ntitle: x\ncolumn: in-progress\n---\nbody\n'
  const after = '---\nid: KAN-103\ntitle: x\ncolumn: in-progress\nqueued: "2026-07-14T09:30:00.000Z"\n---\nbody\n'
  assert.equal(kanbanSetAttr(before, 'queued', '2026-07-14T09:30:00.000Z'), after)
})

test('kanbanSetAttr removes the queued marker when the Ticket dequeues', () => {
  const before = '---\nid: KAN-103\ntitle: x\ncolumn: in-progress\nqueued: "2026-07-14T09:30:00.000Z"\n---\nbody\n'
  const after = '---\nid: KAN-103\ntitle: x\ncolumn: in-progress\n---\nbody\n'
  assert.equal(kanbanSetAttr(before, 'queued', null), after)
})
