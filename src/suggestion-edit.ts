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
