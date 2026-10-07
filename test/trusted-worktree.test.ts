import { describe, expect, test } from "bun:test";
import {
  evaluateRoutineProcessCheck,
  evaluateTrustedWorkflowBatch,
  evaluateTrustedWorkflow,
  isTrustedWorkflowCandidate,
  isValidTrustedScriptPath,
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

const scriptOptions: TrustedWorkflowOptions = { ...options, trustedScripts: ["scripts/check-rules.sh"] };
const cleanProbe = { tracked: ["scripts/check-rules.sh"], dirty: [] as string[] };

function decideScript(command: string, overrides: Partial<WorktreeMetadata> = {}, opts = scriptOptions) {
  return evaluateTrustedWorkflow(command, fixture({ scriptProbe: cleanProbe, ...overrides }), opts);
}

describe("trusted scripts", () => {
  test.each([
    "./scripts/check-rules.sh",
    "./scripts/check-rules.sh src/core/example.ts",
    "./scripts/check-rules.sh src/a.ts src/b.ts",
  ])("allows a listed, unchanged script: %s", (command) => {
    expect(decideScript(command)).toMatchObject({ kind: "allow", category: "trusted-script" });
  });

  test("an unlisted script or an empty list stays unrecognized (reviewer path)", () => {
    expect(decideScript("./scripts/other.sh")).toEqual({ kind: "unrecognized" });
    expect(decideScript("./scripts/check-rules.sh", {}, options)).toEqual({ kind: "unrecognized" });
    expect(isTrustedWorkflowCandidate("./scripts/other.sh", scriptOptions)).toBe(false);
  });

  test.each([
    ["modified in worktree", { scriptProbe: { tracked: ["scripts/check-rules.sh"], dirty: ["scripts/check-rules.sh"] } }],
    ["sibling file added to scripts dir", { scriptProbe: { tracked: ["scripts/check-rules.sh"], dirty: ["scripts/lib.sh"] } }],
    ["untracked", { scriptProbe: { tracked: [], dirty: [] } }],
  ])("guard-asks when the script is %s", (_name, overrides) => {
    expect(decideScript("./scripts/check-rules.sh", overrides)).toMatchObject({ kind: "ask", guard: true });
  });

  test("asks (no guard) when the probe is missing", () => {
    const decision = decideScript("./scripts/check-rules.sh", { scriptProbe: undefined });
    expect(decision).toMatchObject({ kind: "ask" });
    expect((decision as { guard?: true }).guard).toBeUndefined();
  });

  test.each([
    "./scripts/check-rules.sh --fix",
    "./scripts/check-rules.sh ../secrets.txt",
    "./scripts/check-rules.sh /etc/passwd",
    "./scripts/check-rules.sh .env",
    "./scripts/check-rules.sh src/*.ts",
    "./scripts/check-rules.sh src/a.ts; rm -rf /",
    "./scripts/check-rules.sh $(whoami)",
  ])("near-miss still asks: %s", (command) => {
    expect(decideScript(command).kind).toBe("ask");
  });

  test("asks outside a trusted worktree", () => {
    expect(decideScript("./scripts/check-rules.sh", { directory: "/tmp/p", root: "/tmp/p" }).kind).toBe("ask");
  });

  test.each([["scripts/*.sh"], ["../x.sh"], ["/abs/x.sh"], ["x.sh"], ["scripts/.env"], ["scripts/a b.sh"]])(
    "rejects invalid trusted script entry %s",
    (entry) => expect(isValidTrustedScriptPath(entry)).toBe(false),
  );
  test("accepts a plain relative entry", () => expect(isValidTrustedScriptPath("scripts/check-rules.sh")).toBe(true));
});

describe("git blame", () => {
  test.each([
    "git blame src/core/turn-manager.ts",
    "git blame -L 150,162 src/core/turn-manager.ts",
    "git blame -L 150,+12 -w src/core/turn-manager.ts",
    "git blame -w -- src/core/turn-manager.ts",
  ])("allows read-only blame: %s", (command) => {
    expect(decide(command)).toMatchObject({ kind: "allow", category: "git-blame" });
  });

  test.each([
    "git blame",
    "git blame --contents /etc/passwd src/a.ts",
    "git blame --ignore-revs-file x src/a.ts",
    "git blame -L abc src/a.ts",
    "git blame src/a.ts src/b.ts",
    "git blame ../other.ts",
    "git blame /etc/passwd",
    "git blame src/a.ts | cat",
  ])("near-miss still asks: %s", (command) => {
    expect(decide(command).kind).toBe("ask");
  });

  test("blaming a secret-like path is a guard ask", () => {
    expect(decide("git blame .env")).toMatchObject({ kind: "ask", guard: true });
  });
});

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
    ["git ls-remote origin main", "inspect-remote-feature-branch"],
    ["git ls-remote origin refs/heads/main", "inspect-remote-feature-branch"],
    ["git ls-remote origin master", "inspect-remote-feature-branch"],
    ["git push origin HEAD", "push-feature-branch"],
    ["git push origin feature/x", "push-feature-branch"],
    ["git push --force-with-lease origin HEAD:feature/x", "push-feature-branch-with-lease"],
    ["gh pr create --base main --head feature/x --fill", "create-pull-request"],
    ["gh pr create --base main --head feature/x --fill --draft", "create-pull-request"],
    ['gh pr create --base main --head feature/x --title "Add trustedScripts" --body "Why and what"', "create-pull-request"],
    ["gh pr create --base main --head feature/x --title 'Fix it' --body-file docs/pr.md", "create-pull-request"],
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
    ["git ls-remote upstream main", {}],
    ["git ls-remote origin refs/heads/other", {}],
    ["git ls-remote --heads origin main", {}],
    ["git ls-remote origin main feature/x", {}],
    ["git ls-remote origin main | cat", {}],
    ["git ls-remote origin", {}],
    ["git ls-remote upstream refs/heads/feature/x", {}],
    ["git push origin main", { branch: "main" }],
    ["git push --force origin HEAD", {}],
    ["git push --force-with-lease origin HEAD", {}],
    ["git push --force-with-lease origin HEAD:main", {}],
    ["git push --force-with-lease=refs/heads/feature/x origin HEAD:feature/x", {}],
    ["git push --force-with-lease origin HEAD:feature/x", { rebaseActive: true }],
    ["git push origin --tags", {}],
    ["git push fork HEAD", {}],
    ["gh pr create --base main --head feature/x --fill --repo other/repo", {}],
    ["gh pr create --base main --head feature/x --fill --web", {}],
    ["gh pr create --base main --head feature/x --title a --title b", {}],
    ["gh pr create --base main --head feature/x --body-file ../x.md", {}],
    ["gh pr create --base main --head feature/x --body-file .env", {}],
    ["gh pr create --base main --head feature/x --title \"unterminated", {}],
    ["gh pr create --base main --head feature/x --title \"x $(whoami)\"", {}],
    ["gh pr create --base main --head feature/x --fill", { branch: "main" }],
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

describe("read-only output filters after an allowed command", () => {
  const filters = [
    "2>&1 | tail -20",
    "| tail -n 20",
    "| head -30",
    "| wc -l",
    '| grep -E "FAIL|passed"',
    '2>&1 | grep -E "FAIL|passed" | head -30',
    "2>&1 | grep -v ok | grep -i fail | tail -5",
  ];

  const families: ReadonlyArray<readonly [string, string, Partial<WorktreeMetadata>]> = [
    ["./scripts/run-with-mise.sh yarn build", "project-verification", {}],
    ["./scripts/run-with-mise.sh yarn test", "project-verification", {}],
    ["./scripts/run-with-mise.sh yarn test:durable", "project-verification", {}],
    ["./scripts/run-with-mise.sh yarn install", "locked-install", {}],
    ["git blame -L 1,20 src/a.ts", "git-blame", {}],
    ["git add src/a.ts", "stage-explicit-files", {}],
    ["git fetch origin", "fetch-origin", {}],
    ["git push origin HEAD", "push-feature-branch", {}],
    ["gh pr create --base main --head feature/x --fill", "create-pull-request", {}],
    ["./scripts/check-rules.sh src/core/example.ts", "trusted-script", { scriptProbe: cleanProbe }],
  ];

  for (const [command, category, overrides] of families) {
    test.each(filters)(`allows ${command} ${"%s"}`, (filter) => {
      const decision = evaluateTrustedWorkflow(`${command} ${filter}`, fixture(overrides), scriptOptions);
      expect(decision).toMatchObject({ kind: "allow", category });
    });
  }

  test("the allow keeps the left-hand command's category and says filters were accepted", () => {
    const decision = decide("./scripts/run-with-mise.sh yarn build 2>&1 | tail -20");
    expect(decision).toMatchObject({ kind: "allow", category: "project-verification" });
    expect((decision as { reason: string }).reason).toContain("read-only output filters");
  });

  test.each([
    "| tail -f",
    "| tail -20 build.log",
    "| tail 20",
    "| grep -r x",
    "| grep -f patterns",
    "| grep x file",
    "| grep -E \"x$\"",
    "| grep \"$(whoami)\"",
    "| grep \"`whoami`\"",
    "| grep \"unterminated",
    "| tee out",
    "> out.log",
    "2>&1 > out.log",
    "| tail -5 > out.log",
    "| sh",
    "| xargs rm",
    "| awk 1",
    "| sed s/a/b/",
    "| sort",
    "; echo $?",
    "| tail -5; echo $?",
    "&& other",
    "| tail -5 && other",
    "|| other",
    "& | tail -5",
    "| grep a | grep b | grep c | head -5",
  ])("near-miss still asks (shape ask, never a guard): ./scripts/run-with-mise.sh yarn build %s", (suffix) => {
    const decision = decide(`./scripts/run-with-mise.sh yarn build ${suffix}`);
    expect(decision.kind).toBe("ask");
    expect((decision as { guard?: true }).guard).toBeUndefined();
  });

  test.each([
    ["bash scripts/run-with-mise.sh yarn install", "locked-install"],
    ["bash scripts/run-with-mise.sh yarn test", "project-verification"],
    ["bash scripts/run-with-mise.sh yarn verify:impact", "project-verification"],
    ["bash scripts/run-with-mise.sh yarn build 2>&1 | tail -20", "project-verification"],
  ])("`bash scripts/…` spelling is the same canonical command: %s", (command, category) => {
    expect(isTrustedWorkflowCandidate(command)).toBe(true);
    expect(decide(command)).toMatchObject({ kind: "allow", category });
  });

  test.each([
    "bash -c scripts/run-with-mise.sh yarn build",
    "bash ./scripts/run-with-mise.sh yarn build",
    "bash -x scripts/run-with-mise.sh yarn build",
    "bash /abs/scripts/run-with-mise.sh yarn build",
    "bash scripts/run-with-mise.sh yarn test tests/x.test.ts",
    "bash scripts/run-with-mise.sh yarn build && other",
    "bash scripts/run-with-mise.sh yarn dev",
  ])("`bash` variants and near-misses do not newly allow: %s", (command) => {
    expect(decide(command).kind).not.toBe("allow");
  });

  test("a quoted pipe inside the left-hand command is not a filter pipeline", () => {
    expect(decide('gh pr create --base main --head feature/x --title "a | b" --body x | tail -5').kind).toBe("ask");
  });

  test("a filter never makes a command that is not otherwise allowed allowed", () => {
    for (const command of [
      "./scripts/run-with-mise.sh yarn test tests/x.test.ts",
      "./scripts/run-with-mise.sh yarn install extra",
      "git add .",
      "git push origin --tags",
      "git blame ../other.ts",
      "git fetch --all",
    ]) {
      expect(decide(`${command} 2>&1 | tail -20`).kind).toBe("ask");
    }
  });

  test("a left-hand command the preflight does not own behaves exactly as without a pipe", () => {
    for (const command of ["ls -la", "yarn test", "cat README.md", "rm -rf build"]) {
      expect(decide(`${command} 2>&1 | tail -20`)).toEqual({ kind: "unrecognized" });
      expect(decide(command)).toEqual({ kind: "unrecognized" });
    }
  });

  test("an owned command that is not canonical keeps asking with a command-shape reason, not the reviewer path", () => {
    const decision = decide("./scripts/run-with-mise.sh yarn test tests/x.test.ts 2>&1 | tail -20");
    expect(decision).toMatchObject({ kind: "ask", category: "command-shape" });
  });

  test("a guard ask on the left-hand command still wins", () => {
    expect(decide("git push origin main 2>&1 | tail -5", { branch: "main" })).toMatchObject({ kind: "ask", guard: true });
    expect(decide("git push origin fork-branch | tail -5")).toMatchObject({ kind: "ask", guard: true });
    expect(decide("git add .env | head -5")).toMatchObject({ kind: "ask", guard: true });
    expect(decide("git blame .env | head -5")).toMatchObject({ kind: "ask", guard: true });
    expect(decideScript("./scripts/check-rules.sh | tail -5", { scriptProbe: { tracked: [], dirty: [] } })).toMatchObject({
      kind: "ask",
      guard: true,
    });
  });

  test("the trusted boundary still applies to the left-hand command", () => {
    const decision = decide("./scripts/run-with-mise.sh yarn build 2>&1 | tail -20", { directory: "/tmp/p", root: "/tmp/p" });
    expect(decision).toMatchObject({ kind: "ask" });
    expect((decision as { guard?: true }).guard).toBeUndefined();
  });

  test("commands without a pipe are unchanged, including a bare 2>&1", () => {
    expect(decide("./scripts/run-with-mise.sh yarn build 2>&1")).toEqual({ kind: "unrecognized" });
    expect(decide("./scripts/run-with-mise.sh yarn build")).toMatchObject({ kind: "allow" });
  });

  test("a batch of two commands is never filtered", () => {
    const metadata = fixture();
    expect(
      evaluateTrustedWorkflowBatch(["git add src/a.ts", "git rebase --continue | tail -5"], metadata, options).kind,
    ).toBe("ask");
  });

  test("a single filtered command is accepted through the batch entry point", () => {
    expect(
      evaluateTrustedWorkflowBatch(["./scripts/run-with-mise.sh yarn build 2>&1 | tail -20"], fixture(), options),
    ).toMatchObject({ kind: "allow", category: "project-verification" });
  });

  test("a filtered rebase continuation is not accepted", () => {
    const metadata = fixture({ rebaseActive: true, hasUnresolvedConflicts: true, unresolvedConflictFiles: ["src/a.ts"] });
    expect(evaluateTrustedWorkflowBatch(["GIT_EDITOR=true git rebase --continue | tail -5"], metadata, options).kind).toBe("ask");
  });
});


describe("explicit remote ref inspection", () => {
  test.each([
    "git ls-remote origin 'refs/heads/feature/x'",
    'git ls-remote origin "refs/heads/main"',
    "git ls-remote origin refs/heads/feature/x refs/heads/main",
    "git ls-remote origin main 2>&1",
    "git ls-remote origin 'refs/heads/feature/x' refs/heads/main 2>&1",
  ])("allows equivalent bounded read-only ref inspection: %s", (command) => {
    expect(decide(command)).toMatchObject({ kind: "allow", category: "inspect-remote-feature-branch" });
  });
  test.each([
    "git ls-remote origin main refs/heads/other", "git ls-remote upstream main",
    "git ls-remote origin 'refs/heads/*'", "git ls-remote origin main > output",
    "git ls-remote origin main 2>&1 2>&1", "git ls-remote origin main 2>&1; touch output",
    "git ls-remote origin main main main main main", "git ls-remote origin 'unterminated",
  ])("rejects unsafe or broad inspection: %s", (command) => expect(decide(command).kind).toBe("ask"));
});
