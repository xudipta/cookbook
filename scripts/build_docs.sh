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

cp README.md CONTRIBUTING.md CHANGELOG.md "$dest/"

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

echo "assembled $(find "$dest" -name '*.md' | wc -l | tr -d ' ') pages into $dest/"
