/**
 * A tiny, closed grammar of read-only output filters that may follow a command
 * the trusted-worktree preflight already owns:
 *
 *   <command> [2>&1] [ | <filter> ]{1,3}
 *   filter := tail -N | tail -n N | head -N | head -n N
 *           | grep [-E|-F|-i|-v|-n|-c]* <one quoted or plain pattern>
 *           | wc -l
 *
 * Pure parsing only. This module never decides whether the left-hand command
 * is allowed; the caller evaluates it exactly as if the filters were absent.
 * Filters read stdin only: no file operands, no follow/recursive/pattern-file
 * options, no redirection, no expansion. Anything outside the grammar is
 * `invalid` and the caller falls back to its behavior for composed commands.
 */

import { shellWords } from "./shell-words.js";

export type OutputFilterSplit =
  /** No unquoted pipe: not a filtered command; behave exactly as before. */
  | { readonly kind: "none" }
  /** An unquoted pipe that does not fit the grammar. */
  | { readonly kind: "invalid" }
  | { readonly kind: "filtered"; readonly command: string; readonly filters: readonly string[] };

const MAX_FILTERS = 3;
const MAX_LINES = 10000;
/** Quotes, backslashes, expansion, redirection, chaining, grouping and control characters (tab excepted). */
const FORBIDDEN = /[\\$`;&<>()\x00-\x08\x0a-\x1f\x7f]/;
/** A `#` that starts a word is a shell comment, which would hide the rest of the line. */
const COMMENT = /(?:^|\s)#/;
/** Outside quotes a filter may use only characters the shell never expands or reinterprets. */
const SAFE_UNQUOTED = /[A-Za-z0-9_.:@%+,=/\- \t'"]/;
const GREP_FLAGS = /^-[EFivnc]+$/;

/** Splits on `|` outside plain quotes. Returns null for unbalanced quotes or `||`. */
function splitUnquotedPipes(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "|") {
      if (command[i + 1] === "|") return null;
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

function hasOnlySafeUnquotedCharacters(segment: string): boolean {
  let quote: string | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (!SAFE_UNQUOTED.test(ch)) {
      return false;
    }
  }
  return quote === null;
}

function isLineCount(value: string): boolean {
  if (!/^[1-9]\d{0,4}$/.test(value)) return false;
  return Number(value) <= MAX_LINES;
}

function isLineLimitFilter(words: readonly string[]): boolean {
  if (words.length === 2) return /^-\d+$/.test(words[1]) ? isLineCount(words[1].slice(1)) : /^-n\d+$/.test(words[1]) && isLineCount(words[1].slice(2));
  return words.length === 3 && words[1] === "-n" && isLineCount(words[2]);
}

function isGrepFilter(words: readonly string[]): boolean {
  let i = 1;
  while (i < words.length && GREP_FLAGS.test(words[i])) i += 1;
  if (words.length - i !== 1) return false;
  const pattern = words[i];
  return pattern.length > 0 && !pattern.startsWith("-");
}

function isAllowedFilter(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0 || !hasOnlySafeUnquotedCharacters(trimmed)) return false;
  const words = shellWords(trimmed);
  if (!words || words.length === 0) return false;
  switch (words[0]) {
    case "tail":
    case "head":
      return isLineLimitFilter(words);
    case "grep":
      return isGrepFilter(words);
    case "wc":
      return words.length === 2 && words[1] === "-l";
    default:
      return false;
  }
}

export function splitOutputFilters(command: string): OutputFilterSplit {
  const segments = splitUnquotedPipes(command);
  if (segments === null) return /\|/.test(command) ? { kind: "invalid" } : { kind: "none" };
  if (segments.length === 1) return { kind: "none" };

  const filters = segments.slice(1).map((segment) => segment.trim());
  if (filters.length > MAX_FILTERS) return { kind: "invalid" };
  if (COMMENT.test(command)) return { kind: "invalid" };

  // `2>&1` is accepted only as the single last token of the command, before any pipe.
  const left = segments[0].trim().replace(/\s2>&1$/, "").trim();
  if (left.length === 0 || FORBIDDEN.test(left)) return { kind: "invalid" };
  for (const filter of filters) {
    if (FORBIDDEN.test(filter) || !isAllowedFilter(filter)) return { kind: "invalid" };
  }
  return { kind: "filtered", command: left, filters };
}
