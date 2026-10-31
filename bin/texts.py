#!/usr/bin/env python3
"""The panes' English texts, the keys of ``language.text``, with the translation the settings give each.

``{name}`` in a text is a value the pane fills in; a translation keeps the same names.
Prints JSON ``{"<English>": "<translation or empty>"}``; ``--missing`` keeps only the untranslated ones.
Translations of texts the panes no longer have are named on stderr.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
import companion_config  # noqa: E402

CALL = re.compile(r"""\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1""")


def texts() -> list[str]:
    found = set()
    for path in sorted((ROOT / "hooks").glob("*.ts*")):
        for m in CALL.finditer(path.read_text()):
            found.add(m.group(2).replace("\\" + m.group(1), m.group(1)))
    return sorted(found)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--missing", action="store_true")
    args = parser.parse_args()
    try:
        own = companion_config.load()["language"]["text"]
    except companion_config.ConfigError as err:
        sys.exit(f"session-companion config: {err}")
    known = texts()
    out = {text: own.get(text, "") for text in known if not (args.missing and own.get(text))}
    unused = sorted(set(own) - set(known))
    if unused:
        print(f"translations of texts the panes no longer have: {json.dumps(unused, ensure_ascii=False)}", file=sys.stderr)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
