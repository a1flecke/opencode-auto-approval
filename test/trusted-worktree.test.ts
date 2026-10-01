import { describe, expect, test } from "bun:test";
import {
  evaluateRoutineProcessCheck,
  evaluateTrustedWorkflowBatch,
  evaluateTrustedWorkflow,
  type TrustedWorkflowOptions,
  type WorktreeMetadata,
} from "../trusted-worktree.js";

const options: TrustedWorkflowOptions = {
  trustedRoots: ["/home/user/dev"],
  trustedRemoteHosts: ["github.com"],
  defaultBranches: ["main", "master"],
};

function fixture(overrides: Partial<WorktreeMetadata> = {}): WorktreeMetadata {
  return {
    directory: "/home/user/dev/project/.worktrees/feature-x",
    root: "/home/user/dev/project",
    branch: "feature/x",
    originUrl: "git@github.com:example-org/project.git",
    changedFiles: [],
    rebaseActive: false,
    hasUnresolvedConflicts: false,
    unresolvedConflictFiles: [],
    stagedFiles: [],
    ...overrides,
  };
}

function decide(command: string, overrides: Partial<WorktreeMetadata> = {}) {
  return evaluateTrustedWorkflow(command, fixture(overrides), options);
}

describe("evaluateTrustedWorkflow", () => {
  test("allows a filtered status check for an active test-profile process", () => {
    expect(
      evaluateRoutineProcessCheck(["ps aux", 'grep -i "yarn test:profile:default"', "grep -v grep"]),
    ).toMatchObject({ kind: "allow", category: "process-status" });
  });

  test.each([
    ["ps aux", 'grep -i "OPENCODE_GO_API_KEY"', "grep -v grep"],
    ["ps aux", 'grep -i "yarn test:profile:default"', "grep -v root"],
    ["ps aux", 'grep -i "yarn test:profile:default"'],
  ])("does not claim broad or malformed process inspection", (resources) => {
    expect(evaluateRoutineProcessCheck(resources)).toEqual({ kind: "unrecognized" });
  });

  test.each([
    ["./scripts/run-with-mise.sh yarn install", "locked-install"],
    ["./scripts/run-with-mise.sh yarn test", "project-verification"],
    ["./scripts/run-with-mise.sh yarn test:durable", "project-verification"],
    ["./scripts/run-with-mise.sh yarn build", "project-verification"],
    ["./scripts/run-with-mise.sh yarn verify:pr", "project-verification"],
    ["git add src/main.ts tests/main.test.ts", "stage-explicit-files"],
    ["git add -- src/main.ts tests/main.test.ts", "stage-explicit-files"],
    ["git fetch origin", "fetch-origin"],
    ["git rebase origin/main", "rebase-origin-main"],
    ["git ls-remote origin refs/heads/feature/x", "inspect-remote-feature-branch"],
    ["git push origin HEAD", "push-feature-branch"],
    ["git push origin feature/x", "push-feature-branch"],
    ["git push --force-with-lease origin HEAD:feature/x", "push-feature-branch-with-lease"],
    ["gh pr create --base main --head feature/x --fill", "create-pull-request"],
  ])("allows the trusted workflow: %s", (command, category) => {
    expect(decide(command)).toMatchObject({ kind: "allow", category });
  });

  test.each([
    ["./scripts/run-with-mise.sh yarn install", { changedFiles: ["yarn.lock"] }],
    ["./scripts/run-with-mise.sh yarn install", { changedFiles: ["package.json"] }],
    ["git add .", {}],
    ["git add -A", {}],
    ["git add .env", {}],
    ["git add config/credentials.json", {}],
    ["git add ~/.ssh/id_ed25519", {}],
    ["git fetch --all", {}],
    ["git fetch fork", {}],
    ["git rebase origin/main --rebase-merges", {}],
    ["GIT_EDITOR=true git rebase origin/main", {}],
    ["GIT_EDITOR=true git rebase origin/main | tail -40", {}],
    ["git rebase origin/main", { branch: "main" }],
    ["git rebase origin/main", { rebaseActive: true }],
    ["git ls-remote origin refs/heads/main", {}],
    ["git ls-remote upstream refs/heads/feature/x", {}],
    ["git push origin main", { branch: "main" }],
    ["git push --force origin HEAD", {}],
    ["git push --force-with-lease origin HEAD", {}],
    ["git push --force-with-lease origin HEAD:main", {}],
    ["git push --force-with-lease=refs/heads/feature/x origin HEAD:feature/x", {}],
    ["git push --force-with-lease origin HEAD:feature/x", { rebaseActive: true }],
    ["git push origin --tags", {}],
    ["git push fork HEAD", {}],
    ["gh pr create --base main --head feature/x --fill --draft", {}],
    ["gh pr create --base develop --head feature/x --fill", {}],
    ["git add src/main.ts && git push origin HEAD", {}],
  ])("asks when the trusted-worktree contract is not met: %s", (command, overrides) => {
    expect(decide(command, overrides).kind).toBe("ask");
  });

  test("asks outside the trusted roots or GitHub origin", () => {
    expect(decide("git push origin HEAD", { directory: "/tmp/project", root: "/tmp/project" }).kind).toBe("ask");
    expect(decide("git push origin HEAD", { originUrl: "git@gitlab.com:group/project.git" }).kind).toBe("ask");
  });

  test("does not claim unfamiliar shell commands", () => {
    expect(decide("python scripts/release.py")).toEqual({ kind: "unrecognized" });
  });

  test("allows an explicit safe stage followed by rebase continuation", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["git add tests/simulation/ai-playability-fixture.ts", "git rebase --continue"],
        fixture({
          rebaseActive: true,
          stagedFiles: ["tests/simulation/ai-playability-fixture.ts"],
        }),
        options,
      ),
    ).toMatchObject({ kind: "allow", category: "rebase-continue" });
  });

  test("allows non-interactive rebase continuation after a conflict-free safe stage", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["GIT_EDITOR=true git rebase --continue"],
        fixture({
          rebaseActive: true,
          stagedFiles: ["tests/simulation/ai-playability-fixture.ts"],
        }),
        options,
      ),
    ).toMatchObject({ kind: "allow", category: "rebase-continue" });
  });

  test("does not recognize arbitrary environment-prefixed rebases", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["GIT_EDITOR=vim git rebase --continue"],
        fixture({ rebaseActive: true, stagedFiles: ["tests/simulation/ai-playability-fixture.ts"] }),
        options,
      ),
    ).toEqual({ kind: "unrecognized" });
  });

  test("allows non-interactive continuation while Git still has an unresolved conflict", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["GIT_EDITOR=true git rebase --continue"],
        fixture({
          rebaseActive: true,
          hasUnresolvedConflicts: true,
          unresolvedConflictFiles: ["scripts/ci-test-shards.json"],
        }),
        options,
      ),
    ).toMatchObject({ kind: "allow", category: "rebase-continue" });
  });

  test.each([
    [{ rebaseActive: false, stagedFiles: ["tests/simulation/ai-playability-fixture.ts"] }],
    [{ rebaseActive: true, hasUnresolvedConflicts: true, stagedFiles: ["tests/simulation/ai-playability-fixture.ts"] }],
    [{ rebaseActive: true, stagedFiles: [".env"] }],
  ])("asks before continuing a rebase unless every safety condition is met", (overrides) => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["git add tests/simulation/ai-playability-fixture.ts", "git rebase --continue"],
        fixture(overrides),
        options,
      ).kind,
    ).toBe("ask");
  });

  test("allows the projected result of staging every resolved conflict before continuing", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["git add tests/simulation/ai-playability-fixture.ts", "git rebase --continue"],
        fixture({
          rebaseActive: true,
          hasUnresolvedConflicts: true,
          unresolvedConflictFiles: ["tests/simulation/ai-playability-fixture.ts"],
          stagedFiles: ["tests/helpers/save-state-invariants.ts"],
        }),
        options,
      ),
    ).toMatchObject({ kind: "allow", category: "rebase-continue", reason: expect.stringContaining("will resolve") });
  });

  test("asks when the stage command does not cover every unresolved conflict", () => {
    expect(
      evaluateTrustedWorkflowBatch(
        ["git add tests/simulation/ai-playability-fixture.ts", "git rebase --continue"],
        fixture({
          rebaseActive: true,
          hasUnresolvedConflicts: true,
          unresolvedConflictFiles: ["tests/simulation/ai-playability-fixture.ts", "src/main.ts"],
        }),
        options,
      ).kind,
    ).toBe("ask");
  });
});

describe("guard asks (safe to tighten an already-allowed command)", () => {
  test.each([
    ["git push origin main", {}],
    ["git push origin HEAD:main", {}],
    ["git push origin HEAD:refs/heads/master", {}],
    ["git push origin feature/x HEAD:main", {}],
    ["git push upstream HEAD", {}],
    ["git push origin other-branch", {}],
    ["git push origin HEAD", { branch: "main" }],
    ["git rebase origin/main", { branch: "main" }],
    ["git add .env", {}],
  ] as const)("%s is a guard ask", (command, overrides) => {
    expect(decide(command, overrides)).toMatchObject({ kind: "ask", guard: true });
  });

  test.each([
    "git push -u origin HEAD",
    "git push",
    "git add -A",
    "git add .",
    "./scripts/run-with-mise.sh yarn test tests/foo.test.ts",
    "git rebase origin/develop",
  ])("%s is a non-canonical shape, not a guard ask", (command) => {
    const decision = decide(command);
    expect(decision.kind === "ask" ? decision.guard : undefined).toBeUndefined();
  });
});

test("a guard ask survives outside a trusted worktree", () => {
  expect(decide("git push origin main", { directory: "/tmp/p", root: "/tmp/p" })).toMatchObject({ kind: "ask", guard: true });
});

test("a guard ask survives outside a trusted worktree", () => {
  expect(decide("git push origin main", { directory: "/tmp/p", root: "/tmp/p" })).toMatchObject({ kind: "ask", guard: true });
});
