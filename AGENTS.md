# AGENTS.md

Mandatory instructions for every coding agent (Claude Code, OpenCode, Codex,
and others) working in this repository. Human contributors should follow them
too. `CLAUDE.md` imports this file; this is the single source of truth.

## What this is

`opencode-auto-approval` is an OpenCode plugin that decides which shell commands
and file operations an AI coding agent may run **without asking the human**. It
is a security control. A bug here is not a normal bug: a wrong "allow" lets an
agent do something the human never approved. Treat every change as
security-sensitive.

Start with `README.md` (design, configuration, the three-layer model) and
`TRUSTED-WORKTREE-DESIGN.md` (what the deterministic preflight may allow).

## Commands

Always use mise; never a globally installed bun/node/jq.

```bash
mise install                                  # once: bun, node, jq (pinned in mise.toml)
mise run test                                 # bun test, the whole suite
sh scripts/verify-before-push.sh              # what CI and the pre-push hook run
sh scripts/setup-git-hooks.sh                 # once per clone: enable .githooks/pre-push
```

`mise run test` must pass, with the new tests you added, before you commit.

## Layout

| File | Responsibility |
|---|---|
| `index.ts` | Plugin entry: the `evaluate` hook, option parsing, routing between preflight and reviewer |
| `policy.ts` | Pure classification: sensitive-even-if-allowed categories, secret redaction |
| `trusted-worktree.ts` | Pure deterministic decisions for the small trusted-worktree workflow |
| `output-filters.ts` | Pure parser for the closed grammar of read-only output filters (`2>&1`, `tail`, `head`, `grep`, `wc -l`) allowed after an allowed command |
| `shell-words.ts` | Quote-aware word splitter shared by the pure decision modules |
| `workflow-preflight.ts` | Resolves the session directory and runs the deterministic decision |
| `git-metadata.ts` | Read-only Git probes feeding the preflight |
| `reviewer.ts` | The model reviewer for everything the preflight does not own |
| `test/` | `bun test` suite, one file per module |

Keep modules small and single-purpose. Pure decision logic stays free of I/O so
it can be unit tested exhaustively.

## Security invariants (never weaken)

1. **A hard `deny` is never turned into an `allow`.** The hook returns
   immediately on `deny`.
2. **Fail closed.** Any doubt, missing context, probe failure, model error,
   timeout, or malformed output resolves to `ask` (human approval), never `allow`.
   The model reviewer can only produce `allow` or `ask`, never `deny`.
3. **`trustedRoots` defaults to empty.** Real values live in the user's OpenCode
   config, never in this repository.
4. **Exact-match allows.** The preflight allows a command only when it matches a
   canonical form exactly; extra flags, refspecs, or shell composition fall out
   of the allow path.
5. **Guard asks may tighten an already-allowed command; shape asks may not.** An
   ask marked `guard: true` (default-branch push, wrong remote/target, secret
   path staging) can override a static or stored allow. A merely non-canonical
   shape (for example `yarn test <file>`) must never newly prompt.
6. **Routing is explicit.** A sensitive category whose commands the preflight
   owns must be listed in `PREFLIGHT_OWNED_SENSITIVE_CATEGORIES` in `index.ts`;
   deliberate reviewer-only categories go in
   `PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES` with a reason. A test fails when a new
   category overlaps a preflight family and is in neither list. Do not silence
   it; classify the category.
7. **No secrets at rest or in prompts.** Never persist or log credentials,
   command output, or conversation text. Redact before anything reaches the
   reviewer. The API key is read from an environment variable only.
8. **No new runtime dependencies** without explicit maintainer approval. The
   plugin has none today, which keeps the supply chain small. Do not add a
   dependency to solve a convenience problem.
9. **No new network calls.** The only outbound request is the reviewer call.

## Public repository: keep it clean

This repository is public. Never commit real usernames, home directories,
machine names, email addresses, API keys, or the names of private projects. Use
placeholders (`/home/user/dev`, `project`, `example-org/project`).
`scripts/check-private-content.sh` runs in CI and in the pre-push hook; do not
loosen it to get a change through.

## How to work

- **Branch and PR only.** Never commit or push to `main`. Create a branch, open a
  pull request, and let CI pass. `main` is protected: one code-owner approval,
  required `required` and `analyze` checks, linear history, rebase merges only.
- **Test first for behavior changes.** A new allow rule, category, or guard needs
  a test showing it allows what it should *and* a test showing a near-miss still
  asks. A security fix needs a regression test that fails without the fix.
- **Keep docs honest.** If behavior or a setting changes, update `README.md` (and
  `TRUSTED-WORKTREE-DESIGN.md` for preflight changes) in the same PR.
- **Small, reviewable commits** with a message explaining *why*, as a
  Conventional Commit (`feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert`,
  optional `(scope)`, then `: summary`). semantic-release derives the version
  and cuts the release from these on merge to `main`, so the type matters: `feat`
  = minor, `fix`/`perf` = patch, a `BREAKING CHANGE:` footer = major (never `!`).
  CI rejects non-conforming commits.
- **Never skip checks.** No `--no-verify`, no disabling or editing hooks or
  workflows to make something pass, no `git push --force`. If a check blocks you,
  fix the cause or ask the maintainer.

## Do not do without explicit maintainer approval

- Edit `.github/` (workflows, `CODEOWNERS`, Dependabot), `scripts/configure-repo.sh`,
  `SECURITY.md`, or `LICENSE`. They define what protects releases.
- Change repository settings, rulesets, environments, or secrets, including via
  `gh api` or `gh repo edit`.
- Create, move, or delete tags, or create releases. Releases are cut only by the
  tag-triggered workflow and are immutable; fix a bad release with a new version.
- Bump `version` in `package.json` outside a release PR the maintainer asked for.
- Add or modify anything under `.claude/` or `.opencode/` that changes agent
  permissions.
- Publish, push, or share anything outside this repository.

## When unsure

Choose the more restrictive behavior and ask. A needless prompt costs a click; a
wrongly auto-approved command can cost much more.
