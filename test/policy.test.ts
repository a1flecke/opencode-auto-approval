import { describe, expect, test } from "bun:test";
import { isSensitiveEvenIfAllowed, redact } from "../policy.js";

describe("isSensitiveEvenIfAllowed", () => {
  test("flags gh pr merge", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["gh pr merge 123 --squash"]).sensitive).toBe(true);
  });

  test("flags gh pr merge with --admin", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["gh pr merge 123 --admin --squash"]).sensitive).toBe(true);
  });

  test("flags git reset --hard", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git reset --hard origin/main"]).sensitive).toBe(true);
  });

  test("flags git clean -fd", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git clean -fd"]).sensitive).toBe(true);
  });

  test("routes a lease-protected feature-branch push through trusted-worktree review", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git push --force-with-lease origin HEAD:feature/x"])).toMatchObject({
      sensitive: true,
      category: "git-force-with-lease",
    });
  });

  test("flags remote branch deletion but not an ordinary HEAD refspec", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git push origin :feature/x"]).sensitive).toBe(true);
    expect(isSensitiveEvenIfAllowed("shell", ["git push origin HEAD:feature/x"]).sensitive).toBe(false);
  });

  test("flags npm publish", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["npm publish --access public"]).sensitive).toBe(true);
  });

  test("flags terraform apply", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["terraform apply -auto-approve"]).sensitive).toBe(true);
  });

  test("flags gh auth login", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["gh auth login --with-token"]).sensitive).toBe(true);
  });

  test("flags reading a .env file", () => {
    expect(isSensitiveEvenIfAllowed("read", ["/repo/.env.production"]).sensitive).toBe(true);
  });

  test("does NOT flag a routine git status", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git status"]).sensitive).toBe(false);
  });

  test("does NOT flag a routine git push of a feature branch", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["git push origin feature/my-branch"]).sensitive).toBe(false);
  });

  test("does NOT flag gh pr view", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["gh pr view 123"]).sensitive).toBe(false);
  });

  test("does NOT flag npm install with no args (lockfile install)", () => {
    expect(isSensitiveEvenIfAllowed("shell", ["npm install"]).sensitive).toBe(false);
  });

  test("does NOT flag reading an ordinary source file", () => {
    expect(isSensitiveEvenIfAllowed("read", ["/repo/src/index.ts"]).sensitive).toBe(false);
  });

  test("a compound/multi-resource operation is sensitive if ANY resource matches", () => {
    const result = isSensitiveEvenIfAllowed("shell", ["echo hi", "gh pr merge 42"]);
    expect(result.sensitive).toBe(true);
  });
});

describe("redact", () => {
  test("redacts a GitHub personal access token", () => {
    const out = redact("token is ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts an AWS access key id", () => {
    const out = redact("AKIAABCDEFGHIJKLMNOP is my key");
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  test("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAKCAQ==\n-----END RSA PRIVATE KEY-----";
    const out = redact(`here is my key:\n${pem}`);
    expect(out).not.toContain("MIIBogIBAAKCAQ==");
  });

  test("redacts a key=value style secret while keeping the key name", () => {
    const out = redact("API_KEY=sk-thisisaveryrealsecretvalue1234567890");
    expect(out).toContain("API_KEY");
    expect(out).not.toContain("thisisaveryrealsecretvalue1234567890");
  });

  test("leaves ordinary text untouched", () => {
    const text = "run yarn build then yarn test";
    expect(redact(text)).toBe(text);
  });
});


describe("PR approval classification", () => {
  test.each(["gh pr review 7 --approve", "gh pr review --approve 7", "gh pr review 7 -a"]) (
    "reviews approval even when a broad static rule allows it: %s", (command) => {
      expect(isSensitiveEvenIfAllowed("shell", [command])).toEqual({ sensitive: true, category: "pr-approve" });
    });
  test.each(["gh pr review 7 --comment", "gh pr view 7", "gh pr review 7 --request-changes"])(
    "does not classify ordinary inspection or feedback as approval: %s", (command) => {
      expect(isSensitiveEvenIfAllowed("shell", [command]).sensitive).toBe(false);
    });
});
