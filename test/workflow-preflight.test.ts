import { describe, expect, test } from "bun:test";
import { resolveWorkflowDirectory } from "../workflow-preflight.js";

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
