/** Splits on whitespace, honoring plain '...' and "..." quotes. Backslashes and unbalanced quotes yield null. */
export function shellWords(command: string): string[] | null {
  if (command.includes("\\")) return null;
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(current);
  return words;
}
