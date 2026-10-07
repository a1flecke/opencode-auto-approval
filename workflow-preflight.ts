/** Runtime adapter for deterministic trusted-worktree permission decisions. */

import { splitOutputFilters } from "./output-filters.js";
import { shellWords } from "./shell-words.js";
import { bunPathExists, loadWorktreeMetadata, runBunReadOnly } from "./git-metadata.js";
import {
  evaluateTrustedWorkflowBatch,
  evaluateRoutineProcessCheck,
  isTrustedWorkflowCandidate,
  type TrustedWorkflowOptions,
  type WorkflowDecision,
} from "./trusted-worktree.js";

interface SessionInfo {
  directory?: unknown;
  location?: { directory?: unknown };
}

interface SessionToolMessage {
  content?: ReadonlyArray<unknown>;
}

export interface WorkflowPreflightContext {
  session?: {
    get?(input: { sessionID: string }): Promise<SessionInfo | undefined>;
    context?(input: { sessionID: string }): Promise<ReadonlyArray<SessionToolMessage>>;
  };
}

export interface WorkflowPreflightEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  /** Runtime-provided shell metadata. Only an absolute directory is accepted. */
  readonly directory?: unknown;
  readonly cwd?: unknown;
  readonly workdir?: unknown;
  readonly metadata?: unknown;
  readonly source?: unknown;
}

export type WorkflowPreflight = (
  ctx: WorkflowPreflightContext,
  event: WorkflowPreflightEvent,
  options: TrustedWorkflowOptions,
) => Promise<WorkflowDecision>;

function ask(category: string, reason: string): WorkflowDecision {
  return { kind: "ask", category, reason };
}

function sessionDirectory(info: SessionInfo | undefined): string | null {
  const direct = info?.directory;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;
  const nested = info?.location?.directory;
  return typeof nested === "string" && nested.trim().length > 0 ? nested : null;
}

function absoluteDirectory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const directory = value.trim();
  return directory.startsWith("/") && !directory.includes("\0") ? directory : null;
}

function metadataDirectory(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  return absoluteDirectory(metadata.cwd) ?? absoluteDirectory(metadata.directory) ?? absoluteDirectory(metadata.workdir);
}

function sourceToolID(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return source.type === "tool" && typeof source.id === "string" && source.id.length > 0 ? source.id : null;
}

function sourceToolInput(event: WorkflowPreflightEvent, messages: ReadonlyArray<SessionToolMessage>): Record<string, unknown> | null {
  const toolID = sourceToolID(event.source);
  if (!toolID) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
      const tool = part as Record<string, unknown>;
      if (tool.type !== "tool" || tool.id !== toolID || (tool.name !== undefined && tool.name !== "shell")) continue;
      const state = tool.state;
      if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
      const input = (state as Record<string, unknown>).input;
      return typeof input === "object" && input !== null && !Array.isArray(input)
        ? input as Record<string, unknown> : null;
    }
  }
  return null;
}

function sourceToolDirectory(event: WorkflowPreflightEvent, messages: ReadonlyArray<SessionToolMessage>): string | null {
  const input = sourceToolInput(event, messages);
  if (!input) return null;
  const directory = absoluteDirectory(input.cwd) ?? absoluteDirectory(input.directory) ?? absoluteDirectory(input.workdir);
  if (directory) return directory;
  const match = typeof input.command === "string" ? input.command.match(/^cd\s+(\/[^\s;&|`$]+)\s+&&\s+/) : null;
  return match ? absoluteDirectory(match[1]) : null;
}

/** Bind scanner resources to the exact source pipeline; never infer operators from a resource list. */
function workflowCommands(event: WorkflowPreflightEvent, messages: ReadonlyArray<SessionToolMessage>): readonly string[] {
  if (event.resources.length < 2) return event.resources;
  const command = sourceToolInput(event, messages)?.command;
  if (typeof command !== "string") return event.resources;
  const split = splitOutputFilters(command);
  if (split.kind !== "filtered") return event.resources;
  const expected = [split.command, ...split.filters];
  if (expected.length !== event.resources.length) return event.resources;
  const matches = expected.every((segment, i) => {
    const resource = i === 0 ? event.resources[i].trim().replace(/\s2>&1$/, "") : event.resources[i];
    const words = shellWords(resource);
    return words !== null && JSON.stringify(words) === JSON.stringify(shellWords(segment));
  });
  return matches ? [command] : event.resources;
}

/**
 * OpenCode sessions retain their initial checkout even when a shell call
 * changes into a sibling worktree. The permission request's absolute cwd is
 * therefore authoritative when supplied; the session directory is only a
 * fallback for clients that do not provide it.
 */
export function resolveWorkflowDirectory(
  event: WorkflowPreflightEvent,
  info: SessionInfo | undefined,
  messages: ReadonlyArray<SessionToolMessage> = [],
): string | null {
  return (
    absoluteDirectory(event.cwd) ??
    absoluteDirectory(event.directory) ??
    absoluteDirectory(event.workdir) ??
    metadataDirectory(event.metadata) ??
    sourceToolDirectory(event, messages) ??
    sessionDirectory(info)
  );
}

/**
 * Performs no work for unfamiliar commands. Recognized workflow commands are
 * fail-closed: missing session identity, an ambiguous command list, or a Git
 * probe failure is an explicit human approval rather than a model fallback.
 */
export async function evaluateTrustedWorktreeCommand(
  ctx: WorkflowPreflightContext,
  event: WorkflowPreflightEvent,
  options: TrustedWorkflowOptions,
): Promise<WorkflowDecision> {
  if (event.action !== "shell") return { kind: "unrecognized" };
  const processCheck = evaluateRoutineProcessCheck(event.resources);
  if (processCheck.kind !== "unrecognized") return processCheck;
  if (!event.resources.some((command) => isTrustedWorkflowCandidate(command, options))) return { kind: "unrecognized" };
  try {
    const messages = (await ctx.session?.context?.({ sessionID: event.sessionID })) ?? [];
    const commands = workflowCommands(event, messages);
    const candidates = commands.filter((command) => isTrustedWorkflowCandidate(command, options));
    if (commands.length !== candidates.length) {
      return ask("command-shape", "Automatic workflow approval cannot mix workflow commands with other shell operations.");
    }
    const info = await ctx.session?.get?.({ sessionID: event.sessionID });
    const directory = resolveWorkflowDirectory(event, info, messages);
    if (!directory) return ask("trusted-worktree", "Could not resolve the session worktree for automatic approval.");
    const metadata = await loadWorktreeMetadata(
      directory,
      runBunReadOnly,
      bunPathExists,
      undefined,
      options.trustedScripts ?? [],
    );
    if (!metadata) return ask("trusted-worktree", "Could not verify this session as a trusted Git worktree.");
    return evaluateTrustedWorkflowBatch(candidates, metadata, options);
  } catch {
    return ask("trusted-worktree", "Could not verify this worktree safely; human approval is required.");
  }
}
