import { describe, expect, test } from "bun:test";
import { bunPathExists, loadWorktreeMetadata, type PathExists, type RunReadOnly } from "../git-metadata.js";

const directory = "/home/user/dev/project/.worktrees/feature-x";

function fakeRun(calls: string[][]): RunReadOnly {
  return async (_directory, args) => {
    calls.push([...args]);
    const key = args.join(" ");
    const responses: Record<string, string> = {
      "git rev-parse --show-toplevel": "/home/user/dev/project\n",
      "git rev-parse --git-dir": "/home/user/dev/project/.git/worktrees/feature-x\n",
      "git branch --show-current": "feature/x\n",
      "git remote get-url origin": "git@github.com:example-org/project.git\n",
      "git diff --name-only HEAD -- package.json yarn.lock": "",
      "git ls-files --others --exclude-standard -- package.json yarn.lock": "",
      "git status --porcelain": "",
      "git diff --cached --name-only": "",
    };
    if (!(key in responses)) throw new Error(`unexpected probe: ${key}`);
    return responses[key];
  };
}

describe("loadWorktreeMetadata", () => {
  test("recognizes an existing directory used by Git for rebase state", async () => {
    await expect(bunPathExists(process.cwd())).resolves.toBe(true);
  });

  test("collects only fixed read-only Git metadata", async () => {
    const calls: string[][] = [];
    const pathExists: PathExists = async () => false;

    await expect(loadWorktreeMetadata(directory, fakeRun(calls), pathExists)).resolves.toEqual({
      directory,
      root: "/home/user/dev/project",
      branch: "feature/x",
      originUrl: "git@github.com:example-org/project.git",
      changedFiles: [],
      rebaseActive: false,
      hasUnresolvedConflicts: false,
      unresolvedConflictFiles: [],
      stagedFiles: [],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        ["git", "rev-parse", "--show-toplevel"],
        ["git", "rev-parse", "--git-dir"],
        ["git", "branch", "--show-current"],
        ["git", "remote", "get-url", "origin"],
        ["git", "diff", "--name-only", "HEAD", "--", "package.json", "yarn.lock"],
        ["git", "ls-files", "--others", "--exclude-standard", "--", "package.json", "yarn.lock"],
        ["git", "status", "--porcelain"],
        ["git", "diff", "--cached", "--name-only"],
      ]),
    );
  });

  test("treats an untracked dependency input as changed", async () => {
    const run: RunReadOnly = async (_directory, args) => {
      const key = args.join(" ");
      if (key === "git ls-files --others --exclude-standard -- package.json yarn.lock") return "yarn.lock\n";
      return fakeRun([])(_directory, args);
    };
    await expect(loadWorktreeMetadata(directory, run, async () => false)).resolves.toMatchObject({
      changedFiles: ["yarn.lock"],
    });
  });

  test("distinguishes an active rebase from unresolved conflicts without reading repository contents", async () => {
    const pathExists: PathExists = async (path) => path.endsWith("/rebase-merge");
    await expect(loadWorktreeMetadata(directory, fakeRun([]), pathExists)).resolves.toMatchObject({
      rebaseActive: true,
      hasUnresolvedConflicts: false,
    });
  });

  test("recovers the original feature branch from Git's rebase state when HEAD is detached", async () => {
    const run: RunReadOnly = async (cwd, args) => {
      if (args.join(" ") === "git branch --show-current") return "";
      return fakeRun([])(cwd, args);
    };
    const pathExists: PathExists = async (path) => path.endsWith("/rebase-merge");
    await expect(
      loadWorktreeMetadata(directory, run, pathExists, async () => "refs/heads/feature/x\n"),
    ).resolves.toMatchObject({ branch: "feature/x", rebaseActive: true });
  });

  test("returns null when a fixed metadata probe fails", async () => {
    const failing: RunReadOnly = async () => {
      throw new Error("not a repository");
    };
    await expect(loadWorktreeMetadata(directory, failing, async () => false)).resolves.toBeNull();
  });

  test("probes trusted scripts read-only and fails closed to no probe on error", async () => {
    const run: RunReadOnly = async (_d, args) => {
      const key = args.join(" ");
      const r: Record<string, string> = {
        "git rev-parse --show-toplevel": "/home/user/dev/project\n",
        "git rev-parse --git-dir": "/home/user/dev/project/.git\n",
        "git branch --show-current": "feature/x\n",
        "git remote get-url origin": "git@github.com:example-org/project.git\n",
        "git diff --name-only HEAD -- package.json yarn.lock": "",
        "git ls-files --others --exclude-standard -- package.json yarn.lock": "",
        "git status --porcelain": "",
        "git diff --cached --name-only": "",
        "git ls-files -- scripts/check-rules.sh": "scripts/check-rules.sh\n",
        "git diff --name-only --relative HEAD -- scripts": "scripts/lib.sh\n",
        "git ls-files --others -- scripts": "",
      };
      if (!(key in r)) throw new Error(`unexpected probe: ${key}`);
      return r[key];
    };
    const meta = await loadWorktreeMetadata(directory, run, async () => false, undefined, ["scripts/check-rules.sh"]);
    expect(meta?.scriptProbe).toEqual({ tracked: ["scripts/check-rules.sh"], dirty: ["scripts/lib.sh"] });
    const failing: RunReadOnly = async (d, args) => {
      if (args[1] === "ls-files" && args[2] === "--" && args[3] === "scripts/check-rules.sh") throw new Error("boom");
      return run(d, args);
    };
    const degraded = await loadWorktreeMetadata(directory, failing, async () => false, undefined, ["scripts/check-rules.sh"]);
    expect(degraded).not.toBeNull();
    expect(degraded?.scriptProbe).toBeUndefined();
  });
});
