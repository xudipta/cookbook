#!/usr/bin/env python3
"""Check that internal cross-references in Markdown files resolve to real files.

This repo's notes mostly reference other files as plain inline code
(`NN-title.md`, `examples/pod/sample-pod.yaml`, `topics/mcp/examples/...`)
rather than as real Markdown links, so a generic link-checker (which only
follows `[text](target)`/`<a href>`) wouldn't catch a broken one. This
script checks both: real relative Markdown links, and the three inline-code
reference shapes actually used across the repo.
"""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# `NN-title.md` — a sibling note, relative to the referencing file's own directory.
SIBLING_NOTE = re.compile(r"`(\d{2}-[a-z0-9-]+\.md)`")

# `notes/...` or `examples/...` — relative to the referencing file's *topic* directory
# (topics/<topic>/), which is also the file's own directory when it's a topic README,
# or the parent of its own directory when it's a notes/*.md file.
TOPIC_RELATIVE = re.compile(r"`((?:notes|examples)/[A-Za-z0-9_.\-/]+[A-Za-z0-9_\-/])`")

# `topics/<topic>/...` — relative to the repo root, from anywhere.
REPO_RELATIVE = re.compile(r"`(topics/[a-z]+/[A-Za-z0-9_.\-/]+[A-Za-z0-9_\-/])`")

# [text](target) — a real Markdown link with a relative (non-http, non-anchor) target.
MD_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def topic_dir(md_file: Path) -> Path:
    """The topics/<topic>/ directory a note or topic README belongs to."""
    parts = md_file.relative_to(REPO_ROOT).parts
    # topics/<topic>/README.md or topics/<topic>/notes/NN-*.md
    return REPO_ROOT / parts[0] / parts[1]


def check_file(md_file: Path) -> list[str]:
    text = md_file.read_text()
    errors = []

    # `NN-title.md` means "the sibling note in this file's own notes/ dir" when the
    # referencing file is itself a note, or "notes/NN-title.md" when it's a topic
    # README (which lives next to notes/, not inside it).
    note_dir = md_file.parent if md_file.parent.name == "notes" else md_file.parent / "notes"
    for m in SIBLING_NOTE.finditer(text):
        target = note_dir / m.group(1)
        if not target.is_file():
            errors.append(f"{m.group(0)} -> {target.relative_to(REPO_ROOT)} (not found)")

    if md_file.parts[len(REPO_ROOT.parts)] == "topics":
        base = topic_dir(md_file)
        for m in TOPIC_RELATIVE.finditer(text):
            target = base / m.group(1)
            if not target.exists():
                errors.append(f"`{m.group(1)}` -> {target.relative_to(REPO_ROOT)} (not found)")

    for m in REPO_RELATIVE.finditer(text):
        target = REPO_ROOT / m.group(1)
        if not target.exists():
            errors.append(f"`{m.group(1)}` -> {target.relative_to(REPO_ROOT)} (not found)")

    for m in MD_LINK.finditer(text):
        target = m.group(1).split("#", 1)[0]
        if not target or target.startswith(("http://", "https://", "mailto:")):
            continue
        resolved = (md_file.parent / target).resolve()
        if not resolved.exists():
            errors.append(f"[]({m.group(1)}) -> {target} (not found)")

    return errors


def main() -> int:
    md_files = sorted(REPO_ROOT.glob("topics/**/*.md")) + sorted(REPO_ROOT.glob("docs/**/*.md")) + [
        REPO_ROOT / "README.md",
        REPO_ROOT / "CONTRIBUTING.md",
    ]

    had_errors = False
    for md_file in md_files:
        for err in check_file(md_file):
            had_errors = True
            print(f"{md_file.relative_to(REPO_ROOT)}: {err}")

    if had_errors:
        return 1
    print(f"checked {len(md_files)} files, all internal references resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
