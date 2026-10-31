import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
import companion_config  # noqa: E402


class TextsTest(unittest.TestCase):
    def run_texts(self, settings, *argv):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            path.write_text(json.dumps(settings))
            env = {**os.environ, "SESSION_COMPANION_CONFIG": str(path)}
            done = subprocess.run([sys.executable, ROOT / "bin" / "texts.py", *argv], env=env, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout), done.stderr

    def test_every_pane_text_is_listed_with_its_translation(self):
        out, err = self.run_texts({"language": {"text": {"Tasks": "Aufgaben", "Gone": "Weg"}}})
        self.assertEqual(out["Tasks"], "Aufgaben")
        for text in ("My work", "Session notes", 'Nothing matches "{q}".', "Drafts", "For you", "Links"):
            self.assertEqual(out[text], "")
        self.assertIn('"Gone"', err)

        missing, _ = self.run_texts({"language": {"text": {"Tasks": "Aufgaben"}}}, "--missing")
        self.assertNotIn("Tasks", missing)

    def test_t_takes_only_literal_text_so_the_list_is_complete(self):
        for path in (ROOT / "hooks").glob("*.ts*"):
            calls = re.findall(r"(?<!function )\bt\((?!\s*['\"])", path.read_text())
            self.assertEqual(calls, [], path.name)

    def test_the_panes_fallback_triggers_are_the_defaults(self):
        source = (ROOT / "hooks" / "config.ts").read_text()
        for key in ("startWords", "rememberWords"):
            for word in companion_config.DEFAULTS["language"][key]:
                self.assertIn(word.replace("\\", "\\\\"), source, key)


if __name__ == "__main__":
    unittest.main()
