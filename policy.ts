/**
 * Pure, side-effect-free classification helpers for the model-approval plugin.
 * Kept dependency-free and framework-free so they can be unit tested directly
 * with `bun test` (see test/policy.test.ts) without booting OpenCode at all.
 */

/**
 * Sensitive-even-if-allowed classifier. These categories must still go
 * through the reviewer even when the configured effect resolves to "allow"
 * (e.g. because of a stale project-scoped "Allow always" approval, or an
 * --auto invocation). A hard `experimental.policies` deny short-circuits
 * before the hook ever runs, so the very worst of these (sudo, su, force
 * push, gh repo delete, SSH key reads) are ALSO covered there as a second,
 * unbypassable layer — this classifier exists for everything one notch
 * below that: legitimate-looking but consequential operations that need
 * judgment, not a blanket block.
 *
 * Deliberately conservative: false positives here just mean one extra
 * cheap model call, so patterns are written broad rather than narrow.
 */
interface SensitiveRule {
  readonly category: string;
  readonly actions: ReadonlySet<string> | null; // null = any action
  readonly pattern: RegExp;
}

const SENSITIVE_RULES: readonly SensitiveRule[] = [
  // PR/issue/repo mutation and lifecycle operations on GitHub.
  { category: "pr-approve", actions: new Set(["shell"]), pattern: /\bgh\s+pr\s+review\b[^\n]*(?:--approve(?:[=\s]|$)|\s-[A-Za-z]*a[A-Za-z]*(?:\s|$))/i },
  { category: "pr-merge", actions: new Set(["shell"]), pattern: /\bgh\s+pr\s+merge\b/i },
  { category: "pr-close", actions: new Set(["shell"]), pattern: /\bgh\s+pr\s+close\b/i },
  { category: "issue-close-delete", actions: new Set(["shell"]), pattern: /\bgh\s+issue\s+(close|delete)\b/i },
  { category: "gh-repo-mutate", actions: new Set(["shell"]), pattern: /\bgh\s+repo\s+(delete|archive|edit|rename|transfer)\b/i },
  { category: "gh-api-mutation", actions: new Set(["shell"]), pattern: /\bgh\s+api\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--method[= ]\s*(POST|PUT|PATCH|DELETE))/i },
  { category: "release-tag", actions: new Set(["shell"]), pattern: /\b(gh\s+release\s+create|git\s+tag\b|git\s+push\b[^\n]*--tags)/i },

  // Destructive/rewriting git operations short of the Layer-1 force-push ban.
  { category: "git-reset-hard", actions: new Set(["shell"]), pattern: /\bgit\s+reset\s+.*--hard\b/i },
  { category: "git-clean", actions: new Set(["shell"]), pattern: /\bgit\s+clean\b[^\n]*-[a-z]*f/i },
  { category: "git-force-with-lease", actions: new Set(["shell"]), pattern: /\bgit\s+push\b[^\n]*--force-with-lease(?:\s|=|$)/i },
  { category: "git-branch-delete-remote", actions: new Set(["shell"]), pattern: /\bgit\s+push\b[^\n]*(?:--delete|\s:[^\s]+)/i },
  { category: "git-rebase", actions: new Set(["shell"]), pattern: /\bgit\s+rebase\b/i },
  { category: "git-filter", actions: new Set(["shell"]), pattern: /\bgit\s+(filter-branch|filter-repo)\b/i },

  // Auth / credential / account changes.
  { category: "auth-change", actions: new Set(["shell"]), pattern: /\b(gh\s+auth\s+(login|logout|switch|refresh)|npm\s+(login|adduser|logout)|aws\s+configure|az\s+login|gcloud\s+auth|docker\s+login|ssh-keygen|ssh-copy-id)\b/i },

  // Publish / deploy / release to somewhere outside the local machine.
  { category: "publish-deploy", actions: new Set(["shell"]), pattern: /\b(npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+push|cargo\s+publish|twine\s+upload|vercel(\s+--prod)?\s*$|vercel\s+deploy|netlify\s+deploy|firebase\s+deploy|eas\s+submit|fastlane\b)/i },

  // Cloud / infrastructure mutation.
  { category: "cloud-infra", actions: new Set(["shell"]), pattern: /\b(terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|kubectl\s+(apply|delete|create|patch|scale)|aws\s+\S+\s+(create|delete|put|update|terminate|modify)|gcloud\s+\S+\s+(create|delete)|az\s+\S+\s+(create|delete))\b/i },

  // Uploading/exfiltrating data via generic network tools.
  { category: "network-upload", actions: new Set(["shell"]), pattern: /\b(curl|wget)\b[^\n]*(-X\s*(POST|PUT)|--upload-file|--data|-d\s|-F\s)/i },
  { category: "scp-rsync-push", actions: new Set(["shell"]), pattern: /\b(scp|rsync)\b[^\n]*:.*$/i },

  // Secret/credential material beyond what Layer-1 already hard-blocks
  // (SSH private keys). These are read-only-looking commands that could
  // still surface a secret into model context or terminal output.
  { category: "dotenv-secret-file", actions: new Set(["shell", "read"]), pattern: /\.env(\.[a-z]+)?\b|credentials\.json|\.npmrc\b|\.pypirc\b|\.netrc\b/i },

  // Package installs from a source not already vendored/lockfiled — a
  // meaningful supply-chain moment, not routine `install` from a lockfile.
  { category: "add-new-dependency", actions: new Set(["shell"]), pattern: /\b(npm\s+install\s+\S|yarn\s+add\s|pnpm\s+add\s|pip\s+install\s+\S|cargo\s+add\s|gem\s+install\s)/i },
];

export function isSensitiveEvenIfAllowed(action: string, resources: readonly string[]): { sensitive: boolean; category?: string } {
  for (const rule of SENSITIVE_RULES) {
    if (rule.actions !== null && !rule.actions.has(action)) continue;
    for (const resource of resources) {
      if (rule.pattern.test(resource)) {
        return { sensitive: true, category: rule.category };
      }
    }
  }
  return { sensitive: false };
}

/**
 * Redacts obvious secret material before anything is sent to the reviewer
 * model or persisted. Best-effort, not exhaustive — the reviewer prompt
 * separately instructs the model never to echo raw secret values back.
 */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, // GitHub tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style secret keys
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, // Slack tokens
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, // JWTs
  /((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)(['"]?)([^\s'"]{4,})(\2)/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // The generic key/value pattern has capture groups; keep the key name
      // and quote characters, redact only the value.
      if (groups.length >= 4 && typeof groups[0] === "string" && typeof groups[2] === "string") {
        return `${groups[0]}${groups[1]}[REDACTED]${groups[3] ?? ""}`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}
