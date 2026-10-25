#!/usr/bin/env python3
"""Validate the browser games under docs/games/.

For every game directory (anything in docs/games/ except `shared/`) check that:
  * index.md, game.js and scenarios.json exist, and game.js registers the same id;
  * scenarios.json has the required fields and well-formed events and solution steps;
  * every event's `learn.note` is a real file and `learn.section` is a real heading in it
    (so a game can never point a reader at a note section that doesn't exist);
  * every action named in the scripted solution is defined in game.js.

Stdlib only. The scripted solution is actually *played* by scripts/games_smoke.cjs.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GAMES_DIR = REPO_ROOT / "docs" / "games"


def normalize_heading(text: str) -> str:
    text = text.replace("`", "")
    return re.sub(r"\s+", " ", text).strip().lower()


def headings(note: Path) -> set[str]:
    found = set()
    for line in note.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            found.add(normalize_heading(m.group(1)))
    return found


def check_game(game_dir: Path) -> list[str]:
    gid = game_dir.name
    errors: list[str] = []

    def err(msg: str) -> None:
        errors.append(f"{game_dir.relative_to(REPO_ROOT)}: {msg}")

    for required in ("index.md", "game.js", "scenarios.json"):
        if not (game_dir / required).is_file():
            err(f"missing {required}")
    if errors:
        return errors

    game_js = (game_dir / "game.js").read_text(encoding="utf-8")
    if not re.search(r"registerGame\s*\(", game_js):
        err("game.js never calls registerGame()")
    if not re.search(r"""id:\s*['"]%s['"]""" % re.escape(gid), game_js):
        err(f"game.js does not register id '{gid}' (must match the directory name)")

    styles = re.search(r"""styles:\s*['"]([^'"]+)['"]""", game_js)
    if styles and not (game_dir / styles.group(1)).is_file():
        err(f"game.js declares styles {styles.group(1)!r} but that file does not exist")

    try:
        scenario = json.loads((game_dir / "scenarios.json").read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        err(f"scenarios.json is not valid JSON: {exc}")
        return errors

    if scenario.get("id") != gid:
        err(f"scenarios.json id {scenario.get('id')!r} != directory name {gid!r}")
    if not isinstance(scenario.get("title"), str) or not scenario["title"]:
        err("title must be a non-empty string")
    if not isinstance(scenario.get("seed"), int):
        err("seed must be an integer")

    events = scenario.get("events")
    if not isinstance(events, list) or not events:
        err("events must be a non-empty list")
        events = []
    seen: set[str] = set()
    for i, event in enumerate(events):
        where = f"events[{i}]"
        if not isinstance(event, dict):
            err(f"{where} must be an object")
            continue
        eid = event.get("id")
        if not isinstance(eid, str) or not eid:
            err(f"{where} needs a string id")
        elif eid in seen:
            err(f"{where} duplicate id {eid!r}")
        else:
            seen.add(eid)
            where = f"event {eid!r}"
        for key in ("title", "fix"):
            if not isinstance(event.get(key), str) or not event[key]:
                err(f"{where} needs a non-empty {key}")
        learn = event.get("learn")
        if not isinstance(learn, dict) or not isinstance(learn.get("note"), str):
            err(f"{where} needs learn.note")
            continue
        note = REPO_ROOT / learn["note"]
        if not note.is_file():
            err(f"{where}: learn.note {learn['note']!r} does not exist")
            continue
        section = learn.get("section")
        if not isinstance(section, str) or not section:
            err(f"{where} needs learn.section")
        elif normalize_heading(section) not in headings(note):
            err(f"{where}: no heading {section!r} in {learn['note']}")

    solution = scenario.get("solution")
    if not isinstance(solution, list) or not solution:
        err("solution must be a non-empty list of {tick, action[, args]} steps")
        solution = []
    for i, step in enumerate(solution):
        if (
            not isinstance(step, dict)
            or not isinstance(step.get("tick"), int)
            or step["tick"] < 0
            or not isinstance(step.get("action"), str)
        ):
            err(f"solution[{i}] must have an integer tick >= 0 and a string action")
            continue
        if not re.search(r"\b%s\b" % re.escape(step["action"]), game_js):
            err(f"solution[{i}]: action {step['action']!r} is not defined in game.js")

    return errors


def main() -> int:
    games = sorted(p for p in GAMES_DIR.iterdir() if p.is_dir() and p.name != "shared")
    if not games:
        print("no games found under docs/games/")
        return 1
    errors = []
    for game_dir in games:
        errors.extend(check_game(game_dir))
    for line in errors:
        print(line)
    if errors:
        return 1
    print(f"checked {len(games)} game(s): {', '.join(p.name for p in games)} — scenarios valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
