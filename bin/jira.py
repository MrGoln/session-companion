#!/usr/bin/env python3
"""Jira Server / Data Center over its REST API with the person's token, for the pane and the worklog skill.

Settings come from ``companion_config``: ``jira.url``, ``jira.login`` (empty: the OS user), ``jira.myTasksJql``.
The token is ``$SESSION_COMPANION_JIRA_TOKEN``, else the macOS Keychain entry (service
``session-companion-jira``, account = the login); macOS asks once which programs may read it.
An API token goes as Basic ``login:token``; a Data Center personal access token (base64 of
``<id>:<secret>``) goes as Bearer. A refused Basic login counts as a failed password, and a few of
those lock the account behind a CAPTCHA, so a token refused over Basic is not sent again until it changes.

The pane's data lives in a SQLite cache (``$SESSION_COMPANION_CACHE``, else
``~/.claude/session-companion/jira.sqlite3``) shared by every session: ``snapshot`` answers from it
while it is fresh, and one process at a time refreshes it under a file lock, so all open sessions
together ask Jira once per ``--max-age``.

Commands, each printing JSON:
  config                                                            the settings the pane needs
  snapshot --since DATE [--linked KEYS] [--max-age SEC] [--force]   tasks in work and my hours per day
  myself                                                            the user the token signs in as
  search JQL [--fields F] [--limit N]                               issues, as Jira returns them
  worklog KEY [--since DATE]                                        my worklog entries on an issue
  my-worklogs --since DATE                                          my worklog entries on every issue
  add-worklog KEY --started TS --time-spent T [--comment C]         log time; the only worklog write
  fields [--match TEXT]                                             field ids and names, for create-issue
  create-issue --fields FILE                                        a new issue from a JSON ``fields`` object
  update-issue KEY --fields FILE                                    set the fields of an issue

Exit codes: 0 done, 3 no token, 4 Jira is not configured, 1 any other failure.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent))
import companion_config  # noqa: E402

KEYCHAIN_SERVICE = "session-companion-jira"
TOKEN_ENV = "SESSION_COMPANION_JIRA_TOKEN"
NO_TOKEN = 3
NOT_CONFIGURED = 4
CACHE = Path(os.environ.get("SESSION_COMPANION_CACHE") or companion_config.HOME_DIR / "jira.sqlite3")
REFUSED = CACHE.with_name("refused-tokens.json")
ISSUE_KEY = re.compile(r"[A-Z][A-Z0-9]{1,9}-\d+")


def fail(message: str, code: int = 1) -> NoReturn:
    print(message, file=sys.stderr)
    sys.exit(code)


try:
    CONFIG = companion_config.load()
except companion_config.ConfigError as err:
    fail(f"session-companion config: {err}")

BASE = CONFIG["jira"]["url"]
USER = CONFIG["jira"]["login"] or getpass.getuser()
SET_TOKEN = f"security add-generic-password -U -s {KEYCHAIN_SERVICE} -a {USER} -w"
REFUSED_MESSAGE = (
    f"Jira refused the token for {USER}: it expired, was revoked or is the wrong one; "
    f"create a new one in your Jira profile and store it: {SET_TOKEN}"
)
CATEGORIES = {"indeterminate": "progress", "done": "done"}


class JiraError(Exception):
    pass


def issue_key(value: str) -> str:
    if not ISSUE_KEY.fullmatch(value):
        raise argparse.ArgumentTypeError(f"{value!r} is not an issue key like ABC-123")
    return value


def private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def read_refused() -> dict:
    try:
        known = json.loads(REFUSED.read_text())
    except (FileNotFoundError, ValueError):
        return {}
    return known if isinstance(known, dict) else {}


def token() -> str:
    if os.environ.get(TOKEN_ENV):
        return os.environ[TOKEN_ENV].strip()
    try:
        found = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", USER, "-w"],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        fail(f"no Jira token: set ${TOKEN_ENV}", NO_TOKEN)
    if found.returncode != 0:
        fail(f"no Jira token in the Keychain: {SET_TOKEN} (or set ${TOKEN_ENV})", NO_TOKEN)
    return found.stdout.rstrip()


def auth_header(token: str) -> str:
    try:
        is_pat = re.match(rb"^\d+:", base64.b64decode(token, validate=True)) is not None
    except ValueError:
        is_pat = False
    if is_pat:
        return "Bearer " + token
    return "Basic " + base64.b64encode(f"{USER}:{token}".encode()).decode()


class Jira:
    def __init__(self) -> None:
        if not BASE:
            fail("Jira is off: set jira.url in ~/.claude/session-companion/config.json", NOT_CONFIGURED)
        secret = token()
        # Slow and salted: under Basic the token is often the password itself.
        self.token_sha = hashlib.pbkdf2_hmac("sha256", secret.encode(), f"{USER}@{BASE}".encode(), 100_000).hex()
        if read_refused().get(USER) == self.token_sha:
            fail(
                f"{REFUSED_MESSAGE}. This token is not sent again, so Jira does not lock the account; "
                f"if it is right after all, delete {REFUSED}"
            )
        self.auth = auth_header(secret)
        # Set on the first refusal: requests still queued in a thread pool then stop without sending the token.
        self.stopped = threading.Event()

    def call(self, method: str, path: str, body: Any = None) -> Any:
        if self.stopped.is_set():
            fail(REFUSED_MESSAGE)
        data = None if body is None else json.dumps(body).encode()
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        request = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        # Unredirected: urllib would carry a plain header to whatever host a redirect names.
        request.add_unredirected_header("Authorization", self.auth)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                # A token Jira does not know makes the request anonymous: search then answers 200 or 400, not 401.
                if response.headers.get("X-AUSERNAME") == "anonymous":
                    self.refused()
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            if err.code == 401 or err.headers.get("X-AUSERNAME") == "anonymous":
                self.refused()
            raise JiraError(
                f"Jira {err.code} on {method} {path.split('?')[0]}: {err.read().decode(errors='replace')[:300]}"
            ) from None
        except urllib.error.URLError as err:
            raise JiraError(f"Jira is unreachable: {err.reason}") from None

    def refused(self) -> NoReturn:
        self.stopped.set()
        # A refused Bearer token does not count as a failed login; only Basic leads to the CAPTCHA.
        if self.auth.startswith("Basic "):
            private_dir(REFUSED.parent)
            part = REFUSED.with_name(f"{REFUSED.name}.{os.getpid()}.{threading.get_ident()}")
            part.write_text(json.dumps({**read_refused(), USER: self.token_sha}))
            part.chmod(0o600)
            part.replace(REFUSED)
        fail(REFUSED_MESSAGE)

    def get(self, path: str, **query: Any) -> Any:
        return self.call("GET", path + ("?" + urllib.parse.urlencode(query) if query else ""))

    def search(self, jql: str, fields: str, limit: int) -> list[dict]:
        return self.get("/rest/api/2/search", jql=jql, fields=fields, maxResults=limit).get("issues", [])

    def worklogs(self, key: str) -> list[dict]:
        found: list[dict] = []
        while True:
            page = self.get(f"/rest/api/2/issue/{key}/worklog", startAt=len(found), maxResults=1000)
            found += page.get("worklogs", [])
            if not page.get("worklogs") or len(found) >= int(page.get("total", 0)):
                return found


def mine(entries: list[dict], me: str, since: str) -> list[dict]:
    return [
        {"id": w.get("id"), "started": w["started"], "seconds": int(w.get("timeSpentSeconds", 0))}
        for w in entries
        if w.get("author", {}).get("key") == me and str(w.get("started", ""))[:10] >= since
    ]


@contextlib.contextmanager
def cache() -> Generator[sqlite3.Connection, None, None]:
    private_dir(CACHE.parent)
    db = sqlite3.connect(CACHE, timeout=120)
    CACHE.chmod(0o600)
    try:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS me (login TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshot (
                login TEXT PRIMARY KEY, fetched_at REAL NOT NULL, since TEXT NOT NULL, linked TEXT NOT NULL, body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS invalidated (login TEXT PRIMARY KEY, at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS worklog (
                login TEXT NOT NULL, issue TEXT NOT NULL, updated TEXT NOT NULL, entries TEXT NOT NULL,
                PRIMARY KEY (login, issue)
            );
            """
        )
        with db:
            yield db
    finally:
        db.close()


def myself(jira: Jira, db: sqlite3.Connection) -> dict:
    row = db.execute("SELECT body FROM me WHERE login = ?", (USER,)).fetchone()
    if row:
        return json.loads(row[0])
    me = jira.get("/rest/api/2/myself")
    me = {"key": me["key"], "name": me.get("name"), "displayName": me.get("displayName")}
    db.execute("INSERT OR REPLACE INTO me VALUES (?, ?)", (USER, json.dumps(me)))
    # Committed at once: an open write transaction would block other sessions through the requests that follow.
    db.commit()
    return me


def fresh(db: sqlite3.Connection, since: str, linked: str, newer_than: float) -> dict | None:
    row = db.execute(
        "SELECT s.fetched_at, s.since, s.linked, s.body, coalesce(i.at, 0) FROM snapshot s "
        "LEFT JOIN invalidated i ON i.login = s.login WHERE s.login = ?",
        (USER,),
    ).fetchone()
    if row and row[1] == since and row[2] == linked and row[0] > max(newer_than, row[4]):
        return json.loads(row[3])
    return None


def my_entries(jira: Jira, db: sqlite3.Connection, since: str) -> dict[str, list[dict]]:
    me = myself(jira, db)["key"]
    # Search embeds up to 20 worklog entries per issue; a longer worklog is read whole, once per change of the issue.
    logged = jira.search(f'worklogAuthor = currentUser() AND worklogDate >= "{since}"', "worklog,updated", 200)
    entries: dict[str, list[dict]] = {}
    to_read: list[dict] = []
    for issue in logged:
        embedded = issue["fields"].get("worklog") or {}
        cached = db.execute(
            "SELECT updated, entries FROM worklog WHERE login = ? AND issue = ?", (USER, issue["key"])
        ).fetchone()
        if len(embedded.get("worklogs", [])) >= int(embedded.get("total", 0)):
            entries[issue["key"]] = mine(embedded.get("worklogs", []), me, since)
        elif cached and cached[0] == issue["fields"]["updated"]:
            entries[issue["key"]] = [e for e in json.loads(cached[1]) if e["started"][:10] >= since]
        else:
            to_read.append(issue)
    with ThreadPoolExecutor(max_workers=4) as pool:
        whole = list(pool.map(lambda issue: jira.worklogs(issue["key"]), to_read))
    for issue, log in zip(to_read, whole):
        all_mine = mine(log, me, "")
        entries[issue["key"]] = [e for e in all_mine if e["started"][:10] >= since]
        db.execute(
            "INSERT OR REPLACE INTO worklog VALUES (?, ?, ?, ?)",
            (USER, issue["key"], issue["fields"]["updated"], json.dumps(all_mine)),
        )
    return entries


def linked_tasks(jira: Jira, keys: list[str]) -> list[dict]:
    # A key Jira does not know (a typo saved as a session link) fails the whole `key in` search: it alone is left out.
    jql = "key in ({}) AND statusCategory != Done"
    try:
        return jira.search(jql.format(", ".join(keys)), "summary,status", len(keys))
    except JiraError:
        found: list[dict] = []
        for key in keys:
            with contextlib.suppress(JiraError):
                found += jira.search(jql.format(key), "summary,status", 1)
        return found


def fetch(jira: Jira, db: sqlite3.Connection, since: str, linked: list[str]) -> dict:
    tasks = jira.search(CONFIG["jira"]["myTasksJql"], "summary,status", 50)
    extra = [key for key in linked if key not in {t["key"] for t in tasks}]
    if extra:
        tasks += linked_tasks(jira, extra)

    days: dict[str, int] = {}
    for entry in (e for found in my_entries(jira, db, since).values() for e in found):
        days[entry["started"][:10]] = days.get(entry["started"][:10], 0) + entry["seconds"]
    return {
        "issues": [
            {
                "key": t["key"],
                "summary": t["fields"]["summary"],
                "status": t["fields"]["status"]["name"],
                "category": CATEGORIES.get(t["fields"]["status"].get("statusCategory", {}).get("key"), "todo"),
            }
            for t in tasks
        ],
        "days": days,
    }


def snapshot(args: argparse.Namespace) -> dict:
    linked = ",".join(sorted({k.strip() for k in args.linked.split(",") if ISSUE_KEY.fullmatch(k.strip())}))
    asked_at = time.time()
    newer_than = asked_at if args.force else asked_at - args.max_age
    with cache() as db:
        if found := fresh(db, args.since, linked, newer_than):
            return found
    with open(CACHE.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with cache() as db:
            # Another session may have refreshed while this one waited for the lock.
            if found := fresh(db, args.since, linked, newer_than):
                return found
            # Stamped with the start: a write or a forced refresh after it must not take this answer as fresh.
            started = time.time()
            body = {**fetch(Jira(), db, args.since, [k for k in linked.split(",") if k]), "fetchedAt": started}
            db.execute(
                "INSERT OR REPLACE INTO snapshot VALUES (?, ?, ?, ?, ?)",
                (USER, started, args.since, linked, json.dumps(body)),
            )
            return body


def forget_snapshot() -> None:
    try:
        with cache() as db:
            db.execute("INSERT OR REPLACE INTO invalidated VALUES (?, ?)", (USER, time.time()))
    except sqlite3.Error as err:
        # The write in Jira is done; a failure here must not make the caller retry it.
        print(f"the pane's cache was not reset: {err}", file=sys.stderr)


def read_fields(path: str) -> dict:
    fields = json.loads(Path(path).read_text())
    return fields.get("fields", fields)


def pane_config() -> dict:
    return {
        "jira": {
            "url": BASE,
            "login": USER,
            "offsetMinutes": companion_config.offset_minutes(CONFIG["jira"]["timezone"]),
            "projects": CONFIG["jira"]["projects"],
        },
        "github": CONFIG["github"],
        "workday": CONFIG["workday"],
        "notes": CONFIG["notes"],
        "language": CONFIG["language"],
    }


def run(args: argparse.Namespace) -> None:
    if args.command == "config":
        result: Any = pane_config()
    elif args.command == "snapshot":
        result = snapshot(args)
    elif args.command == "myself":
        with cache() as db:
            result = myself(Jira(), db)
    elif args.command == "search":
        result = {"issues": Jira().search(args.jql, args.fields, args.limit)}
    elif args.command == "worklog":
        jira = Jira()
        with cache() as db:
            me = myself(jira, db)["key"]
        result = {"worklogs": mine(jira.worklogs(args.key), me, args.since)}
    elif args.command == "my-worklogs":
        with cache() as db:
            found = my_entries(Jira(), db, args.since)
        result = {"worklogs": [{"issue": key, **e} for key, entries in found.items() for e in entries]}
    elif args.command == "add-worklog":
        body = {"started": args.started, "timeSpent": args.time_spent}
        if args.comment:
            body["comment"] = args.comment
        made = Jira().call("POST", f"/rest/api/2/issue/{args.key}/worklog", body)
        result = {
            "id": made.get("id"),
            "issue": args.key,
            "started": made.get("started"),
            "seconds": made.get("timeSpentSeconds"),
        }
    elif args.command == "fields":
        found = Jira().get("/rest/api/2/field")
        match = args.match.lower()
        result = {
            "fields": [
                {"id": f["id"], "name": f["name"]}
                for f in found
                if match in f["name"].lower() or match in f["id"].lower()
            ]
        }
    elif args.command == "create-issue":
        made = Jira().call("POST", "/rest/api/2/issue", {"fields": read_fields(args.fields)})
        result = {"key": made.get("key"), "url": f"{BASE}/browse/{made.get('key')}"}
    else:
        Jira().call("PUT", f"/rest/api/2/issue/{args.key}", {"fields": read_fields(args.fields)})
        result = {"key": args.key, "updated": True}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if args.command in ("add-worklog", "update-issue"):
        forget_snapshot()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("config")
    p = sub.add_parser("snapshot")
    p.add_argument("--since", required=True)
    p.add_argument("--linked", default="")
    p.add_argument("--max-age", type=float, default=600)
    p.add_argument("--force", action="store_true")
    sub.add_parser("myself")
    p = sub.add_parser("search")
    p.add_argument("jql")
    p.add_argument("--fields", default="summary,status,assignee,issuetype,resolutiondate")
    p.add_argument("--limit", type=int, default=50)
    p = sub.add_parser("worklog")
    p.add_argument("key", type=issue_key)
    p.add_argument("--since", default="")
    p = sub.add_parser("my-worklogs")
    p.add_argument("--since", required=True)
    p = sub.add_parser("add-worklog")
    p.add_argument("key", type=issue_key)
    p.add_argument("--started", required=True, help="2026-09-15T18:15:00.000+0200")
    p.add_argument("--time-spent", required=True, help="1h 30m")
    p.add_argument("--comment", default="")
    p = sub.add_parser("fields")
    p.add_argument("--match", default="")
    p = sub.add_parser("create-issue")
    p.add_argument("--fields", required=True)
    p = sub.add_parser("update-issue")
    p.add_argument("key", type=issue_key)
    p.add_argument("--fields", required=True)
    try:
        run(parser.parse_args())
    except JiraError as err:
        fail(str(err))


if __name__ == "__main__":
    main()
