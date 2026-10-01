/**
 * model-approval — local, model-reviewed permission plugin for OpenCode V2.
 *
 * WHY NO `import { Plugin } from "@opencode/plugin"` HERE:
 * That package is only a type-checking convenience (`Plugin.define()` is an
 * identity function per its own .d.ts) and is not resolvable at runtime
 * unless it's installed as a real dependency next to this file. OpenCode's
 * own actively-maintained `superpowers` plugin does the same thing for the
 * same reason ("No external dependencies — pure JavaScript works ... without
 * installing @opencode-ai/plugin or effect", see its index.js). This file
 * was verified against the real 2.0.18 `@opencode/plugin` promise-API type
 * definitions (dist/promise/*.d.ts) so the shapes below match production,
 * without taking a runtime dependency on that package.
 *
 * See README.md for the full design, the three-layer model this plugin is
 * Layer 3 of, and how to disable/roll it back.
 */

import { isSensitiveEvenIfAllowed, redact } from "./policy.js";
import { isValidTrustedScriptPath } from "./trusted-worktree.js";
import { runReviewer, type MinimalPluginContext, type MinimalPermissionEvent } from "./reviewer.js";
import {
  evaluateTrustedWorktreeCommand,
  type WorkflowPreflight,
} from "./workflow-preflight.js";

/**
 * Sensitive-even-if-allowed categories whose commands the deterministic
 * trusted-worktree preflight owns. They MUST reach the preflight even when an
 * incoming "allow" (stored "Allow always", static rule) would otherwise route
 * them straight to the model reviewer. `test/index.test.ts` fails if a new
 * sensitive category overlaps a preflight command family without being listed
 * here or in PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES.
 */
export const PREFLIGHT_OWNED_SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set([
  "git-force-with-lease",
  "git-rebase",
]);

/** Overlapping categories deliberately left to the model reviewer, with why. */
export const PREFLIGHT_EXEMPT_SENSITIVE_CATEGORIES: Readonly<Record<string, string>> = {
  "release-tag": "tag/--tags pushes are never a routine workflow; reviewer judges them",
  "git-branch-delete-remote": "remote branch deletion is never a routine workflow; reviewer judges it",
  "dotenv-secret-file": "secret-path staging needs judgment, not an exact-command match",
};

interface PluginOptionsShape {
  model?: string;
  apiKeyEnvVar?: string;
  timeoutMs?: number;
  maxContextChars?: number;
  threshold?: number;
  mode?: string;
  debug?: boolean;
  trustedRoots?: unknown;
  trustedRemoteHosts?: unknown;
  defaultBranches?: unknown;
  trustedScripts?: unknown;
}

interface ResolvedOptions {
  model: string;
  apiKeyEnvVar: string;
  timeoutMs: number;
  maxContextChars: number;
  threshold: number;
  debug: boolean;
  trustedRoots: readonly string[];
  trustedRemoteHosts: readonly string[];
  defaultBranches: readonly string[];
  trustedScripts: readonly string[];
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  // Jev is OpenCode's System One model for fast structured decisions. It is
  // called directly instead of through ctx.generate.text, because that
  // session-less route cannot authenticate free/Go inference requests.
  model: "jev-1.13-free",
  // Keep the existing desktop-process variable working. This is an
  // inference-only Console key despite the historical GO name; it is never
  // persisted or included in the request state.
  apiKeyEnvVar: "OPENCODE_GO_API_KEY",
  timeoutMs: 8000,
  maxContextChars: 12000,
  // Calibrated against a benign explicit local read (minimum 0.87) and
  // an unauthorized merge (maximum relevant score 0.70). Keep headroom for
  // normal language variance while remaining fail-closed below 0.85.
  threshold: 0.85,
  debug: false,
  trustedRoots: [],
  trustedRemoteHosts: ["github.com"],
  defaultBranches: ["main", "master"],
  trustedScripts: [],
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : fallback;
}

export function resolveOptions(raw: unknown): ResolvedOptions {
  const o = (raw ?? {}) as PluginOptionsShape;
  const model = typeof o.model === "string" && o.model.trim().length > 0 ? o.model : DEFAULT_OPTIONS.model;
  const apiKeyEnvVar =
    typeof o.apiKeyEnvVar === "string" && o.apiKeyEnvVar.trim().length > 0
      ? o.apiKeyEnvVar
      : DEFAULT_OPTIONS.apiKeyEnvVar;
  const timeoutMs =
    typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
      ? o.timeoutMs
      : DEFAULT_OPTIONS.timeoutMs;
  const maxContextChars =
    typeof o.maxContextChars === "number" && Number.isFinite(o.maxContextChars) && o.maxContextChars > 0
      ? o.maxContextChars
      : DEFAULT_OPTIONS.maxContextChars;
  const threshold =
    typeof o.threshold === "number" && Number.isFinite(o.threshold) && o.threshold > 0 && o.threshold <= 1
      ? o.threshold
      : DEFAULT_OPTIONS.threshold;
  const debug = typeof o.debug === "boolean" ? o.debug : DEFAULT_OPTIONS.debug;
  return {
    model,
    apiKeyEnvVar,
    timeoutMs,
    maxContextChars,
    threshold,
    debug,
    trustedRoots: stringList(o.trustedRoots, DEFAULT_OPTIONS.trustedRoots),
    trustedRemoteHosts: stringList(o.trustedRemoteHosts, DEFAULT_OPTIONS.trustedRemoteHosts),
    defaultBranches: stringList(o.defaultBranches, DEFAULT_OPTIONS.defaultBranches),
    // Invalid entries (globs, absolute or parent paths, secret-like names) are
    // dropped, never repaired: a script that cannot be matched exactly is not trusted.
    trustedScripts: stringList(o.trustedScripts, DEFAULT_OPTIONS.trustedScripts).filter(isValidTrustedScriptPath),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`reviewer timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface Stats {
  reviewed: number;
  allow: number;
  ask: number;
  deny: number;
  failures: number;
  timeouts: number;
  totalLatencyMs: number;
}

const STATS_KEY = "model-approval:stats";

function emptyStats(): Stats {
  return { reviewed: 0, allow: 0, ask: 0, deny: 0, failures: 0, timeouts: 0, totalLatencyMs: 0 };
}

async function recordOutcome(
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  update: (stats: Stats) => void,
): Promise<void> {
  try {
    const current = ((await storage.get(STATS_KEY)) as Stats | undefined) ?? emptyStats();
    update(current);
    await storage.set(STATS_KEY, current);
  } catch {
    // Storage is observability-only; never let a storage failure affect the
    // actual permission decision.
  }
}

interface DiagnosticEntry {
  time: string;
  action: string;
  sensitiveCategory: string;
  kind: "exception" | "malformed-output";
  detail: string;
}

const DIAGNOSTICS_KEY = "model-approval:last-errors";
const MAX_DIAGNOSTICS = 10;
const RECENT_DECISIONS_KEY = "model-approval:recent-decisions";
const MAX_RECENT_DECISIONS = 20;

interface DecisionEntry {
  time: string;
  action: string;
  category: string;
  decision: "allow" | "ask";
  reasonCode: string;
}

function workflowReasonCode(category: string, reason: string): string {
  if (category === "rebase-continue" && reason === "Rebase continuation requires an active rebase.") {
    return "rebase-continuation-requires-active-rebase";
  }
  if (category === "trusted-worktree" && reason.startsWith("Could not resolve")) return "trusted-worktree-directory-unresolved";
  if (category === "trusted-worktree" && reason.startsWith("Could not verify")) return "trusted-worktree-verification-failed";
  return `${category.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-${reason.startsWith("Only ") ? "noncanonical-command" : "approval-required"}`;
}

async function recordDecision(
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  entry: Omit<DecisionEntry, "time">,
): Promise<void> {
  try {
    const current = ((await storage.get(RECENT_DECISIONS_KEY)) as DecisionEntry[] | undefined) ?? [];
    const bounded = [...current, { time: new Date().toISOString(), ...entry }].slice(-MAX_RECENT_DECISIONS);
    await storage.set(RECENT_DECISIONS_KEY, bounded);
  } catch {
    // Redacted history helps diagnose prompts but must never affect approval.
  }
}

interface ServiceReadiness {
  readonly checkedAt: string;
  readonly state: "configured" | "missing-api-key";
  readonly apiKeyEnvVar: string;
  readonly apiKeyPresent: boolean;
  readonly model: string;
}

const SERVICE_READINESS_KEY = "model-approval:service-readiness";

function reviewerReadiness(
  options: ResolvedOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServiceReadiness {
  const apiKey = env[options.apiKeyEnvVar];
  const apiKeyPresent = typeof apiKey === "string" && apiKey.trim().length > 0;
  return {
    checkedAt: new Date().toISOString(),
    state: apiKeyPresent ? "configured" : "missing-api-key",
    apiKeyEnvVar: options.apiKeyEnvVar,
    apiKeyPresent,
    model: options.model,
  };
}

async function recordServiceReadiness(
  storage: { set(key: string, value: unknown): Promise<void> },
  readiness: ServiceReadiness,
): Promise<void> {
  try {
    await storage.set(SERVICE_READINESS_KEY, readiness);
  } catch {
    // A diagnostic must never block plugin registration or a permission decision.
  }
}

/**
 * console.error from this plugin does not reliably surface anywhere the
 * user (or I) can read when OpenCode runs as the detached `--service`
 * background daemon (checked: not in ~/.local/share/opencode/log/opencode.log,
 * not in the Electron app's main/renderer logs, not in macOS unified
 * logging). ctx.storage, by contrast, is a plain sqlite-backed kv store
 * that's trivially queryable directly, so failures are recorded there
 * instead of relied on to show up in a log file. console.error calls are
 * kept alongside this as a no-cost second attempt in case a future
 * OpenCode version does wire plugin stdio somewhere.
 */
async function recordDiagnostic(
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> },
  entry: DiagnosticEntry,
): Promise<void> {
  try {
    const current = ((await storage.get(DIAGNOSTICS_KEY)) as DiagnosticEntry[] | undefined) ?? [];
    current.push(entry);
    while (current.length > MAX_DIAGNOSTICS) current.shift();
    await storage.set(DIAGNOSTICS_KEY, current);
  } catch {
    // Best-effort; never let diagnostic recording affect the decision.
  }
}

export interface PluginDependencies {
  readonly evaluateTrustedWorktree?: WorkflowPreflight;
  /** Test-only environment override; production always reads the service process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createPlugin(dependencies: PluginDependencies = {}) {
  const workflowPreflight = dependencies.evaluateTrustedWorktree ?? evaluateTrustedWorktreeCommand;
  return {
    id: "opencode-auto-approval",

    async setup(ctx: any) {
      const options = resolveOptions(ctx.options);
      // This is intentionally a service-process check, not a login-shell
      // check: OpenCode can be restarted from an environment that lacks the
      // key even while an interactive terminal has it. Never persist the key.
      await recordServiceReadiness(ctx.storage, reviewerReadiness(options, dependencies.env));

      await ctx.permission.hook("evaluate", async (event: any) => {
        // A hard policy denial is a security boundary. The plugin may never
        // turn one into an allow, regardless of model or worktree evidence.
        if (event.effect === "deny") return;

        const sensitivity = isSensitiveEvenIfAllowed(event.action, event.resources);

        // Fast path: ordinary allows outside the sensitive-even-if-allowed
        // class return immediately with no model call, per design — routine
        // reads/edits/inspection must never incur review latency.
        // The one exception: an already-allowed shell command (static rule or
        // stored "Allow always") still gets the preflight's safety guards
        // below, so a broad allow like `git push *` cannot carry a push of the
        // default branch. The preflight is a no-op for commands it does not own.
        const guardableAllow = event.effect === "allow" && event.action === "shell";
        if (event.effect !== "ask" && !sensitivity.sensitive && !guardableAllow) return;

        const minimalCtx: MinimalPluginContext = ctx;
        const minimalEvent: MinimalPermissionEvent = {
          sessionID: event.sessionID,
          agent: event.agent,
          action: event.action,
          resources: event.resources,
          effect: event.effect,
          directory: event.directory,
          cwd: event.cwd,
          workdir: event.workdir,
          metadata: event.metadata,
          source: event.source,
        };

        const startedAt = Date.now();

        // Guard pass for an incoming allow: the preflight may only TIGHTEN it,
        // and only for safety-invariant violations (`guard`), never for a
        // command that is merely not the exact canonical shape (e.g. extra
        // flags or test-file arguments on an allowed `yarn test`).
        const ownedSensitive = sensitivity.category !== undefined && PREFLIGHT_OWNED_SENSITIVE_CATEGORIES.has(sensitivity.category);
        if (guardableAllow && !ownedSensitive) {
          let guard;
          try {
            guard = await workflowPreflight(ctx, minimalEvent, options);
          } catch {
            guard = { kind: "unrecognized" as const };
          }
          if (guard.kind === "ask" && guard.guard === true) {
            event.effect = "ask";
            event.message = guard.reason;
            await recordDecision(ctx.storage, {
              action: event.action,
              category: guard.category,
              decision: "ask",
              reasonCode: workflowReasonCode(guard.category, guard.reason),
            });
            await recordOutcome(ctx.storage, (s) => {
              s.reviewed += 1;
              s.ask += 1;
            });
            return;
          }
          if (!sensitivity.sensitive) return;
        }

        // A stored project "Allow always" (e.g. `git rebase *`) resolves the
        // incoming effect to "allow", which would skip the deterministic
        // preflight and send these categories to the model reviewer instead,
        // where they often come back "ask". Always run the exact-command,
        // trusted-worktree preflight for them; it returns "unrecognized" for
        // anything it does not own, so the reviewer path is unchanged.
        if (
          event.effect === "ask" ||
          (sensitivity.category !== undefined && PREFLIGHT_OWNED_SENSITIVE_CATEGORIES.has(sensitivity.category))
        ) {
          let workflow;
          try {
            workflow = await workflowPreflight(ctx, minimalEvent, options);
          } catch {
            workflow = {
              kind: "ask" as const,
              category: "trusted-worktree",
              reason: "Trusted-worktree verification failed; human approval is required.",
            };
          }
          if (workflow.kind !== "unrecognized") {
            const latencyMs = Date.now() - startedAt;
            event.effect = workflow.kind;
            event.message = workflow.reason;
            await recordDecision(ctx.storage, {
              action: event.action,
              category: workflow.category,
              decision: workflow.kind,
              reasonCode: workflowReasonCode(workflow.category, workflow.reason),
            });
            await recordOutcome(ctx.storage, (s) => {
              s.reviewed += 1;
              s.totalLatencyMs += latencyMs;
              if (workflow.kind === "allow") s.allow += 1;
              else s.ask += 1;
            });
            return;
          }
        }

        try {
          const review = await withTimeout(runReviewer(minimalCtx, minimalEvent, options), options.timeoutMs);
        const latencyMs = Date.now() - startedAt;

        // System One can only produce allow or ask. Never let a model infer a
        // permanent deny: uncertainty is explicitly surfaced to the user.
        event.effect = review.decision;
        event.message = review.reason;
        if (options.debug) {
          console.error(
            `[model-approval] action=${event.action} sensitive=${sensitivity.category ?? "n/a"} incoming=${minimalEvent.effect} decision=${review.decision} latencyMs=${latencyMs} reason=${review.reason}`,
          );
        }
        await recordOutcome(ctx.storage, (s) => {
          s.reviewed += 1;
          s.totalLatencyMs += latencyMs;
          if (review.decision === "allow") s.allow += 1;
          else s.ask += 1;
        });
        } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const timedOut = err instanceof Error && /timed out/.test(err.message);
        event.effect = "ask";
        const keyMissing = err instanceof Error && err.message === `${options.apiKeyEnvVar} is not set`;
        event.message = keyMissing
          ? `Automated permission review is unavailable because the OpenCode service lacks ${options.apiKeyEnvVar}; restart it from the configured login environment.`
          : "Automated permission review unavailable; human approval required.";
        if (keyMissing) {
          await recordServiceReadiness(ctx.storage, reviewerReadiness(options));
        }
        // Always logged (not gated by `debug`) for the same reason as the
        // malformed-output branch above: a silent reviewer failure that
        // always falls back to ask is safe, but invisible, and would have
        // made this exact bug class impossible to diagnose.
        const errorDetail =
          err instanceof Error
            ? `${err.name}: ${redact(err.message)}${err.stack ? `\n${redact(err.stack).slice(0, 800)}` : ""}`
            : redact(String(err));
        console.error(
          `[model-approval] reviewer error action=${event.action} sensitive=${sensitivity.category ?? "n/a"} latencyMs=${latencyMs} timedOut=${timedOut}: ${errorDetail}`,
        );
        await recordOutcome(ctx.storage, (s) => {
          s.reviewed += 1;
          s.ask += 1;
          s.failures += 1;
          if (timedOut) s.timeouts += 1;
          s.totalLatencyMs += latencyMs;
        });
        await recordDiagnostic(ctx.storage, {
          time: new Date().toISOString(),
          action: event.action,
          sensitiveCategory: sensitivity.category ?? "n/a",
          kind: "exception",
          detail: errorDetail.slice(0, 800),
        });
        }
      });
    },
  };
}

const plugin = createPlugin();
export default plugin;
