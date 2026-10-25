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

if [ -d .github/images ]; then
  mkdir -p "$dest/.github/images"
  cp .github/images/* "$dest/.github/images/"
fi

while IFS= read -r f; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$f" "$dest/$f"
done < <(find topics docs -type f -name '*.md' -not -path '*/examples/*')

# The browser games under docs/games/ ship scripts, styles and scenario data alongside their pages.
while IFS= read -r f; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$f" "$dest/$f"
done < <(find docs -type f \( -name '*.js' -o -name '*.css' -o -name '*.json' \))

echo "assembled $(find "$dest" -name '*.md' | wc -l | tr -d ' ') pages into $dest/"
