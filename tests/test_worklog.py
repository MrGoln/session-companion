import importlib.util
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "worklog" / "scripts" / "worklog.py"
spec = importlib.util.spec_from_file_location("worklog", SCRIPT)
assert spec and spec.loader
worklog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worklog)


class WorklogTest(unittest.TestCase):
    def test_jira_offsets_without_a_colon_are_read_on_every_python(self):
        found = worklog.parse_ts("2026-10-20T10:00:00.000+0200")
        self.assertEqual(found.utcoffset().total_seconds(), 7200)
        self.assertEqual(worklog.parse_ts("2026-10-20T08:00:00.000Z").hour, 8)

    def test_logged_time_is_subtracted_and_an_unreadable_entry_stops_the_run(self):
        tz = worklog.parse_ts("2026-10-20T00:00:00+0200").tzinfo
        lo, hi = datetime(2026, 10, 20, 9, tzinfo=tz), datetime(2026, 10, 20, 13, tzinfo=tz)
        with tempfile.TemporaryDirectory() as folder:
            good = Path(folder) / "good.json"
            good.write_text(json.dumps({"worklogs": [{"started": "2026-10-20T10:00:00.000+0200", "seconds": 7200}]}))
            cuts = worklog.load_logged([good], tz, lo, hi)
            self.assertEqual([(a.hour, b.hour) for a, b in cuts], [(10, 12)])

            bad = Path(folder) / "bad.json"
            bad.write_text(json.dumps({"worklogs": [{"started": "yesterday", "seconds": 60}]}))
            with self.assertRaises(SystemExit) as stop:
                worklog.load_logged([bad], tz, lo, hi)
            self.assertIn("count twice", str(stop.exception))


if __name__ == "__main__":
    unittest.main()
