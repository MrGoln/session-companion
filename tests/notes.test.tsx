import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_CONFIG } from '../hooks/config'

// 2026-10-26 08:00 +02:00.
const NOW = Date.parse('2026-10-26T06:00:00Z')
const THREAD = 'https://acme.slack.com/archives/C024BE91L/p1700000000123456'
const PR = 'https://github.com/acme/acme-api/pull/519'

const PANE = {
  plugin: 'session-companion',
  component: 'Pane',
  requestId: 'notes',
  props: {
    title: 'Session notes',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type EngineOptions = {
  appId?: string | null
  store?: Record<string, unknown>
  opened?: string[]
  // The text get_session answers on each call; null is an error, as before the server connects.
  appAnswers?: (string | null)[]
  placed?: { isPlaced: true } | { isPlaced: false; reason: string }
  files?: Record<string, string>
  failWrite?: (path: string) => boolean
  // Ticks the first read of a notes file waits, so a second write could overtake it.
  slowFirstRead?: number
}

const DIR = '/home/u/.claude/session-companion/notes'
// bin/jira.py config: Jira off, Slack permalinks as threads, repository names cut after "acme-".
const CONFIG = JSON.stringify({
  jira: { url: '', login: 'jdoe', offsetMinutes: 120, projects: [] },
  github: { search: '', shortenRepos: ['acme-'] },
  workday: { hours: 8 },
  notes: { threadUrls: ['^https://[^/]+\\.slack\\.com/archives/[^/]+/p\\d+'] },
  language: DEFAULT_CONFIG.language,
})
const fileOf = (session: string) => `${DIR}/${session.replace(/[^\w.-]/g, '_')}.json`

function engine(on: On, opts: EngineOptions = {}) {
  const store = opts.store ?? {}
  const files = opts.files ?? {}
  let slow = opts.slowFirstRead ?? 0
  on('store.get', (_, e) => ({ value: store[e.key] as never }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', async (_, e) => {
    if (slow > 0) {
      const ticks = slow
      slow = 0
      for (let i = 0; i < ticks; i++) await Promise.resolve()
    }
    return { value: files[e.path] as string }
  })
  on('fs.write', (_, e) => {
    if (opts.failWrite?.(e.path)) return { deny: 'EACCES: permission denied' } as never
    files[e.path] = e.text
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  const clock = mock.clock(on, { now: NOW })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: undefined as never }))
  on('ui.open', (_, e) => {
    opts.opened?.push(e.id)
    return { value: opts.placed ?? { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'transcript-1' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const answers = [...(opts.appAnswers ?? [])]
  // The work pane asks for this session once as it starts, before the notes do: the script is for the notes.
  let isFirst = true
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text' as const, text: '[]' }], isError: false } }
    const scripted = isFirst ? undefined : answers.length ? answers.shift() : undefined
    isFirst = false
    const text =
      scripted !== undefined
        ? scripted
        : opts.appId === null
          ? null
          : JSON.stringify({ sessionId: opts.appId ?? 'local_now', title: 'Rocket' }, null, 2)
    if (text === null) return { value: { content: [{ type: 'text' as const, text: 'not connected' }], isError: true } }
    return { value: { content: [{ type: 'text' as const, text }], isError: false } }
  })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'date') return { value: { exitCode: 0, stderr: '', stdout: '+0200\n' } as never }
    if (e.argv[2] === 'config') return { value: { exitCode: 0, stderr: '', stdout: CONFIG } as never }
    return { value: { exitCode: 1, stderr: 'gh is not part of these tests', stdout: '' } as never }
  })
  const saved = (session: string): { text: string }[] => JSON.parse(files[fileOf(session)] ?? '[]')
  return { clock, store, files, saved }
}

// A Link is found by its address followed by its words; the words are what the list shows.
const labels = (links: { text?: string }[]) => links.map(l => String(l.text).replace(/^https:\/\/\S+?\/(pull\/\d+|p\d+)/, ''))

const addNote = (input: Record<string, string>) => ({ tool: 'mcp__session-companion__add_note', ...input }) as never

test('a note added by the tool shows in the pane, newest first, with its time, kind and link', async ($, on) => {
  const { clock, saved } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const first = await $.tool.call(addNote({ text: 'Discussion of the launch schema', url: THREAD }))
  expect(first.result).toMatch(/^Saved the note: \[thread\] Discussion of the launch schema/)
  await clock.advance(5 * 60_000)
  await $.tool.call(addNote({ text: 'Decided to write to a message queue', kind: 'decision' }))
  await clock.advance(60_000)
  await $.tool.call(addNote({ text: 'PR with the migration', url: PR }))
  expect(saved('local_now')).toHaveLength(3)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const links = await ui.findAll({ type: 'Link' })
    expect(labels(links)).toEqual(['api#519', 'chat thread'])
    const times = (await ui.findAll({ type: 'Text', text: /^\d\d:\d\d$/ })).map(t => t.text)
    expect(times).toEqual(['08:06', '08:05', '08:00'])
    expect(await ui.find({ type: 'Text', text: /decision/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the search filters notes as typed and the clear button brings them back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Discussion of the launch schema', url: THREAD }))
  await $.tool.call(addNote({ text: 'Decided to write to a message queue', kind: 'decision' }))
  await $.tool.call(addNote({ text: 'PR with the migration', url: PR }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'search', text: 'queue', kind: 'change' })
    expect((await ui.findAll({ type: 'Text', text: /a message queue|migration|schema/ })).map(t => t.text)).toEqual([
      'Decided to write to a message queue',
    ])
    // Every word must match, the link's label included.
    await ui.input({ key: 'search', text: 'api#519 migra', kind: 'change' })
    expect(labels(await ui.findAll({ type: 'Link' }))).toEqual(['api#519'])
    await ui.input({ key: 'search', text: 'no such thing', kind: 'change' })
    expect(await ui.find({ type: 'Text', text: 'Nothing matches "no such thing".' })).toBeDefined()
    await ui.press({ key: 'search-clear' })
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(2)
    await ui.unmount()
  }
})

test('the kind picker filters the list and the same link noted again updates its note', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Thread', url: THREAD }))
  await $.tool.call(addNote({ text: 'PR', url: PR }))
  const again = await $.tool.call(addNote({ text: 'PR with the migration, awaiting review', url: PR }))
  expect(again.result).toMatch(/^Updated the note/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(2)
  await ui.select({ key: 'filter', value: 'thread' })
  expect(labels(await ui.findAll({ type: 'Link' }))).toEqual(['chat thread'])
  await ui.select({ key: 'filter', value: 'all' })
  expect(await ui.find({ type: 'Text', text: 'PR with the migration, awaiting review' })).toBeDefined()
  const remove = (await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('delete-'))
  await ui.press({ key: String(remove?.key) })
  expect(await ui.findAll({ type: 'Link' })).toHaveLength(1)
  await ui.unmount()
})

test('the band button sits right of what other mods draw and toggles the pane', async ($, on) => {
  const opened: string[] = []
  engine(on, { opened })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'One note' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'session-companion',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, bodyColumns: 80 } as never,
    })
    expect(await band.find({ type: 'Text', text: 'other mod' })).toBeDefined()
    expect((await band.find({ type: 'Button', key: 'toggle-notes' }))?.text).toBe('▸ Notes 1')
    await band.press({ key: 'toggle-notes' })
    expect((await band.find({ type: 'Button', key: 'toggle-notes' }))?.text).toMatch(/^▾ Hide notes/)
    await band.press({ key: 'toggle-notes' })
    await band.unmount()
  }
  expect(opened).toEqual(['notes', 'notes'])
})

test('notes survive a restart: a new session start with the same app id reads them back', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Command: make deploy-staging' }))
  expect(Object.keys(files)).toEqual([fileOf('local_now')])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Command: make deploy-staging' })).toBeDefined()
  await ui.unmount()
})

test('without the app id notes are kept under the transcript id', async ($, on) => {
  const { saved } = engine(on, { appId: null })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'A note' }))
  expect(saved('cli:transcript-1')).toHaveLength(1)
})

test('show_notes opens the pane and answers the notes the query finds', async ($, on) => {
  const opened: string[] = []
  engine(on, { opened })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Thread about the schema', url: THREAD }))
  await $.tool.call(addNote({ text: 'PR with the migration', url: PR }))

  const shown = await $.tool.call({ tool: 'mcp__session-companion__show_notes', query: 'schema' } as never)
  expect(shown.result).toMatch(/^Notes matching "schema": 1 of 2\.\nThe pane is open\.\n08:00 \[thread\] Thread about the schema — https:\/\/acme\.slack/)
  expect(opened).toEqual(['notes'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(labels(await ui.findAll({ type: 'Link' }))).toEqual(['chat thread'])
  await ui.unmount()
})

test('/note adds a note with the link from its text', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'note', args: `important thread ${THREAD}` } as never)
  expect(ran as unknown).toMatchObject({ text: `Note saved: [thread] important thread — ${THREAD}` })
})

test('"remember this" and a new work link get one note beside the prompt', async ($, on) => {
  engine(on)
  const context: string[] = []
  on('prompt.submit', (_, e) => {
    context.push(...(e.context ?? []))
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit({ text: `Remember this: thread ${THREAD}.` } as never)
  expect(context).toHaveLength(2)
  expect(context[0]).toMatch(/asks to remember/)
  expect(context[1]).toContain(THREAD)
  await $.prompt.submit({ text: `once more ${THREAD}` } as never)
  expect(context).toHaveLength(2)
  await $.prompt.submit({ text: 'just a question https://example.com/x' } as never)
  expect(context).toHaveLength(2)
})

test('a pane open before a reload opens again', async ($, on) => {
  const opened: string[] = []
  engine(on, { opened })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'notes', args: '' } as never)
  // A reload closed the pane (the engine lists none) and starts the module again.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual(['notes', 'notes'])
})

test('with nothing beneath, the band draws the button alone, not the engine node', async ($, on) => {
  engine(on)
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'session-companion',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, bodyColumns: 80 } as never,
    })
    expect((await band.find({ type: 'Button', key: 'toggle-notes' }))?.text).toBe('▸ Notes ')
    await band.unmount()
  }
})

const own = (sessionId: string) => JSON.stringify({ sessionId })
const note = (id: string, at: number, text: string) => ({ id, at, kind: 'other', text })

test('an app id that comes late keeps the notes saved under it', async ($, on) => {
  const { saved } = engine(on, {
    appAnswers: [null, own('local_now')],
    files: { [fileOf('local_now')]: JSON.stringify([note('old', NOW - 1000, 'Old note')]) },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'New' }))

  expect(saved('local_now').map(n => n.text)).toEqual(['New', 'Old note'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Old note' })).toBeDefined()
  await ui.unmount()
})

test('notes kept under the transcript id join the app id once, and a removed one stays removed', async ($, on) => {
  const { saved } = engine(on, { appAnswers: [null, null, own('local_now')] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Early' }))
  expect(saved('cli:transcript-1')).toHaveLength(1)

  await $.tool.call(addNote({ text: 'Late' }))
  expect(saved('cli:transcript-1')).toEqual([])
  expect(saved('local_now')).toHaveLength(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const remove = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('delete-'))
  await ui.press({ key: String(remove[1]?.key) })
  await ui.unmount()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(saved('local_now').map(n => n.text)).toEqual(['Late'])
})

test('a session keeps its newest 200 notes; other sessions have files of their own', async ($, on) => {
  const old = Array.from({ length: 200 }, (_, i) => note(`n${i}`, NOW - 1000 - i, `Note ${i}`))
  const other = JSON.stringify([note('o', NOW - 5000, 'Another session')])
  const { saved, files } = engine(on, {
    files: { [fileOf('local_now')]: JSON.stringify(old), [fileOf('local_other')]: other },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Fresh' }))

  const kept = saved('local_now')
  expect(kept).toHaveLength(200)
  expect(kept[0]!.text).toBe('Fresh')
  expect(kept.some(n => n.text === 'Note 199')).toBe(false)
  expect(files[fileOf('local_other')]).toBe(other)
})

test('a note the file refuses is an error for the model and does not show in the pane', async ($, on) => {
  engine(on, { failWrite: path => path === fileOf('local_now') })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = (await $.tool.call(addNote({ text: 'Not written' }))) as { deny?: string }

  expect(ran.deny).toMatch(/^Note not saved: .*EACCES/)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Not written' })).toBeUndefined()
  await ui.unmount()
})

test('a notes file that does not parse is left alone, not overwritten', async ($, on) => {
  const { files } = engine(on, { files: { [fileOf('local_now')]: '[{"id": "x", ' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = (await $.tool.call(addNote({ text: 'New' }))) as { deny?: string }

  expect(ran.deny).toMatch(/^Note not saved/)
  expect(files[fileOf('local_now')]).toBe('[{"id": "x", ')
})

test('notes added at once are all kept: writes run one at a time', async ($, on) => {
  const { saved } = engine(on, {
    slowFirstRead: 50,
    files: { [fileOf('local_now')]: '[]' },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await Promise.all(['a', 'b', 'c'].map(text => $.tool.call(addNote({ text }))))

  expect(saved('local_now').map(n => n.text).sort()).toEqual(['a', 'b', 'c'])
})

test('show_notes says the pane waits for a window when no surface is attached', async ($, on) => {
  engine(on, { placed: { isPlaced: false, reason: 'no-surface: no surface is attached' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const shown = await $.tool.call({ tool: 'mcp__session-companion__show_notes' } as never)

  expect(shown.result).toMatch(/^Notes in this session: 0\.\nThe pane shows once the session is open in an app window\./)
})

test('the app id is read from the session record, not from a session nested in it', async ($, on) => {
  const { saved } = engine(on, {
    appAnswers: [`Session:\n${JSON.stringify({ parent: { sessionId: 'local_parent' }, sessionId: 'local_now' })}`],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call(addNote({ text: 'Own' }))

  expect(saved('local_now')).toHaveLength(1)
  expect(saved('local_parent')).toEqual([])
})
