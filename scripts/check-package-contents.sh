#!/usr/bin/env bash
# Verifies what `npm pack` would publish: the runtime sources and docs only,
# never tests, CI config, or local tooling.
set -euo pipefail

cd "$(dirname "$0")/.."

listing="$(mise exec -- npm pack --dry-run --json 2>/dev/null | jq -r '.[0].files[].path')"
echo "$listing"

for required in LICENSE index.ts policy.ts reviewer.ts trusted-worktree.ts output-filters.ts shell-words.ts workflow-preflight.ts git-metadata.ts package.json README.md; do
  grep -qx "$required" <<<"$listing" || { echo "Missing from package: $required" >&2; exit 1; }
done

if grep -E '^(test/|\.github/|scripts/|mise\.toml|\.gitignore)' <<<"$listing"; then
  echo "Unexpected files in the published package (listed above)." >&2
  exit 1
fi
# Every relative import in the packed sources must resolve inside the package,
# so a new module cannot be left out of `files`. Bundle the plugin from the
# unpacked tarball alone: a missing module fails the build.
check="$(mktemp -d)"
trap 'rm -rf "$check"' EXIT
mise exec -- npm pack --silent --pack-destination "$check" >/dev/null
tar -xzf "$check"/*.tgz -C "$check"
mise exec -- sh -c 'cd "$1/package" && bun build index.ts --target bun --outdir "$1/out"' _ "$check" >/dev/null 2>&1 \
  || { echo "A packed source file imports a module that is not in the package (check package.json files)." >&2; exit 1; }

# Exercise the exact publish invocation the release workflow uses (a local
# tarball addressed as ./dist/<file>), without publishing. A bare dist/<file>
# path is parsed by npm as a GitHub repo and breaks the release.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/dist"
tarball="$(mise exec -- npm pack --json --pack-destination "$work/dist" | jq -r '.[0].filename')"
mise exec -- sh -c 'cd "$1" && npm publish "./dist/$2" --dry-run --registry https://npm.pkg.github.com' _ "$work" "$tarball" >/dev/null 2>&1 \
  || { echo "npm publish --dry-run of the packed tarball failed" >&2; exit 1; }

echo "Package contents OK."
