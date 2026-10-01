#!/bin/sh
# Canonical pre-push verification: the same gates CI runs, via the pinned
# toolchain from mise.toml. Used by .githooks/pre-push and by agent push gates.
#
#   scripts/verify-before-push.sh [--regular]
#
# --regular is accepted for compatibility with callers that pass it; this suite
# is small, so there is no lighter tier and it always runs everything.
set -eu

cd "$(dirname "$0")/.."

case "${1:-}" in
  ""|--regular) ;;
  *) echo "Usage: verify-before-push.sh [--regular]" >&2; exit 2 ;;
esac

echo "==> private-content scan"
mise exec -- bash scripts/check-private-content.sh
echo "==> package contents"
mise exec -- bash scripts/check-package-contents.sh
echo "==> tests"
mise run test
echo "Verification passed."
