#!/usr/bin/env python3
"""Fail when an example pins an image to `:latest` or to no tag at all.

The Docker notes tell readers to pin base image tags, so the examples they copy
must do the same: an unpinned image can change under a passing CI run. This scans
`image:` fields in topics/**/*.{yaml,yml} and `FROM` lines in Dockerfiles. A digest
(`@sha256:...`) counts as pinned. Skipped on purpose: templated references (`{{ ... }}`,
`${...}`), `FROM scratch`, and `FROM <earlier stage>`.

An entry in scripts/image_tags_allow.txt (`path<TAB>image<TAB>reason`) lets a file
keep an unpinned image when that is the point of the example.

Usage: python3 scripts/check_image_tags.py [paths...]   (default: topics/)
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ALLOW_FILE = Path(__file__).with_name("image_tags_allow.txt")
IMAGE_FIELD = re.compile(r"^\s*(?:-\s*)?image:\s*[\"']?([^\s\"'#]+)")
FROM_LINE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?", re.IGNORECASE)


def load_allow() -> set[tuple[str, str]]:
    allowed = set()
    if ALLOW_FILE.is_file():
        for raw in ALLOW_FILE.read_text(encoding="utf-8").splitlines():
            if not raw.strip() or raw.lstrip().startswith("#"):
                continue
            parts = raw.split("\t")
            if len(parts) < 3 or not parts[2].strip():
                sys.exit(f"{ALLOW_FILE.name}: each entry needs path<TAB>image<TAB>reason: {raw!r}")
            allowed.add((parts[0].strip(), parts[1].strip()))
    return allowed


def unpinned(ref: str) -> bool:
    if "@" in ref:  # a digest pins it
        return False
    if "{{" in ref or "${" in ref or "$" in ref:  # templated: the value is checked where it is set
        return False
    name = ref.rsplit("/", 1)[-1]
    if ":" not in name:
        return True
    return name.rsplit(":", 1)[1] == "latest"


def scan(path: Path) -> list[tuple[int, str]]:
    hits = []
    stages = set()
    is_docker = path.name.lower().startswith("dockerfile")
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if is_docker:
            m = FROM_LINE.match(line)
            if not m:
                continue
            ref, alias = m.group(1), m.group(2)
            if alias:
                stages.add(alias.lower())
            if ref.lower() == "scratch" or ref.lower() in stages:
                continue
        else:
            m = IMAGE_FIELD.match(line)
            if not m:
                continue
            ref = m.group(1)
        if unpinned(ref):
            hits.append((n, ref))
    return hits


def main() -> int:
    roots = [Path(a) for a in sys.argv[1:]] or [REPO / "topics"]
    allow = load_allow()
    files = []
    for root in roots:
        if root.is_file():
            files.append(root)
            continue
        files += [p for p in sorted(root.rglob("*")) if p.is_file() and (p.suffix in (".yaml", ".yml") or p.name.lower().startswith("dockerfile"))]
    bad = 0
    for f in files:
        try:
            rel = str(f.resolve().relative_to(REPO))
        except ValueError:
            rel = str(f)
        for n, ref in scan(f):
            if (rel, ref) in allow:
                continue
            print(f"{rel}:{n}: image '{ref}' is not pinned to a version tag (see topics/docker/notes/01-images-and-dockerfiles.md)")
            bad += 1
    if bad:
        print(f"\n{bad} unpinned image(s); pin a tag, or add the file to scripts/image_tags_allow.txt with a reason")
        return 1
    print(f"checked {len(files)} file(s): every image is pinned to a version tag or digest")
    return 0


if __name__ == "__main__":
    sys.exit(main())
