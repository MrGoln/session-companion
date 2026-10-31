#!/usr/bin/env python3
"""Build a Jira worklog proposal for the current user.

Subcommands:
  mine  — take the day's time from Claude Code session transcripts
  fill  — lay out an explicit percentage split over a time window

Both print NON-OVERLAPPING worklog entries ready for ``bin/jira.py add-worklog``.
The script writes NOTHING to Jira. Settings (Jira's zone, project keys, cwdDefaults) come from
``bin/companion_config.py``: the team file and the person's own file.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "bin"))
import companion_config  # noqa: E402

PROJECTS_DIR = Path.home() / ".claude" / "projects"
JIRA_FMT = "%Y-%m-%dT%H:%M:%S.000%z"


def load_config():
    try:
        cfg = companion_config.load()
    except companion_config.ConfigError as err:
        sys.exit(f"session-companion config: {err}")
    return {
        "jira_tz": cfg["jira"]["timezone"],
        "projects": cfg["jira"]["projects"],
        "cwd_defaults": cfg["worklog"]["cwdDefaults"],
    }


def tz_arg(s):
    try:
        return companion_config.tz_of(s)
    except companion_config.ConfigError as err:
        raise argparse.ArgumentTypeError(str(err)) from None


def parse_ts(s):
    # Python before 3.11 reads an offset only with a colon, and Jira writes "+0200".
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s.replace("Z", "+00:00"))
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def hm(dt):
    return dt.strftime("%H:%M")


def dur(seconds):
    seconds = int(seconds)
    h, m = seconds // 3600, (seconds % 3600) // 60
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


# ---------------------------------------------------------------- transcripts


def iter_texts(rec):
    """Text of a transcript entry (tool_result skipped: it is noise)."""
    c = rec.get("content")
    if isinstance(c, str):
        yield c
    msg = rec.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                yield b.get("text", "")
            elif b.get("type") == "tool_use":
                yield json.dumps(b.get("input", {}), ensure_ascii=False)[:2000]


def mine_sessions(day_start, day_end, cfg, idle_gap, tail):
    """Sessions with their activity blocks and ticket candidates."""
    projects = "|".join(re.escape(p) for p in cfg["projects"]) or r"[A-Z][A-Z0-9]{1,9}"
    ticket_re = re.compile(r"\b(" + projects + r")-(\d{1,6})\b")
    sessions = {}
    for path in PROJECTS_DIR.glob("*/*.jsonl"):
        stamps, votes, cwd, branch, title = [], {}, None, None, None
        for line in path.open(errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            cwd = rec.get("cwd") or cwd
            branch = rec.get("gitBranch") or branch
            title = rec.get("customTitle") or rec.get("aiTitle") or title
            ts = parse_ts(rec.get("timestamp") or "")
            if ts is None:
                continue
            ts = ts.astimezone(day_start.tzinfo)
            if not (day_start <= ts <= day_end):
                continue
            stamps.append(ts)
            weight = 3 if rec.get("type") == "user" else 1
            for text in iter_texts(rec):
                for m in ticket_re.finditer(text or ""):
                    key = f"{m.group(1)}-{int(m.group(2))}"
                    votes[key] = votes.get(key, 0) + weight
        if not stamps:
            continue
        if branch:
            for m in ticket_re.finditer(branch.upper()):
                key = f"{m.group(1)}-{int(m.group(2))}"
                votes[key] = votes.get(key, 0) + 25
        stamps = sorted(t.replace(second=0, microsecond=0) for t in stamps)
        blocks, bs, prev = [], stamps[0], stamps[0]
        for ts in stamps[1:]:
            if (ts - prev).total_seconds() > idle_gap * 60:
                blocks.append((bs, prev + timedelta(minutes=tail)))
                bs = ts
            prev = ts
        blocks.append((bs, prev + timedelta(minutes=tail)))
        blocks = [(s, min(e, day_end)) for s, e in blocks if (min(e, day_end) - s).total_seconds() > 0]
        if not blocks:
            continue
        ticket, how = None, "none"
        if votes:
            ticket = max(votes.items(), key=lambda kv: (kv[1], kv[0]))[0]
            how = "branch" if branch and ticket.lower() in (branch or "").lower() else "mention"
        if ticket is None:
            for frag, default in cfg["cwd_defaults"].items():
                if frag and frag in (cwd or ""):
                    ticket, how = default, "cwd"
                    break
        sessions[path.stem] = {
            "id": path.stem,
            "cwd": cwd,
            "branch": branch,
            "title": title,
            "ticket": ticket,
            "how": how,
            "votes": dict(sorted(votes.items(), key=lambda kv: -kv[1])[:6]),
            "blocks": blocks,
            "active_seconds": sum((e - s).total_seconds() for s, e in blocks),
        }
    return sorted(sessions.values(), key=lambda s: s["blocks"][0][0])


# ------------------------------------------------------------------ intervals


def merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def subtract(base, cuts):
    out = []
    for s, e in base:
        pieces = [(s, e)]
        for cs, ce in cuts:
            nxt = []
            for ps, pe in pieces:
                if ce <= ps or cs >= pe:
                    nxt.append((ps, pe))
                    continue
                if cs > ps:
                    nxt.append((ps, cs))
                if ce < pe:
                    nxt.append((ce, pe))
            pieces = nxt
        out.extend(p for p in pieces if (p[1] - p[0]).total_seconds() > 0)
    return sorted(out)


def load_logged(paths, tz, lo, hi):
    """Already logged time from ``bin/jira.py my-worklogs`` output: my entries only, those inside [lo, hi] count."""
    cuts = []
    for path in paths:
        for w in json.loads(Path(path).read_text()).get("worklogs", []):
            started = parse_ts(str(w.get("started", "")))
            if not started:
                sys.exit(f"{path}: cannot read started={w.get('started')!r}; the logged time would count twice")
            if not w.get("seconds"):
                continue
            a = started.astimezone(tz)
            b = a + timedelta(seconds=int(w["seconds"]))
            if b <= lo or a >= hi:
                continue
            cuts.append((a, b))
    return merge(cuts)


# ------------------------------------------------------------- allocation


def parse_split(spec):
    """'ABC-31:40,ABC-34:60' -> [(key, share)]"""
    raw = []
    for part in spec.split(","):
        t, _, pct = part.partition(":")
        raw.append((t.strip().upper(), float(pct)))
    tot = sum(v for _, v in raw) or 1
    return [(t, v / tot) for t, v in raw]


def allocate(total_seconds, shares, step_min):
    """shares: [(ticket, fraction)] -> [(ticket, seconds)], sum <= total."""
    step = step_min * 60
    budget = int(total_seconds // step)
    if budget <= 0:
        return []
    raw = [(t, f * budget) for t, f in shares]
    alloc = [[t, int(v)] for t, v in raw]
    left = budget - sum(a[1] for a in alloc)
    for i in sorted(range(len(raw)), key=lambda i: -(raw[i][1] - int(raw[i][1])))[: max(left, 0)]:
        alloc[i][1] += 1
    return [(t, n * step) for t, n in alloc if n > 0]


def lay_out(free, alloc):
    """Lay allocated seconds over free intervals in order, without overlaps."""
    out, fi = [], 0
    cur = free[0][0] if free else None
    for ticket, secs in alloc:
        while secs > 0 and fi < len(free):
            s, e = free[fi]
            if cur is None or cur < s:
                cur = s
            avail = (e - cur).total_seconds()
            if avail <= 0:
                fi += 1
                cur = free[fi][0] if fi < len(free) else None
                continue
            take = min(avail, secs)
            out.append({"issue": ticket, "start": cur, "seconds": int(take)})
            cur += timedelta(seconds=take)
            secs -= take
            if (e - cur).total_seconds() <= 0:
                fi += 1
                cur = free[fi][0] if fi < len(free) else None
    return out


def tidy(entries, min_minutes):
    """Merge adjacent entries of one ticket and absorb scraps shorter than min_minutes."""

    def contiguous(a, b):
        return a["start"] + timedelta(seconds=a["seconds"]) == b["start"]

    out = []
    for e in entries:
        if out and out[-1]["issue"] == e["issue"] and contiguous(out[-1], e):
            out[-1]["seconds"] += e["seconds"]
        else:
            out.append(dict(e))
    changed = True
    while changed and len(out) > 1:
        changed = False
        for i, e in enumerate(out):
            if e["seconds"] >= min_minutes * 60:
                continue
            if i > 0 and contiguous(out[i - 1], e):
                out[i - 1]["seconds"] += e["seconds"]
            elif i + 1 < len(out) and contiguous(e, out[i + 1]):
                out[i + 1]["start"] = e["start"]
                out[i + 1]["seconds"] += e["seconds"]
            else:
                continue
            out.pop(i)
            changed = True
            break
    return out


# ------------------------------------------------------------------- output


def report(title, free, entries, sessions, tz, warnings):
    print(f"\n{title}")
    print(f"time zone: {datetime.now(tz).strftime('%z')} (times as Jira shows them)\n")
    if sessions:
        print("Sessions:")
        for s in sessions:
            span = ", ".join(f"{hm(a)}–{hm(b)}" for a, b in s["blocks"])
            name = (s["title"] or Path(s["cwd"] or "?").name)[:44]
            print(
                f"  {s['ticket'] or '— NO ISSUE':<12} {dur(s['active_seconds']):>7}  {span:<28} {name}  [{s['how']}]"
            )
            if s["how"] in ("mention", "none") and len(s["votes"]) > 1:
                print(f"               candidates: {', '.join(f'{k}×{v}' for k, v in s['votes'].items())}")
        print()
    total_free = sum((e - s).total_seconds() for s, e in free)
    print(f"Free time (activity minus what is already logged): {dur(total_free)}")
    print("  " + ", ".join(f"{hm(s)}–{hm(e)}" for s, e in free) + "\n")
    if not entries:
        print("Nothing to log.\n")
        return
    print("Proposal (nothing sent):")
    by_ticket = {}
    for e in entries:
        end = e["start"] + timedelta(seconds=e["seconds"])
        print(
            f"  {e['issue']:<12} {dur(e['seconds']):>7}  {hm(e['start'])}–{hm(end)}   started={e['start'].strftime(JIRA_FMT)}"
        )
        by_ticket[e["issue"]] = by_ticket.get(e["issue"], 0) + e["seconds"]
    total = sum(by_ticket.values())
    print(f"\nTotal {dur(total)}: " + ", ".join(f"{k} {dur(v)} ({v * 100 // total}%)" for k, v in by_ticket.items()))
    for w in warnings:
        print(f"\n!! {w}")
    print(
        "\nConfirm and I log it with jira.py add-worklog. A worklog can be deleted or edited only by hand in Jira.\n"
    )


def emit_json(entries, sessions, free):
    print(
        json.dumps(
            {
                "free": [[s.isoformat(), e.isoformat()] for s, e in free],
                "sessions": [
                    dict(s, blocks=[[a.isoformat(), b.isoformat()] for a, b in s["blocks"]]) for s in sessions
                ],
                "proposal": [
                    {"issue": e["issue"], "time_spent": dur(e["seconds"]), "started": e["start"].strftime(JIRA_FMT)}
                    for e in entries
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


# -------------------------------------------------------------------- CLI


def window(args, tz):
    day = datetime.strptime(args.date, "%Y-%m-%d").date() if args.date else datetime.now(tz).date()

    def at(spec, default):
        if not spec:
            return datetime.combine(day, datetime.min.time(), tz) + default
        if spec == "now":
            return datetime.now(tz).replace(second=0, microsecond=0)
        h, m = spec.split(":")
        return datetime.combine(day, datetime.min.time(), tz) + timedelta(hours=int(h), minutes=int(m))

    return at(args.start, timedelta(hours=0)), at(args.end, timedelta(hours=23, minutes=59))


def main():
    cfg = load_config()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("mine", "fill"):
        sp = sub.add_parser(name)
        sp.add_argument("--date", help="YYYY-MM-DD, today by default")
        sp.add_argument("--start", help="HH:MM, the window's start")
        sp.add_argument("--end", help="HH:MM or now")
        sp.add_argument("--tz", default=cfg["jira_tz"], help="zone of the window and the output (jira.timezone by default)")
        sp.add_argument(
            "--exclude-logged",
            metavar="FILE",
            nargs="+",
            default=[],
            help="JSON from jira.py my-worklogs: subtract what is already logged",
        )
        sp.add_argument("--step", type=int, default=5, help="rounding, minutes (5 by default)")
        sp.add_argument(
            "--min-entry",
            type=int,
            default=10,
            help="shortest entry, minutes: shorter scraps join a neighbour",
        )
        sp.add_argument("--json", action="store_true")
    m = sub.choices["mine"]
    m.add_argument("--idle-gap", type=int, default=20, help="a pause that ends a block of work, minutes")
    m.add_argument("--tail", type=int, default=3, help="added after a block's last event, minutes")
    m.add_argument(
        "--split",
        help="set the shares by hand (ABC-31:40,ABC-34:60): windows come "
        "from session activity, the sessions' own issues are ignored",
    )
    m.add_argument(
        "--map",
        action="append",
        default=[],
        metavar="SUBSTRING=KEY",
        help="override a session's issue: a substring of its title, id or folder = issue key "
        "(repeatable; =SKIP drops the session)",
    )
    f = sub.choices["fill"]
    f.add_argument("--split", required=True, help="ABC-31:30,ABC-36:70")

    args = p.parse_args()
    tz = tz_arg(args.tz)
    w_start, w_end = window(args, tz)
    warnings = []
    cuts = load_logged(args.exclude_logged, tz, w_start, w_end) if args.exclude_logged else []

    if args.cmd == "mine":
        sessions = mine_sessions(w_start, w_end, cfg, args.idle_gap, args.tail)
        for rule in args.map:
            needle, _, ticket = rule.rpartition("=")
            hay_hits = [
                s
                for s in sessions
                if needle.lower() in ((s["title"] or "") + " " + s["id"] + " " + (s["cwd"] or "")).lower()
            ]
            if not hay_hits:
                warnings.append(f"--map {rule}: no session matched")
            for s_ in hay_hits:
                s_["ticket"] = None if ticket.upper() == "SKIP" else ticket.upper()
                s_["how"] = "manual"
        known = [s for s in sessions if s["ticket"]]
        active = merge([b for s in known for b in s["blocks"]])
        free = subtract(active, cuts)
        unknown_secs = sum(s["active_seconds"] for s in sessions if not s["ticket"])
        if unknown_secs:
            names = ", ".join((s["title"] or "?")[:30] for s in sessions if not s["ticket"])
            warnings.append(f"{dur(unknown_secs)} of activity with no issue is NOT in the proposal: {names}")
        # Split each free interval only between tickets worked on inside it,
        # otherwise morning time leaks into the evening window.
        entries = []
        forced = parse_split(args.split) if getattr(args, "split", None) else None
        if forced:
            total_free = sum((e - s).total_seconds() for s, e in free)
            entries = lay_out(free, allocate(total_free, forced, args.step))
            free_iter = []
        else:
            free_iter = free
        for span in free_iter:
            weight, first = {}, {}
            for sess in known:
                overlap = sum(
                    max(0.0, (min(b[1], span[1]) - max(b[0], span[0])).total_seconds()) for b in sess["blocks"]
                )
                if overlap <= 0:
                    continue
                t = sess["ticket"]
                weight[t] = weight.get(t, 0) + overlap
                starts = [max(b[0], span[0]) for b in sess["blocks"] if b[1] > span[0] and b[0] < span[1]]
                first[t] = min(first.get(t, starts[0]), starts[0])
            if not weight:
                continue
            total_w = sum(weight.values())
            order = sorted(weight, key=lambda t: (first[t], t))
            shares = [(t, weight[t] / total_w) for t in order]
            entries += lay_out([span], allocate((span[1] - span[0]).total_seconds(), shares, args.step))
        title = f"Activity on {w_start:%Y-%m-%d} {hm(w_start)}–{hm(w_end)} from session transcripts"
    else:
        shares = parse_split(args.split)
        free = subtract([(w_start, w_end)], cuts)
        sessions = []
        total_free = sum((e - s).total_seconds() for s, e in free)
        entries = lay_out(free, allocate(total_free, shares, args.step))
        title = f"Window {w_start:%Y-%m-%d} {hm(w_start)}–{hm(w_end)}, split {args.split}"

    entries = tidy(entries, args.min_entry)
    if args.json:
        emit_json(entries, sessions, free)
    else:
        report(title, free, entries, sessions, tz, warnings)


if __name__ == "__main__":
    sys.exit(main())
