#!/usr/bin/env python3
"""Keep the Agent Skills game's lint gate in step with scripts/check_skill.py.

The game "Skill Issue" (docs/games/skills/) tells the player what the real SKILL.md validator would say,
using a JavaScript port of its rules (checkSkill in docs/games/skills/sim.js). This script runs a set of
SKILL.md fixtures through both the real validator and the port and fails if the error messages differ,
so a rule changed in check_skill.py cannot silently drift from what the game teaches. It also checks the
game's own skill texts: each `solution` file in scenarios.json must pass the real validator.

Needs PyYAML (already installed by requirements-docs.txt) and Node (any version that can import a
data: URL module). Usage: python3 scripts/check_skills_game.py
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))
import check_skill  # noqa: E402

SIM = REPO_ROOT / "docs" / "games" / "skills" / "sim.js"
SCENARIOS = REPO_ROOT / "docs" / "games" / "skills" / "scenarios.json"

LONG = "x" * 1025
FIXTURES: list[tuple[str, str, str]] = [
    # (label, directory name, SKILL.md text)
    ("valid", "demo", "---\nname: demo\ndescription: Does a thing. Use when asked.\n---\n\nDo it.\n"),
    ("no frontmatter", "demo", "# just a heading\n"),
    ("unterminated frontmatter", "demo", "---\nname: demo\ndescription: x\n"),
    ("empty frontmatter", "demo", "---\n\n---\nbody\n"),
    ("missing name", "demo", "---\ndescription: x\n---\nbody\n"),
    ("missing description", "demo", "---\nname: demo\n---\nbody\n"),
    ("empty body", "demo", "---\nname: demo\ndescription: x\n---\n\n   \n"),
    ("name not kebab", "Demo_Skill", "---\nname: Demo_Skill\ndescription: x\n---\nbody\n"),
    ("name mismatches directory", "other", "---\nname: demo\ndescription: x\n---\nbody\n"),
    ("name too long", "a" * 65, f"---\nname: {'a' * 65}\ndescription: x\n---\nbody\n"),
    ("name trailing hyphen", "demo-", "---\nname: demo-\ndescription: x\n---\nbody\n"),
    ("description too long", "demo", f"---\nname: demo\ndescription: {LONG}\n---\nbody\n"),
    ("description exactly 1024", "demo", f"---\nname: demo\ndescription: {'y' * 1024}\n---\nbody\n"),
    ("colon in plain scalar", "demo", "---\nname: demo\ndescription: Steps: run it\n---\nbody\n"),
    ("quoted colon is fine", "demo", '---\nname: demo\ndescription: "Steps: run it"\n---\nbody\n'),
    ("single-quoted", "demo", "---\nname: demo\ndescription: 'It''s fine: really'\n---\nbody\n"),
    ("unterminated quote", "demo", '---\nname: demo\ndescription: "oops\n---\nbody\n'),
    ("no colon on a line", "demo", "---\nname: demo\ndescription x\n---\nbody\n"),
    ("folded block", "demo", "---\nname: demo\ndescription: >-\n  Folds over\n  two lines. Use when asked.\n---\nbody\n"),
    ("literal block", "demo", "---\nname: demo\ndescription: |\n  Keeps\n  lines.\n---\nbody\n"),
    ("multi-line plain", "demo", "---\nname: demo\ndescription: Spans\n  two lines\n---\nbody\n"),
    ("flow list", "demo", "---\nname: demo\ndescription: x\nallowed-tools: [Bash, Read]\n---\nbody\n"),
    ("block list", "demo", "---\nname: demo\ndescription: x\nallowed-tools:\n  - Bash\n  - Read\n---\nbody\n"),
    ("unclosed flow list", "demo", "---\nname: demo\ndescription: x\nallowed-tools: [Bash, Read\n---\nbody\n"),
    ("comments", "demo", "---\n# a comment\nname: demo # trailing\ndescription: x\n---\nbody\n"),
    ("name is a boolean", "demo", "---\nname: yes\ndescription: x\n---\nbody\n"),
    ("name is a number", "123", "---\nname: 123\ndescription: x\n---\nbody\n"),
    ("empty name", "demo", "---\nname:\ndescription: x\n---\nbody\n"),
    ("empty description", "demo", '---\nname: demo\ndescription: ""\n---\nbody\n'),
    ("list frontmatter", "demo", "---\n- a\n- b\n---\nbody\n"),
    ("scalar frontmatter", "demo", "---\njust some words\n---\nbody\n"),
    ("body with rule line", "demo", "---\nname: demo\ndescription: x\n---\nA\n---\nB\n"),
    ("only name and body", "demo", "---\nname: demo\n---\nbody\n"),
    ("tabs and spaces", "demo", "---\nname:   demo   \ndescription:   spaced out   \n---\nbody\n"),
    ("unicode description", "demo", "---\nname: demo\ndescription: café – résumé\n---\nbody\n"),
]


def python_errors(label: str, dirname: str, text: str) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / dirname
        folder.mkdir()
        path = folder / "SKILL.md"
        path.write_text(text, encoding="utf-8")
        return check_skill.check(str(path))


def node_errors(cases: list[tuple[str, str, str]]) -> list[list[str]]:
    source = SIM.read_text(encoding="utf-8")
    url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    program = (
        "const sim = await import(process.argv[1]);"
        "const cases = JSON.parse(process.argv[2]);"
        "console.log(JSON.stringify(cases.map(([label, dir, text]) => sim.checkSkill(text, dir))));"
    )
    out = subprocess.run(
        ["node", "--input-type=module", "-e", program, url, json.dumps(cases)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


def same(py: list[str], js: list[str]) -> bool:
    # PyYAML's own wording for a YAML error is long and varies; the game only says the YAML is invalid.
    prefix = "frontmatter is not valid YAML:"
    if py and py[0].startswith(prefix):
        return len(js) == 1 and js[0].startswith(prefix)
    return py == js


def main() -> int:
    cases = list(FIXTURES)
    scenario = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    for level in scenario.get("levels", []):
        for step in level.get("solution", []):
            if step["action"] == "save":
                cases.append((f"level {level['id']} solution", "release-notes", step["args"][0]))

    js = node_errors(cases)
    failures = 0
    for (label, dirname, text), got in zip(cases, js):
        want = python_errors(label, dirname, text)
        if not same(want, got):
            failures += 1
            print(f"MISMATCH {label}\n  check_skill.py: {want}\n  game sim.js:    {got}")
        elif label.endswith("solution") and want:
            failures += 1
            print(f"FAIL {label} does not pass the real validator: {want}")
    if failures:
        print(f"{failures} lint fixture(s) disagree", file=sys.stderr)
        return 1
    print(f"ok: the game's lint gate agrees with check_skill.py on {len(cases)} fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
