import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date, datetime
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
spec = importlib.util.spec_from_file_location("companion_config", BIN / "companion_config.py")
assert spec and spec.loader
config = importlib.util.module_from_spec(spec)
sys.modules["companion_config"] = config
spec.loader.exec_module(config)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)

    def write(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body))
        return path

    def test_no_file_gives_the_defaults_with_jira_off(self):
        cfg = config.load(self.root / "missing.json")
        self.assertEqual(cfg["jira"]["url"], "")
        self.assertEqual(cfg["github"]["search"], "")
        self.assertEqual(cfg["workday"]["hours"], 8)

    def test_the_team_file_fills_in_and_the_personal_file_wins(self):
        self.write("team/team.json", {
            "jira": {"url": "https://jira.example.com/", "timezone": "+02:00"},
            "github": {"search": "org:acme"},
            "worklog": {"guide": "team-worklog.md"},
        })
        own = self.write("me/config.json", {"team": "../team/team.json", "jira": {"login": "jdoe"}, "github": {"search": "org:other"}})

        cfg = config.load(own)

        self.assertEqual(cfg["jira"]["url"], "https://jira.example.com")
        self.assertEqual(cfg["jira"]["login"], "jdoe")
        self.assertEqual(cfg["jira"]["timezone"], "+02:00")
        self.assertEqual(cfg["github"]["search"], "org:other")
        self.assertEqual(cfg["worklog"]["guide"], str((self.root / "team" / "team-worklog.md").resolve()))

    def test_a_missing_team_file_is_an_error_not_silence(self):
        own = self.write("config.json", {"team": "nowhere.json"})
        with self.assertRaisesRegex(config.ConfigError, "no such file"):
            config.load(own)

    def test_a_bad_zone_or_regex_is_named(self):
        with self.assertRaisesRegex(config.ConfigError, "jira.timezone"):
            config.load(self.write("a.json", {"jira": {"timezone": "Europe/Berlin"}}))
        with self.assertRaisesRegex(config.ConfigError, "notes.threadUrls"):
            config.load(self.write("b.json", {"notes": {"threadUrls": ["("]}}))

    def test_a_value_of_the_wrong_type_is_named(self):
        cases = [
            ({"github": {"shortenRepos": "acme-"}}, "github.shortenRepos must be a list of strings"),
            ({"notes": {"threadUrls": "^https://x"}}, "notes.threadUrls must be a list of strings"),
            ({"jira": None}, "jira must be a JSON object"),
            ({"workday": {"hours": "8"}}, "workday.hours must be a number"),
            ({"workday": {"hours": 0}}, "workday.hours must be above zero"),
            ({"worklog": {"cwdDefaults": {"api": 1}}}, "worklog.cwdDefaults must map strings to strings"),
        ]
        for i, (body, message) in enumerate(cases):
            with self.subTest(body=body), self.assertRaisesRegex(config.ConfigError, message):
                config.load(self.write(f"{i}.json", body))

    def test_jira_url_must_be_https_so_the_token_is_not_sent_in_clear(self):
        with self.assertRaisesRegex(config.ConfigError, "must start with https://"):
            config.load(self.write("a.json", {"jira": {"url": "http://jira.example.com"}}))
        local = config.load(self.write("b.json", {"jira": {"url": "http://localhost:8080/"}}))
        self.assertEqual(local["jira"]["url"], "http://localhost:8080")

    def test_local_zone_takes_each_dates_own_offset_across_dst(self):
        saved = os.environ.get("TZ")
        os.environ["TZ"] = "Europe/Berlin"
        time.tzset()
        try:
            zone = config.tz_of("local")
            summer = datetime.combine(date(2026, 10, 20), datetime.min.time(), zone)
            winter = datetime.combine(date(2026, 11, 20), datetime.min.time(), zone)
            self.assertEqual((summer.strftime("%z"), winter.strftime("%z")), ("+0200", "+0100"))
            self.assertEqual(datetime.fromisoformat("2026-11-20T09:00:00+00:00").astimezone(zone).hour, 10)
        finally:
            if saved is None:
                os.environ.pop("TZ")
            else:
                os.environ["TZ"] = saved
            time.tzset()

    def test_offsets(self):
        self.assertEqual(config.offset_minutes("+02:00"), 120)
        self.assertEqual(config.offset_minutes("-0330"), -210)


if __name__ == "__main__":
    unittest.main()
