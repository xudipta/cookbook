#!/usr/bin/env python3
"""Check that every local asset a built docs page references exists in the built site.

`mkdocs build --strict` only logs an INFO line when a page links to a file MkDocs decided not to
publish (anything inside a dot-directory such as `.github/` is skipped), so a README screenshot
can build "successfully" and still 404 on the live site. This reads the built HTML and fails on
any relative <img>, <script>, <source> or stylesheet/icon <link> whose target isn't on disk.

Root-absolute URLs (MkDocs writes them on 404.html) are resolved under the site root after
removing the path of `site_url` from mkdocs.yml (e.g. "/cookbook/"), as they would be on Pages.

Usage: python3 scripts/check_site_assets.py <site-dir>      (e.g. _site, or site/)
"""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ASSET_LINK_RELS = {"stylesheet", "icon", "shortcut icon", "apple-touch-icon", "preload", "manifest"}


class AssetCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.refs: list[tuple[str, str]] = []  # (tag, url)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag in ("img", "script", "source") and a.get("src"):
            self.refs.append((tag, a["src"]))
        elif tag == "link" and a.get("href") and (a.get("rel") or "").lower() in ASSET_LINK_RELS:
            self.refs.append((tag, a["href"]))


def site_prefix() -> str:
    """The path component of site_url in mkdocs.yml, e.g. "/cookbook/" ("/" if there is none)."""
    config = Path(__file__).resolve().parent.parent / "mkdocs.yml"
    match = re.search(r"^site_url:\s*(\S+)", config.read_text(encoding="utf-8"), re.M)
    path = urlsplit(match.group(1)).path if match else "/"
    return path if path.endswith("/") else path + "/"


def is_local(url: str) -> bool:
    parts = urlsplit(url)
    return not (parts.scheme or parts.netloc or url.startswith(("#", "//", "data:")))


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}")
        return 2

    prefix = site_prefix()
    pages = sorted(root.rglob("*.html"))
    problems: list[str] = []
    checked = 0
    for page in pages:
        collector = AssetCollector()
        collector.feed(page.read_text(encoding="utf-8", errors="replace"))
        for tag, url in collector.refs:
            if not is_local(url):
                continue
            checked += 1
            path = unquote(urlsplit(url).path)
            if path.startswith("/"):
                target = (root / path.removeprefix(prefix).lstrip("/")).resolve()
            else:
                target = (page.parent / path).resolve()
            if not target.is_file():
                problems.append(f"{page.relative_to(root)}: <{tag}> {url} -> not found in the built site")

    for line in problems:
        print(line)
    if problems:
        print(f"\n{len(problems)} broken asset reference(s) across {len(pages)} pages")
        return 1
    print(f"checked {checked} local asset references across {len(pages)} pages: all present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
