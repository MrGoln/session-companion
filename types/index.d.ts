export type Config = {
  // An empty url: Jira is off. offsetMinutes is the zone Jira stamps worklogs in.
  jira: { url: string; login: string; offsetMinutes: number; projects: string[] }
  // search is added to every PR query ("org:acme"); shortenRepos are name prefixes cut in rows.
  github: { search: string; shortenRepos: string[] }
  workday: { hours: number }
  // Regexes for chat permalinks saved as threads.
  notes: { threadUrls: string[] }
  // Trigger regexes and the panes' text in the user's language; text maps English to theirs.
  language: { startWords: string[]; rememberWords: string[]; text: Record<string, string> }
}

export type Issue = { key: string; summary: string; status: string; category: 'todo' | 'progress' | 'done'; url: string }
// The app session a task was started in: `link` opens it in the desktop app.
export type TaskLink = { sessionId: string; link: string; title: string }
export type Pr = {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  review: string
  ci: string
  author: string
  createdAt: number
  headRef: string
  // The Code session the PR is open in, latest by activity; `link` opens it in the desktop app.
  session?: { link: string; title: string }
  // Set on PRs awaiting my review: requested from me, from my team, or opened by a bot.
  audience?: 'me' | 'team' | 'bot'
}
export type SourceError = { source: 'Jira' | 'GitHub' | 'Hours'; message: string }
export type DayLog = { date: string; seconds: number }
// null in a field means that source failed this round (its reason is in errors) or is off.
export type Snapshot = {
  issues: Issue[] | null
  prs: Pr[] | null
  reviews: Pr[] | null
  loggedSeconds: number | null
  // Monday to Friday of this week, by Jira's calendar day; today is that day's date.
  week: DayLog[] | null
  today: string
  updatedAt: number
  // When bin/jira.py last asked Jira: its cache is shared by every session, so this can be older than updatedAt.
  jiraAt: number | null
  errors: SourceError[]
}

export type NoteKind = 'link' | 'thread' | 'decision' | 'other'
export type Note = {
  id: string
  // Milliseconds since the epoch.
  at: number
  kind: NoteKind
  text: string
  url?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-companion': {
      snapshot: Snapshot | null
      isLoading: boolean
      folds: Record<string, boolean>
      prTab: 'mine' | 'review'
      tasksOpen: boolean
      fullTitles: string[]
      taskLinks: Record<string, TaskLink>
      notes: Note[]
      notesOpen: boolean
      noteQuery: string
      noteFilter: NoteKind | 'all'
    }
  }
}
