import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_CONFIG } from '../hooks/config'

// 2026-10-25 08:00 +02:00, Jira's day.
const NOW = Date.parse('2026-10-25T06:00:00Z')

const PANE = {
  plugin: 'session-companion',
  component: 'Pane',
  requestId: 'work',
  props: {
    title: 'My work',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const pr = (repo: string, number: number, extra: object) => ({
  number,
  title: `fix: pr ${number}`,
  url: `https://github.com/x/${repo}/pull/${number}`,
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  createdAt: '2026-10-25T05:00:00Z',
  author: { login: 'jdoe' },
  headRefName: `branch-${number}`,
  repository: { name: repo },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra,
})

const GH = JSON.stringify({
  data: {
    mine: {
      nodes: [
        pr('acme-api', 479, {
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
        }),
        pr('acme-api', 502, { isDraft: true }),
      ],
    },
    review: {
      nodes: [
        pr('acme-api', 501, { author: { login: 'octocat' } }),
        pr('acme-api', 398, { author: { login: 'octocat' }, createdAt: '2026-10-12T12:00:00Z' }),
        pr('widgets', 265, { author: { login: 'dependabot' } }),
      ],
    },
    direct: { nodes: [{ url: 'https://github.com/x/acme-api/pull/501' }] },
  },
})

// bin/jira.py snapshot: tasks in work, a task linked from a session, and my hours by Jira day.
// Sunday the 25th: 2h today, 8h30 on Wednesday the 21st.
function jiraSnapshot(linked: string[]): string {
  const issues = [
    { key: 'ABC-82', summary: 'Design the rocket', status: 'Review', category: 'progress' },
    { key: 'ABC-52', summary: 'Fuel valve check', status: 'In Progress', category: 'progress' },
    { key: 'ABC-50', summary: 'Closed in the sprint', status: 'Closed', category: 'done' },
  ]
  if (linked.includes('ABC-70')) issues.push({ key: 'ABC-70', summary: 'Dashboard access', status: 'Paused', category: 'todo' })
  return JSON.stringify({ issues, days: { '2026-10-25': 7200, '2026-10-21': 30600 }, fetchedAt: NOW / 1000 })
}

// bin/jira.py config: Jira on, its day in +02:00, repository names cut after "acme-".
const CONFIG = JSON.stringify({
  jira: { url: 'https://jira.example.com', login: 'jdoe', offsetMinutes: 120, projects: [] },
  github: { search: 'org:acme', shortenRepos: ['acme-'] },
  workday: { hours: 8 },
  notes: { threadUrls: [] },
  language: DEFAULT_CONFIG.language,
})

function engine(
  on: On,
  gh?: { exitCode: number; stdout: string; stderr: string },
  store?: Record<string, unknown>,
  opened: string[] = [],
  jira?: { exitCode: number; stdout: string; stderr: string },
  jiraRuns: { argv: string[]; env: Record<string, string> }[] = [],
  shared?: Map<string, unknown>,
  config: string = CONFIG,
) {
  // A shared store lets a test play another open session by changing it.
  if (shared) {
    on('store.get', (_, e) => ({ value: shared.get(e.key) as never }))
    on('store.set', (_, e) => {
      shared.set(e.key, JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
  } else mock.store(on, store)
  mock.env(on, { USER: 'jdoe', HOME: '/home/u' })
  // The notes module keeps its files on disk; this file's tests read none back.
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'transcript-1' }))
  const clock = mock.clock(on, { now: NOW })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.register', () => ({ value: undefined as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    if (e.server === 'ccd_session_mgmt' && e.tool === 'get_session') {
      const own = { sessionId: 'local_now', cwd: '/', link: 'claude://x/local_now', title: 'Rocket', lastActivityAt: '2026-10-25T00:00:00Z' }
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(own) }], isError: false } }
    }
    if (e.server === 'ccd_session_mgmt') {
      // The app leaves the calling session out of its list.
      const sessions = [
        { sessionId: 'local_old', cwd: '/', link: 'claude://x/local_old', title: 'Old', lastActivityAt: '2026-10-20T00:00:00Z' },
        { sessionId: 'local_other', cwd: '/elsewhere', link: 'claude://x/local_other', title: 'Other', lastActivityAt: '2026-10-25T01:00:00Z' },
        { sessionId: 'local_pr_old', cwd: '/w/a', branch: 'branch-479', link: 'claude://x/local_pr_old', title: 'PR 479 old', lastActivityAt: '2026-10-21T00:00:00Z' },
        { sessionId: 'local_pr', cwd: '/w/b', branch: 'branch-479', link: 'claude://x/local_pr', title: 'PR 479', lastActivityAt: '2026-10-24T00:00:00Z' },
        { sessionId: 'local_pr501', cwd: '/x/acme-api/.claude/worktrees/r', prNumber: 501, link: 'claude://x/local_pr501', title: 'Review 501', lastActivityAt: '2026-10-24T00:00:00Z' },
      ]
      return { value: { content: [{ type: 'text' as const, text: JSON.stringify(sessions) }], isError: false } }
    }
    throw new Error(`unexpected MCP call ${e.server} ${e.tool}`)
  })
  // The kit types this answer as undefined, though the engine reads `value` as the run result.
  on('process.run', (_, e) => {
    if (e.argv[0] === 'date') return { value: { exitCode: 0, stderr: '', stdout: '-0300\n' } as never }
    if (String(e.argv[1] ?? '').endsWith('jira.py') && e.argv[2] === 'config') {
      return { value: { exitCode: 0, stderr: '', stdout: config } as never }
    }
    if (String(e.argv[1] ?? '').endsWith('jira.py')) {
      jiraRuns.push({ argv: [...e.argv], env: { ...(e.init?.env ?? {}) } })
      const linked = String(e.argv[e.argv.indexOf('--linked') + 1] ?? '').split(',')
      return { value: (jira ?? { exitCode: 0, stderr: '', stdout: jiraSnapshot(linked) }) as never }
    }
    if (e.argv[0] === '/usr/bin/open') {
      opened.push(`open ${e.argv[1]}`)
      return { value: { exitCode: 0, stderr: '', stdout: '' } as never }
    }
    return { value: (gh ?? { exitCode: 0, stderr: '', stdout: GH }) as never }
  })
  return clock
}

test('blocks fold by their header and stay folded across a redraw', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Open, the header is the title alone; the summary shows once folded.
    expect((await ui.find({ type: 'Button', key: 'toggle-hours' }))?.text).toBe('▾ Today ')
    await ui.press({ key: 'toggle-hours' })
    expect((await ui.find({ type: 'Button', key: 'toggle-hours' }))?.text).toMatch(/▸ Today 2h 00m of 8h/)
    await ui.press({ key: 'toggle-hours' })
    expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeDefined()
    // Drafts start folded.
    expect(await ui.find({ type: 'Link', text: 'api#502' })).toBeUndefined()

    await ui.press({ key: 'toggle-tasks' })
    expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'toggle-tasks' }))?.text).toMatch(/Tasks 3/)

    await ui.press({ key: 'toggle-tasks' })
    await ui.press({ key: 'toggle-pr:Drafts' })
    expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'api#502' })).toBeDefined()

    await ui.press({ key: 'toggle-pr:Drafts' })
    await ui.unmount()
  }
})

test('a failed source shows its reason and keeps the others', async ($, on) => {
  const clock = engine(on, { exitCode: 1, stdout: '', stderr: 'gh auth login required' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /gh is not signed in/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'ABC-52' })).toBeDefined()
  await ui.unmount()
})

test('gh missing from PATH is named, not shown as a login problem', async ($, on) => {
  const clock = engine(on, { exitCode: 127, stdout: '', stderr: 'spawn gh ENOENT' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /gh is not installed/ })).toBeDefined()
  await ui.unmount()
})

test('a token Jira refused is named in both Jira cards, not as a gh login problem', async ($, on) => {
  const refused = 'Jira refused the token for jdoe: it expired, was revoked or is the wrong one'
  const clock = engine(on, undefined, undefined, [], { exitCode: 1, stderr: refused, stdout: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text', text: /Jira refused the token/ })).length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /gh is not signed in/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Week ·/ })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeDefined()
  await ui.unmount()
})

test('the review tab groups PRs awaiting me by who was asked', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Link', text: 'api#501' })).toBeUndefined()

    await ui.press({ key: 'tab-review' })
    expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeUndefined()
    expect(await ui.find({ type: 'Link', text: 'api#501' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /For you · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /To my teams · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /api#398 ⚠ 12d @octocat/ })).toBeDefined()
    // Bots start folded.
    expect(await ui.find({ type: 'Link', text: 'widgets#265' })).toBeUndefined()

    await ui.press({ key: 'tab-mine' })
    expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane starts closed and /work toggles it', async ($, on) => {
  const opened: string[] = []
  const clock = engine(on, undefined, undefined, opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(opened).toHaveLength(0)

  expect((await $.command.run({ command: 'work', args: '' } as never)) as unknown).toMatchObject({ text: 'The "My work" pane is open.' })
  expect((await $.command.run({ command: 'work', args: '' } as never)) as unknown).toMatchObject({ text: 'The "My work" pane is closed.' })
  expect(opened).toEqual(['work'])
  // Opening refreshes in the background; let it finish inside the test.
  await clock.settle()
})

test('the button above the prompt toggles the pane and shows a summary while it is closed', async ($, on) => {
  const opened: string[] = []
  const clock = engine(on, undefined, undefined, opened)
  // Another mod's band beneath ours is drawn after it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'session-companion',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, bodyColumns: 80 } as never,
    })
    expect((await band.find({ type: 'Button', key: 'toggle-work' }))?.text).toBe('▸ My work')
    expect(await band.find({ type: 'Text', text: 'other mod' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /2 tasks · 2 PRs · 1 ✗ CI · 1 to review · 2h 00m of 8h/ })).toBeDefined()

    await band.press({ key: 'toggle-work' })
    expect((await band.find({ type: 'Button', key: 'toggle-work' }))?.text).toBe('▾ My work')
    await band.press({ key: 'toggle-work' })
    expect((await band.find({ type: 'Button', key: 'toggle-work' }))?.text).toBe('▸ My work')
    await band.unmount()
  }
  expect(opened).toEqual(['work', 'work'])
  await clock.settle()
})

test('with nothing beneath, the band draws its own row, not the engine node', async ($, on) => {
  const clock = engine(on)
  // What the engine answers beneath the band when no survey is up.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'session-companion',
      component: 'AbovePrompt',
      requestId: 'band',
      surface,
      props: { hasSurvey: false, bodyColumns: 80 } as never,
    })
    expect((await band.find({ type: 'Button', key: 'toggle-work' }))?.text).toBe('▸ My work')
    await band.unmount()
  }
})

test('"let\'s start on KEY" links the session, the task gets a button to it, done tasks start folded', async ($, on) => {
  const opened: string[] = []
  const clock = engine(on, undefined, undefined, opened)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const sent = await $.prompt.submit({ text: 'Ok, let\'s start on ABC-82, plan below' } as never)
  expect(sent).toMatchObject({ text: 'Ok, let\'s start on ABC-82, plan below' })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(toasts.join(" | ")).toMatch(/ABC-82 linked to session .*Rocket/)
  expect(await ui.find({ type: 'Button', key: 'go-task-ABC-52' })).toBeUndefined()
  await ui.press({ key: 'go-task-ABC-82' })
  expect(opened).toContain('open claude://x/local_now')
  expect(await ui.find({ type: 'Link', text: 'ABC-50' })).toBeUndefined()
  await ui.unmount()
})

test('a prompt that only mentions a key links nothing', async ($, on) => {
  const clock = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.prompt.submit({ text: 'what about ABC-82?' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'go-task-ABC-82' })).toBeUndefined()
  await ui.unmount()
})

test('a key outside the projects of my issues is not a task: UTF-8 links nothing', async ($, on) => {
  const clock = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.prompt.submit({ text: "let's work on UTF-8 decoding" } as never)
  await clock.settle()
  expect(toasts).toEqual([])
  await $.prompt.submit({ text: "let's work on SHA-256, then ABC-82" } as never)
  await clock.settle()
  expect(toasts.join(' | ')).toMatch(/ABC-82 linked to session/)
})

test('a group folded by default opens on the first click', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: 'ABC-50' })).toBeUndefined()
  await ui.press({ key: 'toggle-task:Closed' })
  expect(await ui.find({ type: 'Link', text: 'ABC-50' })).toBeDefined()
  await ui.unmount()
})

test('a PR gets a button to the latest session it is open in, by branch or by number', async ($, on) => {
  const opened: string[] = []
  const clock = engine(on, undefined, undefined, opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'go-pr-acme-api-479' })
  // Two sessions on its branch: the later one opens.
  expect(opened).toContain('open claude://x/local_pr')
  expect(await ui.find({ type: 'Button', key: 'go-pr-acme-api-502' })).toBeUndefined()

  await ui.press({ key: 'tab-review' })
  expect(await ui.find({ type: 'Button', key: 'go-review-acme-api-501' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'go-review-acme-api-398' })).toBeUndefined()
  await ui.unmount()
})

test('an unlinked session gets one note per task key beside the prompt, and Claude links via its tool', async ($, on) => {
  const clock = engine(on)
  on('ui.toast', () => ({ value: undefined }))
  const notes: string[] = []
  on('prompt.submit', (_, e) => {
    notes.push(...(e.context ?? []))
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.prompt.submit({ text: 'look at ABC-82' } as never)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatch(/not linked to a Jira issue, and the user's message names ABC-82.*ask the user once/)
  await $.prompt.submit({ text: 'and ABC-82 again' } as never)
  expect(notes).toHaveLength(1)

  const ran = await $.tool.call({ tool: 'mcp__session-companion__link_task', key: 'ABC-82' } as never)
  expect(ran.result).toBe('ABC-82 linked to session "Rocket".')
  await $.prompt.submit({ text: 'now ABC-85' } as never)
  expect(notes).toHaveLength(1)
})

test('each list card unfolds its own titles from a button in its header', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A row's text starts with its link's href, then the drawn words.
  expect(await ui.find({ type: 'Text', text: /api#479 pr 479$/ })).toBeDefined()
  await ui.press({ key: 'full-prs' })
  expect(await ui.find({ type: 'Text', text: /api#479 fix: pr 479$/ })).toBeDefined()
  // Only the PR card unfolds its titles; tasks stay cut until their own button.
  expect(await ui.find({ type: 'Text', text: /ABC-82 Design the rocket$/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'full-prs' }))?.text).toBe('⤡')
  await ui.press({ key: 'full-tasks' })
  expect(await ui.find({ type: 'Text', text: /ABC-82 Design the rocket · Review$/ })).toBeDefined()
  await ui.unmount()
})

test('the week sums Monday to Friday by Jira day, weekend hours apart', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Sunday the 25th: 2h today, 8h30 on Wednesday the 21st, last week's hour left out.
  expect(await ui.find({ type: 'Text', text: 'Week · 8h 30m of 40h' })).toBeDefined()
  await ui.unmount()
})

test('the week and today come from the script\'s days', async ($, on) => {
  const days = { '2026-10-19': 28800, '2026-10-20': 30000, '2026-10-25': 3600 }
  const clock = engine(on, undefined, undefined, [], { exitCode: 0, stderr: '', stdout: JSON.stringify({ issues: [], days, fetchedAt: NOW / 1000 }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Week · 16h 20m of 40h' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'toggle-hours' })).toBeDefined()
  await ui.press({ key: 'toggle-hours' })
  expect((await ui.find({ type: 'Button', key: 'toggle-hours' }))?.text).toMatch(/1h 00m of 8h · week 16h 20m/)
  await ui.unmount()
})

test('the timer reads the shared cache; only Refresh asks Jira past it', async ($, on) => {
  const runs: { argv: string[]; env: Record<string, string> }[] = []
  const clock = engine(on, undefined, undefined, [], undefined, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(10 * 60 * 1000)
  await clock.settle()

  expect(runs.length).toBe(2)
  expect(runs.every(r => r.argv.includes('snapshot') && !r.argv.includes('--force'))).toBe(true)
  expect(runs[0]!.argv.slice(runs[0]!.argv.indexOf('--since'), runs[0]!.argv.indexOf('--since') + 2)).toEqual(['--since', '2026-10-19'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(runs.at(-1)!.argv).toContain('--force')
  await ui.unmount()
})

test('the update time is when Jira was last asked, if the cache is older', async ($, on) => {
  const older = JSON.stringify({ issues: [], days: {}, fetchedAt: (NOW - 7 * 60_000) / 1000 })
  const clock = engine(on, undefined, undefined, [], { exitCode: 0, stderr: '', stdout: older })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // NOW is 06:00 UTC, the machine -03:00; Jira was asked 7 minutes before.
  expect(await ui.find({ type: 'Text', text: 'updated at 02:53' })).toBeDefined()
  await ui.unmount()
})

test('the update time is shown in the machine\'s own time zone', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // NOW is 06:00 UTC; `date +%z` answers -0300.
  expect(await ui.find({ type: 'Text', text: 'updated at 03:00' })).toBeDefined()
  await ui.unmount()
})

const link = (sessionId: string) => ({ sessionId, link: `claude://x/${sessionId}`, title: sessionId })

test('Refresh picks up a task linked in another open session', async ($, on) => {
  const shared = new Map<string, unknown>()
  const clock = engine(on, undefined, undefined, [], undefined, [], shared)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'go-task-ABC-82' })).toBeUndefined()
  shared.set('taskLinks', { 'ABC-82': link('local_other') })
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await ui.find({ type: 'Button', key: 'go-task-ABC-82' })).toBeDefined()
  await ui.unmount()
})

test('a linked task outside the sprint and work lists still shows, with its session button', async ($, on) => {
  const shared = new Map<string, unknown>([['taskLinks', { 'ABC-70': link('local_other') }]])
  const clock = engine(on, undefined, undefined, [], undefined, [], shared)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: 'ABC-70' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'go-task-ABC-70' })).toBeDefined()
  await ui.unmount()
})

test('linking keeps the links other sessions made after this one started', async ($, on) => {
  const shared = new Map<string, unknown>([['taskLinks', { 'ABC-1': link('local_a') }]])
  const clock = engine(on, undefined, undefined, [], undefined, [], shared)
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  shared.set('taskLinks', { ...(shared.get('taskLinks') as object), 'ABC-2': link('local_b') })
  await $.command.run({ command: 'task', args: 'ABC-82' } as never)
  await clock.settle()
  expect(Object.keys(shared.get('taskLinks') as object).sort()).toEqual(['ABC-1', 'ABC-2', 'ABC-82'])
})

test('one search filters tasks and PRs by text, key and number, opening folded groups', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Text, case-insensitive, in a task's summary: other tasks and every PR drop out.
  await ui.input({ key: 'search', text: 'ROCK', kind: 'change' })
  expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'ABC-52' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Nothing matches "ROCK".' })).toBeDefined()

  // A key without its project, as part of the text.
  await ui.input({ key: 'search', text: '52', kind: 'change' })
  expect(await ui.find({ type: 'Link', text: 'ABC-52' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeUndefined()

  // "#502" is exactly PR 502, a draft whose group starts folded: the search opens it.
  await ui.input({ key: 'search', text: '#502', kind: 'change' })
  expect(await ui.find({ type: 'Link', text: 'api#502' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'tab-review' }))?.text).toMatch(/Review 0/)

  // Words must all match; an author finds review PRs, the bots' folded group included.
  await ui.press({ key: 'tab-review' })
  await ui.input({ key: 'search', text: 'dependabot 265', kind: 'change' })
  expect(await ui.find({ type: 'Link', text: 'widgets#265' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'api#501' })).toBeUndefined()

  await ui.press({ key: 'search-clear' })
  expect(await ui.find({ type: 'Link', text: 'api#501' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'ABC-52' })).toBeDefined()
  await ui.unmount()
})

test('the search works the same on the terminal', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: '#479', kind: 'change' })
  expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeUndefined()
  await ui.unmount()
})

test('a pane with no data yet still has Refresh, and it loads', async ($, on) => {
  const clock = engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'No data yet.' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await ui.find({ type: 'Link', text: 'ABC-82' })).toBeDefined()
  await ui.unmount()
})

test('without a Jira url the pane shows PRs alone and says how to turn Jira on', async ($, on) => {
  const runs: { argv: string[]; env: Record<string, string> }[] = []
  const off = JSON.stringify({ ...JSON.parse(CONFIG), jira: { url: '', login: 'jdoe', offsetMinutes: 0, projects: [] } })
  const clock = engine(on, undefined, undefined, [], undefined, runs, undefined, off)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  expect(runs).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Jira is off\. Set jira\.url/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'toggle-hours' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: 'api#479' })).toBeDefined()
  await ui.unmount()
})

test('the language settings give the start words and the pane text in the user language', async ($, on) => {
  const german = JSON.stringify({
    ...JSON.parse(CONFIG),
    language: {
      startWords: ['fangen\\s+wir\\s+mit', 'bad(regex'],
      rememberWords: [],
      text: { Tasks: 'Aufgaben', '{key} linked to session "{title}"': '{key} mit Sitzung „{title}“ verknüpft', Drafts: 'Entwürfe' },
    },
  })
  const clock = engine(on, undefined, undefined, [], undefined, [], undefined, german)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.prompt.submit({ text: "let's start on ABC-82" } as never)
  await clock.settle()
  expect(toasts).toEqual([])
  await $.prompt.submit({ text: 'Fangen wir mit ABC-82 an' } as never)
  await clock.settle()
  expect(toasts.join(' | ')).toMatch(/ABC-82 mit Sitzung „Rocket“ verknüpft/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Aufgaben' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tasks' })).toBeUndefined()
  await ui.unmount()
})

test('a question that names a task links nothing: "is Bob still working on ABC-82?"', async ($, on) => {
  const clock = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await $.prompt.submit({ text: 'is Bob still working on ABC-82?' } as never)
  await $.prompt.submit({ text: "I'm working on ABC-82? no, let's check first" } as never)
  await clock.settle()
  expect(toasts).toEqual([])
  await $.prompt.submit({ text: "I'm working on ABC-82 today" } as never)
  await clock.settle()
  expect(toasts.join(' | ')).toMatch(/ABC-82 linked to session/)
})
