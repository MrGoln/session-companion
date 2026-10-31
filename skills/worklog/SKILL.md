---
name: worklog
description: >-
  MUST USE when asked to log, fill in or submit a Jira worklog, track time, close
  the day, find untracked time up to now, or pick or create an ops (support) task
  to log time to: "log my time", "fill in today's worklog", "close the day", "how
  much did I work today", in any language. Builds the day from Claude Code session
  transcripts and the calendar, logs only after the user confirms, the current
  user's own time only.
---

# Worklog

Two scenarios: **log time for a day** and **pick or create an ops task**.

Jira goes through `${CLAUDE_SKILL_DIR}/../../bin/jira.py`: Jira's REST API with the user's token, JSON on stdout.
Jira API pitfalls are in `${CLAUDE_SKILL_DIR}/reference.md`; read it before creating or editing issues.
Exit code 3 or "refused the token" means the token is missing or refused, exit code 4 means Jira is not set up: give the user the fix the script printed and stop.

## Settings and guides

Read these first, every time:

1. The settings file, `~/.claude/session-companion/config.json` (or `$SESSION_COMPANION_CONFIG`), and the team file its `team` names; the guides' paths are under `worklog`.
2. The team guide, `worklog.guide`: shared buckets the whole team logs to, fields Jira requires on new issues, how ops buckets are named, routing rules.
3. The personal guide, `worklog.personalGuide` (`~/.claude/session-companion/worklog.md` by default): the user's own ops buckets, recurring meetings, board.

A path in the team file is relative to the team file.
If a guide is missing, say so and offer to create it from `${CLAUDE_SKILL_DIR}/../../examples/`; ask the user for the values instead of guessing.
What a guide says wins over the defaults below; when the two guides disagree, the personal guide wins for the user's own buckets and the team guide for shared ones.

## Hard rules

1. **Never log time without explicit confirmation.** Show the table, wait for "yes".
   `jira.py` cannot delete or edit a worklog, so a mistake has to be fixed by hand in Jira's Work Log tab.
2. **Time zone.** Jira's day is `jira.timezone` from the settings (`local` by default); the machine has its own zone (`date +%z`).
   The user reads time the way Jira shows it, and `worklog.py` works in that zone by default; do not convert anything by hand.
   `started` format for the API: `2026-09-15T18:15:00.000+0200` (no colon in the offset).
3. **Only your own issues.** Log only where the assignee is the current user.
   Before submitting, check every key in the proposal with `jira.py search` by assignee; replace someone else's issue with the matching ops bucket from the guides.
   The exception is the **shared buckets** in the team guide, where the whole team logs.
   The assignee field cannot tell a shared issue apart; if unsure, ask instead of moving the time to ops.
   **Closed issues are off-limits too**: if `resolutiondate` is older than a day, the time goes to ops.
   **Epics are off-limits too**: fetch `issuetype` in the same query and drop every `Epic`, Jira rejects them with "no permission to associate a worklog".
4. **Do not invent time.** If activity is not tied to an issue, say so and ask instead of spreading it over neighbouring issues.
5. **Include meetings.** They are not in transcripts.
   If a calendar tool is connected, read the day's events from it; where recurring meetings go is in the personal guide, team rituals go to the shared buckets.
   If no calendar can be read, **say so before logging and ask for meeting times** instead of laying out the day without them.
6. **Cover the window without gaps.** The user asks for a day "from X to Y" and expects no holes in it.
   Fill an empty gap with the issue worked on right before it; if the gap had activity, use that.
   For every gap not covered by transcripts, say explicitly what you filled it with.
7. **Ops time goes to the bucket of the product the work was for.** Which buckets exist and which topic goes where is in the guides.
   If a topic fits no bucket, ask instead of guessing.

## Scenario A: log time for a day

### 1. Find what is already logged

```bash
python3 "${CLAUDE_SKILL_DIR}/../../bin/jira.py" my-worklogs --since <YYYY-MM-DD> > <scratchpad>/logged.json
```

The file holds only your own entries from that day on, by issue; pass it to `--exclude-logged` below instead of reading it.

### 2. Build the proposal

From Claude Code session transcripts (what was actually done and when):

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/worklog.py" mine \
  --start 10:00 --end now --min-entry 1 \
  --exclude-logged <scratchpad>/logged.json
```

Or with an explicit split when the user gave the proportions ("30% ABC-31, 70% ABC-36"):

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/worklog.py" fill \
  --start 10:00 --end now --split ABC-31:30,ABC-36:70 \
  --exclude-logged <scratchpad>/logged.json
```

What `mine` does: merges session events into activity blocks (a pause over 20 min breaks a block), resolves the issue from the git branch, then mentions in the session, then `worklog.cwdDefaults`, merges overlapping sessions, subtracts logged time and lays out the rest **sequentially, without overlaps and without filling pauses**.
Issue keys are those of `jira.projects` when it is set, any `KEY-123` otherwise.

Each free window is split **only between the issues worked on in that window**, so morning time does not leak into the evening.

Fix wrong attribution with `--map`, not in your head:

```bash
--map "flaky test=ABC-36" --map "draft=SKIP"
```

The substring is matched against the session title, its id and `cwd`; `=SKIP` drops the session entirely.

Useful flags: `--date` (another day), `--idle-gap`, `--min-entry` (entries shorter than N minutes stick to a neighbour), `--step` (rounding, 5 min by default), `--json`.

**Always pass `--min-entry 1`.** Without it a long background session takes the whole window and small 5–20 minute tasks drop to zero and vanish from the proposal.

### 3. Check by eye and by assignee

Required before logging:

```bash
python3 "${CLAUDE_SKILL_DIR}/../../bin/jira.py" search "key in (<all proposal keys>)" --fields assignee,issuetype,status,resolutiondate
```

Move to an ops bucket everything whose assignee is not the current user (shared buckets aside) and everything closed more than a day ago.
A key mentioned in chat does not make the issue yours: it is often someone else's ticket you only consulted on.

- Sessions marked `[mention]` with a list of candidates have uncertain attribution; check the session title against the issue.
- A line `!! ... with no issue is NOT in the proposal` means that time is missing.
  Offer options: a specific issue, the product's ops bucket, or skip.
- Sanity-check the total: more than ~9 hours a day is almost certainly a mistake.

### 4. Show and log

The script output is ready to show: show the table and ask whether to log it.
After "yes", run for each row, taking `started` from the `started` column as is:

```bash
python3 "${CLAUDE_SKILL_DIR}/../../bin/jira.py" add-worklog <KEY> --started <started> --time-spent "<1h 30m>"
```

Each call prints the new entry's `id`; report them.

## Scenario B: ops tasks

Ops means **support of existing processes and small bug fixes**.
Anything that amounts to a feature or a sizeable piece of work is a separate issue, not ops.

- **Where to log time**: your bucket for the product the work was for, from the guides.
- **No bucket for the product**: offer to create one by the team guide's recipe, with the fields it says Jira requires.
  Find a field's id with `jira.py fields --match <name>`.
  After creating it, add the bucket to the personal guide, and if the product has its own repository, to `worklog.cwdDefaults` in the settings file.
