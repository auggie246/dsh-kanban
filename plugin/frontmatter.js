// Ticket File frontmatter parsing — pure functions.
//
// This file is the shared seam between the test suite (`node --test`,
// CommonJS export below) and the Plugin's Host half: `cordis_define`
// receives this file's source concatenated in front of `plugin/host.js`,
// so the `kanban*` functions must stay plain top-level declarations.
//
// Vocabulary follows CONTEXT.md: one Ticket File is
// `.dsh-kanban/tickets/<id>-<slug>.md` with frontmatter for state.

// The five Board columns; mirror of COLUMNS in plugin/client.js — keep the
// pair in lockstep (one concept, two copies; there is no shared module the
// define payload can import on both sides).
const KANBAN_COLUMNS = ['backlog', 'ready', 'in-progress', 'in-review', 'done']

// parseFrontmatter(text) → { attrs, body } | null.
// Accepts the strict form ---\n key: value … \n---; values are scalars
// (multi-line YAML is intentionally unsupported for now).
function kanbanParseFrontmatter(text) {
  if (typeof text !== 'string') return null
  const open = text.match(/^\uFEFF?---[ \t]*\r?\n/)
  if (!open) return null
  const rest = text.slice(open[0].length)
  const close = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!close) return null
  const attrs = {}
  for (const line of rest.slice(0, close.index).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value[value.length - 1] === q && value.length >= 2) {
      value = value.slice(1, -1)
      if (q === '"') value = value.replace(/\\(["\\])/g, '$1')
    }
    attrs[m[1]] = value
  }
  let body = rest.slice(close.index + close[0].length)
  if (body.startsWith('---')) {
    // Closing fence consumed without its trailing newline (file ends at ---).
    body = body.slice(3).replace(/^[ \t]*\r?\n?/, '')
  }
  return { attrs, body }
}

function kanbanIdFromFileName(fileName) {
  const m = /^(kan-\d+)/i.exec(fileName || '')
  return m ? m[1].toUpperCase() : null
}

function kanbanFirstHeading(body) {
  const m = /^#\s+(.+?)\s*$/m.exec(body)
  return m ? m[1] : null
}

function kanbanBodyPreview(body, max) {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.length <= max) return line
    return line.slice(0, max - 1) + '…'
  }
  return ''
}

// kanbanSlug(title) → the <slug> part of a new Ticket File name: lowercase,
// alphanumerics separated by single dashes, at most 40 characters, never
// ending on a dash; 'ticket' when the title carries no usable characters.
function kanbanSlug(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'ticket' : slug
}

// kanbanNextId(ids) → the next free 'KAN-<n>' id: one above the highest
// existing KAN number, never below KAN-101. The 101 floor keeps KAN ids
// visually distinct from GitHub issue numbers (#1.. in this repo), even on
// Boards seeded with hand-numbered low ids.
function kanbanNextId(ids) {
  let max = 0
  for (const raw of ids || []) {
    const m = /^kan-(\d+)$/i.exec(String(raw == null ? '' : raw).trim())
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return 'KAN-' + Math.max(max + 1, 101)
}

// kanbanScalar(value) → one line-safe YAML-lite scalar: plain when safe,
// double-quoted (with \" and \\ escapes) when the value carries characters
// that would break a flat scalar or a strict YAML reader. Newlines are
// folded to single spaces first — scalars always stay on one line.
function kanbanScalar(value) {
  const text = String(value).replace(/\s*\r?\n\s*/g, ' ')
  if (text !== '' && text === text.trim() && !/[:#"'\\\n\r]/.test(text)) return text
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// The documented frontmatter keys (CONTEXT.md, Ticket File), in canonical
// write order. Keys outside this set are never written by the serializer.
const KANBAN_KEY_ORDER = [
  'id',
  'title',
  'column',
  'queued',
  'blocked',
  'issue',
  'reviewUrl',
  'base',
  'baseBranch',
  'branch',
  'worktreePath',
  'sessionId',
  'bounces',
  'mergeSha',
]

// serializeTicketFile(attrs, body) → the full Ticket File text. Only the
// documented keys are written; undefined/null values are omitted, an empty
// string is written as the quoted empty scalar "". The body always ends
// with exactly one newline.
function serializeTicketFile(attrs, body) {
  const lines = []
  for (const key of KANBAN_KEY_ORDER) {
    const value = attrs[key]
    if (value === undefined || value === null) continue
    lines.push(key + ': ' + kanbanScalar(value))
  }
  let text = '---\n' + lines.join('\n') + '\n---\n' + String(body || '')
  if (!text.endsWith('\n')) text += '\n'
  return text
}

// kanbanFrontmatterParts(text) → { head, lines, sep, tail } | null, the one
// place that finds the frontmatter boundaries. `head` is the opening fence
// including its line ending, `lines` the frontmatter lines without endings,
// `sep` the detected line-ending style (LF or CRLF), `tail` everything from
// the newline before the closing fence onward. A caller that re-joins
// `lines` with `sep` leaves the rest of the file byte-identical.
function kanbanFrontmatterParts(text) {
  const open = text.match(/^\uFEFF?---[ \t]*\r?\n/)
  if (open === null) return null
  const rest = text.slice(open[0].length)
  const close = rest.match(/\r?\n---[ \t]*(?:\r?\n|$)/)
  if (close === null) return null
  return {
    head: open[0],
    lines: rest.slice(0, close.index).split(/\r?\n/),
    sep: open[0].endsWith('\r\n') ? '\r\n' : '\n',
    tail: rest.slice(close.index),
    fenceLength: close[0].length,
  }
}

// kanbanSetAttr(text, key, value) → the same Ticket File with exactly one
// frontmatter line rewritten (or inserted before the closing fence, or
// removed when value is empty/null). Everything else — key order, quoting,
// line endings, and the whole body — stays byte-identical, which is what
// makes a move touch only the `column` field. Null when there is no fence.
function kanbanSetAttr(text, key, value) {
  const parts = kanbanFrontmatterParts(text)
  if (parts === null) return null
  const matcher = new RegExp('^\\s*' + key + ':')
  const index = parts.lines.findIndex((line) => matcher.test(line))
  if (value === undefined || value === null || value === '') {
    if (index === -1) return text
    parts.lines.splice(index, 1)
  } else {
    const line = key + ': ' + kanbanScalar(value)
    if (index === -1) parts.lines.push(line)
    else parts.lines[index] = line
  }
  return parts.head + parts.lines.join(parts.sep) + parts.tail
}

// kanbanSetBody(text, body) → the same Ticket File with the body (everything
// after the closing fence) replaced; frontmatter stays byte-identical,
// including its line endings. Used by ticket.update so untouched fields
// cannot drift. Null when no fence.
function kanbanSetBody(text, body) {
  const parts = kanbanFrontmatterParts(text)
  if (parts === null) return null
  let head = parts.head + parts.lines.join(parts.sep) + parts.tail.slice(0, parts.fenceLength)
  if (!head.endsWith('\n')) head += parts.sep
  let next = head + String(body || '')
  if (!next.endsWith('\n')) next += '\n'
  return next
}

function kanbanNormalizeColumn(value) {
  const c = String(value || '').trim().toLowerCase()
  return KANBAN_COLUMNS.includes(c) ? c : 'backlog'
}

// parseTicketFile(fileName, text) → card data for one Board card, or null
// when the file is not a Ticket File.
function parseTicketFile(fileName, text) {
  const fm = kanbanParseFrontmatter(text)
  if (fm === null) return null
  const id = (fm.attrs.id || '').trim() || kanbanIdFromFileName(fileName)
  if (id === null || id === '') return null
  return {
    id: id.toUpperCase(),
    title: (fm.attrs.title || '').trim() || kanbanFirstHeading(fm.body) || fileName,
    column: kanbanNormalizeColumn(fm.attrs.column),
    queued: (fm.attrs.queued || '').trim(),
    blocked: (fm.attrs.blocked || '').trim(),
    issue: (fm.attrs.issue || '').trim(),
    reviewUrl: (fm.attrs.reviewUrl || '').trim(),
    base: fm.attrs.base === 'head' ? 'head' : 'remote',
    branch: (fm.attrs.branch || '').trim(),
    baseBranch: (fm.attrs.baseBranch || '').trim(),
    mergeSha: (fm.attrs.mergeSha || '').trim(),
    worktreePath: (fm.attrs.worktreePath || fm.attrs.worktree || '').trim(),
    sessionId: (fm.attrs.sessionId || fm.attrs.session || '').trim(),
    body: fm.body,
    preview: kanbanBodyPreview(fm.body, 160),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTicketFile,
    KANBAN_COLUMNS,
    kanbanSlug,
    kanbanNextId,
    serializeTicketFile,
    kanbanSetAttr,
    kanbanSetBody,
  }
}
