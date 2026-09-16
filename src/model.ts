import type { Comment, MrsfDocument } from "@mrsf/cli/browser";

export type { Comment, MrsfDocument };

export const MRSF_VERSION = "1.0";

export type SuggestionResult = "accepted" | "declined";

/**
 * Edit suggestions aren't part of MRSF 1.0 (its `proposed` field is only a
 * listed future extension), so they live in an `x_suggestion` extension field
 * on a root comment with `type: suggestion`. The root's author/timestamp are
 * the proposal's, and its `text` is the optional explanation.
 */
export interface SuggestionData {
  replacement: string;
  result?: SuggestionResult;
}

export function emptyDocument(documentPath: string): MrsfDocument {
  return { mrsf_version: MRSF_VERSION, document: documentPath, comments: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The suggestion carried by a comment, or null for plain comments and malformed data. */
export function suggestionOf(comment: Comment): SuggestionData | null {
  const raw = comment.x_suggestion;
  if (!isRecord(raw) || typeof raw.replacement !== "string") return null;
  const result = raw.result === "accepted" || raw.result === "declined" ? raw.result : undefined;
  return result ? { replacement: raw.replacement, result } : { replacement: raw.replacement };
}

/** True when a comment claims to be a suggestion, even if its data is malformed. */
export function isSuggestionComment(comment: Comment): boolean {
  return comment.x_suggestion !== undefined || comment.type === "suggestion";
}

export function stringExtension(comment: Comment, key: `x_${string}`): string | undefined {
  const value = comment[key];
  return typeof value === "string" ? value : undefined;
}

/** A root comment with every descendant reply, oldest first. */
export interface Thread {
  root: Comment;
  replies: Comment[];
}

/**
 * Groups MRSF's flat `reply_to` list into threads. Nested replies are
 * flattened under their root; replies whose parent is missing (or that form a
 * cycle) are promoted to roots so nothing becomes invisible.
 */
export function buildThreads(doc: MrsfDocument): Thread[] {
  const byId = new Map(doc.comments.map((c) => [c.id, c]));
  const rootOf = (comment: Comment): Comment => {
    let current = comment;
    const seen = new Set<string>([current.id]);
    while (typeof current.reply_to === "string") {
      const parent = byId.get(current.reply_to);
      if (!parent) return current;
      // A reply_to cycle has no real root; show each member on its own.
      if (seen.has(parent.id)) return comment;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, Thread>();
  for (const comment of doc.comments) {
    const root = rootOf(comment);
    let thread = threads.get(root.id);
    if (!thread) {
      thread = { root, replies: [] };
      threads.set(root.id, thread);
    }
    if (root !== comment) thread.replies.push(comment);
  }
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => timeOf(a) - timeOf(b));
  }
  return [...threads.values()];
}

export function timeOf(comment: Comment): number {
  const t = Date.parse(comment.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** Most recent activity in a thread, for "newest/oldest" sorting. */
export function threadActivity(thread: Thread): number {
  return Math.max(timeOf(thread.root), ...thread.replies.map(timeOf));
}
