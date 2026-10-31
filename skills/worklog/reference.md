# Jira API pitfalls

Access goes through this plugin's `bin/jira.py`: Jira Server / Data Center REST API v2 with the user's token.
Team specifics (shared tasks, required fields, ops task recipe) live in the team guide, the user's own in the personal guide; this file holds what holds for any Jira.

## Writing issues

- Fields for `create-issue` and `update-issue` go in a JSON file as `{"fields": {...}}`.
- The description is Jira wiki markup, not Markdown: `h2.` for a heading, `*bold*`, `#` for a numbered item, `*` for a bullet, `{code}...{code}` for code.
- A custom field is set by its id, not its name: find it with `jira.py fields --match <part of the name>`.
- A select field takes `{"value": "<option>"}`, a user field `{"name": "<login>"}`, an epic link the epic's key as a string.
- A field missing from the project's create or edit screen fails with "not on the appropriate screen": set it by hand in Jira.

## Sprints

- An issue cannot be taken out of a sprint through the API: the sprint field set to `null` is silently ignored, `[]` or `""` fails with "expected a number".
  Drag it to the backlog on the board by hand.

## Worklogs

- A worklog cannot be deleted or edited through `jira.py`, only added; fix a mistake by hand in the Work Log tab.
- An epic takes no worklog: Jira answers "no permission to associate a worklog".
- `started` carries the offset without a colon: `2026-09-15T18:15:00.000+0200`.

## Useful JQL

- Your open work: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- Current and next sprints: `project = ABC AND (sprint in openSprints() OR sprint in futureSprints())`.
- Your time logged today: `worklogAuthor = currentUser() AND worklogDate >= startOfDay()`.
- Existing ops tasks: `project = ABC AND summary ~ "ops"` (use the naming from the team guide).
