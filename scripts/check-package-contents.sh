#!/usr/bin/env bash
# Verifies what `npm pack` would publish: the runtime sources and docs only,
# never tests, CI config, or local tooling.
set -euo pipefail

cd "$(dirname "$0")/.."

listing="$(mise exec -- npm pack --dry-run --json 2>/dev/null | jq -r '.[0].files[].path')"
echo "$listing"

for required in LICENSE index.ts policy.ts reviewer.ts trusted-worktree.ts workflow-preflight.ts git-metadata.ts package.json README.md; do
  grep -qx "$required" <<<"$listing" || { echo "Missing from package: $required" >&2; exit 1; }
done

if grep -E '^(test/|\.github/|scripts/|mise\.toml|\.gitignore)' <<<"$listing"; then
  echo "Unexpected files in the published package (listed above)." >&2
  exit 1
fi
echo "Package contents OK."
