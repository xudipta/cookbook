#!/usr/bin/env python3
"""Validate the browser games under docs/games/.

For every game directory (anything in docs/games/ except `shared/`) check that:
  * index.md, game.js and scenarios.json exist, and game.js registers the same id;
  * scenarios.json has the required fields and well-formed events and solution steps;
  * every event's `learn.note` is a real file and `learn.section` is a real heading in it
    (so a game can never point a reader at a note section that doesn't exist);
  * docs/games/games.json (the home page's board) lists every game, and each live entry matches its
    directory (level count, notes folder), is linked from its topic README and from docs/games/index.md;
  * every level has a hint ladder (`hints`: 1-4 non-empty strings) and the game has a guided start
    (`coach`: board, actions, firstMove), so a first-time player is never left guessing;
  * every level has a `par` (an integer move count: the scripted solution's counted moves; the smoke test
    checks they agree), which the stars are measured against;
  * every action named in the scripted solution (one per level, if the scenario has `levels`) is
    defined in game.js, and every level's `schedule` only names declared events.

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

    coach = scenario.get("coach")
    if not isinstance(coach, dict):
        err("coach must be an object with board, actions and firstMove (the guided start)")
    else:
        for key in ("board", "actions", "firstMove"):
            if not isinstance(coach.get(key), str) or not coach[key].strip():
                err(f"coach.{key} must be a non-empty string")

    def check_par(label: str, par: object) -> None:
        if not isinstance(par, int) or isinstance(par, bool) or par < 0:
            err(f"{label}: par must be a non-negative integer (the scripted solution's move count)")

    def check_hints(label: str, hints: object) -> None:
        if not isinstance(hints, list) or not 1 <= len(hints) <= 4:
            err(f"{label}: hints must be a list of 1-4 strings (where to look, what is wrong, what to do)")
        elif not all(isinstance(h, str) and h.strip() for h in hints):
            err(f"{label}: every hint must be a non-empty string")

    levels = scenario.get("levels")
    if levels is not None and not isinstance(levels, list):
        err("levels must be a list")
        levels = None
    # Every run that CI will play: one per level, or the top-level solution.
    runs: list[tuple[str, object]] = []
    if levels:
        seen_levels: set[str] = set()
        for i, level in enumerate(levels):
            lid = level.get("id") if isinstance(level, dict) else None
            if not isinstance(lid, str) or not lid or lid in seen_levels:
                err(f"levels[{i}] needs a unique string id")
                continue
            seen_levels.add(lid)
            if not isinstance(level.get("title"), str):
                err(f"level {lid!r} needs a title")
            runs.append((f"level {lid!r}", level.get("solution")))
            check_hints(f"level {lid!r}", level.get("hints"))
            check_par(f"level {lid!r}", level.get("par"))
            for j, item in enumerate(level.get("schedule", [])):
                if not isinstance(item, dict) or item.get("event") not in seen:
                    err(f"level {lid!r} schedule[{j}] must name an event declared in events (got {item!r})")
                elif not isinstance(item.get("tick"), int) or item["tick"] < 1:
                    err(f"level {lid!r} schedule[{j}] needs an integer tick >= 1")
    else:
        runs.append(("scenario", scenario.get("solution")))
        check_hints("scenario", scenario.get("hints"))
        check_par("scenario", scenario.get("par"))

    for label, solution in runs:
        if not isinstance(solution, list) or not solution:
            err(f"{label}: solution must be a non-empty list of {{tick, action[, args]}} steps")
            continue
        for i, step in enumerate(solution):
            if (
                not isinstance(step, dict)
                or not isinstance(step.get("tick"), int)
                or step["tick"] < 0
                or not isinstance(step.get("action"), str)
            ):
                err(f"{label}: solution[{i}] must have an integer tick >= 0 and a string action")
                continue
            if not re.search(r"\b%s\b" % re.escape(step["action"]), game_js):
                err(f"{label}: solution[{i}]: action {step['action']!r} is not defined in game.js")

    return errors


# Game directories that are not on the home page's board (the shell's demo game).
NOT_ON_BOARD = {"demo"}


def check_manifest(game_dirs: list[Path]) -> list[str]:
    """docs/games/games.json drives the home page's board, so it must agree with the game directories."""
    path = GAMES_DIR / "games.json"
    rel = path.relative_to(REPO_ROOT)
    errors: list[str] = []
    try:
        games = json.loads(path.read_text(encoding="utf-8"))["games"]
    except (OSError, ValueError, KeyError) as exc:
        return [f"{rel}: cannot read a top-level \"games\" list ({exc})"]
    seen: set[str] = set()
    for i, g in enumerate(games):
        gid = g.get("id") if isinstance(g, dict) else None
        where = f"{rel}: games[{i}] ({gid})"
        if not isinstance(gid, str) or gid in seen:
            errors.append(f"{rel}: games[{i}] needs a unique string id")
            continue
        seen.add(gid)
        for key in ("title", "topic", "code", "hue", "notes"):
            if not isinstance(g.get(key), str) or not g[key]:
                errors.append(f"{where}: needs a non-empty {key}")
        if isinstance(g.get("notes"), str) and not (REPO_ROOT / g["notes"]).is_dir():
            errors.append(f"{where}: notes {g['notes']!r} is not a directory in the repo")
        if g.get("status") == "live":
            game_dir = GAMES_DIR / gid
            if not game_dir.is_dir():
                errors.append(f"{where}: live, but docs/games/{gid}/ does not exist")
                continue
            for key in ("blurb", "chips", "facts"):
                if not g.get(key):
                    errors.append(f"{where}: live games need {key}")
            try:
                scenario = json.loads((game_dir / "scenarios.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue  # check_game reports it
            readme = REPO_ROOT / g["notes"] / "README.md"
            if readme.is_file() and f"docs/games/{gid}/" not in readme.read_text(encoding="utf-8"):
                errors.append(f"{where}: {g['notes']}README.md has no link to docs/games/{gid}/ (add a 'Play it' pointer)")
            landing = GAMES_DIR / "index.md"
            if landing.is_file() and f"]({gid}/index.md)" not in landing.read_text(encoding="utf-8"):
                errors.append(f"{where}: docs/games/index.md does not list it (add a row linking {gid}/index.md)")
            expected = len(scenario.get("levels") or [1])
            if g.get("levels") != expected:
                errors.append(f"{where}: levels is {g.get('levels')!r} but scenarios.json has {expected}")
        elif g.get("status") == "queued":
            if not isinstance(g.get("issue"), int):
                errors.append(f"{where}: queued games need an integer issue")
        else:
            errors.append(f"{where}: status must be 'live' or 'queued'")
    for d in game_dirs:
        if d.name not in NOT_ON_BOARD and d.name not in seen:
            errors.append(f"{rel}: game {d.name!r} has no entry (add it, or list it in NOT_ON_BOARD)")
    return errors


def main() -> int:
    games = sorted(p for p in GAMES_DIR.iterdir() if p.is_dir() and p.name != "shared")
    if not games:
        print("no games found under docs/games/")
        return 1
    errors = []
    for game_dir in games:
        errors.extend(check_game(game_dir))
    errors.extend(check_manifest(games))
    for line in errors:
        print(line)
    if errors:
        return 1
    print(f"checked {len(games)} game(s): {', '.join(p.name for p in games)} — scenarios valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
