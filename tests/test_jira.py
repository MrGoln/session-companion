import base64
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from email.message import Message
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "bin" / "jira.py"
CONFIG_DIR = tempfile.TemporaryDirectory()
CONFIG_FILE = Path(CONFIG_DIR.name) / "config.json"
CONFIG_FILE.write_text(json.dumps({"jira": {"url": "https://jira.example.com/", "login": "jdoe"}}))
os.environ["SESSION_COMPANION_CONFIG"] = str(CONFIG_FILE)
os.environ.pop("SESSION_COMPANION_JIRA_TOKEN", None)
spec = importlib.util.spec_from_file_location("jira", SCRIPT)
assert spec and spec.loader
jira = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jira)

ME = {"key": "JDoe", "name": "jdoe", "displayName": "Jane Doe"}


def keychain(code=0, secret="pat-token"):
    return mock.patch.object(
        jira.subprocess,
        "run",
        return_value=subprocess.CompletedProcess([], code, stdout=secret + "\n", stderr=""),
    )


def headers(user="jdoe"):
    found = Message()
    found["X-AUSERNAME"] = user
    return found


def http_error(code, user="jdoe"):
    return urllib.error.HTTPError(jira.BASE, code, "x", headers(user), io.BytesIO(b"denied"))


class Answer(io.BytesIO):
    def __init__(self, body, user="jdoe"):
        super().__init__(json.dumps(body).encode())
        self.headers = headers(user)


def entry(key, started, seconds):
    return {"id": started, "author": {"key": key}, "started": started, "timeSpentSeconds": seconds}


class FakeJira:
    """Answers by path and JQL, and records every request."""

    def __init__(self, bucket_updated="2026-10-20T10:00:00.000+0200"):
        self.sent = []
        self.bucket_updated = bucket_updated

    def __call__(self, request, **_):
        url = urllib.parse.urlsplit(request.full_url)
        query = dict(urllib.parse.parse_qsl(url.query))
        self.sent.append((request.get_method(), url.path, query.get("jql", ""), request.get_header("Authorization")))
        if url.path == "/rest/api/2/myself":
            body = ME
        elif url.path == "/rest/api/2/search" and "worklogAuthor" in query["jql"]:
            small = {
                "total": 2,
                "worklogs": [
                    entry("JDoe", "2026-10-20T10:00:00.000+0200", 3600),
                    entry("other", "2026-10-20T10:00:00.000+0200", 600),
                ],
            }
            # A shared bucket: search embeds only its first entries.
            big = {"total": 30, "worklogs": [entry("other", "2026-01-01T10:00:00.000+0200", 60)] * 20}
            body = {
                "issues": [
                    {"key": "ABC-1", "fields": {"updated": "x", "worklog": small}},
                    {"key": "OPS-1", "fields": {"updated": self.bucket_updated, "worklog": big}},
                ]
            }
        elif url.path == "/rest/api/2/search" and "BAD-1" in query["jql"]:
            raise urllib.error.HTTPError(jira.BASE, 400, "x", headers(), io.BytesIO(b"no such issue"))
        elif url.path == "/rest/api/2/search" and query["jql"].startswith("key in"):
            body = {
                "issues": [
                    {
                        "key": "ABC-70",
                        "fields": {
                            "summary": "Linked",
                            "status": {"name": "Paused", "statusCategory": {"key": "new"}},
                        },
                    }
                ]
            }
        elif url.path == "/rest/api/2/search":
            body = {
                "issues": [
                    {
                        "key": "ABC-82",
                        "fields": {
                            "summary": "Rocket",
                            "status": {"name": "Review", "statusCategory": {"key": "indeterminate"}},
                        },
                    }
                ]
            }
        elif url.path == "/rest/api/2/issue/OPS-1/worklog":
            body = {
                "total": 3,
                "worklogs": [
                    entry("JDoe", "2026-10-21T11:00:00.000+0200", 1800),
                    entry("JDoe", "2026-10-12T11:00:00.000+0200", 900),
                    entry("other", "2026-10-21T11:00:00.000+0200", 600),
                ],
            }
        elif url.path == "/rest/api/2/field":
            body = [{"id": "summary", "name": "Summary"}, {"id": "customfield_10002", "name": "Epic Link"}]
        elif url.path == "/rest/api/2/issue/ABC-1/worklog" and request.get_method() == "POST":
            body = {"id": "77", "started": "2026-10-22T10:00:00.000+0200", "timeSpentSeconds": 1800}
        else:
            raise AssertionError(f"unexpected {request.get_method()} {url.path}")
        return Answer(body)

    def paths(self):
        return [path for _, path, _, _ in self.sent]


class JiraTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        for name, value in (
            ("CACHE", Path(folder.name) / "jira.sqlite3"),
            ("REFUSED", Path(folder.name) / "refused.json"),
        ):
            patch = mock.patch.object(jira, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def run_script(self, argv, fake=None, secret="pat-token"):
        out, err = io.StringIO(), io.StringIO()
        with (
            keychain(secret=secret),
            mock.patch.object(jira.urllib.request, "urlopen", side_effect=fake),
            mock.patch.object(sys, "argv", ["jira.py", *argv]),
            redirect_stdout(out),
            redirect_stderr(err),
        ):
            try:
                jira.main()
                code = 0
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue(), err.getvalue()

    def test_a_refused_token_is_sent_once_and_not_again_until_it_changes(self):
        sent = []

        def refuse(request, **_):
            sent.append(request.get_header("Authorization"))
            raise http_error(401)

        code, _, err = self.run_script(["snapshot", "--since", "2026-10-19"], refuse)
        self.assertEqual(code, 1)
        self.assertEqual(sent, ["Basic " + base64.b64encode(f"{jira.USER}:pat-token".encode()).decode()])
        self.assertIn("Jira refused the token", err)
        self.assertNotIn("pat-token", err)

        # A refused Basic login counts as a failed password: the same token is not sent again, even forced.
        code, _, err = self.run_script(["snapshot", "--since", "2026-10-19", "--force"], refuse)
        self.assertEqual((code, len(sent)), (1, 1))
        self.assertIn("not sent again", err)

        code, _, _ = self.run_script(["snapshot", "--since", "2026-10-19"], FakeJira(), secret="new-token")
        self.assertEqual(code, 0)

    def test_the_refused_token_file_is_private_salted_and_survives_corruption(self):
        self.run_script(["myself"], lambda request, **_: (_ for _ in ()).throw(http_error(401)))
        self.assertEqual(jira.REFUSED.stat().st_mode & 0o777, 0o600)
        self.run_script(["snapshot", "--since", "2026-10-19"], FakeJira(), secret="new-token")
        self.assertEqual(jira.CACHE.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(jira.hashlib.sha256(b"pat-token").hexdigest(), jira.REFUSED.read_text())

        jira.REFUSED.write_text("{broken")
        code, _, _ = self.run_script(["myself"], FakeJira())
        self.assertEqual(code, 0)

    def test_the_token_does_not_follow_a_redirect(self):
        seen = []

        def answer(request, **_):
            seen.append(request)
            return Answer(ME)

        self.run_script(["myself"], answer)
        self.assertTrue(seen[0].has_header("Authorization"))
        self.assertNotIn("Authorization", seen[0].headers)

    def test_an_issue_key_is_checked_before_it_goes_into_a_path(self):
        code, _, err = self.run_script(["add-worklog", "../../user", "--started", "x", "--time-spent", "1m"], FakeJira())
        self.assertEqual(code, 2)
        self.assertIn("not an issue key", err)

    def test_a_refused_bearer_token_is_not_blocked(self):
        pat = base64.b64encode(b"123456789012:" + bytes(range(20))).decode()
        sent = []

        def refuse(request, **_):
            sent.append(request.get_header("Authorization"))
            raise http_error(401)

        self.run_script(["myself"], refuse, secret=pat)
        code, _, err = self.run_script(["myself"], refuse, secret=pat)

        # Only a refused Basic login counts as a failed password.
        self.assertEqual((code, len(sent)), (1, 2))
        self.assertNotIn("not sent again", err)

    def test_a_refusal_stops_the_worklog_reads_still_queued(self):
        long_log = {"total": 30, "worklogs": [entry("other", "2026-01-01T10:00:00.000+0200", 60)] * 20}
        read = []

        def refuse_worklogs(request, **_):
            path = urllib.parse.urlsplit(request.full_url).path
            if path == "/rest/api/2/myself":
                return Answer(ME)
            if path == "/rest/api/2/search":
                issues = [{"key": f"OPS-{n}", "fields": {"updated": "x", "worklog": long_log}} for n in range(8)]
                return Answer({"issues": issues})
            read.append(path)
            raise http_error(401)

        code, _, err = self.run_script(["my-worklogs", "--since", "2026-10-19"], refuse_worklogs)

        self.assertEqual(code, 1)
        self.assertIn("Jira refused the token", err)
        # Four workers may each send one request before the first refusal lands; the rest are not sent.
        self.assertLessEqual(len(read), 4)

    def test_fields_finds_a_custom_field_by_part_of_its_name(self):
        code, out, _ = self.run_script(["fields", "--match", "epic"], FakeJira())

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"fields": [{"id": "customfield_10002", "name": "Epic Link"}]})

    def test_settings_come_from_the_config_file(self):
        self.assertEqual((jira.BASE, jira.USER), ("https://jira.example.com", "jdoe"))

    def test_the_token_from_the_environment_skips_the_keychain(self):
        fake = FakeJira()
        with mock.patch.dict(jira.os.environ, {"SESSION_COMPANION_JIRA_TOKEN": "env-token"}):
            code, _, _ = self.run_script(["myself"], fake, secret="keychain-token")
        self.assertEqual(code, 0)
        self.assertEqual(fake.sent[0][3], "Basic " + base64.b64encode(b"jdoe:env-token").decode())

    def test_without_a_jira_url_jira_commands_exit_4_and_config_still_answers(self):
        with mock.patch.object(jira, "BASE", ""):
            code, _, err = self.run_script(["myself"], FakeJira())
            self.assertEqual(code, jira.NOT_CONFIGURED)
            self.assertIn("set jira.url", err)
            code, out, _ = self.run_script(["config"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["jira"]["url"], "")

    def test_a_data_center_personal_access_token_goes_as_bearer(self):
        pat = base64.b64encode(b"123456789012:" + bytes(range(20))).decode()
        fake = FakeJira()
        self.run_script(["myself"], fake, secret=pat)

        self.assertEqual(fake.sent[0][3], "Bearer " + pat)

    def test_an_unknown_token_answered_as_anonymous_is_refused_not_an_empty_list(self):
        code, out, err = self.run_script(
            ["snapshot", "--since", "2026-10-19"], lambda request, **_: Answer({"issues": []}, user="anonymous")
        )

        self.assertEqual((code, out), (1, ""))
        self.assertIn("Jira refused the token", err)

    def test_a_400_for_an_anonymous_search_is_refused(self):
        def anonymous(request, **_):
            raise http_error(400, user="anonymous")

        code, _, err = self.run_script(["search", "project = ABC"], anonymous)

        self.assertEqual(code, 1)
        self.assertIn("Jira refused the token", err)

    def test_no_token_exits_3_without_calling_jira(self):
        out, err = io.StringIO(), io.StringIO()
        with (
            keychain(code=44),
            mock.patch.object(jira.urllib.request, "urlopen") as urlopen,
            mock.patch.object(sys, "argv", ["jira.py", "snapshot", "--since", "2026-10-19"]),
            redirect_stdout(out),
            redirect_stderr(err),
            self.assertRaises(SystemExit) as exit,
        ):
            jira.main()

        self.assertEqual(exit.exception.code, jira.NO_TOKEN)
        urlopen.assert_not_called()
        self.assertIn("no Jira token in the Keychain", err.getvalue())

    def test_snapshot_sums_my_hours_and_maps_task_categories(self):
        fake = FakeJira()
        code, out, _ = self.run_script(["snapshot", "--since", "2026-10-19", "--linked", "ABC-70"], fake)

        self.assertEqual(code, 0)
        body = json.loads(out)
        # ABC-1 from the embedded entries, OPS-1 read whole; other people's and older entries left out.
        self.assertEqual(body["days"], {"2026-10-20": 3600, "2026-10-21": 1800})
        self.assertEqual(
            [(i["key"], i["category"]) for i in body["issues"]],
            [("ABC-82", "progress"), ("ABC-70", "todo")],
        )
        self.assertEqual(fake.paths().count("/rest/api/2/issue/ABC-1/worklog"), 0)

    def test_a_fresh_snapshot_is_served_from_the_cache_without_jira(self):
        first = FakeJira()
        self.run_script(["snapshot", "--since", "2026-10-19"], first)
        again = FakeJira()
        code, out, _ = self.run_script(["snapshot", "--since", "2026-10-19"], again)

        self.assertEqual(code, 0)
        self.assertEqual(again.sent, [])
        self.assertEqual(json.loads(out)["days"]["2026-10-21"], 1800)

    def test_force_refetches_but_an_unchanged_long_worklog_is_not_read_again(self):
        self.run_script(["snapshot", "--since", "2026-10-19"], FakeJira())
        forced = FakeJira()
        code, out, _ = self.run_script(["snapshot", "--since", "2026-10-19", "--force"], forced)

        self.assertEqual(code, 0)
        self.assertNotIn("/rest/api/2/myself", forced.paths())
        self.assertNotIn("/rest/api/2/issue/OPS-1/worklog", forced.paths())
        self.assertEqual(json.loads(out)["days"], {"2026-10-20": 3600, "2026-10-21": 1800})

        changed = FakeJira(bucket_updated="2026-10-22T09:00:00.000+0200")
        self.run_script(["snapshot", "--since", "2026-10-19", "--force"], changed)
        self.assertIn("/rest/api/2/issue/OPS-1/worklog", changed.paths())

    def test_an_unknown_linked_key_drops_only_itself(self):
        code, out, _ = self.run_script(["snapshot", "--since", "2026-10-19", "--linked", "BAD-1,ABC-70"], FakeJira())

        self.assertEqual(code, 0)
        self.assertEqual([i["key"] for i in json.loads(out)["issues"]], ["ABC-82", "ABC-70"])

    def test_a_snapshot_fetched_across_a_worklog_write_is_not_served_as_fresh(self):
        class WriteMidFetch(FakeJira):
            def __call__(self, request, **_):
                if "worklogAuthor" in urllib.parse.unquote_plus(request.full_url):
                    jira.forget_snapshot()
                return super().__call__(request)

        self.run_script(["snapshot", "--since", "2026-10-19"], WriteMidFetch())
        after = FakeJira()
        self.run_script(["snapshot", "--since", "2026-10-19"], after)

        self.assertIn("/rest/api/2/search", after.paths())

    def test_a_new_linked_task_makes_the_cache_stale(self):
        self.run_script(["snapshot", "--since", "2026-10-19"], FakeJira())
        linked = FakeJira()
        self.run_script(["snapshot", "--since", "2026-10-19", "--linked", "ABC-70"], linked)

        self.assertIn("/rest/api/2/search", linked.paths())

    def test_my_worklogs_lists_only_my_entries_by_issue(self):
        code, out, _ = self.run_script(["my-worklogs", "--since", "2026-10-19"], FakeJira())

        self.assertEqual(code, 0)
        self.assertEqual(
            sorted((w["issue"], w["started"][:10], w["seconds"]) for w in json.loads(out)["worklogs"]),
            [("ABC-1", "2026-10-20", 3600), ("OPS-1", "2026-10-21", 1800)],
        )

    def test_add_worklog_posts_once_and_drops_the_cached_snapshot(self):
        self.run_script(["snapshot", "--since", "2026-10-19"], FakeJira())
        write = FakeJira()
        code, out, _ = self.run_script(
            ["add-worklog", "ABC-1", "--started", "2026-10-22T10:00:00.000+0200", "--time-spent", "30m"], write
        )

        self.assertEqual(code, 0)
        self.assertEqual([(m, p) for m, p, _, _ in write.sent], [("POST", "/rest/api/2/issue/ABC-1/worklog")])
        self.assertEqual(
            json.loads(out), {"id": "77", "issue": "ABC-1", "started": "2026-10-22T10:00:00.000+0200", "seconds": 1800}
        )
        after = FakeJira()
        self.run_script(["snapshot", "--since", "2026-10-19"], after)
        self.assertIn("/rest/api/2/search", after.paths())


if __name__ == "__main__":
    unittest.main()
