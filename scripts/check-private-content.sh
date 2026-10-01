#!/usr/bin/env bash
# Fails if machine-specific or private content is tracked in the repository.
# This repository is public: keep real usernames, home paths and the projects
# it was extracted from out of it; use placeholders (/home/user/dev, project).
# Configure real values in your OpenCode config instead. Real secrets are
# caught by GitHub secret scanning + push protection, not here (tests contain
# deliberately fake secret fixtures).
set -euo pipefail

cd "$(dirname "$0")/.."

# The checker names the patterns it looks for, so it must not scan itself.
files=()
while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z -- . ':!scripts/check-private-content.sh')

found=0
if grep -nEI -- '/Users/' "${files[@]}"; then found=1; fi
# Any home directory other than the documented placeholder.
if grep -nEI -- '/home/[A-Za-z0-9_.-]+' "${files[@]}" | grep -v '/home/user'; then found=1; fi

if [[ "$found" -ne 0 ]]; then
  echo "Private or machine-specific content found above; replace it with a placeholder." >&2
  exit 1
fi
echo "No private content found."
