#!/bin/sh
# One-time per clone: use the repository's tracked git hooks.
set -eu
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "core.hooksPath = $(git config --get core.hooksPath)"
