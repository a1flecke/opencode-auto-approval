#!/usr/bin/env bash
# Every commit subject in a range must be a Conventional Commit, because
# semantic-release derives the next version from them. Rebase merges keep each
# commit on main, so each one is checked, not just the PR title.
#
#   scripts/check-commit-messages.sh <base-sha> <head-sha>
#
# The breaking-change marker `!` is rejected on purpose: the default
# semantic-release parser does not understand it and would silently skip the
# release. Use a `BREAKING CHANGE:` footer instead.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: check-commit-messages.sh <base-sha> <head-sha>" >&2
  exit 2
fi

pattern='^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)(\([a-z0-9._/-]+\))?: .+'
bad=0
while IFS= read -r line; do
  sha="${line%% *}"
  subject="${line#* }"
  if ! [[ "$subject" =~ $pattern ]]; then
    echo "Not a Conventional Commit: $sha $subject" >&2
    bad=1
  fi
done < <(git log --no-merges --format='%h %s' "$1..$2")

if [[ $bad -ne 0 ]]; then
  echo "Use: <feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert>(scope)?: summary" >&2
  echo "Breaking change: add a 'BREAKING CHANGE: ...' footer (not '!')." >&2
  exit 1
fi
echo "Commit messages OK."
