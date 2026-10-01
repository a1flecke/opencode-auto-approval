#!/usr/bin/env bash
# Applies this repository's GitHub security configuration. Idempotent: safe to
# re-run. Requires an authenticated `gh` with admin rights on the repository.
#
#   bash scripts/configure-repo.sh OWNER/REPO
#
# Run it AFTER the first push of `main`, because the rulesets it creates block
# direct pushes to main and restrict who may create release tags.
set -euo pipefail

REPO="${1:?usage: configure-repo.sh OWNER/REPO}"
OWNER="${REPO%%/*}"
ADMIN_ROLE_ID=5 # GitHub's built-in "Admin" repository role.

api() { gh api "$@"; }
warn() { echo "WARN: $*" >&2; }

echo "==> Repository merge settings and security features"
api -X PATCH "repos/$REPO" --input - >/dev/null <<JSON
{
  "allow_rebase_merge": true,
  "allow_squash_merge": false,
  "allow_merge_commit": false,
  "allow_auto_merge": false,
  "allow_update_branch": true,
  "delete_branch_on_merge": true,
  "has_wiki": false,
  "has_projects": false,
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null || warn "could not enable Dependabot alerts"
api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null || warn "could not enable Dependabot security updates"
api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null || warn "could not enable private vulnerability reporting"

echo "==> Actions: least-privilege defaults, SHA pinning required"
api -X PUT "repos/$REPO/actions/permissions" --input - >/dev/null <<JSON
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": true }
JSON
api -X PUT "repos/$REPO/actions/permissions/workflow" --input - >/dev/null <<JSON
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --input - >/dev/null <<JSON \
  || warn "could not require approval for outside contributors' workflow runs"
{ "approval_policy": "all_external_contributors" }
JSON

echo "==> Immutable releases"
api -X PUT "repos/$REPO/immutable-releases" >/dev/null \
  || warn "could not enable immutable releases via the API; enable it in Settings > General > Releases"

upsert_ruleset() { # name, json
  local name="$1" body="$2" id
  id="$(api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$name\") | .id")"
  if [[ -n "$id" ]]; then
    echo "$body" | api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null
    echo "    updated ruleset $name ($id)"
  else
    echo "$body" | api -X POST "repos/$REPO/rulesets" --input - >/dev/null
    echo "    created ruleset $name"
  fi
}

echo "==> Ruleset: protect-main"
# Admins may bypass the approval requirement but only through a pull request;
# nobody can force-push, delete, or push straight to main.
upsert_ruleset protect-main "$(cat <<JSON
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "required" },
          { "context": "analyze" }
        ]
      }
    }
  ]
}
JSON
)"

echo "==> Ruleset: protect-release-tags (v* tags are create-restricted and immutable)"
upsert_ruleset protect-release-tags "$(cat <<JSON
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": $ADMIN_ROLE_ID, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
)"

echo "==> Environment: release (manual approval, v* tags only)"
OWNER_ID="$(api "users/$OWNER" --jq .id)"
api -X PUT "repos/$REPO/environments/release" --input - >/dev/null <<JSON
{
  "reviewers": [ { "type": "User", "id": $OWNER_ID } ],
  "prevent_self_review": false,
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
api -X POST "repos/$REPO/environments/release/deployment-branch-policies" --input - >/dev/null <<JSON 2>/dev/null || true
{ "name": "v*", "type": "tag" }
JSON

echo "==> Done. Review the result:"
api "repos/$REPO/rulesets" --jq '.[] | "    ruleset: \(.name) [\(.enforcement)]"'
