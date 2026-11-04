#!/usr/bin/env python3
"""Check that every merged PR appears in CHANGELOG.md.

The merged PRs are the squash commits on the base branch: their subjects end in "(#N)". A number that is
neither written in CHANGELOG.md as "#N" nor listed in scripts/changelog_skip.txt makes this fail.

Only commits already on the base branch are checked, so the PR being reviewed (whose number is not known
until it merges) never has to list itself. The newest GRACE merged PRs are not required yet, so the PRs that
merge right after each other do not fail one another's builds before the changelog catches up.

Usage: python3 scripts/check_changelog.py [REF]     (REF defaults to origin/main, then HEAD)
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRACE = 5  # the newest merged PRs that may still be missing


def git_subjects(ref: str) -> list[str]:
    out = subprocess.run(["git", "log", ref, "--format=%s"], cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"git log {ref} failed: {out.stderr.strip()}")
    return out.stdout.splitlines()


def skipped() -> set[int]:
    path = ROOT / "scripts" / "changelog_skip.txt"
    nums: set[int] = set()
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    for line in lines:
        if line.lstrip().startswith("#"):
            continue
        m = re.match(r"\s*(\d+)\b", line)
        if m:
            nums.add(int(m.group(1)))
    return nums


def main() -> int:
    ref = sys.argv[1] if len(sys.argv) > 1 else "origin/main"
    probe = subprocess.run(["git", "rev-parse", "--verify", "-q", ref], cwd=ROOT, capture_output=True)
    if probe.returncode != 0:
        ref = "HEAD"
    merged_newest_first = []
    for subject in git_subjects(ref):
        m = re.search(r"\(#(\d+)\)\s*$", subject)
        if m:
            merged_newest_first.append(int(m.group(1)))
    merged = set(merged_newest_first[GRACE:])
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    listed = {int(n) for n in re.findall(r"#(\d+)", text)}
    missing = sorted(n for n in merged if n not in listed and n not in skipped())
    if missing:
        print(f"CHANGELOG.md is missing {len(missing)} merged PR(s): " + ", ".join(f"#{n}" for n in missing))
        print("Add each to the right section of CHANGELOG.md, or list it in scripts/changelog_skip.txt with a reason.")
        return 1
    print(f"checked {len(merged)} merged PRs against CHANGELOG.md (the newest {GRACE} are not required yet): all covered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
