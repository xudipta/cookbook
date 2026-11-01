#!/usr/bin/env python3
"""Add banners to every note page of a topic that has a story or a game (site build only).

Reads docs/games/games.json. For each entry, every Markdown page under its `notes` folder in the
assembled docs tree (site-src/) gets an admonition right after its first heading: a link to the game
when it is live, or a pointer to its issue when it is queued. A page that already links to the live
game (the topic README keeps its own pointer so GitHub readers see it too) is left alone. The live banner
also lists the sections of the page that the game's events link back to (read from scenarios.json), so
the notes and the game point at each other and cannot drift apart.

Usage: python3 scripts/play_banners.py site-src
"""

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ISSUES = "https://github.com/xudipta/cookbook/issues/"


def slugify(text: str) -> str:
    """Same rule as MkDocs' toc extension (and docs/games/shared/learn.js)."""
    text = re.sub(r"[^\w\s-]", "", text.replace("`", "").lower()).strip()
    return re.sub(r"[\s-]+", "-", text)


def linked_sections(game: dict, page: Path, root: Path) -> list[tuple[str, str]]:
    """Sections of this page that the game's events link to, in the order the page lists them."""
    scenario = REPO_ROOT / "docs" / "games" / game["id"] / "scenarios.json"
    if not scenario.is_file():
        return []
    note = page.relative_to(root).as_posix()
    wanted = {e["learn"]["section"] for e in json.loads(scenario.read_text(encoding="utf-8"))["events"] if e["learn"]["note"] == note}
    found = []
    for line in page.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#{2,6}\s+(.*?)\s*#*\s*$", line)
        if m and m.group(1).replace("`", "").lower() in {w.replace("`", "").lower() for w in wanted}:
            found.append((m.group(1), slugify(m.group(1))))
    return found


def story_banner(game: dict, page: Path, root: Path) -> list[str]:
    """The story comes first: a topic with a live story points at it before the practice game."""
    story = game["story"]
    target = os.path.relpath(root / story["path"] / "index.md", page.parent)
    return [
        '!!! tip "Start with the story"',
        f"    [{story['title']}]({Path(target).as_posix()}): {story['blurb']}",
    ]


def banner(game: dict, page: Path, root: Path) -> list[str]:
    if game["status"] == "live":
        target = os.path.relpath(root / "docs" / "games" / game["id"] / "index.md", page.parent)
        lines = [
            '!!! note "Practice it"',
            f"    [{game['title']}]({Path(target).as_posix()}): {game['blurb']}",
        ]
        sections = linked_sections(game, page, root)
        if sections:
            links = ", ".join(f"[{title}](#{slug})" for title, slug in sections)
            lines += ["", f"    The game links back to this page from: {links}."]
        return lines
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
            lines = text.split("\n")
            at = next((i for i, l in enumerate(lines) if re.match(r"^# \S", l)), None)
            if at is None:
                continue
            add: list[str] = []
            story_live = game["story"]["status"] == "live"
            if story_live and f"stories/{game['id']}/" not in text:
                add += ["", *story_banner(game, page, root)]
            if not (game["status"] == "live" and f"games/{game['id']}/" in text):
                add += ["", *banner(game, page, root)]
            if not add:
                continue
            lines[at + 1 : at + 1] = add
            page.write_text("\n".join(lines), encoding="utf-8")
            added += 1
    print(f"added {added} story and practice banner(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
