#!/usr/bin/env bash
#
# build_docs.sh — assemble the MkDocs source tree (site-src/) from the repo.
#
# Topic notes live under topics/<topic>/{README.md,notes/}, not in one docs
# directory, so this copies the pages MkDocs should publish into site-src/,
# preserving their paths. Runnable examples are left out of the site.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

dest=site-src
rm -rf "$dest"
mkdir -p "$dest"

cp CONTRIBUTING.md CHANGELOG.md "$dest/"

# The site root is the games-first home page (docs/site/index.html), so the README is published as the
# About page instead of becoming index.html. CONTRIBUTING links to it as README.md.
cp README.md "$dest/about.md"
sed -i 's#](README.md)#](about.md)#g' "$dest/CONTRIBUTING.md"
cp docs/site/index.html "$dest/index.html"

while IFS= read -r f; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$f" "$dest/$f"
done < <(find topics docs -type f -name '*.md' -not -path '*/examples/*')

# Non-Markdown assets under docs/: images for the README, and the scripts, styles and scenario data
# of the browser games. (Keep them out of dot-directories: MkDocs never publishes those.)
while IFS= read -r f; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$f" "$dest/$f"
done < <(find docs -type f \( -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.png' -o -name '*.svg' -o -name '*.jpg' -o -name '*.gif' \))

# Notes of topics with a game (or a planned one) get a Play banner; see scripts/play_banners.py.
python3 scripts/play_banners.py "$dest"

echo "assembled $(find "$dest" -name '*.md' | wc -l | tr -d ' ') pages into $dest/"
