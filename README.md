# opencode-auto-approval

A local, inspectable OpenCode V2 plugin that adds contextual, model-reviewed
permission decisions on top of OpenCode's built-in permission system — Layer
3 of a three-layer model. You own this file, it is not a third-party
marketplace plugin.

## Install and update

There is no build step and no runtime dependencies.

1. Clone this repository anywhere outside the projects your agents work in, then run
   `mise install` (bun is pinned in `mise.toml`; use mise, not a global bun).
2. Register it by path in `~/.config/opencode/opencode.jsonc` (see
   [Configuration](#configuration)). Set `trustedRoots` explicitly: the
   built-in default is an empty list, so without it the deterministic
   trusted-worktree preflight never auto-approves anything (it fails closed).
3. Restart the OpenCode service.

To update: `git pull` (or check out a tag), then restart OpenCode. Run
`mise run test` before restarting after any local change. Keep your machine-specific
values (`trustedRoots`, model, key variable name) in your OpenCode config, never
in this repository.

Because this plugin decides what your agents may run, keep the clone out of any
path your agents may edit: add an `edit` deny for its directory in your OpenCode
permissions so changes come only from you.

## Releasing and repository security

Maintainer-facing; none of this affects using the plugin.

**Pipeline** (`.github/workflows/`, every action pinned by commit SHA, workflows
linted with zizmor, default `GITHUB_TOKEN` permissions denied):

- `ci.yml` — workflow lint, tests (`mise run test`), a private-content scan, a
  check of exactly what the npm tarball contains, and dependency review on PRs.
  A single `required` job aggregates them and is the branch-protection check.
- `codeql.yml` — CodeQL on PRs, `main`, and weekly.
- `release.yml` — runs only for a `vX.Y.Z` tag that matches `package.json` and
  is on `main`. It re-runs the checks, packs the tarball once, waits for approval
  on the `release` environment, attests build provenance, creates a **draft**
  GitHub release with the tarball and its `.sha256`, publishes the package to
  GitHub Packages, and publishes the release **last**.

**Immutability.** Once published, a release's tag and assets are locked by
GitHub's immutable-releases setting; a ruleset blocks moving, deleting, or
creating `v*` tags except by admins; the workflow refuses to touch an existing
release; and a package version that already exists is never republished.
Verify a download with
`gh attestation verify <tarball> --repo <owner>/<repo>` and the `.sha256` file.
To fix a bad release, ship a new version; never rewrite the old one.

**Before pushing:** run `sh scripts/setup-git-hooks.sh` once per clone; the tracked `pre-push` hook then runs `scripts/verify-before-push.sh` (private-content scan, package check, tests).

**Cutting a release:** bump `version` in `package.json` through a PR, merge it,
then push the tag (`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`) and
approve the `release` environment deployment.

**Repository settings** are code: after the first push of `main`, run
`bash scripts/configure-repo.sh OWNER/REPO` (admin `gh` auth required). It
enforces PR-only changes to `main` with one code-owner approval, stale-review
dismissal, last-push approval, resolved conversations, linear history,
rebase-only merges, required `required` + `analyze` checks, no force-push or
deletion, secret scanning with push protection, Dependabot alerts and updates,
private vulnerability reporting, read-only default token permissions, SHA-pinned
actions required, and the `release` environment. Admins may bypass the approval
requirement only through a pull request.

## Why this exists

Without it, OpenCode's permission system has two states for anything not
explicitly allowed/denied: prompt the human, or (with `--auto`/a saved
"Allow always") skip review entirely. That's either too much friction for
routine engineering work, or too little scrutiny for a stale broad approval.
This plugin adds a middle tier: Jev System One evaluates *this specific
proposed operation* against five fixed safety questions and recent user
instructions. It can return only `allow` or `ask`; any uncertainty, timeout,
transport failure, missing key, or malformed response becomes a human prompt.

## The three-layer model (tested 2026-09-27 against OpenCode 2.0.18)

```
Layer 1 — HARD POLICY        (experimental.policies in opencode.jsonc)
  sudo/su, ordinary forced pushes, `gh repo delete`, reading SSH private keys,
  whole-machine/home wipe commands. Runs AFTER agent rules and saved
  approvals and BEFORE this plugin — nothing below can override it, not a
  stale "Allow always", not a plugin bug, not a --auto flag.

Layer 2 — DETERMINISTIC PERMISSIONS   (permissions[] in opencode.jsonc)
  Routine reads/edits/git-inspection/gh-inspection are `allow`. Anything
  ambiguous resolves to `ask`, which flows into Layer 3.

Layer 3 — THIS PLUGIN
  For an `ask`, it first applies a small deterministic trusted-worktree
  preflight. Recognized routine commands can be allowed only after exact
  local Git metadata checks; a failed check is always `ask`. Everything else,
  plus the narrow "sensitive-even-if-allowed" class (gh pr merge, git reset
  --hard, publish/deploy, auth changes, cloud mutations, secret-file reads,
  new dependency installs, etc — see `policy.ts`), goes to Jev. Both paths
  choose allow / ask only. Any uncertainty, metadata failure, timeout,
  malformed reply, missing key, or exception becomes `ask`, never `allow`.
```

## Files

- `index.ts` — plugin entry point (`export default { id, setup }`). Registers
  the `ctx.permission.hook("evaluate", ...)` callback, gates on the
  sensitive-even-if-allowed classifier, calls the reviewer under a timeout,
  and records outcome counters in `ctx.storage`.
- `reviewer.ts` — builds bounded, redacted context and calls the authenticated
  OpenCode Zen System One endpoint with five typed `noul` questions.
- `policy.ts` — pure, dependency-free sensitive-operation classification and
  secret redaction.
- `trusted-worktree.ts` — pure, auditable decision rules for normal Git/Yarn
  workflow commands; it neither executes commands nor reads files.
- `git-metadata.ts` and `workflow-preflight.ts` — fixed read-only Git probes
  and the runtime adapter that supplies their results to the pure rules.
- `test/` — `bun test` suite for options, policy, and reviewer behavior. No
  network or OpenCode process is required.

## Why there's no `import { Plugin } from "@opencode/plugin"`

That package's `Plugin.define()` is an identity function purely for
IDE/type-checking convenience — it is not resolvable at runtime unless
installed as an actual dependency next to this file, and this plugin
deliberately has zero dependencies. This was verified two ways:

1. OpenCode's own actively-maintained `superpowers` plugin does the same
   thing, with the comment "No external dependencies — pure JavaScript works
   ... without installing @opencode-ai/plugin or effect."
2. A disposable test plugin that *did* `import { Plugin } from "@opencode/plugin"`
   failed to load with `Cannot find package '@opencode/plugin'` when pointed
   at from a project's `opencode.jsonc`, while the identical plugin with a
   plain `export default { id, setup }` loaded and its permission hook fired
   correctly (independently verified end-to-end: a shell command was
   deliberately denied by the hook and the run was blocked with the
   plugin's own message).

The shapes used in `index.ts`/`reviewer.ts` (the `PermissionEvaluation`
event's `resources: readonly string[]` and
`ctx.session.context({sessionID})` returning typed session messages) were
confirmed against the installed OpenCode 2.0.18 plugin/client definitions.
The direct reviewer route is required because `ctx.generate.text()` creates
no OpenCode session and therefore cannot carry the routing identity required
by free or Go inference.

## Configuration

Registered in `~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  "superpowers@git+https://github.com/obra/superpowers.git",
  {
    "package": "/path/to/opencode-auto-approval",
    "options": {
      "model": "jev-1.13-free",
      "apiKeyEnvVar": "OPENCODE_GO_API_KEY",
      "timeoutMs": 8000,
      "maxContextChars": 12000,
      "threshold": 0.85,
      "debug": false,
      "trustedRoots": ["/home/user/dev"],
      "trustedRemoteHosts": ["github.com"],
      "defaultBranches": ["main", "master"],
      "trustedScripts": ["scripts/check-src-rule-violations.sh"]
    }
  }
]
```

- `model` — `jev-1.13-free`, OpenCode's limited-time-free System One model
  for fast structured yes/no decisions. It is not used as a general chat
  model.
- `apiKeyEnvVar` — the desktop process environment variable containing an
  inference-only OpenCode Console key. The key is sent only as a Bearer
  authorization header; it is never written to this file, logged, persisted,
  or placed in Jev's decision state. The existing `OPENCODE_GO_API_KEY` name
  works despite its historical name because the same scoped Console key
  authenticated the Zen endpoint in a live probe.
- `timeoutMs` — 8000ms. On timeout the check becomes `ask`, never `allow`.
- `maxContextChars` — 12000 chars of recent user/assistant/system text (most
  recent first, then re-ordered chronologically for the prompt). Shell/tool
  output is deliberately excluded from context — only conversation text is
  sent, so injected tool output can't pose as a user instruction.
- `debug` — off by default. When `true`, logs one line per reviewed check to
  stderr (action, sensitivity category, decision, latency, reason) — no
  secret values, since everything is redacted before logging too. Does not
  persist full conversation text anywhere; `ctx.storage` only ever holds the
  small aggregate counters below.
- `threshold` — 0.85. Jev must meet or exceed it on **all five** checks:
  harmless operation, private-data safety, explicit trusted intent, no
  untrusted-code execution, and narrow authorized effect. This was calibrated
  on live probes: an explicit `git status` had a minimum 0.87; an unauthorized
  PR merge had a maximum relevant score of 0.70; an injected upload-shaped
  command scored 0.06–0.16.
- `trustedRoots`, `trustedRemoteHosts`, and `defaultBranches` — the complete
  local trust boundary for deterministic workflow approval. The defaults are
  the personal development directory, `github.com`, and `main`/`master`.
  An empty or malformed override falls back to those conservative defaults.
- `trustedScripts` — exact worktree-relative paths of project scripts you have
  vetted (default: none; plain `dir/name` paths only, no globs, `..`, absolute
  or secret-like entries; invalid entries are dropped). See
  [Trusted project scripts](#trusted-project-scripts).

## Trusted project scripts

Any project script not in `trustedScripts` is judged by the reviewer, which
usually asks. A listed script (for example
`./scripts/check-src-rule-violations.sh src/systems/turn.ts`) runs without
prompting only when all hold: the worktree is trusted; the command is the
exact `./<listed path>` followed only by explicit non-secret, non-glob,
in-worktree path arguments (no flags, no shell composition); the script is
tracked by Git; and nothing under the script's directory differs from `HEAD`
or is untracked/ignored. A modified or untracked script is a guard ask, so it
also overrides a stored "Allow always". A script file the agent has committed
is, by definition, `HEAD`: review commits that touch listed scripts.

**Drift check.** Every tracked `scripts/*.sh` must be deliberately classified,
listed or exempted, so new scripts cannot silently fall outside the list:

```bash
bun scripts/check-trusted-scripts.ts --config ~/.config/opencode/opencode.jsonc \
  --repo /path/to/project --exempt scripts/release.sh
```

It exits 1 and names each unclassified script. The list lives in your config,
not in a repository, so run this where that config exists (a project's
pre-push hook, or by hand).

## Trusted-worktree workflow

The following commands can bypass Jev only when all conditions hold: the
originating shell invocation resolves to a Git worktree below `trustedRoots`,
its `origin` is a listed host, and the command has no shell
composition/expansion. This is an exact command allowlist, not a prefix
allowlist:

- `./scripts/run-with-mise.sh yarn test`, `build`, or `verify:*`; and an exact
  `yarn install` only if `package.json` and `yarn.lock` are unchanged from
  `HEAD` and neither is untracked.
- `git blame` of exactly one explicit, non-secret in-worktree file, with only
  `-L <n>[,<m>|,+<k>]`, `-w`, `-s`, `-e`, and an optional `--`. Other flags
  (`--contents`, `--ignore-revs-file`), several files, or a secret-like path
  prompt.
- `git add` with one or more explicit, non-secret, non-glob paths (with an
  optional standalone `--`). Broad staging, options, `.env*`, credential
  files, private-key material, and parent/absolute paths prompt.
- `git fetch origin`, plus a direct `git ls-remote origin refs/heads/<current-
  feature-branch>` inspection. Other remotes, default-branch refs, refspecs,
  and shell-composed checks prompt.
- `git rebase origin/main` only on a nondefault branch with no rebase or merge
  conflict already in progress.
- The initial rebase must use that exact direct command. `GIT_EDITOR=true` is
  reserved for `git rebase --continue`; output filtering or other shell
  composition around either form prompts.
- `git push origin HEAD` or `git push origin <current-feature-branch>` only
  from a nondefault branch, without flags, force, tags, deletion, or refspec
  rewrite. After a completed rebase, the exact lease-protected form
  `git push --force-with-lease origin HEAD:<current-feature-branch>` is also
  allowed. It remains limited to the verified current nondefault branch and
  is rejected while a rebase or conflict is active.
- `gh pr create --base main|master --head <current-feature-branch> --fill`
  only from a nondefault branch.

Every near miss remains `ask`: a new dependency, another remote, default
branch work, an added flag, shell chaining, an unfamiliar command, or an
unverifiable Git state. Hard-deny policies still win before this plugin.

### Worktree resolution

The plugin never treats its startup `directory`/`worktree` as proof that a
specific permission request belongs to that worktree. Those values describe
where OpenCode loaded the plugin; a session may instead run a tool from a
linked worktree with `cd /absolute/worktree && …`. For a permission request
without an explicit absolute `cwd`, the plugin binds `event.source.id` to the
same source tool invocation and accepts only that strict leading `cd` form.
It then independently verifies the resulting Git metadata. A base checkout,
an ambiguous shell expression, and a source mismatch all remain `ask`.

## What gets reviewed vs. what doesn't

- A plain `allow` outside the sensitive class returns from the hook
  immediately — **no model call, no added latency** for routine reads,
  edits, or already-allowed git/gh inspection commands.
- The global policy additionally allows pure shell inspection (`pwd`, `ls`,
  `which`, `command -v`, `basename`, `dirname`, and `realpath`) directly.
  It intentionally does **not** blanket-allow `find`, `sed`, `cat`, or shell
  pipelines: those can read secrets or use effectful flags despite looking
  like reconnaissance.
- Anything resolving to `ask` is always reviewed.
- A narrow list of categories is reviewed **even if** Layer 2 or a saved
  "Allow always" approval already resolved it to `allow` — see
  `SENSITIVE_RULES` in `policy.ts` for the exact patterns (currently: PR/issue
  merge-close-delete, GitHub repo mutation, `gh api` mutations, releases/tags,
  `git reset --hard`, `git clean -f*`, remote branch deletion, rebase/filter,
  auth/login changes, publish/deploy commands, cloud/infra mutations, network
  uploads via curl/wget/scp/rsync, `.env`/credentials-file reads, and
  installing a new dependency).

### Expected prompts

Prompting is intentional for anything outside the exact trusted-worktree set:
commits, history rewrites other than the exact rebase, new or changed
dependencies, broader staging, remote mutation beyond a feature-branch push
or filled PR, sensitive files, and work outside the known worktree. Jev is a
fail-closed second check for those bounded asks; it is not a replacement for
the explicit deterministic trust decision above.

## Observability

`ctx.storage` under key `model-approval:stats` holds a small JSON object:
`{ reviewed, allow, ask, deny, failures, timeouts, totalLatencyMs }`. `deny`
remains a legacy counter and is never incremented by Jev. No raw
commands, no conversation text, no secrets are persisted — just counters, so
you can sanity-check how often the reviewer is actually firing without
creating a new leak surface.

On every plugin load, `model-approval:service-readiness` records only whether
the **running OpenCode service process** has the configured key, along with
the key variable name, selected reviewer model, timestamp, and one of
`configured`/`missing-api-key`. The value of the key is never stored or
logged. If a reviewer call discovers a missing key later, the permission
message says so explicitly and refreshes this record. This distinguishes a
reviewer outage from a genuine safety prompt.

## Known limitations

- This is a probabilistic safety aid, not a security boundary. Keep the Layer
  1 hard policies and deterministic permission rules; Jev only reduces normal
  approval friction.
- The 8-second timeout does not cancel a request already in flight. It only
  stops waiting and returns `ask`; the late result cannot change the pending
  permission decision.
- Restart the OpenCode service (or fully reopen the desktop app) after editing
  this global plugin/configuration so the running process reloads it. Restart
  interrupts active tasks. When the key is loaded from `~/.zshenv`, restart
  through a login shell so the detached service inherits that environment:

  ```bash
  /bin/zsh -lc '/Applications/OpenCode.app/Contents/Resources/opencode-cli service restart'
  ```

  A terminal having the key is not sufficient evidence: the readiness record
  above reflects the actual plugin host process.

## Testing

```bash
cd ~/.config/opencode/plugins/model-approval
mise run test
```

The tests cover options validation, all five required Jev answers, threshold
mapping, malformed-payload fallback, missing-key behavior before any network
call, sensitive-operation classification, redaction, bounded context, and
injection-safe state construction. The live integration proof sends three
non-mutating probes through the production reviewer: explicit `git status`
allows; an unauthorized `gh pr merge` asks; and an injected upload-shaped
command asks.

## Disabling / rolling back

**Fastest disable** (keeps everything else): remove the object entry for
`model-approval` from the `plugins` array in
`~/.config/opencode/opencode.jsonc`, then restart the service or reopen the
app. The hard `experimental.policies` block is independent of this plugin
and will keep working even with the plugin removed.

**Full rollback to the pre-setup config**: copy the timestamped backup back
into place —

```bash
cp ~/.config/opencode/backups/opencode.jsonc.bak-<timestamp> ~/.config/opencode/opencode.jsonc
```

(see `ls ~/.config/opencode/backups/` for the exact filename), then restart
the service. The plugin directory itself
(`~/.config/opencode/plugins/model-approval/`) can simply be left in place
unreferenced, or deleted — it has no effect unless listed in `plugins`.

## Extending

- Add a new hard-deny to `experimental.policies` in `opencode.jsonc` for
  anything that should be impossible regardless of context.
- Add a new sensitive-even-if-allowed pattern to `SENSITIVE_RULES` in
  `policy.ts` (with a test in `test/policy.test.ts`) for anything that should
  always get a contextual second look even when otherwise allowed.
- Everything else is arbitrated by the fixed state and five typed questions in
  `reviewer.ts` — edit those with tests, rather than adding ad-hoc branching
  logic in `index.ts`.
