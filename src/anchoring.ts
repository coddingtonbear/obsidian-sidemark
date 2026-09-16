import { combinedScore, resolveAnchor } from "@mrsf/cli/browser";
import { type Comment, stringExtension } from "./model";
import { type LineColumnRange, rangeToLineColumns } from "./positions";

/** Characters of surrounding text kept in `x_prefix`/`x_suffix` for disambiguation. */
export const CONTEXT_LENGTH = 20;

/**
 * MRSF's line/column fallback accepts whatever text now sits at the recorded
 * position, even when it is unrelated. A fallback match must be at least this
 * similar to the original or last-tracked text, or the comment is orphaned.
 */
export const FALLBACK_MIN_SIMILARITY = 0.25;

/**
 * A fuzzy match found by resolution (not by live tracking) is only saved back
 * to the sidecar when at least this similar; weaker guesses stay in memory so
 * they don't become the recorded position.
 */
export const PERSIST_MIN_SIMILARITY = 0.6;

export type Resolution =
  | {
      kind: "resolved";
      from: number;
      to: number;
      ambiguous: boolean;
      fuzzy: boolean;
      /** For fuzzy matches, similarity (0–1) between the found text and the recorded text. */
      similarity?: number;
    }
  | { kind: "orphaned" };

/** The anchoring fields for a new comment on `text.slice(from, to)`. */
export function anchorFieldsFor(text: string, from: number, to: number): Partial<Comment> & { selected_text: string } {
  const fields: Partial<Comment> & { selected_text: string } = {
    ...rangeToLineColumns(text, from, to),
    selected_text: text.slice(from, to),
  };
  const prefix = text.slice(Math.max(0, from - CONTEXT_LENGTH), from);
  const suffix = text.slice(to, to + CONTEXT_LENGTH);
  if (prefix) fields.x_prefix = prefix;
  if (suffix) fields.x_suffix = suffix;
  return fields;
}

function contextMatches(text: string, at: number, length: number, comment: Comment): boolean {
  const prefix = stringExtension(comment, "x_prefix");
  const suffix = stringExtension(comment, "x_suffix");
  if (prefix && text.slice(Math.max(0, at - prefix.length), at) !== prefix) return false;
  if (suffix && text.slice(at + length, at + length + suffix.length) !== suffix) return false;
  return true;
}

/** MRSF leaves exact-duplicate quotes without position hints ambiguous; x_prefix/x_suffix can settle them. */
function resolveByContext(text: string, comment: Comment): Resolution {
  const quote = comment.selected_text;
  if (!quote) return { kind: "orphaned" };
  const matches: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) matches.push(i);
  if (matches.length === 0) return { kind: "orphaned" };
  const filtered = matches.filter((m) => contextMatches(text, m, quote.length, comment));
  const candidates = filtered.length > 0 ? filtered : matches;
  return {
    kind: "resolved",
    from: candidates[0],
    to: candidates[0] + quote.length,
    ambiguous: candidates.length > 1,
    fuzzy: false,
  };
}

/** How similar `found` is to the comment's original or last-tracked text (1 = identical). */
function similarity(comment: Comment, found: string): number {
  if (found.trim() === "") return 0;
  const anchored = comment.anchored_text;
  if (anchored !== undefined && found === anchored) return 1;
  if (comment.selected_text === undefined) return 1;
  return Math.max(
    combinedScore(comment.selected_text, found),
    anchored !== undefined ? combinedScore(anchored, found) : 0
  );
}

/** Locates a comment's anchor in `text` using MRSF's resolution procedure (§7.4). */
export function resolveComment(comment: Comment, text: string): Resolution {
  if (comment.line == null && !comment.selected_text) return { kind: "orphaned" };
  const position = resolveAnchor(comment, text);
  if (position.status === "ambiguous") return resolveByContext(text, comment);
  if (position.status === "orphaned" || position.from == null || position.to == null) {
    return { kind: "orphaned" };
  }
  const from = Math.min(position.from, text.length);
  const to = Math.min(Math.max(position.to, from), text.length);
  const found = text.slice(from, to);
  const exact = comment.selected_text != null && found === comment.selected_text;
  if (exact) return { kind: "resolved", from, to, ambiguous: false, fuzzy: false };
  const score = similarity(comment, found);
  if (score < FALLBACK_MIN_SIMILARITY) return { kind: "orphaned" };
  return { kind: "resolved", from, to, ambiguous: false, fuzzy: true, similarity: score };
}

/**
 * Records a tracked position on a comment: fresh line/column fields, plus
 * `anchored_text` when the passage no longer matches the reviewer's original
 * `selected_text` (which MRSF says tools must not overwrite). Returns whether
 * anything changed.
 */
export function applyTrackedPosition(comment: Comment, text: string, from: number, to: number): boolean {
  const next = rangeToLineColumns(text, from, to);
  const current = text.slice(from, to);
  let changed = false;
  for (const key of Object.keys(next) as (keyof LineColumnRange)[]) {
    const value = next[key];
    if (comment[key] !== value) {
      comment[key] = value;
      changed = true;
    }
  }
  if (comment.selected_text === undefined) {
    comment.selected_text = current;
    changed = true;
  } else if (current !== comment.selected_text) {
    if (comment.anchored_text !== current) {
      comment.anchored_text = current;
      changed = true;
    }
  } else if (comment.anchored_text !== undefined) {
    delete comment.anchored_text;
    changed = true;
  }
  return changed;
}
