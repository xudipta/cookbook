#!/usr/bin/env python3
"""Check the external (http/https) links in the notes, docs and stories.

`check_links.py` only follows internal references. This one asks the web whether the
external ones still resolve, using only the standard library (no third-party action or
package to pin).

  scripts/check_external_links.py                 every external URL in the repo
  scripts/check_external_links.py --changed BASE  only URLs on lines added since BASE
                                                  (Markdown files; for pull requests)
  scripts/check_external_links.py --report FILE   also write a Markdown report (the
                                                  weekly job opens an issue from it)

Verdicts:
  dead        404/410 and other definite client errors, or a host that does not exist.
              These fail the run.
  unverified  timeouts, 5xx, 429, 401/403 (bot walls), TLS or connection errors. Listed,
              never failing: a third-party outage must not block a merge.

Placeholder hosts used in the notes' snippets live in scripts/external_links_ignore.txt
(one regular expression per line, '#' for comments).
"""

import argparse
import concurrent.futures
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IGNORE_FILE = REPO_ROOT / "scripts" / "external_links_ignore.txt"
UA = "Mozilla/5.0 (compatible; cookbook-link-check; +https://github.com/xudipta/cookbook)"
TIMEOUT = 15
RETRIES = 2
TOLERATED = {401, 403, 405, 406, 408, 429, 451, 999}

URL = re.compile(r"https?://[^\s)>\"'`\\\]\[<]+")
SCAN_GLOBS = [
    "topics/**/*.md",
    "docs/**/*.md",
    "docs/games/*/scenarios.json",
    "docs/stories/*/story.js",
    "docs/site/*.html",
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "mkdocs.yml",
]


def load_ignores() -> list[re.Pattern]:
    patterns = []
    for line in IGNORE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(re.compile(line))
    return patterns


def clean(url: str) -> str:
    return url.rstrip(".,;:!?*_")


def urls_in(text: str, ignores: list[re.Pattern]) -> set[str]:
    found = set()
    for raw in URL.findall(text):
        url = clean(raw)
        host = re.sub(r"^https?://", "", url).split("/")[0].split(":")[0]
        if "." not in host or "$" in url or "{" in url or "…" in url:
            continue  # a template or an elided placeholder, not a link
        if any(p.search(url) for p in ignores):
            continue
        found.add(url)
    return found


def all_urls(ignores: list[re.Pattern]) -> dict[str, set[str]]:
    """url -> files that mention it."""
    seen: dict[str, set[str]] = {}
    for pattern in SCAN_GLOBS:
        for path in sorted(REPO_ROOT.glob(pattern)):
            if not path.is_file():
                continue
            for url in urls_in(path.read_text(encoding="utf-8", errors="replace"), ignores):
                seen.setdefault(url, set()).add(str(path.relative_to(REPO_ROOT)))
    return seen


def changed_urls(base: str, ignores: list[re.Pattern]) -> dict[str, set[str]]:
    """URLs on lines added to Markdown files since `base` (a ref, usually origin/<base branch>)."""
    diff = subprocess.run(
        ["git", "diff", "--unified=0", "--no-color", f"{base}...HEAD", "--", "*.md"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout
    seen: dict[str, set[str]] = {}
    current = ""
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            for url in urls_in(line[1:], ignores):
                seen.setdefault(url, set()).add(current)
    return seen


def probe(url: str) -> tuple[str, str]:
    """('ok' | 'dead' | 'unverified', detail)"""
    detail = ""
    for attempt in range(RETRIES + 1):
        for method in ("HEAD", "GET"):
            req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "*/*"})
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    return "ok", str(resp.status)
            except urllib.error.HTTPError as e:
                detail = f"HTTP {e.code}"
                if e.code in (404, 410) and method == "GET":
                    return "dead", detail
                if e.code in TOLERATED or e.code >= 500:
                    if method == "GET":
                        break
                    continue  # HEAD is often refused: try GET
                if method == "GET":
                    return "dead", detail  # another definite 4xx
            except urllib.error.URLError as e:
                reason = e.reason
                detail = f"{type(reason).__name__}: {reason}"
                if isinstance(reason, socket.gaierror) and attempt == RETRIES:
                    return "dead", f"host not found ({reason})"
                break  # connection problem: retry
            except (TimeoutError, socket.timeout, OSError) as e:
                detail = f"{type(e).__name__}: {e}"
                break
    return "unverified", detail


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--changed", metavar="BASE", help="only URLs added since this git ref")
    ap.add_argument("--report", metavar="FILE", help="write a Markdown report here")
    args = ap.parse_args()

    ignores = load_ignores()
    urls = changed_urls(args.changed, ignores) if args.changed else all_urls(ignores)
    if not urls:
        print("no external links to check")
        return 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        verdicts = dict(zip(urls, pool.map(probe, sorted(urls))))

    dead = sorted(u for u, (v, _) in verdicts.items() if v == "dead")
    unverified = sorted(u for u, (v, _) in verdicts.items() if v == "unverified")
    ok = len(verdicts) - len(dead) - len(unverified)

    for u in dead:
        print(f"DEAD        {u}  ({verdicts[u][1]})  in {', '.join(sorted(urls[u]))}")
    for u in unverified:
        print(f"unverified  {u}  ({verdicts[u][1]})")
    print(f"\nchecked {len(verdicts)} external link(s): {ok} ok, {len(dead)} dead, {len(unverified)} unverified")

    if args.report:
        lines = ["Found by `scripts/check_external_links.py` (weekly job).", ""]
        if dead:
            lines += ["## Dead links", ""]
            lines += [f"- <{u}> ({verdicts[u][1]}), in {', '.join(f'`{f}`' for f in sorted(urls[u]))}" for u in dead]
            lines.append("")
        if unverified:
            lines += ["## Not verified (timeouts, bot walls, 5xx); look if they repeat", ""]
            lines += [f"- <{u}> ({verdicts[u][1]})" for u in unverified]
            lines.append("")
        Path(args.report).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 1 if dead else 0


if __name__ == "__main__":
    sys.exit(main())
