# Trusted Worktree Permission Design

**Date:** 2026-09-27

## Goal

Make ordinary work in trusted local Git worktrees run without repeated
permission prompts while preserving prompts or hard blocks for account,
secret, machine, supply-chain, and irreversible remote risks.

## Trust boundary

Only a session located under `/home/user/dev`
can use the trusted-worktree workflow. The session directory must be a valid
Git worktree with an `origin` remote hosted on `github.com`. The configured
default branches are `main` and `master`.

Anything outside that boundary remains subject to the normal `ask` policy.
The preflight never changes a configured hard `deny`.

## Decision model

The permission hook evaluates an incoming shell `ask` in this order:

1. Existing hard policies deny privileged operations, force pushes, SSH-key
   reads, repository deletion, and whole-machine/home wipes.
2. A deterministic trusted-worktree preflight recognizes one exact command
   family and gathers only local Git metadata required for its contract.
3. If the preflight passes, it changes the permission to `allow` and records
   a bounded reason/category in plugin storage.
4. If it recognizes the family but a precondition fails, it leaves the event
   as `ask` and gives a concise reason. It never attempts to repair the
   command.
5. If it does not recognize the command, the existing Jev reviewer runs.
   Jev can return only `allow` or `ask`; errors and malformed responses ask.

## Automatically allowed command families

All commands below require the trusted-worktree boundary.

| Family | Required preconditions | Still asks when |
| --- | --- | --- |
| Locked install | The command is the project wrapper followed by `yarn install`; `package.json` and `yarn.lock` are unchanged from `HEAD`. | Manifest/lockfile changed, alternate package manager/source, or extra shell syntax (other than read-only output filters). |
| Test/build | The command is the project wrapper followed by `yarn test`, `yarn test:*`, `yarn build`, `yarn build:*`, or `yarn verify:*`. | Wrapper is absent, arbitrary shell is appended, or the worktree is untrusted. |
| Stage explicit files | `git add <one-or-more explicit paths>`, with an optional standalone `--`; every path is within the worktree, is not secret-like, and is not a broad selector. | Any option other than `--`, `.`/`-A`/`-u`, glob-like/broad staging, external path, a `.env*` file, `.npmrc`, `.netrc`, `.pypirc`, `credentials.json`, any path under `.ssh`, or a `*.pem`/`*.key` file. |
| Trusted project script | `./<path>` exactly as listed in the user-config `trustedScripts`, plus explicit non-secret in-worktree path arguments only; the script is tracked and nothing under its directory differs from `HEAD` or is untracked/ignored. | Unlisted script (reviewer decides), flags, composition, unsafe arguments, modified/untracked script (guard ask), or a failed probe. |
| Blame | `git blame` of one explicit non-secret file with only `-L`, `-w`, `-s`, `-e`, `--`. | Other flags, several files, secret-like or external path. |
| Remote ref inspection | `git ls-remote origin` with one to four quoted or plain explicit refs, each the current feature ref or a configured default branch; optional single terminal `2>&1`. | Other remotes/refs, wildcard selectors, flags, more than four refs or file redirection. |
| Rebase from origin/main | Exactly `git rebase origin/main`; current branch is not `main` or `master`; no rebase/conflict is already in progress. | Any flags, different target, default branch, or in-progress/conflicted rebase. |
| Feature-branch push | Exactly `git push origin HEAD` or a current non-default branch to the same-named remote branch; no force, tags, delete, refspec rewrite, or alternate remote. | Default branch, a different remote/refspec, any force/delete/tag option, or unknown branch state. |
| Pull-request creation | `gh pr create` for the current non-default branch against the same GitHub origin; the base is `main` or `master`; only `--fill`, `--draft`, `--title`, `--body`, `--body-file <safe path>` are accepted, each once. | Different repository/head/base, `--repo`/`--web`/reviewer or other options, composition inside a body (use `--body-file`), a non-GitHub remote, or unsupported command form. |

### Read-only output filters

Any family above may be followed by a closed grammar of output filters, because
agents bound transcripts with `2>&1 | tail -20` and similar:

```
<allowed command> [2>&1] | <filter> [| <filter> [| <filter>]]
filter := tail -N | tail -n N | head -N | head -n N   (N in 1..10000)
        | grep [-E|-F|-i|-v|-n|-c]... <one quoted or plain pattern>
        | wc -l
```

The left-hand command is evaluated by the existing decision exactly as if the
filters were absent, so a filter never makes a non-allowed command allowed and
a guard ask on the left-hand command still wins. Filters read stdin only (no
file operands, `-f`/`--follow`, `-r`/`-R`, `grep -f`, `--include`). The line is
split on unquoted `|` only; backslash, `$`, backtick, newline, `<`, `>`, `;`,
`&`, `(`, `)` and `#` comments are rejected anywhere, and a plain (unquoted)
pattern is limited to characters the shell never expands, so a glob cannot
become a file operand. `2>&1` is accepted only as the last token of the command,
before the first pipe. Explicit remote-ref inspection also accepts one terminal
`2>&1` without a filter. Anything else
(including `tee`, `> file`, `;`, `&&`, `||`, `cd dir &&`, a fourth filter, or
`awk`/`sed`/`sort`/`xargs`) is the same non-guard `command-shape` ask as before,
so it never newly prompts a command a stored approval allowed. The filters only
shape what the agent sees of output the allowed command already produced; they
cannot widen what that command could reveal.

At the runtime boundary, scanner-split filter resources are bound to the exact
source shell tool call. Its original command must pass the closed pipeline grammar,
and every scanner resource must match the expected stage in order. The adapter
never invents pipe operators from independent resources; missing sources, extra
commands and mismatches ask. Safety guards still apply to the command being filtered.

The preflight uses read-only Git queries only: repository root, current branch,
origin URL, default-branch comparison, status/rebase state, and the diff for
`package.json` plus `yarn.lock`. It does not read file
contents or execute a project script itself; for `trustedScripts` it only lists
tracked, changed and untracked paths under the listed scripts' directories.

## Jev's role

Jev remains `jev-1.13-free` on OpenCode's System One endpoint for unfamiliar,
simple, low-risk asks. It is not consulted to prove Git branch, remote,
lockfile, or staged-path conditions. Live calibration showed that it is
appropriately fail-closed but under-confident on composite test/stage/push
requests; deterministic local checks are more reliable for those cases.

Genuine user messages reserve 75% of the bounded reviewer conversation budget.
Messages are JSON-quoted data, so embedded speaker labels cannot impersonate
human instructions. Large messages retain their beginning and end; later user
restrictions and changed tasks override earlier permission. Truncated/missing scope
remains uncertainty. No authorization text is persisted.

PR approval is sensitive even under a static allow. The reviewer requires explicit
human approval intent for the exact PR and prohibits approval on an agent's own behalf.

## Safety invariants

- No preflight path can turn a hard configured denial into an allow.
- Any missing session/worktree/Git metadata results in `ask`.
- The parser accepts only a single supported command, never `;`, `&&`, `||`,
  redirection to a file, command substitution, or shell-variable expansion. The
  only pipes accepted are the read-only output filters above.
- Preflight output and storage contain categories/reasons only—never command
  output, secret values, or credentials.
- The preflight does not call the network or execute the proposed command.

## Verification

Unit tests will fake session and Git metadata and prove one allow and one ask
for each command family, including negative cases for changed lockfiles,
secret/broad staging, default-branch or force push, non-origin rebase, and
cross-repository PR creation. The existing no-review fast-path and Jev
fail-closed tests remain.

After the OpenCode GUI/service is closed, restart the service, run the plugin
suite, and execute harmless live hook probes for a wrapper test/build and a
feature-branch push dry-run. Any live check that could change Git state must
be an explicit user-authorized non-destructive probe or remain a simulated
unit test.
