import { describe, expect, test } from "bun:test";
import plugin, {
  createPlugin,
  resolveOptions,
  PREFLIGHT_OWNED_SENSITIVE_CATEGORIES,
  PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES,
} from "../index.js";
import { isSensitiveEvenIfAllowed } from "../policy.js";
import { isTrustedWorkflowCandidate } from "../trusted-worktree.js";

describe("preflight routing coverage", () => {
  // One exemplar per way a preflight-owned command family can also trip a
  // sensitive rule. Add a line here when extending either list.
  const EXEMPLARS = [
    "git rebase origin/main",
    "GIT_EDITOR=true git rebase --continue",
    "git push --force-with-lease origin HEAD:feature/x",
    "git push origin --tags",
    "git push origin --delete feature/x",
    "git push origin :feature/x",
    "git add .env",
    "git add .npmrc",
    "git fetch origin",
    "gh pr create --base main --head feature/x --fill",
  ];

  test("every sensitive category overlapping a preflight family is owned or explicitly exempt", () => {
    for (const command of EXEMPLARS) {
      if (!isTrustedWorkflowCandidate(command)) continue;
      const { sensitive, category } = isSensitiveEvenIfAllowed("shell", [command]);
      if (!sensitive) continue;
      const routed =
        PREFLIGHT_OWNED_SENSITIVE_CATEGORIES.has(category!) || category! in PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES;
      expect({ command, category, routed }).toEqual({ command, category, routed: true });
    }
  });

  test("owned and exempt sets do not overlap", () => {
    for (const category of PREFLIGHT_OWNED_SENSITIVE_CATEGORIES) {
      expect(category in PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES).toBe(false);
    }
  });
});

describe("approval plugin options", () => {
  test("defaults to the calibrated Jev allow threshold", () => {
    expect(resolveOptions({}).trustedScripts).toEqual([]);
    expect(resolveOptions({ trustedScripts: ["scripts/a.sh", "../x.sh", "scripts/*.sh", 3] }).trustedScripts).toEqual(["scripts/a.sh"]);
    expect(resolveOptions({})).toMatchObject({
      model: "jev-1.13-free",
      apiKeyEnvVar: "OPENCODE_GO_API_KEY",
      threshold: 0.85,
    });
  });

  test("rejects an unsafe threshold override", () => {
    expect(resolveOptions({ threshold: 1.1 }).threshold).toBe(0.85);
  });
});

describe("approval plugin service readiness", () => {
  test("records a configured reviewer without persisting the API key", async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    const testPlugin = createPlugin({ env: { OPENCODE_GO_API_KEY: "secret-value" } });

    await testPlugin.setup({
      options: {},
      permission: { async hook() {} },
      storage: {
        async get() {
          return undefined;
        },
        async set(key: string, value: unknown) {
          writes.push({ key, value });
        },
      },
      session: { async context() { return []; } },
    });

    const readiness = writes.find((write) => write.key === "model-approval:service-readiness");
    expect(readiness?.value).toMatchObject({
      state: "configured",
      apiKeyEnvVar: "OPENCODE_GO_API_KEY",
      apiKeyPresent: true,
      model: "jev-1.13-free",
    });
    expect(JSON.stringify(writes)).not.toContain("secret-value");
  });

  test("explains when the running service lacks the configured reviewer key", async () => {
    let evaluate: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    const testPlugin = createPlugin();

    await testPlugin.setup({
      options: { apiKeyEnvVar: "MODEL_APPROVAL_TEST_MISSING_KEY" },
      permission: { async hook(_name: string, handler: (event: Record<string, unknown>) => Promise<void>) { evaluate = handler; } },
      storage: { async get() { return undefined; }, async set() {} },
      session: { async context() { return []; } },
    });

    const event: Record<string, unknown> = {
      sessionID: "missing-reviewer-key",
      action: "shell",
      resources: ["git status --short"],
      effect: "ask",
    };
    await evaluate?.(event);

    expect(event.effect).toBe("ask");
    expect(event.message).toContain("MODEL_APPROVAL_TEST_MISSING_KEY");
    expect(event.message).toContain("restart");
  });
});

describe("approval plugin fast path", () => {
  test("does not call Jev or change an ordinary pre-approved operation", async () => {
    let evaluate: ((event: Record<string, unknown>) => Promise<void>) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response();
    };

    try {
      await plugin.setup({
        options: {},
        permission: {
          async hook(name: string, handler: (event: Record<string, unknown>) => Promise<void>) {
            expect(name).toBe("evaluate");
            evaluate = handler;
          },
        },
        storage: {
          async get() {
            return undefined;
          },
          async set() {},
        },
        session: {
          async context() {
            return [];
          },
        },
      });

      const event: Record<string, unknown> = {
        sessionID: "ordinary-allow",
        action: "shell",
        resources: ["git diff --stat"],
        effect: "allow",
      };
      await evaluate?.(event);

      expect(event.effect).toBe("allow");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("trusted-worktree hook order", () => {
  test("runs trusted-worktree checks for an otherwise allowed lease push", async () => {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response();
    };
    try {
      const testPlugin = createPlugin({
        evaluateTrustedWorktree: async () => ({
          kind: "allow",
          category: "push-feature-branch-with-lease",
          reason: "Lease-protected update of the current feature branch.",
        }),
      });
      await testPlugin.setup({
        options: {},
        permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
        storage: { async get() { return undefined; }, async set() {} },
        session: { async context() { return []; } },
      });

      const event = {
        sessionID: "trusted-lease-push",
        action: "shell",
        resources: ["git push --force-with-lease origin HEAD:feature/x"],
        effect: "allow",
      };
      await evaluate?.(event);

      expect(event.effect).toBe("allow");
      expect(event.message).toContain("Lease-protected");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runs trusted-worktree checks for a rebase already allowed by a stored project approval", async () => {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response();
    };
    try {
      const testPlugin = createPlugin({
        evaluateTrustedWorktree: async () => ({
          kind: "allow",
          category: "rebase-origin-main",
          reason: "Feature branch is rebasing exactly onto origin/main.",
        }),
      });
      await testPlugin.setup({
        options: {},
        permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
        storage: { async get() { return undefined; }, async set() {} },
        session: { async context() { return []; } },
      });

      const event = {
        sessionID: "trusted-rebase",
        action: "shell",
        resources: ["git rebase origin/main"],
        effect: "allow",
      };
      await evaluate?.(event);

      expect(event.effect).toBe("allow");
      expect(event.message).toContain("rebasing exactly onto origin/main");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  async function setupWith(preflight: (e: any) => Promise<any>) {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    const testPlugin = createPlugin({ evaluateTrustedWorktree: preflight as any });
    await testPlugin.setup({
      options: {},
      permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
      storage: { async get() { return undefined; }, async set() {} },
      session: { async context() { return []; } },
    });
    return evaluate!;
  }

  test("a guard ask tightens an already-allowed command (static `git push *` cannot push main)", async () => {
    const evaluate = await setupWith(async () => ({
      kind: "ask", category: "push-feature-branch", reason: "The default branch is never pushed automatically.", guard: true,
    }));
    const event: Record<string, any> = { sessionID: "s", action: "shell", resources: ["git push origin main"], effect: "allow" };
    await evaluate(event);
    expect(event.effect).toBe("ask");
    expect(event.message).toContain("default branch");
  });

  test("a non-guard ask never tightens an already-allowed command", async () => {
    const evaluate = await setupWith(async () => ({
      kind: "ask", category: "project-verification", reason: "Only the exact form is automatic.",
    }));
    const event: Record<string, any> = { sessionID: "s", action: "shell", resources: ["./scripts/run-with-mise.sh yarn test tests/x.test.ts"], effect: "allow" };
    await evaluate(event);
    expect(event.effect).toBe("allow");
  });

  test("a preflight that throws never tightens or loosens an allow", async () => {
    const evaluate = await setupWith(async () => { throw new Error("boom"); });
    const event: Record<string, any> = { sessionID: "s", action: "shell", resources: ["git push origin HEAD"], effect: "allow" };
    await evaluate(event);
    expect(event.effect).toBe("allow");
  });

  test("a hard deny is never touched", async () => {
    const evaluate = await setupWith(async () => ({ kind: "allow", category: "x", reason: "x" }));
    const event: Record<string, any> = { sessionID: "s", action: "shell", resources: ["git push origin HEAD"], effect: "deny" };
    await evaluate(event);
    expect(event.effect).toBe("deny");
  });

  test("records a redacted reason when a deterministic workflow requires approval", async () => {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    const values = new Map<string, unknown>();
    const testPlugin = createPlugin({
      evaluateTrustedWorktree: async () => ({
        kind: "ask",
        category: "rebase-continue",
        reason: "Rebase continuation requires an active rebase.",
      }),
    });
    await testPlugin.setup({
      options: {},
      permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
      storage: {
        async get(key: string) { return values.get(key); },
        async set(key: string, value: unknown) { values.set(key, value); },
      },
      session: { async context() { return []; } },
    });

    const event = {
      sessionID: "diagnostic-rebase",
      action: "shell",
      resources: ["GIT_EDITOR=true git rebase --continue"],
      effect: "ask",
    };
    await evaluate?.(event);

    expect(event.effect).toBe("ask");
    expect(event.message).toContain("active rebase");
    const decisions = values.get("model-approval:recent-decisions");
    expect(decisions).toEqual([
      expect.objectContaining({
        action: "shell",
        category: "rebase-continue",
        decision: "ask",
        reasonCode: "rebase-continuation-requires-active-rebase",
      }),
    ]);
    expect(JSON.stringify(decisions)).not.toContain("GIT_EDITOR");
    expect(JSON.stringify(decisions)).not.toContain("sessionID");
  });

  test("allows a trusted-worktree decision without calling Jev", async () => {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response();
    };
    try {
      const testPlugin = createPlugin({
        evaluateTrustedWorktree: async () => ({
          kind: "allow",
          category: "push-feature-branch",
          reason: "Current feature branch is pushed to origin.",
        }),
      });
      await testPlugin.setup({
        options: {},
        permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
        storage: { async get() { return undefined; }, async set() {} },
        session: { async context() { return []; } },
      });

      const event = { sessionID: "trusted-push", action: "shell", resources: ["git push origin HEAD"], effect: "ask" };
      await evaluate?.(event);

      expect(event.effect).toBe("allow");
      expect(event.message).toContain("feature branch");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("leaves a failed trusted-worktree preflight as ask without calling Jev", async () => {
    let evaluate: ((event: Record<string, any>) => Promise<void>) | undefined;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response();
    };
    try {
      const testPlugin = createPlugin({
        evaluateTrustedWorktree: async () => ({
          kind: "ask",
          category: "push-feature-branch",
          reason: "The default branch is never pushed automatically.",
        }),
      });
      await testPlugin.setup({
        options: {},
        permission: { async hook(_name: string, handler: (event: Record<string, any>) => Promise<void>) { evaluate = handler; } },
        storage: { async get() { return undefined; }, async set() {} },
        session: { async context() { return []; } },
      });

      const event = { sessionID: "default-push", action: "shell", resources: ["git push origin main"], effect: "ask" };
      await evaluate?.(event);

      expect(event.effect).toBe("ask");
      expect(event.message).toContain("default branch");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
