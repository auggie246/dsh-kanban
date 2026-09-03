const test = require('node:test')
const assert = require('node:assert/strict')
const { parseTicketFile, KANBAN_COLUMNS } = require('./frontmatter.js')

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

test('preview is empty when the body has no prose', () => {
  const text = ['---', 'id: KAN-6', 'title: x', 'column: backlog', '---', '', '# Only headings', ''].join('\n')
  assert.equal(parseTicketFile('KAN-6-x.md', text).preview, '')
})
