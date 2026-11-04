#!/usr/bin/env python3
"""Rewrite `uses: owner/repo@tag` in .github/workflows to `uses: owner/repo@<sha> # tag`.

The tag is resolved to the commit it points at (annotated tags are dereferenced) with the GitHub CLI:
`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. Run it where `gh` is signed in, review the diff, then
refresh the ratchet with `python3 scripts/check_actions_pinned.py --write-baseline`. Dependabot (see
.github/dependabot.yml) keeps pinned SHAs current afterwards.

Usage: python3 scripts/pin_actions.py [--dry-run]
"""

import re
import subprocess
import sys
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
LINE = re.compile(r"^(?P<head>\s*(?:-\s*)?uses:\s*)(?P<action>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^@\s]*)?)@(?P<ref>[^\s#]+)(?P<tail>.*)$")
SHA = re.compile(r"^[0-9a-f]{40}$")


def resolve(owner_repo: str, ref: str) -> str:
    out = subprocess.run(["gh", "api", f"repos/{owner_repo}/commits/{ref}", "--jq", ".sha"], capture_output=True, text=True, check=True)
    sha = out.stdout.strip()
    if not SHA.match(sha):
        raise SystemExit(f"could not resolve {owner_repo}@{ref}: {out.stdout!r}")
    return sha


def pin_line(line: str, lookup=resolve) -> str:
    m = LINE.match(line.rstrip("\n"))
    if not m or SHA.match(m["ref"]):
        return line
    owner_repo = "/".join(m["action"].split("/")[:2])
    return f"{m['head']}{m['action']}@{lookup(owner_repo, m['ref'])} # {m['ref']}\n"


def main() -> int:
    dry = "--dry-run" in sys.argv
    cache: dict[tuple[str, str], str] = {}

    def lookup(owner_repo: str, ref: str) -> str:
        if (owner_repo, ref) not in cache:
            cache[(owner_repo, ref)] = resolve(owner_repo, ref)
        return cache[(owner_repo, ref)]

    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        old = path.read_text(encoding="utf-8").splitlines(keepends=True)
        new = [pin_line(ln, lookup) for ln in old]
        if new != old:
            print(f"{path.name}: {sum(a != b for a, b in zip(old, new))} line(s) pinned")
            if not dry:
                path.write_text("".join(new), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
