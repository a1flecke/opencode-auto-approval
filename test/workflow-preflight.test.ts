import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { evaluateTrustedWorktreeCommand, resolveWorkflowDirectory } from "../workflow-preflight.js";

describe("resolveWorkflowDirectory", () => {
  test("uses the shell request cwd before the session base directory", () => {
    expect(
      resolveWorkflowDirectory(
        {
          sessionID: "session",
          action: "shell",
          resources: ["git rebase origin/main"],
          metadata: {
            cwd: "/home/user/dev/project/.worktrees/pr-1160-rebase",
          },
        },
        { directory: "/home/user/dev/project" },
      ),
    ).toBe("/home/user/dev/project/.worktrees/pr-1160-rebase");
  });

  test("fails closed for a non-absolute request directory", () => {
    expect(
      resolveWorkflowDirectory(
        { sessionID: "session", action: "shell", resources: ["git rebase origin/main"], metadata: { cwd: "../other" } },
        { directory: "/home/user/dev/project" },
      ),
    ).toBe("/home/user/dev/project");
  });

  test("uses the source tool's exact cd worktree when permission metadata has no cwd", () => {
    expect(
      resolveWorkflowDirectory(
        {
          sessionID: "session",
          action: "shell",
          resources: ["git rebase origin/main"],
          source: { type: "tool", messageID: "message", id: "shell-current" },
        },
        { directory: "/home/user/dev/project" },
        [
          {
            content: [
              {
                type: "tool",
                id: "shell-current",
                state: {
                  input: {
                    command:
                      "cd /home/user/dev/project/.worktrees/pr-1160-rebase && git rebase origin/main",
                  },
                },
              },
            ],
          },
        ],
      ),
    ).toBe("/home/user/dev/project/.worktrees/pr-1160-rebase");
  });

  test("uses the source shell tool's workdir field for a direct command (real OpenCode tool input shape)", () => {
    // Confirmed against a live recorded OpenCode shell tool call: the input
    // object is `{ command, timeout, workdir }`, never `cwd` or `directory`.
    // Before this field was checked, every trusted-workflow command whose
    // tool call had no literal `cd ... &&` prefix silently fell through to
    // the stale session directory, which is why the deterministic preflight
    // had never once returned "allow" in production (see plugin stats).
    expect(
      resolveWorkflowDirectory(
        {
          sessionID: "session",
          action: "shell",
          resources: ["git push --force-with-lease origin HEAD:opencode/issue-1019-canonical-owned-cities"],
          source: { type: "tool", messageID: "message", id: "shell-current" },
        },
        { directory: "/home/user/dev/project" },
        [
          {
            content: [
              {
                type: "tool",
                id: "shell-current",
                state: {
                  input: {
                    command: "git push --force-with-lease origin HEAD:opencode/issue-1019-canonical-owned-cities",
                    timeout: 1800000,
                    workdir: "/home/user/dev/project/.worktrees/opencode-issue-1019",
                  },
                },
              },
            ],
          },
        ],
      ),
    ).toBe("/home/user/dev/project/.worktrees/opencode-issue-1019");
  });

  test("uses the source shell tool cwd for a direct command", () => {
    expect(
      resolveWorkflowDirectory(
        {
          sessionID: "session",
          action: "shell",
          resources: ["GIT_EDITOR=true git rebase --continue"],
          source: { type: "tool", messageID: "message", id: "shell-current" },
        },
        { directory: "/home/user/dev/project" },
        [
          {
            content: [
              {
                type: "tool",
                id: "shell-current",
                state: {
                  input: {
                    command: "GIT_EDITOR=true git rebase --continue",
                    cwd: "/home/user/dev/project/.worktrees/pr-1160-rebase",
                  },
                },
              },
            ],
          },
        ],
      ),
    ).toBe("/home/user/dev/project/.worktrees/pr-1160-rebase");
  });
});


describe("scanner-split workflow pipelines", () => {
  let directory: string;
  beforeAll(async () => {
    const { mkdtemp, writeFile, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    directory = await realpath(await mkdtemp(join(tmpdir(), "approval-preflight-")));
    const git = async (...args: string[]) => {
      const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text());
    };
    await git("init", "-b", "feature/test");
    await git("remote", "add", "origin", "https://github.com/example/project.git");
    await writeFile(join(directory, "fixture.txt"), "fixture\n");
    await git("add", "--", "fixture.txt");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  });
  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });

  async function evaluate(command: string, resources: string[], sourceID = "shell-current", toolID = sourceID) {
    return evaluateTrustedWorktreeCommand({ session: {
      async get() { return { directory }; },
      async context() { return [{ content: [{ type: "tool", name: "shell", id: toolID,
        state: { input: { command, workdir: directory } } }] }]; },
    } }, { sessionID: "session", action: "shell", resources,
      source: { type: "tool", id: sourceID } }, {
      trustedRoots: [directory], trustedRemoteHosts: ["github.com"], defaultBranches: ["main", "master"],
    });
  }

  test.each([
    ["./scripts/run-with-mise.sh yarn build | tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -10"]],
    ["./scripts/run-with-mise.sh yarn build 2>&1 | tail -10", ["./scripts/run-with-mise.sh yarn build 2>&1", "tail -10"]],
    ["./scripts/run-with-mise.sh yarn build 2>&1 | tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -10"]],
    ['git ls-remote origin refs/heads/main | grep -E "passed|FAIL" | head -5',
      ["git ls-remote origin refs/heads/main", 'grep -E "passed|FAIL"', "head -5"]],
  ])("allows a validated pipeline from the exact source tool: %s", async (command, resources) => {
    expect(await evaluate(command, resources)).toMatchObject({ kind: "allow" });
  });

  test.each([
    ["./scripts/run-with-mise.sh yarn build; tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -10"]],
    ["./scripts/run-with-mise.sh yarn build && tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -10"]],
    ["./scripts/run-with-mise.sh yarn build | tail -10; touch output", ["./scripts/run-with-mise.sh yarn build", "tail -10"]],
    ["./scripts/run-with-mise.sh yarn build | tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -20"]],
    ["./scripts/run-with-mise.sh yarn build | tail -10", ["./scripts/run-with-mise.sh yarn build", "tail -10", "touch output"]],
    ["./scripts/run-with-mise.sh yarn build | tail -10 private.txt", ["./scripts/run-with-mise.sh yarn build", "tail -10 private.txt"]],
    ["./scripts/run-with-mise.sh yarn build | tee output", ["./scripts/run-with-mise.sh yarn build", "tee output"]],
  ])("keeps unsafe or mismatched scanner requests asking: %s", async (command, resources) => {
    expect(await evaluate(command, resources)).toMatchObject({ kind: "ask" });
  });

  test("retains a default-branch push guard through a validated pipeline", async () => {
    expect(await evaluate("git push origin main | tail -10", ["git push origin main", "tail -10"]))
      .toMatchObject({ kind: "ask", guard: true });
  });

  test("does not recover a pipeline from another tool invocation", async () => {
    expect(await evaluate("./scripts/run-with-mise.sh yarn build | tail -10",
      ["./scripts/run-with-mise.sh yarn build", "tail -10"], "shell-current", "shell-other"))
      .toMatchObject({ kind: "ask" });
  });
});
