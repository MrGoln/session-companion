# Session Companion

A Claude Code plugin that shows your Jira tasks, pull requests and session notes in panes beside the chat.

<table>
  <tr>
    <td valign="top"><img src="assets/work-pane.png" alt="The My work pane: hours logged today, Jira tasks by status, PRs grouped by CI and review state" width="420"></td>
    <td valign="top"><img src="assets/notes-pane.png" alt="The Session notes pane: a command, a PR link, a chat thread and a decision saved with /note" width="420"></td>
  </tr>
</table>

Screenshots from a terminal session with demo data.

## Features

- **My work pane.** Your open Jira tasks grouped by status, your open PRs grouped by CI and review state, PRs waiting for your review, and the hours you logged today and this week.
- **Session notes pane.** Links, chat threads, decisions and commands from the current session. Claude adds them on its own when a PR, issue or thread comes up, and you can add your own.
- **Jump to a session.** A task linked to a session, or a PR whose branch is open in a session, gets a ↗ button that opens that session.
- **Worklog.** Claude builds a day's Jira worklog from your session history and, if a calendar connector is set up, your meetings. It logs nothing until you confirm the table.
- **Any language.** Claude can translate the panes and the trigger phrases into your language.

Jira is optional: without it the work pane shows your PRs only.

## Requirements

- macOS or Linux with Python 3.9 or newer available as `python3`.
- [GitHub CLI](https://cli.github.com/), signed in with `gh auth login`.
- For Jira: Jira Server or Data Center over https.

Not supported:

- Windows, because `bin/jira.py` locks its cache with `fcntl`.
- Jira Cloud, because its search and worklog APIs differ from Server.

## Installation

From a shell:

```bash
claude plugin install session-companion --marketplace MrGoln/session-companion
```

Or at the prompt of a Claude Code terminal session:

```
/plugin install session-companion --marketplace MrGoln/session-companion
```

In the desktop app, click **+** next to the prompt box, choose **Plugins**, add the marketplace `MrGoln/session-companion`, then add the plugin.

## Setup

Ask Claude:

```
set up session companion
```

Claude asks for your Jira address and login, the GitHub organization to search, and writes `~/.claude/session-companion/config.json`.
Then it gives you the command to store your Jira token.

The token is a personal access token (Jira 8.14 and newer) or, on older Jira Server, your password.
It is never written to a file:

```bash
# macOS: stored in the Keychain, the command asks for the token
security add-generic-password -U -s session-companion-jira -a <login> -w
```

```bash
# Linux: add to your shell profile
export SESSION_COMPANION_JIRA_TOKEN=...
```

On the first Jira request macOS asks whether `python3` may read the Keychain item.
Click **Always Allow**, otherwise the question returns on every refresh.

## Usage

Two buttons appear above the prompt: **▸ My work** and **▸ Notes**.

| Action | Result |
| --- | --- |
| Click **▸ My work** or run `/work` | Opens the work pane. It refreshes every 10 minutes and when you click **↻ Refresh**. |
| Click **▸ Notes** or run `/notes` | Opens the notes pane. |
| Run `/note <text> <link>` or say "remember this: …" | Saves a note for this session. |
| Run `/task ABC-123` or say "let's start on ABC-123" | Links this session to the task. The task's ↗ button opens this session. |
| Say "log my time for today" | Claude proposes a worklog table and logs it after you confirm. |

A question does not link a session: "is Bob still working on ABC-123?" changes nothing.

Claude gets three tools: `add_note`, `show_notes` and, when Jira is set up, `link_task`.

### Desktop app and terminal

The plugin works in both.
In the desktop app the panes open beside the chat; in the terminal they open as tabs on the right.
Linking a session to a task and the ↗ buttons need the desktop app, because they use its session list.

### Your language

Ask Claude in your language, for example "set up session companion in German".
Claude translates the pane text and the trigger phrases and writes them into your settings, so plugin updates keep them.

## Configuration

Settings come from two JSON files, applied over the defaults:

1. **Team file** (optional): settings a team shares, kept in a team repository.
2. **Personal file**: `~/.claude/session-companion/config.json`. Its `team` key points at the team file. Its values override the team file.

A list in your file replaces the default list as a whole, so copy the defaults you still want into it.

```json
{
  "team": "~/work/handbook/session-companion/team.json",
  "jira": { "login": "jdoe" },
  "worklog": { "cwdDefaults": { "acme-api": "ABC-101" } }
}
```

| Key | Default | Description |
| --- | --- | --- |
| `jira.url` | empty | Jira address. Empty turns Jira off. |
| `jira.login` | OS user | Jira login, also the Keychain account name. |
| `jira.timezone` | `local` | Time zone of your Jira profile, as `+02:00`. Set it when it differs from the machine's. A fixed offset does not follow daylight saving time. |
| `jira.myTasksJql` | open tasks assigned to you | JQL for the Tasks list. |
| `jira.projects` | any project | Project keys, as `["ABC", "OPS"]`. Only these count as task keys in prompts, branch names and session history. |
| `github.search` | all of GitHub | Added to every PR search, as `org:acme`. |
| `github.shortenRepos` | none | Prefixes removed from repository names: `acme-` shows `acme-api` as `api`. |
| `workday.hours` | `8` | Length of a full working day in hours. |
| `notes.threadUrls` | Slack permalinks | Regexes for links saved as chat threads. |
| `language.startWords` | English phrases | Regexes for phrases like "let's start on". A task key after one, in the same sentence, links the session. |
| `language.rememberWords` | English phrases | Regexes for phrases like "remember this". Claude saves a note. |
| `language.text` | none | Translations of the pane text. Claude fills it in when you ask for another language. |
| `worklog.guide` | none | Path to the team's worklog guide, a Markdown file. |
| `worklog.personalGuide` | `~/.claude/session-companion/worklog.md` | Path to your own worklog guide: your ops tasks and recurring meetings. |
| `worklog.cwdDefaults` | none | Maps part of a session's folder path to a task. The worklog uses it when neither the branch nor the chat names a task. |

An ops task is a catch-all Jira issue per product for support work and small fixes that have no issue of their own.

Examples of every file are in [`examples/`](examples/).

## Data and permissions

A plugin runs with your user rights. This one:

- **Runs**: `gh api graphql` for PRs, `python3 bin/jira.py` for Jira and settings, `date +%z` for the time zone, and `open` (`xdg-open` on Linux) when you click ↗.
- **Connects to**: GitHub through `gh`, and your `jira.url` through `bin/jira.py`. Nothing else.
- **Reads secrets**: the Jira token from `SESSION_COMPANION_JIRA_TOKEN` or the Keychain item `session-companion-jira`.
- **Writes files**: only under `~/.claude/session-companion/`.
- **Reads files**: session history in `~/.claude/projects/`, for the worklog only.
- **Uses the desktop app**: its `get_session` and `list_sessions` tools, to link sessions and show their titles.
- **Changes Jira**: the panes only read. The worklog adds worklogs and creates or edits ops tasks, each after you confirm.

What it stores:

- Notes in `~/.claude/session-companion/notes/<session>.json`, up to 200 per session.
- Jira responses in a SQLite cache, `~/.claude/session-companion/jira.sqlite3`. All open sessions share it, so they do not each query Jira on their own.
- The hash of a token Jira rejected over Basic auth. That token is not sent again until it changes, so failed logins do not lock your account.

## Development

```bash
claude --plugin-dir .                                # run a session with the plugin from this folder
claude plugin validate .                             # check the manifest and hooks
claude plugin test .                                 # TypeScript tests
python3 -m unittest discover -s tests -p 'test_*.py' # Python tests
```

`tsc -p .` needs the engine types in `.claude-plugin/types/`; `claude --plugin-dir .` writes them.

## License

[MIT](LICENSE)
