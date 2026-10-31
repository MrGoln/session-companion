# Team worklog guide

Shared by the whole team, next to `team.json`; the `worklog` skill reads it before every proposal.

## Shared tasks

The whole team logs here, whoever the assignee is:

| Issue | What goes there |
| --- | --- |
| OPS-1 | Team rituals: planning, retro, daily |
| OPS-2 | Interviews and onboarding |

## Required fields on new issues

Jira refuses a new issue in these projects without them:

```json
{ "customfield_12345": { "value": "Platform" } }
```

## Ops tasks

One ops task per product and person, named `Ops: <Product>`, a Task in the product's epic.
Scope: support of existing processes and small bug fixes; features and sizeable work go to separate issues.
Recipe: check that none exists (`project = OPS AND summary ~ "Ops:"`), then create it with the required fields above, the assignee being the person.

## Routing

| Topic | Log to |
| --- | --- |
| Reviewing other people's PRs | the product's ops task |
| CI and build infrastructure | OPS-3 |
