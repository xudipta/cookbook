#!/usr/bin/env python3
"""Fail when a workflow uses a third-party action by a movable tag instead of a full commit SHA.

A tag like `actions/checkout@v4` can be moved to different code after review; a 40-hex commit SHA cannot.
Local actions (`./...`) and `docker://image@sha256:...` references are fine.

Actions not pinned yet are listed in scripts/actions_pin_baseline.txt, one `file: action@ref` per line. That
list is a ratchet: a new unpinned action fails the check, and so does a baseline line that is no longer needed
(delete it when you pin the action). Pin everything with scripts/pin_actions.py, then the baseline is empty.

Usage: python3 scripts/check_actions_pinned.py [--write-baseline]
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
BASELINE = Path(__file__).resolve().parent / "actions_pin_baseline.txt"
HEADER = "# Actions still on a movable tag (file: action@ref). Pin them with scripts/pin_actions.py and delete the line.\n"
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*['\"]?([^\s'\"#]+)")
SHA = re.compile(r"^[0-9a-f]{40}$")


def is_pinned(ref: str) -> bool:
    if ref.startswith("./"):
        return True
    if ref.startswith("docker://"):
        return "@sha256:" in ref
    _, _, version = ref.partition("@")
    return bool(SHA.match(version))


def unpinned() -> set[str]:
    found = set()
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        for line in path.read_text(encoding="utf-8").splitlines():
            m = USES.match(line)
            if m and not is_pinned(m.group(1)):
                found.add(f"{path.name}: {m.group(1)}")
    return found


def baseline() -> set[str]:
    if not BASELINE.exists():
        return set()
    lines = (ln.strip() for ln in BASELINE.read_text(encoding="utf-8").splitlines())
    return {ln for ln in lines if ln and not ln.startswith("#")}


def main() -> int:
    found = unpinned()
    if "--write-baseline" in sys.argv:
        BASELINE.write_text(HEADER + "".join(f"{x}\n" for x in sorted(found)), encoding="utf-8")
        print(f"wrote {len(found)} entries to {BASELINE.name}")
        return 0
    allowed = baseline()
    errors = [f"new unpinned action: {x}" for x in sorted(found - allowed)]
    errors += [f"stale baseline entry (now pinned or gone, delete it): {x}" for x in sorted(allowed - found)]
    if errors:
        print("\n".join(errors))
        print("\nPin the action to a full commit SHA (python3 scripts/pin_actions.py) instead of a tag.")
        return 1
    print(f"actions pinned: {len(found)} still on a tag (baseline), none new")
    return 0


if __name__ == "__main__":
    sys.exit(main())
