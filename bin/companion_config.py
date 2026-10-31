"""The plugin's settings: built-in defaults, then a team file, then the person's own file over both.

The person's file is ``$SESSION_COMPANION_CONFIG``, else ``~/.claude/session-companion/config.json``.
Its ``team`` names a team file (a path, ``~`` allowed) that a team keeps in a shared repository;
paths inside the team file are relative to it. Objects merge key by key; any other value replaces.
"""

from __future__ import annotations

import copy
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any

HOME_DIR = Path.home() / ".claude" / "session-companion"


def config_path() -> Path:
    return Path(os.environ.get("SESSION_COMPANION_CONFIG") or HOME_DIR / "config.json")


DEFAULTS: dict[str, Any] = {
    "team": "",
    "jira": {
        # Empty: Jira is off, the pane shows GitHub alone.
        "url": "",
        # Empty: the OS user.
        "login": "",
        # The zone Jira stamps worklogs in, "+02:00" or "local"; the day boundaries follow it.
        "timezone": "local",
        "myTasksJql": "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
        # Project keys the worklog skill looks for in transcripts; empty matches any KEY-123.
        "projects": [],
    },
    "github": {
        # Added to every PR search: "org:acme", "user:me", or empty for all of GitHub.
        "search": "",
        # Repository name prefixes cut in narrow rows: "acme-" turns "acme-api" into "api".
        "shortenRepos": [],
    },
    "workday": {"hours": 8},
    "notes": {
        # Regexes for chat permalinks (Slack, Mattermost, ...) saved as threads, not plain links.
        "threadUrls": [r"^https://[^/]+\.slack\.com/archives/[^/]+/p\d+"],
    },
    "language": {
        # JavaScript regexes (flags i and u) for "let's start on ABC-12": the key after one links the session.
        "startWords": [
            r"start(?:ing|ed)?(?:\s+work(?:ing)?)?\s+on",
            r"let'?s\s+(?:work\s+on|do|take)",
            r"pick(?:ing)?\s+up",
            r"tak(?:e|ing)\s+on",
            r"work(?:ing)?\s+on",
        ],
        # JavaScript regexes for "remember this": Claude is told to save a note.
        "rememberWords": [
            r"remember\s+(?:this|that)",
            r"note\s+(?:this|that|it)\s+down",
            r"(?:save|add)\s+(?:(?:this|that|it)\s+)?(?:to|in)\s+(?:the\s+|my\s+)?notes",
        ],
        # The panes' English text -> the user's own; bin/texts.py lists every text.
        "text": {},
    },
    "worklog": {
        # The team's worklog guide (shared buckets, required fields, routing), a Markdown file.
        "guide": "",
        # The person's own guide: ops buckets, meetings, board.
        "personalGuide": str(HOME_DIR / "worklog.md"),
        # The last resort for a session with no issue key: a part of its folder path -> KEY.
        "cwdDefaults": {},
    },
}


class ConfigError(Exception):
    pass


def merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in over.items():
        if key.startswith("_"):
            continue
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        raise ConfigError(f"no such file: {path}") from None
    except json.JSONDecodeError as err:
        raise ConfigError(f"{path} is not valid JSON: {err}") from None
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must hold a JSON object")
    return data


def resolve(path: str, base: Path) -> str:
    if not path:
        return ""
    p = Path(path).expanduser()
    return str(p if p.is_absolute() else (base / p).resolve())


def load(path: Path | None = None) -> dict:
    path = path or config_path()
    own = read_json(path) if path.exists() else {}
    cfg = DEFAULTS
    team_path = resolve(str(own.get("team") or ""), path.parent)
    if team_path:
        team = read_json(Path(team_path))
        team.pop("team", None)
        worklog = team.get("worklog")
        if isinstance(worklog, dict) and isinstance(worklog.get("guide"), str):
            worklog["guide"] = resolve(worklog["guide"], Path(team_path).parent)
        cfg = merge(cfg, team)
    cfg = merge(cfg, own)
    check_shape(cfg, DEFAULTS)
    cfg["team"] = team_path
    cfg["jira"]["url"] = cfg["jira"]["url"].rstrip("/")
    if cfg["jira"]["url"] and not re.match(r"https://|http://(localhost|127\.0\.0\.1)[:/]", cfg["jira"]["url"] + "/"):
        raise ConfigError(f"jira.url: {cfg['jira']['url']!r} must start with https://, or the token goes in clear text")
    if cfg["workday"]["hours"] <= 0:
        raise ConfigError("workday.hours must be above zero")
    for key in ("guide", "personalGuide"):
        cfg["worklog"][key] = resolve(str(cfg["worklog"][key] or ""), path.parent)
    tz_of(cfg["jira"]["timezone"])
    for pattern in cfg["notes"]["threadUrls"]:
        try:
            re.compile(pattern)
        except re.error as err:
            raise ConfigError(f"notes.threadUrls: {pattern!r} is not a valid regex: {err}") from None
    return cfg


def check_shape(cfg: dict, defaults: dict, where: str = "") -> None:
    """Every setting must have its default's type: a string where a list is due would be read letter by letter."""
    for key, default in defaults.items():
        value, name = cfg.get(key), where + key
        if isinstance(default, dict):
            if not isinstance(value, dict):
                raise ConfigError(f"{name} must be a JSON object")
            if default:
                check_shape(value, default, name + ".")
            elif not all(isinstance(v, str) for v in value.values()):
                raise ConfigError(f"{name} must map strings to strings")
        elif isinstance(default, list):
            if not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                raise ConfigError(f"{name} must be a list of strings")
        elif isinstance(default, str):
            if not isinstance(value, str):
                raise ConfigError(f"{name} must be a string")
        elif isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"{name} must be a number")


class LocalZone(tzinfo):
    """The machine's zone with the offset of each moment, so a date past a DST switch gets its own offset."""

    @staticmethod
    def _offset(stamp: float) -> timedelta:
        return timedelta(seconds=time.localtime(stamp).tm_gmtoff)

    def utcoffset(self, dt: datetime | None) -> timedelta:
        if dt is None:
            return self._offset(time.time())
        return self._offset(time.mktime((*dt.timetuple()[:8], -1)))

    def dst(self, dt: datetime | None) -> timedelta:
        return timedelta(0)

    def tzname(self, dt: datetime | None) -> str:
        return time.strftime("%Z")

    def fromutc(self, dt: datetime) -> datetime:
        stamp = dt.replace(tzinfo=timezone.utc).timestamp()
        return (dt + self._offset(stamp)).replace(tzinfo=self)


def tz_of(spec: str) -> tzinfo:
    spec = (spec or "").strip()
    if spec in ("", "local"):
        return LocalZone()
    m = re.fullmatch(r"([+-])(\d{2}):?(\d{2})", spec)
    if not m:
        raise ConfigError(f"jira.timezone: {spec!r} is neither local nor an offset like +02:00")
    sign = 1 if m.group(1) == "+" else -1
    return timezone(sign * timedelta(hours=int(m.group(2)), minutes=int(m.group(3))))


def offset_minutes(spec: str) -> int:
    offset = datetime.now(tz_of(spec)).utcoffset() or timedelta()
    return int(offset.total_seconds() // 60)
