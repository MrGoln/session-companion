import type { EngineInterface as Dollar } from 'claude-code'

import type { Config } from '../types'

// Used until bin/jira.py answers, and when it cannot.
export const DEFAULT_CONFIG: Config = {
  jira: { url: '', login: '', offsetMinutes: 0, projects: [] },
  github: { search: '', shortenRepos: [] },
  workday: { hours: 8 },
  notes: { threadUrls: ['^https://[^/]+\\.slack\\.com/archives/[^/]+/p\\d+'] },
  language: {
    startWords: [
      "start(?:ing|ed)?(?:\\s+work(?:ing)?)?\\s+on",
      "let'?s\\s+(?:work\\s+on|do|take)",
      'pick(?:ing)?\\s+up',
      'tak(?:e|ing)\\s+on',
      'work(?:ing)?\\s+on',
    ],
    rememberWords: [
      'remember\\s+(?:this|that)',
      'note\\s+(?:this|that|it)\\s+down',
      '(?:save|add)\\s+(?:(?:this|that|it)\\s+)?(?:to|in)\\s+(?:the\\s+|my\\s+)?notes',
    ],
    text: {},
  },
}

let config: Config = DEFAULT_CONFIG
let problem: string | null = null
let loading: Promise<Config> | null = null

// bin/jira.py owns the merge of the team and personal files.
export function loadConfig($: Dollar, fresh = false): Promise<Config> {
  if (fresh) loading = null
  loading ??= $.process
    .run(['python3', `${$.plugin.root}/bin/jira.py`, 'config'], { timeoutMs: 30_000 })
    .then(run => {
      if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `jira.py config: exit ${run.exitCode}`)
      const next = JSON.parse(run.stdout) as Config
      // The band and both panes draw from the settings: a change shows at once.
      if (JSON.stringify(next) !== JSON.stringify(config)) $.ui.invalidate('ui.render')
      config = next
      problem = null
      return config
    })
    .catch(err => {
      problem = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200)
      return config
    })
  return loading
}

export const currentConfig = (): Config => config

// The pane's words in the user's language: language.text maps the English text to theirs, and
// {name} in either stands for a value filled in here.
export function t(english: string, vars: Record<string, string | number> = {}): string {
  const own = config.language.text[english]
  return (typeof own === 'string' && own ? own : english).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

// A word list as one regex that matches whole words only; a pattern that does not compile is left out.
export function phrases(words: string[]): RegExp | null {
  const valid = words.filter(word => {
    try {
      new RegExp(word, 'iu')
      return true
    } catch {
      return false
    }
  })
  return valid.length ? new RegExp(`(?:^|[^\\p{L}])(?:${valid.join('|')})(?![\\p{L}])`, 'iu') : null
}

export const configProblem = (): string | null => problem

export const shortRepo = (repo: string): string => {
  const prefix = config.github.shortenRepos.find(p => p && repo.startsWith(p) && repo.length > p.length)
  return prefix ? repo.slice(prefix.length) : repo
}
