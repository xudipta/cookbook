#!/usr/bin/env python3
"""Add a "Play it" banner to every note page of a topic that has a game (site build only).

Reads docs/games/games.json. For each entry, every Markdown page under its `notes` folder in the
assembled docs tree (site-src/) gets an admonition right after its first heading: a link to the game
when it is live, or a pointer to its issue when it is queued. A page that already links to the live
game (the topic README keeps its own pointer so GitHub readers see it too) is left alone.

Usage: python3 scripts/play_banners.py site-src
"""

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ISSUES = "https://github.com/xudipta/cookbook/issues/"


def banner(game: dict, page: Path, root: Path) -> list[str]:
    if game["status"] == "live":
        target = os.path.relpath(root / "docs" / "games" / game["id"] / "index.md", page.parent)
        return [
            '!!! tip "Play it"',
            f"    [{game['title']}]({Path(target).as_posix()}): {game['blurb']}",
        ]
    return [
        '!!! note "Game coming"',
        f"    A game for this topic is planned: [issue #{game['issue']}]({ISSUES}{game['issue']}).",
    ]


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else "site-src").resolve()
    games = json.loads((REPO_ROOT / "docs" / "games" / "games.json").read_text(encoding="utf-8"))["games"]
    added = 0
    for game in games:
        folder = root / game["notes"]
        for page in sorted(folder.rglob("*.md")):
            text = page.read_text(encoding="utf-8")
            if game["status"] == "live" and f"games/{game['id']}/" in text:
                continue
            lines = text.split("\n")
            at = next((i for i, l in enumerate(lines) if re.match(r"^# \S", l)), None)
            if at is None:
                continue
            lines[at + 1 : at + 1] = ["", *banner(game, page, root)]
            page.write_text("\n".join(lines), encoding="utf-8")
            added += 1
    print(f"added {added} Play banner(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
