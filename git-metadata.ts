/** Read-only Git metadata adapter for trusted-worktree permission checks. */

import path from "node:path";
import { stat } from "node:fs/promises";
import type { WorktreeMetadata } from "./trusted-worktree.js";

export type RunReadOnly = (directory: string, args: readonly string[]) => Promise<string>;
export type PathExists = (path: string) => Promise<boolean>;
export type ReadText = (path: string) => Promise<string>;

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasConflict(status: string): boolean {
  return unresolvedConflictFiles(status).length > 0;
}

function unresolvedConflictFiles(status: string): string[] {
  return lines(status)
    .filter((line) => /^(?:DD|AU|UD|UA|DU|AA|UU)\s/.test(line))
    .map((line) => line.slice(3));
}

function branchFromRebaseHeadName(value: string): string | null {
  const match = value.trim().match(/^refs\/heads\/(.+)$/);
  return match && match[1].length > 0 ? match[1] : null;
}

export async function loadWorktreeMetadata(
  directory: string,
  run: RunReadOnly,
  pathExists: PathExists,
  readText: ReadText = (target) => Bun.file(target).text(),
): Promise<WorktreeMetadata | null> {
  try {
    const [root, gitDir, branch, originUrl, changed, untrackedInputs, status, staged] = await Promise.all([
      run(directory, ["git", "rev-parse", "--show-toplevel"]),
      run(directory, ["git", "rev-parse", "--git-dir"]),
      run(directory, ["git", "branch", "--show-current"]),
      run(directory, ["git", "remote", "get-url", "origin"]),
      run(directory, ["git", "diff", "--name-only", "HEAD", "--", "package.json", "yarn.lock"]),
      run(directory, ["git", "ls-files", "--others", "--exclude-standard", "--", "package.json", "yarn.lock"]),
      run(directory, ["git", "status", "--porcelain"]),
      run(directory, ["git", "diff", "--cached", "--name-only"]),
    ]);
    const normalizedRoot = root.trim();
    const normalizedGitDir = gitDir.trim();
    const resolvedGitDir = path.isAbsolute(normalizedGitDir) ? normalizedGitDir : path.resolve(directory, normalizedGitDir);
    const conflicts = unresolvedConflictFiles(status);
    const hasUnresolvedConflicts = hasConflict(status);
    const rebaseMerge = path.join(resolvedGitDir, "rebase-merge");
    const rebaseApply = path.join(resolvedGitDir, "rebase-apply");
    const [hasRebaseMerge, hasRebaseApply] = await Promise.all([pathExists(rebaseMerge), pathExists(rebaseApply)]);
    const rebaseActive = hasRebaseMerge || hasRebaseApply;
    const recoveredBranch =
      rebaseActive && !branch.trim()
        ? branchFromRebaseHeadName(await readText(path.join(hasRebaseMerge ? rebaseMerge : rebaseApply, "head-name")))
        : null;
    const activeBranch = branch.trim() || recoveredBranch;
    if (!normalizedRoot || !normalizedGitDir || !activeBranch || !originUrl.trim()) return null;
    return {
      directory,
      root: normalizedRoot,
      branch: activeBranch,
      originUrl: originUrl.trim(),
      changedFiles: [...new Set([...lines(changed), ...lines(untrackedInputs)])],
      stagedFiles: lines(staged),
      rebaseActive,
      hasUnresolvedConflicts,
      unresolvedConflictFiles: conflicts,
    };
  } catch {
    return null;
  }
}

export const runBunReadOnly: RunReadOnly = async (directory, args) => {
  if (args[0] !== "git") throw new Error("trusted-worktree metadata only permits git probes");
  const process = Bun.spawn([...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Git metadata probe failed: ${stderr.slice(0, 200)}`);
  return stdout;
};

export const bunPathExists: PathExists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};
