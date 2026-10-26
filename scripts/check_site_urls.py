#!/usr/bin/env python3
"""Fail if a page that was published before has disappeared from the built site.

scripts/site_urls.txt lists every public page (one site-relative path per line, "" for the home page).
Links to the site live in READMEs, issues, other people's notes and search results, so a page may only
leave the site on purpose: remove its line from the list in the same change. Pages that are new are
reported but do not fail (add them to the list so they are protected from now on).

Usage: python3 scripts/check_site_urls.py _site
"""

import sys
from pathlib import Path

LIST = Path(__file__).resolve().parent / "site_urls.txt"


def built_pages(site: Path) -> set[str]:
    pages = set()
    for index in site.rglob("index.html"):
        rel = index.parent.relative_to(site).as_posix()
        pages.add("" if rel == "." else rel + "/")
    return pages


def main(argv: list[str]) -> int:
    site = Path(argv[1] if len(argv) > 1 else "_site")
    if not site.is_dir():
        print(f"{site}: not a directory (build the site first)")
        return 1
    lines = [line.strip() for line in LIST.read_text(encoding="utf-8").splitlines()]
    # The home page is written as "/" so that it is not an empty line.
    expected = {"" if line == "/" else line for line in lines if line and not line.startswith("#")}
    have = built_pages(site)
    missing = sorted(expected - have)
    new = sorted(have - expected)
    for page in missing:
        print(f"missing: /{page} was published before and is gone (remove it from scripts/site_urls.txt only if that is intended)")
    if new:
        print(f"note: {len(new)} page(s) are not in scripts/site_urls.txt yet: " + ", ".join("/" + p for p in new[:5]) + (" ..." if len(new) > 5 else ""))
    if missing:
        return 1
    print(f"checked {len(expected)} published page(s): all still present")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
