/**
 * Deterministic approval for a deliberately small trusted-worktree workflow.
 * This module never executes commands or reads files. The runtime adapter
 * supplies already-collected Git metadata, making the decision logic easy to
 * audit and unit test.
 */

import { splitOutputFilters } from "./output-filters.js";
import { shellWords } from "./shell-words.js";

export interface TrustedWorkflowOptions {
  readonly trustedRoots: readonly string[];
  readonly trustedRemoteHosts: readonly string[];
  readonly defaultBranches: readonly string[];
  /**
   * Exact worktree-relative paths (e.g. `scripts/check-rules.sh`) of project
   * scripts the user has vetted. Defaults to none; lives only in user config.
   */
  readonly trustedScripts?: readonly string[];
}

/** Result of the read-only probe for trusted project scripts. */
export interface ScriptProbe {
  /** Trusted-script paths that are tracked by Git. */
  readonly tracked: readonly string[];
  /** Paths under the trusted scripts' directories that differ from HEAD, or are untracked/ignored. */
  readonly dirty: readonly string[];
}

export interface WorktreeMetadata {
  readonly directory: string;
  readonly root: string;
  readonly branch: string;
  readonly originUrl: string;
  readonly changedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly rebaseActive: boolean;
  readonly hasUnresolvedConflicts: boolean;
  readonly unresolvedConflictFiles: readonly string[];
  /** Absent when no trusted scripts are configured or the probe failed (fails closed). */
  readonly scriptProbe?: ScriptProbe;
}

export type WorkflowDecision =
  | { readonly kind: "allow"; readonly category: string; readonly reason: string }
  /**
   * `guard: true` marks an ask that is a safety-invariant violation (default
   * branch, wrong target/remote, unsafe staged path), as opposed to a mere
   * "not the exact canonical shape". Only guard asks may tighten a command a
   * static rule or stored approval already allowed.
   */
  | { readonly kind: "ask"; readonly category: string; readonly reason: string; readonly guard?: true }
  | { readonly kind: "unrecognized" };

const SHELL_COMPOSITION = /(?:;|&&|\|\||(?<!\|)\|(?!\|)|(?:^|\s)[<>]|\$\(|`|\$[A-Za-z_{])/;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|\.pypirc$|credentials\.json$|\.ssh(?:\/|$)|[^/]+\.(?:pem|key)$)/i;
const ROUTINE_PROCESS_PATTERNS = new Set([
  "yarn test:profile:default",
  "yarn test:durable",
  "yarn verify:pr",
  "yarn test",
  "yarn build",
  "yarn dev",
  "vitest",
  "vite",
  "cargo test",
  "cargo build",
]);

const SCRIPT_ARG = /^[A-Za-z0-9_@+][A-Za-z0-9._/@+-]*$/;

/** A trusted-script entry is a plain worktree-relative path inside a directory, never secret-like. */
export function isValidTrustedScriptPath(path: string): boolean {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return !SECRET_PATH.test(path);
}

function scriptPathOf(command: string, options: TrustedWorkflowOptions): string | null {
  if (!command.startsWith("./")) return null;
  const script = command.split(/\s+/)[0].slice(2);
  return options.trustedScripts?.includes(script) ? script : null;
}

const BASH_WRAPPER_PREFIX = "bash scripts/run-with-mise.sh yarn ";

/**
 * `bash scripts/run-with-mise.sh yarn …` runs the same file as
 * `./scripts/run-with-mise.sh yarn …`. Only that exact prefix is rewritten (no
 * bash flags, absolute paths, or `bash ./…`); everything after it is judged
 * unchanged by the canonical-form checks.
 */
function canonicalWrapperSpelling(command: string): string {
  return command.startsWith(BASH_WRAPPER_PREFIX) ? `./scripts/run-with-mise.sh yarn ${command.slice(BASH_WRAPPER_PREFIX.length)}` : command;
}

/**
 * True only for a command family this deterministic preflight owns. A project
 * script is owned only when the user listed it in `trustedScripts`; any other
 * script stays with the reviewer exactly as before.
 */
export function isTrustedWorkflowCandidate(command: string, options?: TrustedWorkflowOptions): boolean {
  const trimmed = canonicalWrapperSpelling(command.trim());
  if (options && scriptPathOf(trimmed, options) !== null) return true;
  return /^(?:\.\/scripts\/run-with-mise\.sh yarn (?:install|test|build|verify:)|git (?:add|fetch|ls-remote|rebase|push|blame)(?:\s|$)|GIT_EDITOR=true git rebase(?:\s|$)|gh pr create(?:\s|$))/.test(
    trimmed,
  );
}

function scriptDecision(script: string, tokens: readonly string[], metadata: WorktreeMetadata): WorkflowDecision {
  const category = "trusted-script";
  const args = tokens.slice(1);
  if (!args.every((arg) => SCRIPT_ARG.test(arg) && isSafeStagePath(arg))) {
    return ask(category, "A trusted script is automatic only with explicit non-sensitive in-worktree path arguments.");
  }
  const probe = metadata.scriptProbe;
  if (!probe) return ask(category, "Could not verify the trusted script against Git; human approval is required.");
  if (!probe.tracked.includes(script)) {
    return guardAsk(category, "The script is not tracked by Git, so it is not the vetted version.");
  }
  const dir = `${script.slice(0, script.lastIndexOf("/"))}/`;
  if (probe.dirty.some((path) => path.startsWith(dir))) {
    return guardAsk(category, "The script's directory has changes or untracked files not in HEAD; review before running.");
  }
  return { kind: "allow", category, reason: "Vetted project script, unchanged from HEAD, with explicit path arguments only." };
}

const BLAME_RANGE = /^\d+(?:,(?:\d+|\+\d+))?$/;

/** `git blame` is read-only: one explicit file, with only a line range and whitespace/format flags. */
function blameDecision(tokens: readonly string[]): WorkflowDecision {
  const category = "git-blame";
  const rest = tokens.slice(2);
  const files: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "-L") {
      if (i + 1 >= rest.length || !BLAME_RANGE.test(rest[i + 1])) return ask(category, "Automatic blame accepts only a numeric -L line range.");
      i += 1;
    } else if (token === "-w" || token === "-s" || token === "-e" || token === "--") {
      continue;
    } else if (token.startsWith("-")) {
      return ask(category, "Automatic blame accepts only -L, -w, -s, and -e.");
    } else {
      files.push(token);
    }
  }
  if (files.length !== 1) return ask(category, "Automatic blame requires exactly one explicit file path.");
  if (SECRET_PATH.test(files[0])) return guardAsk(category, "Blaming a secret-like path is never automatic.");
  if (!isSafeStagePath(files[0])) return ask(category, "Automatic blame is limited to an explicit in-worktree path.");
  return { kind: "allow", category, reason: "Read-only blame of one explicit non-sensitive file." };
}

function ask(category: string, reason: string): WorkflowDecision {
  return { kind: "ask", category, reason };
}

function guardAsk(category: string, reason: string): WorkflowDecision {
  return { kind: "ask", category, reason, guard: true };
}

/**
 * Accept only a narrow, read-only process-status query. The selected runner
 * names are intentionally finite: arbitrary `ps aux` filtering can expose
 * unrelated command-line arguments, including credentials.
 */
export function evaluateRoutineProcessCheck(resources: readonly string[]): WorkflowDecision {
  if (resources.length !== 3 || resources[0].trim() !== "ps aux" || resources[2].trim() !== "grep -v grep") {
    return { kind: "unrecognized" };
  }
  const match = resources[1].trim().match(/^grep -i (["'])([^"']+)\1$/);
  if (!match || !ROUTINE_PROCESS_PATTERNS.has(match[2].toLowerCase())) return { kind: "unrecognized" };
  return {
    kind: "allow",
    category: "process-status",
    reason: "Read-only check for a known local build or test runner.",
  };
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = path.replace(/\/+$/, "");
  const normalizedRoot = root.replace(/\/+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function originHost(originUrl: string): string | null {
  const ssh = originUrl.match(/^[^@\s]+@([^:\s]+):/);
  if (ssh) return ssh[1].toLowerCase();
  try {
    return new URL(originUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasTrustedBoundary(metadata: WorktreeMetadata, options: TrustedWorkflowOptions): boolean {
  if (metadata.branch.length === 0 || metadata.root.length === 0) return false;
  if (!options.trustedRoots.some((root) => isWithin(metadata.directory, root) && isWithin(metadata.root, root))) return false;
  const host = originHost(metadata.originUrl);
  return host !== null && options.trustedRemoteHosts.some((candidate) => candidate.toLowerCase() === host);
}

function isDefaultBranch(branch: string, options: TrustedWorkflowOptions): boolean {
  return options.defaultBranches.some((candidate) => candidate === branch);
}

function hasChangedInstallInputs(metadata: WorktreeMetadata): boolean {
  return metadata.changedFiles.some((file) => file === "package.json" || file === "yarn.lock");
}

function stagePaths(tokens: readonly string[]): readonly string[] | null {
  if (tokens[0] !== "git" || tokens[1] !== "add" || tokens.length < 3) return null;
  const rest = tokens.slice(2);
  const usesSeparator = rest[0] === "--";
  const paths = usesSeparator ? rest.slice(1) : rest;
  if (paths.length === 0 || (!usesSeparator && rest.some((token) => token.startsWith("-")))) return null;
  return paths;
}

function stageCommandPaths(command: string): readonly string[] | null {
  return stagePaths(command.split(/\s+/));
}

function isNonInteractiveRebaseContinuation(command: string): boolean {
  return command === "GIT_EDITOR=true git rebase --continue";
}

function isSafeStagePath(path: string): boolean {
  if (path.length === 0 || path === "." || path === ".." || path.startsWith("/") || path.startsWith("~")) return false;
  if (path.includes("../") || path.includes("/..") || /[*?{}\[\]]/.test(path)) return false;
  return !SECRET_PATH.test(path);
}

/**
 * `gh pr create` for the current feature branch against a default branch.
 * Metadata flags (--title/--body/--body-file/--fill/--draft) are accepted, each
 * at most once; anything that changes the target (--repo, --web, reviewers,
 * --head/--base other than the exact trusted values) asks.
 */
function prCreateDecision(command: string, metadata: WorktreeMetadata, options: TrustedWorkflowOptions): WorkflowDecision {
  const category = "create-pull-request";
  const words = shellWords(command);
  const fail = ask(category, "Only a pull request from the current feature branch to the default branch, with --title/--body/--body-file/--fill/--draft, is automatic.");
  if (!words || isDefaultBranch(metadata.branch, options)) return fail;
  const seen = new Set<string>();
  for (let i = 3; i < words.length; i += 1) {
    const flag = words[i];
    if (seen.has(flag)) return fail;
    seen.add(flag);
    if (flag === "--fill" || flag === "--draft") continue;
    const value = words[i + 1];
    if (value === undefined) return fail;
    i += 1;
    if (flag === "--base") {
      if (!options.defaultBranches.includes(value)) return fail;
    } else if (flag === "--head") {
      if (value !== metadata.branch) return fail;
    } else if (flag === "--body-file") {
      if (!isSafeStagePath(value)) return fail;
    } else if (flag !== "--title" && flag !== "--body") {
      return fail;
    }
  }
  if (!seen.has("--base") || !seen.has("--head")) return fail;
  return { kind: "allow", category, reason: "A pull request is being created for the current feature branch." };
}

function commandFamily(command: string, metadata: WorktreeMetadata, options: TrustedWorkflowOptions): WorkflowDecision {
  if (command === "./scripts/run-with-mise.sh yarn install") {
    return hasChangedInstallInputs(metadata)
      ? ask("locked-install", "package.json or yarn.lock changed; review the dependency change before installing.")
      : { kind: "allow", category: "locked-install", reason: "Trusted worktree has an unchanged Yarn dependency set." };
  }

  if (/^\.\/scripts\/run-with-mise\.sh yarn (?:test(?::[A-Za-z0-9:_-]+)?|build(?::[A-Za-z0-9:_-]+)?|verify:[A-Za-z0-9:_-]+)$/.test(command)) {
    return { kind: "allow", category: "project-verification", reason: "Trusted worktree project verification command." };
  }

  const tokens = command.split(/\s+/);
  const script = scriptPathOf(command, options);
  if (script !== null) return scriptDecision(script, tokens, metadata);
  if (tokens[0] === "git" && tokens[1] === "blame") return blameDecision(tokens);
  const paths = stagePaths(tokens);
  if (paths !== null) {
    return paths.every(isSafeStagePath)
      ? { kind: "allow", category: "stage-explicit-files", reason: "Only explicit non-sensitive paths are being staged." }
      : paths.some((path) => SECRET_PATH.test(path))
        ? guardAsk("stage-explicit-files", "Staging a secret-like path is never automatic.")
        : ask("stage-explicit-files", "Staging must name only explicit non-sensitive paths within the worktree.");
  }
  if (tokens[0] === "git" && tokens[1] === "add") {
    return ask("stage-explicit-files", "Only explicit non-sensitive paths may be staged automatically.");
  }

  if (tokens[0] === "git" && tokens[1] === "fetch") {
    return command === "git fetch origin"
      ? { kind: "allow", category: "fetch-origin", reason: "Fetches remote-tracking state from the trusted origin without publishing changes." }
      : ask("fetch-origin", "Automatic fetch is limited to the exact trusted origin.");
  }

  if (/^GIT_EDITOR=true git rebase(?:\s|$)/.test(command)) {
    return ask(
      "rebase-origin-main",
      "Run the initial rebase as `git rebase origin/main`; the non-interactive editor setting is reserved for rebase continuation.",
    );
  }

  if (command === "git rebase origin/main") {
    if (isDefaultBranch(metadata.branch, options)) return guardAsk("rebase-origin-main", "The default branch is never rebased automatically.");
    if (metadata.rebaseActive || metadata.hasUnresolvedConflicts) {
      return ask("rebase-origin-main", "A rebase or conflict is already in progress.");
    }
    return { kind: "allow", category: "rebase-origin-main", reason: "Feature branch is rebasing exactly onto origin/main." };
  }
  if (tokens[0] === "git" && tokens[1] === "rebase") return ask("rebase-origin-main", "Only an exact rebase onto origin/main is automatic.");

  if (tokens[0] === "git" && tokens[1] === "ls-remote") {
    const expected = `git ls-remote origin refs/heads/${metadata.branch}`;
    return command === expected && !isDefaultBranch(metadata.branch, options)
      ? {
          kind: "allow",
          category: "inspect-remote-feature-branch",
          reason: "Read-only inspection of the current feature branch on the trusted origin.",
        }
      : ask(
          "inspect-remote-feature-branch",
          "Automatic remote inspection is limited to the current feature branch on origin.",
        );
  }

  if (tokens[0] === "git" && tokens[1] === "push") {
    const expectedLeaseRefspec = `HEAD:${metadata.branch}`;
    const isExactLeasePush =
      tokens.length === 5 &&
      tokens[2] === "--force-with-lease" &&
      tokens[3] === "origin" &&
      tokens[4] === expectedLeaseRefspec;
    if (isExactLeasePush) {
      if (isDefaultBranch(metadata.branch, options)) {
        return guardAsk("push-feature-branch-with-lease", "The default branch is never force-pushed automatically.");
      }
      if (metadata.rebaseActive || metadata.hasUnresolvedConflicts) {
        return ask("push-feature-branch-with-lease", "Finish the rebase and resolve every conflict before updating the feature branch.");
      }
      return {
        kind: "allow",
        category: "push-feature-branch-with-lease",
        reason: "Lease-protected update of the current feature branch on the trusted origin after a clean rebase.",
      };
    }
    const namesDefaultBranch = tokens
      .slice(2)
      .some((token) => options.defaultBranches.some((b) => token === b || token === `refs/heads/${b}` || token.endsWith(`:${b}`) || token.endsWith(`:refs/heads/${b}`)));
    if (namesDefaultBranch) return guardAsk("push-feature-branch", "A push naming the default branch is never automatic.");
    if (tokens.length >= 3 && !tokens[2].startsWith("-") && tokens[2] !== "origin") {
      return guardAsk("push-feature-branch", "Automatic pushes go only to the trusted origin remote.");
    }
    if (tokens.length !== 4 || tokens[2] !== "origin") return ask("push-feature-branch", "Only an origin feature-branch push is automatic.");
    if (isDefaultBranch(metadata.branch, options)) return guardAsk("push-feature-branch", "The default branch is never pushed automatically.");
    if (tokens[3] !== "HEAD" && tokens[3] !== metadata.branch) return guardAsk("push-feature-branch", "Push target must be the current feature branch.");
    return { kind: "allow", category: "push-feature-branch", reason: "Current feature branch is pushed to origin without force or refspec rewrite." };
  }

  if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "create") {
    return prCreateDecision(command, metadata, options);
  }

  return { kind: "unrecognized" };
}

function evaluateRebaseContinuation(
  stageCommand: string | undefined,
  continueCommand: string | undefined,
  metadata: WorktreeMetadata,
  options: TrustedWorkflowOptions,
): WorkflowDecision {
  if (continueCommand !== "git rebase --continue" && !isNonInteractiveRebaseContinuation(continueCommand)) {
    return { kind: "unrecognized" };
  }
  if (!stageCommand && !isNonInteractiveRebaseContinuation(continueCommand)) {
    return ask("rebase-continue", "Rebase continuation must stage explicit non-sensitive paths in the same request.");
  }

  if (stageCommand) {
    const stage = commandFamily(stageCommand, metadata, options);
    if (stage.kind !== "allow" || stage.category !== "stage-explicit-files") {
      return ask("rebase-continue", "Only explicit non-sensitive paths may be staged before continuing a rebase.");
    }
  }
  if (isDefaultBranch(metadata.branch, options)) {
    return ask("rebase-continue", "The default branch is never rebased automatically.");
  }
  if (!metadata.rebaseActive) {
    return ask("rebase-continue", "Rebase continuation requires an active rebase.");
  }
  if (!stageCommand && isNonInteractiveRebaseContinuation(continueCommand) && metadata.hasUnresolvedConflicts) {
    return {
      kind: "allow",
      category: "rebase-continue",
      reason: "Git will safely refuse this non-interactive continuation until the remaining conflicts are staged explicitly.",
    };
  }
  const pathsToStage = stageCommand ? stageCommandPaths(stageCommand) : [];
  if (stageCommand && !pathsToStage) {
    return ask("rebase-continue", "Rebase continuation must stage explicit non-sensitive paths.");
  }
  if (metadata.hasUnresolvedConflicts) {
    if (
      metadata.unresolvedConflictFiles.length === 0 ||
      !metadata.unresolvedConflictFiles.every((path) => pathsToStage.includes(path))
    ) {
      return ask("rebase-continue", "The stage command must cover every unresolved conflict before continuing a rebase.");
    }
  }
  const projectedStagedFiles = [...new Set([...metadata.stagedFiles, ...(pathsToStage ?? [])])];
  if (projectedStagedFiles.length === 0 || !projectedStagedFiles.every(isSafeStagePath)) {
    return ask("rebase-continue", "Every staged file must be an explicit non-sensitive path before continuing a rebase.");
  }
  return {
    kind: "allow",
    category: "rebase-continue",
    reason: metadata.hasUnresolvedConflicts
      ? "The explicit stage command will resolve every remaining conflict with only non-sensitive files before continuing the trusted feature-branch rebase."
      : "Trusted feature worktree has an active, conflict-free rebase and only explicit non-sensitive files staged.",
  };
}

/**
 * Evaluates the only compound workflow request we permit: an explicit,
 * non-sensitive stage followed immediately by `git rebase --continue`.
 */
export function evaluateTrustedWorkflowBatch(
  commands: readonly string[],
  metadata: WorktreeMetadata,
  options: TrustedWorkflowOptions,
): WorkflowDecision {
  const normalized = commands.map((command) => command.trim());
  if (normalized.length === 1) {
    if (isNonInteractiveRebaseContinuation(normalized[0])) {
      if (!hasTrustedBoundary(metadata, options)) {
        return ask("rebase-continue", "This command is automatic only inside a trusted GitHub worktree.");
      }
      return evaluateRebaseContinuation(undefined, normalized[0], metadata, options);
    }
    return evaluateTrustedWorkflow(normalized[0], metadata, options);
  }
  if (normalized.length !== 2 || normalized.some((command) => SHELL_COMPOSITION.test(command))) {
    return ask("command-shape", "Automatic workflow approval requires one command or an explicit stage followed by rebase continuation.");
  }

  const stage = normalized.find((command) => /^git add(?:\s|$)/.test(command));
  const continuation = normalized.find((command) => command === "git rebase --continue");
  if (!stage || !continuation) {
    return ask("command-shape", "Automatic workflow approval permits only an explicit stage followed by rebase continuation.");
  }
  if (!hasTrustedBoundary(metadata, options)) {
    return ask("rebase-continue", "This command is automatic only inside a trusted GitHub worktree.");
  }
  return evaluateRebaseContinuation(stage, continuation, metadata, options);
}

export function evaluateTrustedWorkflow(
  command: string,
  metadata: WorktreeMetadata,
  options: TrustedWorkflowOptions,
): WorkflowDecision {
  const normalized = canonicalWrapperSpelling(command.trim());
  if (normalized.length === 0) return { kind: "unrecognized" };

  const split = splitOutputFilters(normalized);
  if (split.kind === "filtered") {
    // The left-hand command is judged exactly as if the filters were absent.
    // Filters only ever bound what the agent sees of its output, so they can
    // pass an allow through or let a guard ask win, and nothing else.
    const decision = evaluateTrustedWorkflow(split.command, metadata, options);
    if (decision.kind === "allow") {
      return { ...decision, reason: `${decision.reason} Its output is bounded by read-only output filters.` };
    }
    if (decision.kind === "ask") return decision;
    // Not a command this preflight owns: behave exactly as for any composition.
  }

  if (SHELL_COMPOSITION.test(normalized)) {
    return isTrustedWorkflowCandidate(normalized, options)
      ? ask("command-shape", "Automatic workflow commands cannot contain shell composition or expansion, except a closed set of read-only output filters (tail, head, grep, wc -l) after an allowed command.")
      : { kind: "unrecognized" };
  }

  const family = commandFamily(normalized, metadata, options);
  if (family.kind === "unrecognized") return family;
  // A safety-invariant violation stays a guard ask wherever it happens.
  if (family.kind === "ask" && family.guard) return family;
  if (!hasTrustedBoundary(metadata, options)) {
    return ask(family.category, "This command is automatic only inside a trusted GitHub worktree.");
  }
  return family;
}
