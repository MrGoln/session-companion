import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, Frozen, On, RenderChildren, RenderInput, UiOpenResult } from 'claude-code'

import type { Note, NoteKind } from '../types'
import { currentConfig, loadConfig, localOffset, phrases, readLocalOffset, shortRepo, t } from './config'

const PLUGIN = 'session-companion'
const PANE = 'notes'
// One file per session keeps every write small; the whole $.store is one file the engine rewrites each time.
const MAX_NOTES = 200
const MAX_TEXT = 1000

const notes = atom({ plugin: 'session-companion', key: 'notes' } as const, [])
const isOpen = atom({ plugin: 'session-companion', key: 'notesOpen' } as const, false)
const query = atom({ plugin: 'session-companion', key: 'noteQuery' } as const, '')
const filter = atom({ plugin: 'session-companion', key: 'noteFilter' } as const, 'all')

// label is the English kind the model reads; shown() and plural() are what the pane shows.
const KINDS: Record<NoteKind, { label: string; shown: () => string; plural: () => string; color: string }> = {
  link: { label: 'link', shown: () => t('link'), plural: () => t('Links'), color: 'suggestion' },
  thread: { label: 'thread', shown: () => t('thread'), plural: () => t('Threads'), color: 'claude' },
  decision: { label: 'decision', shown: () => t('decision'), plural: () => t('Decisions'), color: 'success' },
  other: { label: 'other', shown: () => t('other'), plural: () => t('Other'), color: 'inactive' },
}
const isKind = (value: unknown): value is NoteKind => typeof value === 'string' && value in KINDS

const URL_RE = /https?:\/\/[^\s<>()"'`«»]+/g
const firstUrl = (text: string) => trimUrl(text.match(URL_RE)?.[0])
const trimUrl = (url: string | undefined) => url?.replace(/[.,;:!?\]]+$/, '')
// A pattern that does not compile is skipped: bin/jira.py reports it when it reads the settings.
const threadPatterns = (): RegExp[] =>
  currentConfig().notes.threadUrls.flatMap(p => {
    try {
      return [new RegExp(p, 'i')]
    } catch {
      return []
    }
  })
const isThread = (url: string) => threadPatterns().some(re => re.test(url))
const isWorkLink = (url: string) =>
  isThread(url) ||
  /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(url) ||
  /\/-\/(merge_requests|issues)\/\d+/.test(url) ||
  /\/browse\/[A-Z][A-Z0-9]+-\d+/.test(url) ||
  /confluence|\/wiki\/|\/display\/|\/pages\/viewpage/i.test(url)
const decode = (part: string) => {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '))
  } catch {
    return part
  }
}

function linkLabel(url: string): string {
  let m = /github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url)
  if (m) return `${shortRepo(m[1]!)}#${m[2]}`
  m = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(url)
  if (m) return m[1]!
  if (isThread(url)) return t('chat thread')
  m = /\/pages\/\d+\/([^/?#]+)/.exec(url) ?? /\/display\/[^/]+\/([^/?#]+)/.exec(url)
  if (m) return decode(m[1]!)
  const plain = url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain
}

function matches(q: string, note: Note): boolean {
  const hay = [note.text, note.url ?? '', note.url ? linkLabel(note.url) : '', KINDS[note.kind].label, KINDS[note.kind].shown()]
    .join(' ')
    .toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word))
}

function stamp(at: number, now: number): string {
  const local = new Date(at + localOffset()).toISOString()
  const isToday = local.slice(0, 10) === new Date(now + localOffset()).toISOString().slice(0, 10)
  return isToday ? local.slice(11, 16) : `${local.slice(8, 10)}.${local.slice(5, 7)} ${local.slice(11, 16)}`
}

// The app's id of this session outlives a restart of the app; the transcript's id is the fallback.
let appSessionId: string | null = null
async function ownAppId($: Dollar): Promise<string | null> {
  const res = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
  const text = (res.content.find(b => b.type === 'text') as { text?: string } | undefined)?.text ?? ''
  const start = text.indexOf('{')
  if (res.isError || start < 0) return null
  const own = JSON.parse(text.slice(start)) as { sessionId?: unknown }
  return typeof own.sessionId === 'string' && own.sessionId ? own.sessionId : null
}
async function sessionKey($: Dollar): Promise<string> {
  appSessionId ??= await ownAppId($).catch(() => null)
  return appSessionId ?? `cli:${await $.session.id()}`
}
let notesDir: string | null = null
async function fileOf($: Dollar, session: string): Promise<string> {
  notesDir ??= `${(await $.env.get('HOME')) ?? ''}/.claude/session-companion/notes`
  return `${notesDir}/${session.replace(/[^\w.-]/g, '_')}.json`
}

const asNotes = (value: unknown): Note[] => (Array.isArray(value) ? (value as Note[]) : [])
const newestFirst = (list: Note[]) => [...list].sort((a, b) => b.at - a.at)
const union = (a: Note[], b: Note[]) => newestFirst([...a, ...b.filter(n => !a.some(x => x.id === n.id))])

// A file that does not parse is an error, not an empty list: writing over it would lose its notes.
async function readFile($: Dollar, path: string): Promise<Note[]> {
  if (!(await $.fs.exists(path))) return []
  return asNotes(JSON.parse(String(await $.fs.read(path))))
}

// Writes run one at a time: two at once would each write the list they read, and the later write wins.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

type Stored = { path: string; list: Note[]; leftovers: string[] }

// The file is the source, not the pane's copy. Notes kept under the transcript's id while the
// app's id was out of reach join this session's file on the next write.
async function storedNotes($: Dollar): Promise<Stored> {
  const session = await sessionKey($)
  const path = await fileOf($, session)
  let list = await readFile($, path)
  const leftovers: string[] = []
  if (appSessionId) {
    const early = await fileOf($, `cli:${await $.session.id()}`)
    const notes = await readFile($, early)
    if (notes.length) {
      list = union(list, notes)
      leftovers.push(early)
    }
  }
  return { path, list, leftovers }
}

async function persist($: Dollar, stored: Stored, list: Note[]): Promise<void> {
  await $.fs.write(stored.path, JSON.stringify(list))
  // $.fs has no delete: an emptied file stays and reads as no notes.
  for (const path of stored.leftovers) await $.fs.write(path, '[]')
}

// The pane shows a change only once the file holds it.
function changeNotes($: Dollar, change: (list: Note[]) => Note[]): Promise<Note[]> {
  return serial(async () => {
    const stored = await storedNotes($)
    const next = newestFirst(change(stored.list)).slice(0, MAX_NOTES)
    await persist($, stored, next)
    await update($, notes, () => next)
    return next
  })
}

function loadNotes($: Dollar): Promise<Note[]> {
  return serial(async () => {
    const stored = await storedNotes($)
    if (stored.leftovers.length) await persist($, stored, stored.list)
    await update($, notes, () => stored.list)
    return stored.list
  })
}

let counter = 0
type AddInput = { text?: unknown; url?: unknown; kind?: unknown }

// The same link noted again updates its note instead of adding a second one.
async function addNote($: Dollar, input: AddInput): Promise<{ note: Note; isUpdate: boolean }> {
  const given = String(input.text ?? '').trim()
  const url = trimUrl(typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined) ?? firstUrl(given)
  if (!given && !url) throw new Error('empty note: text or url is needed')
  // The pane shows the link under the text, so the text drops it.
  const rawText = (url ? given.split(url).join(' ') : given)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[\s,;:—-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const text = (rawText || (url ? linkLabel(url) : '')).slice(0, MAX_TEXT)
  const kind: NoteKind = isKind(input.kind) ? input.kind : url && isThread(url) ? 'thread' : url ? 'link' : 'other'
  const now = await $.clock.now()
  let added: { note: Note; isUpdate: boolean } | null = null
  await changeNotes($, list => {
    const existing = url ? list.find(n => n.url === url) : undefined
    const note: Note = existing
      ? { ...existing, text: rawText ? text : existing.text, kind: isKind(input.kind) ? input.kind : existing.kind }
      : { id: `${now.toString(36)}-${(counter++).toString(36)}`, at: now, kind, text, ...(url ? { url } : {}) }
    added = { note, isUpdate: !!existing }
    return [note, ...list.filter(n => n.id !== note.id)]
  })
  return added!
}

async function removeNote($: Dollar, id: string): Promise<void> {
  await changeNotes($, list => list.filter(n => n.id !== id))
}

async function openPane($: Dollar): Promise<UiOpenResult> {
  const opened = await $.ui.open({ id: PANE, title: t('Session notes') })
  await update($, isOpen, () => true)
  return opened
}

const paneState = (opened: UiOpenResult) =>
  opened.isPlaced
    ? 'The pane is open.'
    : /^no-surface/.test(opened.reason)
      ? 'The pane shows once the session is open in an app window.'
      : `The pane is open but not shown yet: ${opened.reason}`

async function togglePane($: Dollar): Promise<void> {
  if (await read($, isOpen)) {
    // The mod's own close does not reach its ui.close hook, so the state is set here.
    await $.ui.close({ id: PANE })
    await update($, isOpen, () => false)
    return
  }
  await openPane($)
}

const describe = (note: Note) =>
  `[${KINDS[note.kind].label}] ${note.text}${note.url && !note.text.includes(note.url) ? ` — ${note.url}` : ''}`

const ADD_TOOL = 'add_note'
const SHOW_TOOL = 'show_notes'
const ADD_TOOL_SPEC = {
  name: ADD_TOOL,
  description:
    'Save a note to the "Session notes" pane so that what matters is not lost in the conversation. ' +
    'Call it on your own, without asking, when the work turns up something needed later: a link to a PR, an issue, ' +
    'a wiki page, a chat thread, a decision made, a command that worked. ' +
    'And always when the user asks to remember, note down or save something to notes. ' +
    "text is one or two sentences in the user's language: what it is and why it matters; url is the link, if any. " +
    'Calling it again with the same url updates that note instead of adding a second one.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What it is and why, one or two sentences' },
      url: { type: 'string', description: 'The link, when the note is about a link or a thread' },
      kind: {
        type: 'string',
        enum: ['link', 'thread', 'decision', 'other'],
        description:
          'link: a link (PR, issue, wiki page); thread: a chat thread; decision: a decision; other: a command and the rest. ' +
          'Without kind it follows from the url.',
      },
    },
    required: ['text'],
  },
  isDeferred: false,
}
const SHOW_TOOL_SPEC = {
  name: SHOW_TOOL,
  description:
    'Open the "Session notes" pane and return this session\'s notes, newest first. ' +
    'query filters them like the search in the pane: every word must be found in the text, the link or the kind. ' +
    'Call it when the user asks what was saved, or looks for a link, thread or decision from this session.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to search for; empty for all notes' } },
  },
}
// Links already suggested for a note in this session: the model is told once per link.
const offered = new Set<string>()

export async function notesButton($: Dollar, e: Frozen<RenderInput<'AbovePrompt'>>): Promise<RenderChildren> {
  const { Button, Text } = $.ui.resolve(e)
  const open = await read($, isOpen)
  const count = (await read($, notes)).length
  return (
    <Button key="toggle-notes" plain onPress={() => void togglePane($)}>
      {open ? t('▾ Notes') : t('▸ Notes')} {count > 0 && <Text dimColor>{String(count)}</Text>}
    </Button>
  )
}

export async function startNotes($: Dollar): Promise<void> {
  await loadConfig($)
  await readLocalOffset($)
  await $.command.register({ name: 'notes', description: t('Open or close the "Session notes" pane') })
  await $.command.register({
    name: 'note',
    description: t('Add a note to this session: /note text, link'),
    argumentHint: t('text and link'),
  })
  await $.tool.register(ADD_TOOL_SPEC)
  await $.tool.register(SHOW_TOOL_SPEC)
  await loadNotes($).catch(() => undefined)
  // A reload closes the pane; one that was open before it opens again.
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if ((await read($, isOpen)) && !isUp) await openPane($).catch(() => undefined)
  else await update($, isOpen, () => isUp)
}

// The plugin's own tools are listed as mcp__<plugin>__<tool>.
export async function notesTool(
  $: Dollar,
  tool: string,
  input: unknown,
): Promise<{ result: string } | { deny: string } | null> {
  if (tool === `mcp__${PLUGIN}__${ADD_TOOL}`) {
    try {
      const { note, isUpdate } = await addNote($, input as AddInput)
      const short = note.text.slice(0, 80)
      $.ui.toast(isUpdate ? t('Note updated: {text}', { text: short }) : t('Note saved: {text}', { text: short }))
      return { result: `${isUpdate ? 'Updated the note' : 'Saved the note'}: ${describe(note)}` }
    } catch (err) {
      return { deny: `Note not saved: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  if (tool !== `mcp__${PLUGIN}__${SHOW_TOOL}`) return null
  const q = String((input as { query?: unknown }).query ?? '').trim()
  await update($, query, () => q)
  const opened = await openPane($)
  const list = await loadNotes($)
  const found = q ? list.filter(n => matches(q, n)) : list
  const now = await $.clock.now()
  const head = q ? `Notes matching "${q}": ${found.length} of ${list.length}.` : `Notes in this session: ${list.length}.`
  const lines = found.map(n => `${stamp(n.at, now)} ${describe(n)}`)
  return { result: [head, paneState(opened), ...lines].join('\n') }
}

export async function notesPromptContext($: Dollar, text: string): Promise<string[]> {
  const hints: string[] = []
  if (phrases(currentConfig().language.rememberWords)?.test(text)) {
    hints.push(`${PLUGIN}: the user asks to remember something; save it with ${ADD_TOOL}.`)
  }
  const saved = new Set((await read($, notes)).map(n => n.url))
  const links = [...new Set((text.match(URL_RE) ?? []).map(u => trimUrl(u)!))].filter(
    u => isWorkLink(u) && !saved.has(u) && !offered.has(u),
  )
  if (links.length) {
    links.forEach(u => offered.add(u))
    hints.push(
      `${PLUGIN}: the message has work links (${links.join(', ')}). ` +
        `If they belong to this session's task, save each with ${ADD_TOOL}, saying what it is.`,
    )
  }
  return hints
}

export async function notesPaneClosed($: Dollar, id: string): Promise<void> {
  if (id === PANE) await update($, isOpen, () => false)
}

export function registerNotes(on: On): void {
  on('command.run', { command: 'notes' }, async $ => {
    await togglePane($)

    return { text: (await read($, isOpen)) ? t('The "Session notes" pane is open.') : t('The "Session notes" pane is closed.') }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim()
    if (!args) return { text: t('Write the note: /note we write to staging first, https://…') }
    try {
      const { note } = await addNote($, { text: args })
      return { text: t('Note saved: {text}', { text: note.url ? `${note.text} — ${note.url}` : note.text }) }
    } catch (err) {
      return { text: t('Note not saved: {why}', { why: err instanceof Error ? err.message : String(err) }) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Link, Button } = elements
    // Not every surface has a text field or a picker; there the pane goes without search or the kind filter.
    const Input = 'Input' in elements ? elements.Input : null
    const Select = 'Select' in elements ? elements.Select : null
    const all = await read($, notes)
    const q = (await read($, query)).trim()
    const kind = await read($, filter)
    const now = await $.clock.now()

    const byKind = kind === 'all' ? all : all.filter(n => n.kind === kind)
    const shown = q ? byKind.filter(n => matches(q, n)) : byKind
    const countOf = (k: NoteKind) => all.filter(n => n.kind === k).length

    const chip = (k: NoteKind) => (
      <Text color={KINDS[k].color} bold>
        {` ${KINDS[k].shown()} `}
      </Text>
    )
    const kindOptions = [
      { value: 'all', label: `${t('All kinds')} · ${all.length}` },
      ...(Object.keys(KINDS) as NoteKind[]).map(k => ({ value: k, label: `${KINDS[k].plural()} · ${countOf(k)}` })),
    ]
    return (
      <Box flexDirection="column">
        {Input && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Input
                key="search"
                placeholder={t('Search notes')}
                value={q}
                onInput={(value: string) => void update($, query, () => value)}
                onSubmit={(value: string) => void update($, query, () => value)}
              />
            </Box>
            {q && (
              <Button key="search-clear" plain onPress={() => void update($, query, () => '')}>
                ✕
              </Button>
            )}
          </Box>
        )}

        {Select && (
          <Box marginTop={1}>
            <Select
              key="filter"
              options={kindOptions}
              value={kind}
              onSelect={(value: string) => void update($, filter, () => (isKind(value) ? value : 'all'))}
            />
          </Box>
        )}

        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="suggestion"
          paddingLeft={1}
          paddingRight={1}
        >
          {all.length === 0 && (
            <Text dimColor wrap="wrap">
              {t('No notes yet. Claude saves links, threads and decisions here as the work goes; ask it to remember something or type /note text.')}
            </Text>
          )}
          {all.length > 0 && shown.length === 0 && (
            <Text dimColor>{q ? t('Nothing matches "{q}".', { q }) : t('No notes of this kind.')}</Text>
          )}
          {shown.map((note, i) => (
            <Box key={`note-${note.id}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                {chip(note.kind)}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor size="footnote">
                    {stamp(note.at, now)}
                  </Text>
                </Box>
                <Button key={`delete-${note.id}`} plain onPress={() => void removeNote($, note.id)}>
                  ✕
                </Button>
              </Box>
              {note.url && <Link href={note.url}>{linkLabel(note.url)}</Link>}
              <Text wrap="wrap">{note.text}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
