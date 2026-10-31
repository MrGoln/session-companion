---
name: setup
description: >-
  Use when the user wants to set up, connect or change session-companion: turn on
  Jira, point the PR list at an organization, join a team's shared settings, store
  the Jira token, switch the panes and trigger phrases to their language, or share
  their settings with the team: "set up session companion", "connect my Jira", "the
  work pane says Jira is off", "show the panes in Spanish", in any language.
---

# Set up session-companion

Settings live in two JSON files, merged key by key over the built-in defaults:

- **team file**: what a team shares (Jira url and zone, PR search, chat thread patterns, the worklog guide), kept in a repository the team already has;
- **personal file**: `~/.claude/session-companion/config.json` (or `$SESSION_COMPANION_CONFIG`), its `team` naming the team file; its values win.

Every key and its meaning: `${CLAUDE_SKILL_DIR}/../../examples/config.example.json` and `team.example.json`, defaults in `${CLAUDE_SKILL_DIR}/../../bin/companion_config.py`.

## Steps

1. Read the personal file if it exists, and the team file it names; show the user what is set.
2. Ask whether the team already shares a team file.
   If it does, ask for its path in their checkout and set `team` to it; take nothing from it into the personal file.
3. Ask only for what is still missing, one question at a time, with the default named:
   - Jira url (Server / Data Center), empty to keep Jira off;
   - Jira login, the OS user by default;
   - the zone Jira stamps worklogs in, when the team's Jira day differs from the machine's (`+02:00`), `local` by default;
   - the PR search scope (`org:acme`), all of GitHub by default;
   - chat permalink patterns to save as threads (Slack ones are known already).
4. Write the personal file; never write a token into it.
5. Store the token, by the user's own hand, since it is a secret: give them the command and let them run it.
   - macOS: `security add-generic-password -U -s session-companion-jira -a <login> -w` (it asks for the token).
   - Elsewhere: export `SESSION_COMPANION_JIRA_TOKEN` in the shell profile.
   A personal access token (Jira 8.14 and newer) works as is; on an older Jira Server use the password, which goes with the login.
6. Check: `python3 "${CLAUDE_SKILL_DIR}/../../bin/jira.py" myself` prints the Jira user; then ask the user to press ↻ Refresh in the "My work" pane.
   `gh auth status` must show a signed-in account for the PR list.

## Language

The user writes to you in a language other than English, or asks for one: offer to switch the panes to it, and on their yes:

1. Run `python3 "${CLAUDE_SKILL_DIR}/../../bin/texts.py" --missing`: every pane text not yet translated, as JSON.
2. Translate each value into `language.text`, keyed by the English text as is.
   Keep `{name}` placeholders and leading marks such as `▸`, `▾`, `↻`, `✓` exactly; keep labels short, the panes are narrow.
3. Write `language.startWords` and `language.rememberWords`: JavaScript regexes (flags `i` and `u`) for "let's start on / let's work on / I'm taking" and "remember this / note this down / save to notes" in that language.
   Cover the inflected forms with `\p{L}*` after a stem; keep the English defaults from `bin/companion_config.py` in the list, since a list replaces the default.
4. Write the three keys into the personal file, or into the team file when the team shares a language; a plugin update does not touch either.
5. Check: `texts.py --missing` prints `{}`; ask the user to press ↻ Refresh in the work pane, which reads the settings again and redraws both panes and the buttons above the prompt.
   Pane titles change once a pane is closed and opened again; slash command descriptions and the `link_task` tool text, in the next session.
   A text the stderr line names as no longer used can be dropped.

## Sharing with the team

When the user wants their settings shared, move the team-wide keys (`jira.url`, `jira.timezone`, `jira.myTasksJql`, `jira.projects`, `github`, `workday`, `notes`, `language`, `worklog.guide`) into a `team.json` in a repository the team has, next to a `team-worklog.md` started from `examples/team-worklog.example.md`.
Leave personal keys (`jira.login`, `worklog.personalGuide`, `worklog.cwdDefaults`) in the personal file and point its `team` at the new file.
Committing and pushing that repository is the user's call: show the diff and ask first.
