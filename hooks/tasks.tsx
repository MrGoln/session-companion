import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, Frozen, On, RenderChildren, RenderInput } from 'claude-code'

import type { DayLog, Issue, Pr, Snapshot, SourceError, TaskLink } from '../types'
import { configProblem, currentConfig, loadConfig, phrases, shortRepo, t } from './config'

const PLUGIN = 'session-companion'
const PANE = 'work'
const REFRESH_MS = 10 * 60 * 1000
const daySeconds = () => currentConfig().workday.hours * 3600
const jiraOn = () => !!currentConfig().jira.url
// Jira's own day: worklogs are stamped in its zone, which may differ from the machine's.
const jiraOffsetMs = () => currentConfig().jira.offsetMinutes * 60_000

let localOffsetMs = -new Date().getTimezoneOffset() * 60_000

const snapshot = atom({ plugin: 'session-companion', key: 'snapshot' } as const, null)
const isLoading = atom({ plugin: 'session-companion', key: 'isLoading' } as const, false)
const folds = atom({ plugin: 'session-companion', key: 'folds' } as const, {})
const prTab = atom({ plugin: 'session-companion', key: 'prTab' } as const, 'mine')
// Cards whose rows show full titles: 'tasks', 'prs'.
const fullTitles = atom({ plugin: 'session-companion', key: 'fullTitles' } as const, [])
const isOpen = atom({ plugin: 'session-companion', key: 'tasksOpen' } as const, false)
// The search text as typed, kept in the module: a new state key would need the contract reloaded too.
let typed = ''
function setQuery($: Dollar, value: string): void {
  typed = value
  $.ui.invalidate('ui.render')
}
const taskLinks = atom({ plugin: 'session-companion', key: 'taskLinks' } as const, {})

const PR_FIELDS = `number title url isDraft reviewDecision createdAt headRefName
      author { login } repository { name }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
// review-requested also matches requests to my teams; user-review-requested only the ones to me.
const prQuery = (scope: string) => {
  const q = (terms: string) => JSON.stringify(`${terms} ${scope}`.trim())
  return `query {
  mine: search(query: ${q('is:pr is:open author:@me')}, type: ISSUE, first: 30) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  review: search(query: ${q('is:pr is:open draft:false review-requested:@me -author:@me archived:false')}, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  direct: search(query: ${q('is:pr is:open user-review-requested:@me')}, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { url } }
  }
}`
}
const isBot = (login: string) => /\[bot\]$|^(dependabot|github-actions|renovate)$/.test(login)

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/
// The script's cache is shared by every session; a timer round finds it stale past this age.
const JIRA_MAX_AGE_S = REFRESH_MS / 1000 - 60

async function loadJira(
  $: Dollar,
  linked: string[],
  now: number,
  force: boolean,
): Promise<{ issues: Issue[]; week: DayLog[]; todaySeconds: number; fetchedAt: number }> {
  const local = new Date(now + jiraOffsetMs())
  const day = (offset: number) => new Date(local.getTime() + offset * 86400_000).toISOString().slice(0, 10)
  const fromMonday = (local.getUTCDay() + 6) % 7
  const dates = WEEKDAYS.map((_, i) => day(i - fromMonday))
  const today = day(0)
  const keys = linked.filter(key => ISSUE_KEY.test(key))
  const run = await $.process.run(
    [
      'python3',
      `${$.plugin.root}/bin/jira.py`,
      'snapshot',
      '--since',
      dates[0]!,
      '--linked',
      keys.join(','),
      '--max-age',
      String(JIRA_MAX_AGE_S),
      ...(force ? ['--force'] : []),
    ],
    { timeoutMs: 120_000 },
  )
  if (run.exitCode !== 0) throw new JiraScriptError(run.stderr.trim() || `jira.py: exit ${run.exitCode}`)
  const found = JSON.parse(run.stdout)
  const days: Record<string, number> = found.days ?? {}
  return {
    issues: (found.issues as any[]).map(i => ({ key: i.key, summary: i.summary, status: i.status, category: i.category, url: `${currentConfig().jira.url}/browse/${i.key}` })),
    week: dates.map(date => ({ date, seconds: days[date] ?? 0 })),
    todaySeconds: days[today] ?? 0,
    fetchedAt: Number(found.fetchedAt) * 1000,
  }
}

// The script's message already names the cause and the fix.
class JiraScriptError extends Error {}

function toPr(n: any, audience?: Pr['audience']): Pr {
  return {
    repo: n.repository.name,
    number: n.number,
    title: n.title,
    url: n.url,
    isDraft: n.isDraft,
    review: n.reviewDecision ?? '',
    ci: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE',
    author: n.author?.login ?? '?',
    headRef: String(n.headRefName ?? ''),
    createdAt: Date.parse(n.createdAt),
    audience,
  }
}

async function loadPrs($: Dollar): Promise<{ mine: Pr[]; reviews: Pr[] }> {
  const run = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${prQuery(currentConfig().github.search)}`], {
    timeoutMs: 60_000,
  })
  // gh exits 1 when one organization withholds its part (SAML) but prints the rest; that rest is shown.
  let data: any = null
  try {
    data = JSON.parse(run.stdout).data
  } catch {}
  if (!data?.mine || !data.review || !data.direct) throw new Error(run.stderr.trim() || 'gh failed')
  const nodes = (search: any) => ((search.nodes ?? []) as any[]).filter(Boolean)
  const direct = new Set(nodes(data.direct).map(n => n.url))
  return {
    mine: nodes(data.mine).map(n => toPr(n)),
    reviews: nodes(data.review).map(n =>
      toPr(n, direct.has(n.url) ? 'me' : isBot(n.author?.login ?? '') ? 'bot' : 'team'),
    ),
  }
}

function explain(source: SourceError['source'], err: unknown): SourceError {
  const raw = err instanceof Error ? err.message : String(err)
  let message = raw.split('\n')[0]!.slice(0, 160)
  if (/classifier|auto mode/i.test(raw)) {
    message = t('auto mode refused the request from the plugin; allow it in settings.json')
  } else if (/ENOENT|command not found|executable file not found/i.test(raw) && source === 'GitHub') {
    message = t('gh is not installed: install the GitHub CLI, then run gh auth login')
  } else if (/gh auth|401|Bad credentials/i.test(raw) && source === 'GitHub') {
    message = t('gh is not signed in: run gh auth login')
  } else if (/timed? ?out/i.test(raw)) {
    message = t('no answer in time, try Refresh')
  }
  return { source, message }
}

async function sessionTool($: Dollar, tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await $.mcp.call('ccd_session_mgmt', tool, args)
  const block = res.content.find(b => b.type === 'text') as { text?: string } | undefined
  if (res.isError || !block?.text) throw new Error(block?.text ?? `${tool} failed`)
  const text = block.text
  return JSON.parse(text.slice(Math.min(...['[', '{'].map(c => text.indexOf(c)).filter(i => i >= 0))))
}

// The app's own record of this session: its session list leaves the calling session out.
function ownSession($: Dollar): Promise<any> {
  return sessionTool($, 'get_session', { session_id: 'self' })
}

// The app's Code sessions, this one included.
async function appSessions($: Dollar): Promise<any[]> {
  const [others, own] = await Promise.all([
    sessionTool($, 'list_sessions', { limit: 100 }),
    ownSession($).catch(() => null),
  ])
  return own ? [...others, own] : others
}

const latest = (sessions: any[]) =>
  [...sessions].sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)))[0]

// The session a PR is open in: its branch, else its number in a folder of the same repo; the latest one wins.
function sessionOf(pr: Pr, sessions: any[]): Pr['session'] {
  const live = sessions.filter(x => !x.isArchived && x.link)
  const byBranch = live.filter(x => pr.headRef && x.branch === pr.headRef)
  const byNumber = live.filter(x => x.prNumber === pr.number && String(x.cwd).split('/').includes(pr.repo))
  const found = latest(byBranch.length ? byBranch : byNumber)
  return found ? { link: String(found.link), title: String(found.title ?? '') } : undefined
}

// The guard lives in the module, not in $.state: a reload during a refresh would leave a stored flag set for good.
let inflight: Promise<void> | null = null
// `force` asks Jira past the shared cache: the Refresh button. Every round reads the settings and the
// machine's offset again, so an edit or a DST switch shows without a restart.
function refresh($: Dollar, force = false): Promise<void> {
  inflight ??= load($, force).finally(() => {
    inflight = null
  })
  return inflight
}

async function load($: Dollar, force: boolean): Promise<void> {
  await update($, isLoading, () => true)
  try {
    await Promise.all([loadConfig($, true), readLocalOffset($)])
    const now = await $.clock.now()
    const errors: SourceError[] = []
    const settle = async <T,>(sources: SourceError['source'][], load: Promise<T>, fallback: T) => {
      try {
        return await load
      } catch (err) {
        for (const source of sources) {
          errors.push(err instanceof JiraScriptError ? { source, message: err.message.split('\n')[0]!.slice(0, 200) } : explain(source, err))
        }
        return fallback
      }
    }
    // Links made in other sessions since this one started.
    const links = await loadLinks($).catch(() => ({}))
    const [jira, github] = await Promise.all([
      jiraOn() ? settle(['Jira', 'Hours'], loadJira($, Object.keys(links), now, force), null) : null,
      settle(['GitHub'], loadPrs($), null),
    ])
    // No session list (auto mode refused, an older app): the PRs stay, without their session links.
    const sessions = github ? await appSessions($).catch(() => []) : []
    const withSession = (list: Pr[] | undefined) => list?.map(pr => ({ ...pr, session: sessionOf(pr, sessions) })) ?? null
    const next: Snapshot = {
      issues: jira?.issues ?? null,
      prs: withSession(github?.mine),
      reviews: withSession(github?.reviews),
      loggedSeconds: jira?.todaySeconds ?? null,
      week: jira?.week ?? null,
      today: new Date(now + jiraOffsetMs()).toISOString().slice(0, 10),
      updatedAt: now,
      jiraAt: jira?.fetchedAt ?? null,
      errors,
    }
    await update($, snapshot, () => next)
  } finally {
    await update($, isLoading, () => false)
  }
}

const hm = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? t('{h}h {m}m', { h, m: String(m).padStart(2, '0') }) : t('{m}m', { m })
}
const clock = (ms: number) => new Date(ms + localOffsetMs).toISOString().slice(11, 16)

async function readLocalOffset($: Dollar): Promise<void> {
  const run = await $.process.run(['date', '+%z']).catch(() => null)
  const zone = /^([+-])(\d{2})(\d{2})$/.exec(run?.stdout.trim() ?? '')
  if (zone) localOffsetMs = (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000
}
// "feat(scope)!: ABC-1 Title" -> "Title"; the scope and key are noise in a narrow pane.
const shortTitle = (title: string) =>
  title.replace(/^\w+(\([^)]*\))?!?:\s*/, '').replace(/^[A-Z]+-\d+\s+/, '')

// id is the group's English name, kept in the fold state; label is what the pane shows.
type PrState = { order: number; mark: string; color: string; background?: string; id: string; label: string }
function prState(p: Pr): PrState {
  if (p.ci === 'FAILURE' || p.ci === 'ERROR')
    return { order: 0, mark: '✗', color: 'error', background: 'diffRemovedDimmed', id: 'CI failed', label: t('CI failed') }
  if (p.review === 'CHANGES_REQUESTED' && !p.isDraft)
    return { order: 1, mark: '!', color: 'warning', id: 'Changes requested', label: t('Changes requested') }
  if (p.isDraft) return { order: 5, mark: '○', color: 'inactive', id: 'Drafts', label: t('Drafts') }
  if (p.ci === 'PENDING' || p.ci === 'EXPECTED') return { order: 3, mark: '…', color: 'warning', id: 'CI running', label: t('CI running') }
  if (p.review === 'APPROVED')
    return { order: 2, mark: '✓', color: 'success', background: 'diffAddedDimmed', id: 'Ready to merge', label: t('Ready to merge') }
  return { order: 4, mark: '●', color: 'suggestion', id: 'Awaiting review', label: t('Awaiting review') }
}

// Persisted across sessions: only the blocks the person toggled, so a block added later
// still starts in its default state.
const FOLDS_KEY = 'folds'
const FOLDED_BY_DEFAULT = new Set(['pr:Drafts', 'review:bot'])
const isFolded = (state: Record<string, boolean>, id: string, byDefault = false) =>
  state[id] ?? (byDefault || FOLDED_BY_DEFAULT.has(id))
const TAB_KEY = 'prTab'
const FULL_TITLES_KEY = 'fullTitles'

async function toggleFullTitles($: Dollar, cardId: string): Promise<void> {
  const next = await update($, fullTitles, ids => (ids.includes(cardId) ? ids.filter(x => x !== cardId) : [...ids, cardId]))
  await $.store.set(FULL_TITLES_KEY, next)
}

async function pickTab($: Dollar, tab: 'mine' | 'review'): Promise<void> {
  await update($, prTab, () => tab)
  await $.store.set(TAB_KEY, tab)
}

const AUDIENCE: Record<NonNullable<Pr['audience']>, { order: number; label: () => string; color: string }> = {
  me: { order: 0, label: () => t('To me'), color: 'claude' },
  team: { order: 1, label: () => t('To my teams'), color: 'suggestion' },
  bot: { order: 2, label: () => t('Bots'), color: 'inactive' },
}
const age = (now: number, since: number) => {
  const hours = Math.floor((now - since) / 3600_000)
  return hours < 24 ? t('{h}h', { h: hours }) : t('{d}d', { d: Math.floor(hours / 24) })
}

async function toggle($: Dollar, id: string, byDefault = false): Promise<void> {
  const next = await update($, folds, state => ({ ...state, [id]: !isFolded(state, id, byDefault) }))
  await $.store.set(FOLDS_KEY, next)
}

async function loadFolds($: Dollar): Promise<Record<string, boolean>> {
  const saved = await $.store.get(FOLDS_KEY)
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, boolean>) : {}
}

// Every word must match: "#519" is exactly that PR or task number, any other word a part of the text.
function matches(q: string, text: string[], numbers: string[]): boolean {
  const hay = text.join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(word => (word.length > 1 && word.startsWith('#') ? numbers.includes(word.slice(1)) : hay.includes(word)))
}
const issueMatches = (q: string, i: Issue) => matches(q, [i.key, i.summary, i.status], [i.key.split('-')[1] ?? ''])
const prMatches = (q: string, p: Pr) =>
  matches(q, [`${p.repo}#${p.number}`, `${shortRepo(p.repo)}#${p.number}`, p.title, p.author, p.headRef], [String(p.number)])

function groupBy<T>(items: T[], keyOf: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  return [...groups]
}

const LINKS_KEY = 'taskLinks'
const TASK_KEYS = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g

// jira.projects, else the projects of the user's own issues: "UTF-8" and "SHA-256" are not tasks.
async function knownProjects($: Dollar): Promise<Set<string>> {
  const set = currentConfig().jira.projects
  if (set.length) return new Set(set)
  return new Set(((await read($, snapshot))?.issues ?? []).map(i => i.key.split('-')[0]!))
}
function taskKey(text: string, projects: Set<string>): string | null {
  for (const m of text.matchAll(TASK_KEYS)) if (!projects.size || projects.has(m[1]!)) return m[0]
  return null
}

// "Let's start on ABC-12" and the like: the key that follows a start word, within the same sentence.
function startedTask(text: string, projects: Set<string>): string | null {
  const start = phrases(currentConfig().language.startWords)?.exec(text)
  if (!start) return null
  const rest = text.slice(start.index + start[0].length).split(/[.!?\n]/)[0] ?? ''
  return taskKey(rest, projects)
}

// The store is shared by every open session; this session's copy may miss links made elsewhere.
async function loadLinks($: Dollar): Promise<Record<string, TaskLink>> {
  const saved = await $.store.get(LINKS_KEY)
  const links = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, TaskLink>) : {}
  await update($, taskLinks, () => links)
  return links
}

async function linkSession($: Dollar, key: string): Promise<string> {
  const own = await ownSession($)
  if (!own?.link) throw new Error('the app gave no link to this session')
  const next = {
    ...(await loadLinks($)),
    [key]: { sessionId: String(own.sessionId), link: String(own.link), title: String(own.title ?? '') },
  }
  await $.store.set(LINKS_KEY, next)
  await update($, taskLinks, () => next)
  return String(own.title ?? own.sessionId)
}

// This session's app id and branch, read once at start, to tell the model whether it is linked yet.
let ownSessionId: string | null = null
let ownBranch = ''
// Keys already offered for linking in this session: the model is asked once per key.
const offered = new Set<string>()

const LINK_TOOL = 'link_task'
const LINK_TOOL_SPEC = {
  name: LINK_TOOL,
  description:
    'Link this Code session to a Jira issue: the issue in the "My work" pane gets a button that opens this session. ' +
    'Call it when the user says to work on an issue. If the issue only shows in the context ' +
    '(a key in the branch, a PR or the task), first ask the user once whether to link the session to it.',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'The Jira issue key, for example ABC-123' } },
    required: ['key'],
  },
  isDeferred: false,
}

function linkedKey(links: Record<string, TaskLink>): string | null {
  return Object.entries(links).find(([, link]) => link.sessionId === ownSessionId)?.[0] ?? null
}

async function linkAndSay($: Dollar, key: string): Promise<string> {
  try {
    const title = await linkSession($, key)
    void refresh($).catch(() => undefined)
    $.ui.toast(t('{key} linked to session "{title}"', { key, title }))
    return `${key} linked to session "${title}".`
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    $.ui.toast(t('{key}: not linked to the session — {why}', { key, why: why.slice(0, 120) }))
    return `${key} not linked: ${why.slice(0, 200)}`
  }
}

// A session's app link opens it in the desktop app; anything but that scheme is left alone.
async function openSession($: Dollar, link: string): Promise<void> {
  if (!link.startsWith('claude://')) return
  const run = await $.process
    .run(['/usr/bin/open', link])
    .catch(() => $.process.run(['xdg-open', link]))
    .catch((err: unknown) => ({ exitCode: 1, stderr: err instanceof Error ? err.message : String(err) }))
  if (run.exitCode !== 0) $.ui.toast(t('Cannot open the session: {why}', { why: run.stderr.trim().slice(0, 120) }))
}

async function togglePane($: Dollar): Promise<void> {
  if (await read($, isOpen)) {
    // The mod's own close does not reach its ui.close hook, so the state is set here.
    await $.ui.close({ id: PANE })
    await update($, isOpen, () => false)
    return
  }
  await $.ui.open({ id: PANE, title: t('My work') })
  await update($, isOpen, () => true)
  void refresh($)
}

export async function tasksBand($: Dollar, e: Frozen<RenderInput<'AbovePrompt'>>): Promise<RenderChildren> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const open = await read($, isOpen)
  const snap = await read($, snapshot)
  const hours = currentConfig().workday.hours

  const failed = snap?.prs?.filter(p => p.ci === 'FAILURE' || p.ci === 'ERROR').length ?? 0
  const forMe = snap?.reviews?.filter(p => p.audience === 'me').length ?? 0
  const summary = snap
    ? [
        snap.issues && t('{n} tasks', { n: snap.issues.filter(i => i.category !== 'done').length }),
        snap.prs && t('{n} PRs', { n: snap.prs.length }),
        failed > 0 && t('{n} ✗ CI', { n: failed }),
        forMe > 0 && t('{n} reviews on me', { n: forMe }),
        snap.loggedSeconds !== null && t('{done} of {hours}h', { done: hm(snap.loggedSeconds), hours }),
      ].filter(Boolean)
    : []

  return (
    <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1} minWidth={0}>
      <Button key="toggle-work" plain onPress={() => void togglePane($)}>
        {open ? t('▾ Hide work') : t('▸ My work')}
      </Button>
      {!open && summary.length > 0 && (
        <Text dimColor size="footnote" wrap="truncate-end">
          {summary.join(' · ')}
        </Text>
      )}
    </Box>
  )
}

export async function startTasks($: Dollar): Promise<void> {
    await loadConfig($)
    await readLocalOffset($)
    await $.command.register({ name: 'work', description: t('Open or close the "My work" pane') })
    await $.command.register({ name: 'task', description: t('Link this session to a Jira issue: /task ABC-123') })
    await loadLinks($)
    if (jiraOn()) await $.tool.register(LINK_TOOL_SPEC)
    const own = await ownSession($).catch(() => null)
    ownSessionId = String(own?.sessionId ?? '') || null
    ownBranch = String(own?.branch ?? '')
    const state = await loadFolds($)
    await update($, folds, () => state)
    const tab = await $.store.get(TAB_KEY)
    await update($, prTab, () => (tab === 'review' ? 'review' : 'mine'))
    const full = await $.store.get(FULL_TITLES_KEY)
    await update($, fullTitles, () => (Array.isArray(full) ? (full as string[]) : []))
    $.clock.every(REFRESH_MS, () => void refresh($))
    // Closed by default: the button above the prompt and /work open and close it.
    // A reload closes the pane; one that was open before it opens again.
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if ((await read($, isOpen)) && !isUp) await $.ui.open({ id: PANE, title: t('My work') }).catch(() => undefined)
    else await update($, isOpen, () => isUp)
    void refresh($)
}

// The model's own way to link: the tool is listed as mcp__<plugin>__link_task.
export async function tasksTool($: Dollar, tool: string, input: unknown): Promise<{ result: string } | null> {
  if (tool !== `mcp__${PLUGIN}__${LINK_TOOL}`) return null
  const key = taskKey(String((input as { key?: unknown }).key ?? ''), new Set())
  return { result: key ? await linkAndSay($, key) : 'A Jira issue key is needed, for example ABC-123.' }
}

// "Let's start on ABC-12" in a prompt links this session to the task; the prompt goes on as typed.
// An unlinked session whose prompt or branch names a task gets a note beside the prompt, once per
// key, for the model to offer the link.
export async function tasksPromptContext($: Dollar, text: string): Promise<string[]> {
  if (!jiraOn()) return []
  const projects = await knownProjects($)
  const started = startedTask(text, projects)
  if (started) {
    void linkAndSay($, started)
    return []
  }
  if (!ownSessionId || linkedKey(await read($, taskLinks))) return []
  const fromPrompt = taskKey(text, projects)
  const fromBranch = taskKey(ownBranch.toUpperCase(), projects)
  const key = fromPrompt ?? fromBranch
  if (!key || offered.has(key)) return []
  offered.add(key)
  const where = fromPrompt ? "the user's message" : `the branch ${ownBranch}`
  return [
    `${PLUGIN}: this session is not linked to a Jira issue, and ${where} names ${key}. If the work is on that issue, ` +
      `ask the user once whether to link the session to ${key}, and on their yes call ${LINK_TOOL}.`,
  ]
}

// The pane's own close mark closes it too; the button follows.
export async function tasksPaneClosed($: Dollar, id: string): Promise<void> {
  if (id === PANE) await update($, isOpen, () => false)
}

export function registerTasks(on: On): void {
  on('command.run', { command: 'work' }, async $ => {
    await togglePane($)

    return { text: (await read($, isOpen)) ? t('The "My work" pane is open.') : t('The "My work" pane is closed.') }
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    const key = taskKey(String((e as { args?: unknown }).args ?? ''), new Set())
    return { text: key ? await linkAndSay($, key) : t('Give an issue key: /task ABC-123') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Link, Button } = elements
    // Not every surface has a text field; there the pane goes without search.
    const Input = 'Input' in elements ? elements.Input : null
    const snap = await read($, snapshot)
    const loading = await read($, isLoading)
    const foldState = await read($, folds)
    // Full titles wrap instead of being cut, per card; the desktop has no hover reveal for a single row.
    const fullCards = new Set(await read($, fullTitles))
    const cardOf = (rowId: string) => (rowId.startsWith('task-') ? 'tasks' : 'prs')
    const tab = await read($, prTab)
    const q = typed.trim()

    if (!snap) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{loading ? t('Loading…') : t('No data yet.')}</Text>
          <Box>
            <Button key="refresh" variant="secondary" onPress={() => void refresh($, true)}>
              {t('↻ Refresh')}
            </Button>
          </Box>
        </Box>
      )
    }

    // While a refresh runs, the previous round's error is not shown as if it were current.
    const problem = (source: SourceError['source']) =>
      loading ? (
        <Text dimColor size="footnote">
          {t('refreshing…')}
        </Text>
      ) : (
      <Box borderStyle="round" borderColor="warning" paddingLeft={1} paddingRight={1}>
        <Text color="warning" size="footnote" wrap="wrap">
          ⚠ {snap.errors.find(x => x.source === source)?.message}
        </Text>
      </Box>
    )
    // A one-glyph button before a row: it opens the session the task or PR is worked on in.
    const goButton = (key: string, link: string | undefined) =>
      link ? (
        <Button key={key} plain onPress={() => void openSession($, link)}>
          ↗
        </Button>
      ) : null
    // One list row: a single line of text (key, title) and the session button at its end.
    const row = (id: string, go: RenderChildren, head: RenderChildren, short: RenderChildren, full: RenderChildren, dim = false) => {
      const isFull = fullCards.has(cardOf(id))
      return (
      <Box key={`row-${id}`} flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap={isFull ? 'wrap' : 'truncate-end'} dimColor={dim}>
            {head} {isFull ? full : short}
          </Text>
        </Box>
        {go}
      </Box>
      )
    }
    const chip = (text: string, color: string, background?: string) => (
      <Text color={color} backgroundColor={background} bold>
        {` ${text} `}
      </Text>
    )

    // A card folds by its header; folded, the header still carries the card's summary.
    const card = (
      id: string,
      title: string,
      brief: RenderChildren,
      accent: string,
      body: () => RenderChildren,
      canExpand = false,
    ) => {
      // A search opens the cards it filters, so a match is never folded away.
      const isOpen = (!!q && (id === 'tasks' || id === 'prs')) || !isFolded(foldState, id)
      const isFull = fullCards.has(id)
      return (
        <Box
          key={`card-${id}`}
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={accent}
          paddingLeft={1}
          paddingRight={1}
          hover={{ borderColor: 'claude' }}
        >
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            {/* The title shrinks and is cut, so the expand button keeps its place inside the border. */}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`toggle-${id}`} plain onPress={() => void toggle($, id)}>
                {/* Folded, the header carries the card's summary; open, the card body shows it already. */}
                <Text color={accent}>{isOpen ? '▾' : '▸'}</Text> <Text bold>{title}</Text> {!isOpen && brief}
              </Button>
            </Box>
            {canExpand && isOpen && (
              <Box flexShrink={0}>
                <Button key={`full-${id}`} plain onPress={() => void toggleFullTitles($, id)}>
                  {isFull ? '⤡' : '⤢'}
                </Button>
              </Box>
            )}
          </Box>
          {isOpen && (
            <Box flexDirection="column" marginTop={1}>
              {body()}
            </Box>
          )}
        </Box>
      )
    }
    const group = (id: string, head: RenderChildren, rows: () => RenderChildren, foldedByDefault = false) => {
      const isOpen = !!q || !isFolded(foldState, id, foldedByDefault)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Button key={`toggle-${id}`} plain dimColor onPress={() => void toggle($, id, foldedByDefault)}>
            <Text dimColor>{isOpen ? '▾' : '▸'}</Text> {head}
          </Button>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {rows()}
            </Box>
          )}
        </Box>
      )
    }
    const tile = (label: string, value: string, color: string) => (
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={color}
        paddingLeft={1}
        alignItems="flex-start"
      >
        <Text bold color={color} size="heading">
          {value}
        </Text>
        <Text dimColor size="caption">
          {label}
        </Text>
      </Box>
    )

    const DAY_SECONDS = daySeconds()
    const hours = currentConfig().workday.hours
    const hasJira = jiraOn()
    const setupHint = (
      <Text dimColor wrap="wrap">
        {configProblem()
          ? t('Settings not read: {why}', { why: configProblem()! })
          : t('Jira is off. Set jira.url in ~/.claude/session-companion/config.json, or ask Claude to set up session-companion.')}
      </Text>
    )
    const logged = snap.loggedSeconds
    const weekTotal = (snap.week ?? []).reduce((sum, d) => sum + d.seconds, 0)
    const cells = 100
    const filled = logged === null ? 0 : Math.min(cells, Math.round((logged / DAY_SECONDS) * cells))
    const isDone = logged !== null && logged >= DAY_SECONDS
    const hoursColor = logged === null ? 'warning' : isDone ? 'success' : 'warning'

    const issues = q ? (snap.issues?.filter(i => issueMatches(q, i)) ?? null) : snap.issues
    const prs = q ? (snap.prs?.filter(p => prMatches(q, p)) ?? null) : snap.prs
    const reviews = q ? (snap.reviews?.filter(p => prMatches(q, p)) ?? null) : snap.reviews
    const notFound = <Text dimColor>{t('Nothing matches "{q}".', { q })}</Text>

    const CATEGORY_ORDER = { progress: 0, todo: 1, done: 2 } as const
    const issueGroups = groupBy(
      [...(issues ?? [])].sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]),
      i => i.status,
    )
    const links = await read($, taskLinks)
    const prGroups = groupBy(
      [...(prs ?? [])].map(p => ({ p, s: prState(p) })).sort((a, b) => a.s.order - b.s.order),
      x => x.s.id,
    )
    const failed = prGroups.find(([id]) => id === 'CI failed')?.[1].length ?? 0
    const ready = prGroups.find(([id]) => id === 'Ready to merge')?.[1].length ?? 0
    const reviewGroups = groupBy(
      [...(reviews ?? [])].sort(
        (a, b) => AUDIENCE[a.audience ?? 'team'].order - AUDIENCE[b.audience ?? 'team'].order || a.createdAt - b.createdAt,
      ),
      p => p.audience ?? 'team',
    )
    const forMe = snap.reviews?.filter(p => p.audience === 'me').length ?? 0
    const tabButton = (id: 'mine' | 'review', label: string, n: number | undefined) => (
      <Button key={`tab-${id}`} variant={tab === id ? 'primary' : 'secondary'} onPress={() => void pickTab($, id)}>
        {label} <Text dimColor>{n === undefined ? '—' : String(n)}</Text>
      </Button>
    )
    const count = (n: number | undefined) => (n === undefined ? '—' : String(n))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text dimColor size="footnote">
            {loading ? t('⟳ refreshing…') : t('updated at {time}', { time: clock(Math.min(snap.updatedAt, snap.jiraAt ?? snap.updatedAt)) })}
          </Text>
          <Button key="refresh" variant="secondary" onPress={() => void refresh($, true)}>
            {t('↻ Refresh')}
          </Button>
        </Box>

        <Box flexDirection="row" gap={1} marginTop={1}>
          {hasJira && tile(t('hours'), logged === null ? '—' : hm(logged), hoursColor)}
          {hasJira && tile(t('tasks'), count(snap.issues?.length), 'suggestion')}
          {tile(failed ? t('CI failed') : t('PRs'), failed ? String(failed) : count(snap.prs?.length), failed ? 'error' : 'success')}
        </Box>

        {hasJira && card(
          'hours',
          t('Today'),
          <Text dimColor>
            {logged === null ? t('no data') : t('{done} of {hours}h · week {week}', { done: hm(logged), hours, week: hm(weekTotal) })}
          </Text>,
          hoursColor,
          () =>
            logged === null ? (
              problem('Hours')
            ) : (
              <Box flexDirection="column">
                {/* Boxes, not glyphs: a proportional desktop font overflows a fixed run of █. */}
                <Box flexDirection="row" width="100%">
                  {filled > 0 && (
                    <Box width={`${Math.round((filled / cells) * 100)}%`} backgroundColor={hoursColor}>
                      <Text> </Text>
                    </Box>
                  )}
                  {filled < cells && (
                    <Box flexGrow={1} backgroundColor="inactive">
                      <Text> </Text>
                    </Box>
                  )}
                </Box>
                <Text dimColor size="footnote">
                  {isDone ? t('✓ day closed') : t('{left} to go · worklog skill', { left: hm(DAY_SECONDS - logged) })}
                </Text>
                {snap.week && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text dimColor size="footnote">
                      {t('Week · {done} of {hours}h', { done: hm(weekTotal), hours: WEEKDAYS.length * hours })}
                    </Text>
                  </Box>
                )}
              </Box>
            ),
        )}

        {Input && (
        <Box flexDirection="row" gap={1} marginTop={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Input
              key="search"
              placeholder={t('Search tasks and PRs: ABC-12, #519, text')}
              value={typed}
              onInput={(value: string) => setQuery($, value)}
              onSubmit={(value: string) => setQuery($, value)}
            />
          </Box>
          {typed && (
            <Button key="search-clear" plain onPress={() => setQuery($, '')}>
              ✕
            </Button>
          )}
        </Box>
        )}

        {card(
          'tasks',
          t('Tasks'),
          <Text dimColor>{!hasJira ? t('Jira off') : issues === null ? t('no data') : String(issues.length)}</Text>,
          'suggestion',
          () => (
            <Box flexDirection="column">
              {!hasJira && setupHint}
              {hasJira && snap.issues === null && problem('Jira')}
              {snap.issues?.length === 0 && <Text dimColor>{t('No open tasks.')}</Text>}
              {!!snap.issues?.length && issues?.length === 0 && notFound}
              {issueGroups.map(([status, issues]) =>
                group(
                  `task:${status}`,
                  chip(`${status} · ${issues.length}`, issues[0]!.category === 'done' ? 'inactive' : 'suggestion'),
                  () =>
                    issues.map(i =>
                      row(
                        `task-${i.key}`,
                        goButton(`go-task-${i.key}`, links[i.key]?.link),
                        <Link href={i.url}>{i.key}</Link>,
                        i.summary,
                        `${i.summary} · ${i.status}`,
                        i.category === 'done',
                      ),
                    ),
                  issues[0]!.category === 'done',
                ),
              )}
            </Box>
          ),
          true,
        )}

        {card(
          'prs',
          t('PR'),
          <Text>
            <Text dimColor>{prs === null ? t('no data') : t('mine {n}', { n: prs.length })}</Text>
            {failed > 0 && <Text color="error">{` · ${failed} ✗`}</Text>}
            {ready > 0 && <Text color="success">{` · ${ready} ✓`}</Text>}
            {reviews !== null && <Text dimColor>{` · ${t('reviews {n}', { n: reviews.length })}`}</Text>}
            {forMe > 0 && <Text color="claude">{` · ${t('on me {n}', { n: forMe })}`}</Text>}
          </Text>,
          failed ? 'error' : forMe ? 'claude' : 'success',
          () => (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1} marginBottom={1}>
                {tabButton('mine', t('Mine'), prs?.length)}
                {tabButton('review', t('Review'), reviews?.length)}
              </Box>
              {(snap.prs === null || snap.reviews === null) && problem('GitHub')}
              {tab === 'mine' && snap.prs?.length === 0 && <Text dimColor>{t('No open PRs.')}</Text>}
              {tab === 'mine' && !!snap.prs?.length && prs?.length === 0 && notFound}
              {tab === 'mine' &&
                prGroups.map(([id, items]) => {
                  const s = items[0]!.s
                  return group(`pr:${id}`, chip(`${s.mark} ${s.label} · ${items.length}`, s.color, s.background), () =>
                    items.map(({ p }) =>
                      row(
                        `pr-${p.repo}-${p.number}`,
                        goButton(`go-pr-${p.repo}-${p.number}`, p.session?.link),
                        <Link href={p.url}>{`${shortRepo(p.repo)}#${p.number}`}</Link>,
                        shortTitle(p.title),
                        p.title,
                        p.isDraft,
                      ),
                    ),
                  )
                })}
              {tab === 'review' && snap.reviews?.length === 0 && <Text dimColor>{t('Nobody is waiting for your review.')}</Text>}
              {tab === 'review' && !!snap.reviews?.length && reviews?.length === 0 && notFound}
              {tab === 'review' &&
                reviewGroups.map(([audience, items]) => {
                  const a = AUDIENCE[audience as NonNullable<Pr['audience']>]
                  return group(`review:${audience}`, chip(`${a.label()} · ${items.length}`, a.color), () =>
                    items.map(p => {
                      const waited = age(snap.updatedAt, p.createdAt)
                      const isStale = snap.updatedAt - p.createdAt > 2 * 86400_000
                      return row(
                        `review-${p.repo}-${p.number}`,
                        goButton(`go-review-${p.repo}-${p.number}`, p.session?.link),
                        // Plain text after the link, as in the other rows: nested text is not cut on the desktop.
                        <Link href={p.url}>{`${shortRepo(p.repo)}#${p.number}`}</Link>,
                        `${isStale ? '⚠ ' : ''}${waited} @${p.author} ${shortTitle(p.title)}`,
                        `${isStale ? '⚠ ' : ''}${waited} @${p.author} · ${p.title}`,
                      )
                    }),
                  )
                })}
            </Box>
          ),
          true,
        )}

      </Box>
    )
  })
}
