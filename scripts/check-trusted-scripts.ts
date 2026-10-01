#!/usr/bin/env bun
/**
 * Drift check for the `trustedScripts` plugin option. Every tracked shell
 * script under a `scripts/` directory of a project must be deliberately
 * classified: listed in `trustedScripts` (auto-approved) or passed as
 * `--exempt` (reviewed on each run). A script that is neither is drift.
 *
 *   bun scripts/check-trusted-scripts.ts --config ~/.config/opencode/opencode.jsonc \
 *     [--repo <path>] [--exempt scripts/foo.sh]...
 *
 * The list lives in the user's own config, never in a repository, so run this
 * from a project's pre-push hook or CI step on a machine that has the config.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isValidTrustedScriptPath } from "../trusted-worktree.js";

const SCRIPT_PATH = /(?:^|\/)scripts\/[^/]+\.sh$/;

export interface Drift {
  readonly unclassified: readonly string[];
  readonly invalid: readonly string[];
}

export function findScriptDrift(repoFiles: readonly string[], trusted: readonly string[], exempt: readonly string[]): Drift {
  const classified = new Set([...trusted, ...exempt]);
  return {
    unclassified: repoFiles.filter((file) => SCRIPT_PATH.test(file) && !classified.has(file)).sort(),
    invalid: trusted.filter((entry) => !isValidTrustedScriptPath(entry)),
  };
}

/** Strips // and /* *\/ comments and trailing commas outside of strings. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) throw new Error("unterminated comment");
      i += 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function pluginOptions(config: unknown): Record<string, unknown> {
  const plugins = (config as { plugins?: unknown })?.plugins;
  if (Array.isArray(plugins)) {
    for (const entry of plugins) {
      const e = entry as { package?: unknown; options?: unknown };
      if (typeof e?.package === "string" && e.package.includes("opencode-auto-approval")) {
        return (e.options ?? {}) as Record<string, unknown>;
      }
    }
  }
  throw new Error("opencode-auto-approval plugin entry not found in config");
}

function main(argv: readonly string[]): number {
  let config = "";
  let repo = process.cwd();
  const exempt: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--config") config = argv[i + 1] ?? "";
    else if (argv[i] === "--repo") repo = argv[i + 1] ?? "";
    else if (argv[i] === "--exempt") exempt.push(argv[i + 1] ?? "");
    else { console.error(`Unknown argument: ${argv[i]}`); return 2; }
  }
  if (!config) { console.error("Usage: check-trusted-scripts.ts --config <opencode.jsonc> [--repo <path>] [--exempt <script>]..."); return 2; }
  const listed = pluginOptions(parseJsonc(readFileSync(config, "utf8"))).trustedScripts;
  const trusted = Array.isArray(listed) ? listed.filter((x): x is string => typeof x === "string") : [];
  const git = spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" });
  if (git.status !== 0) { console.error("git ls-files failed"); return 2; }
  const drift = findScriptDrift(git.stdout.split("\n").filter(Boolean), trusted, exempt);
  for (const f of drift.unclassified) console.error(`Unclassified script: ${f} (add it to trustedScripts after review, or --exempt it)`);
  for (const f of drift.invalid) console.error(`Invalid trustedScripts entry (ignored by the plugin): ${f}`);
  if (drift.unclassified.length + drift.invalid.length > 0) return 1;
  console.log("trustedScripts: no drift.");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
