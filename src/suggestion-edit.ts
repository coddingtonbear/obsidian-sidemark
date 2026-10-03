/** The text change that accepting a suggestion makes. */
export interface SuggestionEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * The edit that replaces `text[from, to)` with `replacement`. A deletion that
 * would leave two spaces side by side also removes one of them, so deleting a
 * word from the middle of a sentence doesn't leave a double space behind.
 */
export function suggestionEdit(text: string, from: number, to: number, replacement: string): SuggestionEdit {
  if (replacement === "" && text[from - 1] === " " && text[to] === " ") {
    return { from, to: to + 1, insert: "" };
  }
  return { from, to, insert: replacement };
}

/**
 * `raw` with `[from, to)` replaced by `insert`, or null when that range doesn't
 * read `expected`. Offsets count each CRLF as one character, as the editor
 * does; the rest of the file keeps its line endings, and a file with CRLF ones
 * gets them for the inserted line breaks too.
 */
export function replaceInText(raw: string, from: number, to: number, expected: string, insert: string): string | null {
  const start = rawOffset(raw, from);
  const end = rawOffset(raw, to);
  if (raw.slice(start, end).replace(/\r\n/g, "\n") !== expected) return null;
  const text = raw.includes("\r\n") ? insert.replace(/\r?\n/g, "\r\n") : insert;
  return raw.slice(0, start) + text + raw.slice(end);
}

/** Where the `offset`-th character of `raw` with its CRLFs read as LFs is in `raw` itself. */
function rawOffset(raw: string, offset: number): number {
  let seen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (seen === offset) return i;
    if (!(raw[i] === "\r" && raw[i + 1] === "\n")) seen++;
  }
  return raw.length;
}
