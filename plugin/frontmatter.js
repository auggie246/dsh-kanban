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
    preview: kanbanBodyPreview(fm.body, 160),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseTicketFile, KANBAN_COLUMNS }
}
