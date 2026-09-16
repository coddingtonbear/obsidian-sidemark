import type { Comment, MrsfDocument, SuggestionData, SuggestionResult } from "./model";
import { isResolved, suggestionOf } from "./model";

export interface NewEntry {
  id: string;
  author: string;
  timestamp: string;
  text: string;
}

/** Anchoring fields produced by `anchorFieldsFor`, plus the quote's hash. */
export type AnchorFields = Partial<Comment> & { selected_text: string };

export function addComment(doc: MrsfDocument, entry: NewEntry, anchor: AnchorFields): Comment {
  const comment: Comment = { ...entry, resolved: false, ...anchor };
  doc.comments.push(comment);
  return comment;
}

export function addSuggestion(
  doc: MrsfDocument,
  entry: NewEntry,
  anchor: AnchorFields,
  replacement: string
): Comment {
  const suggestion: SuggestionData = { replacement };
  const comment: Comment = {
    ...entry,
    resolved: false,
    type: "suggestion",
    ...anchor,
    x_suggestion: { ...suggestion },
  };
  doc.comments.push(comment);
  return comment;
}

export function findComment(doc: MrsfDocument, id: string): Comment | undefined {
  return doc.comments.find((c) => c.id === id);
}

/** Every comment whose `reply_to` chain leads back to `rootId` (excluding the root). */
export function descendantIds(doc: MrsfDocument, rootId: string): Set<string> {
  const ids = new Set<string>();
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const c of doc.comments) {
      if (typeof c.reply_to === "string" && frontier.includes(c.reply_to) && !ids.has(c.id) && c.id !== rootId) {
        ids.add(c.id);
        next.push(c.id);
      }
    }
    frontier = next;
  }
  return ids;
}

export function addReply(doc: MrsfDocument, rootId: string, entry: NewEntry): Comment {
  if (!findComment(doc, rootId)) throw new Error(`Sidemark: unknown comment "${rootId}"`);
  const reply: Comment = { ...entry, resolved: false, reply_to: rootId };
  doc.comments.push(reply);
  return reply;
}

export type EditResult = { ok: true } | { ok: false; reason: "missing" | "conflict" };

/** Replaces a comment's text, refusing if it changed since the editor opened. */
export function editText(doc: MrsfDocument, id: string, expected: string, text: string): EditResult {
  const comment = findComment(doc, id);
  if (!comment) return { ok: false, reason: "missing" };
  if (comment.text !== expected) return { ok: false, reason: "conflict" };
  comment.text = text;
  return { ok: true };
}

/** Resolves or reopens a thread: MRSF tracks `resolved` per comment, so the replies follow the root. */
export function setThreadResolved(doc: MrsfDocument, rootId: string, resolved: boolean): void {
  const ids = descendantIds(doc, rootId);
  ids.add(rootId);
  for (const c of doc.comments) if (ids.has(c.id)) c.resolved = resolved;
}

export function deleteThread(doc: MrsfDocument, rootId: string): void {
  const ids = descendantIds(doc, rootId);
  ids.add(rootId);
  doc.comments = doc.comments.filter((c) => !ids.has(c.id));
}

const TARGETING_FIELDS = ["line", "end_line", "start_column", "end_column", "selected_text"] as const;

/**
 * Deletes one comment following MRSF §9.1: its direct replies inherit its
 * targeting fields (when they have none) and are re-parented to its parent.
 */
export function deleteComment(doc: MrsfDocument, id: string): void {
  const target = findComment(doc, id);
  if (!target) return;
  for (const reply of doc.comments) {
    if (reply.reply_to !== id) continue;
    if (TARGETING_FIELDS.every((field) => reply[field] === undefined)) {
      const fields: Record<string, unknown> = reply;
      for (const field of TARGETING_FIELDS) {
        if (target[field] !== undefined) fields[field] = target[field];
      }
    }
    if (typeof target.reply_to === "string") reply.reply_to = target.reply_to;
    else delete reply.reply_to;
  }
  doc.comments = doc.comments.filter((c) => c !== target);
}

export type ResolveBehavior = "keep" | "remove";

export type SuggestionFailure = "missing" | "not-suggestion" | "already-resolved" | "invalid-suggestion";

export type SuggestionOutcome = { ok: true; suggestion: SuggestionData } | { ok: false; reason: SuggestionFailure };

/** Checks that `rootId` is an open suggestion that can still be accepted or declined. */
export function openSuggestion(doc: MrsfDocument, rootId: string): SuggestionOutcome {
  const comment = findComment(doc, rootId);
  if (!comment) return { ok: false, reason: "missing" };
  if (comment.x_suggestion === undefined) return { ok: false, reason: "not-suggestion" };
  const suggestion = suggestionOf(comment);
  if (!suggestion) return { ok: false, reason: "invalid-suggestion" };
  if (comment.resolved || suggestion.result) return { ok: false, reason: "already-resolved" };
  return { ok: true, suggestion };
}

/** Records the outcome of a suggestion, keeping it as resolved history or removing the thread. */
export function finishSuggestion(
  doc: MrsfDocument,
  rootId: string,
  result: SuggestionResult,
  behavior: ResolveBehavior
): SuggestionOutcome {
  const check = openSuggestion(doc, rootId);
  if (!check.ok) return check;
  if (behavior === "remove") {
    deleteThread(doc, rootId);
    return check;
  }
  const comment = findComment(doc, rootId);
  if (comment) {
    comment.x_suggestion = { ...(comment.x_suggestion as Record<string, unknown>), result };
    setThreadResolved(doc, rootId, true);
  }
  return check;
}

/** Undoes an accept/decline decision so the suggestion can be acted on again. */
export function reopenSuggestion(doc: MrsfDocument, rootId: string): void {
  const comment = findComment(doc, rootId);
  if (!comment || comment.x_suggestion === undefined) return;
  const raw = { ...(comment.x_suggestion as Record<string, unknown>) };
  delete raw.result;
  comment.x_suggestion = raw;
  setThreadResolved(doc, rootId, false);
}

/**
 * Re-targets a comment at a new passage. This is a deliberate user action, so
 * unlike automatic re-anchoring it replaces `selected_text` (MRSF §6.2 allows
 * this as an opt-in) and clears the stale drift and re-anchoring markers.
 */
export function retarget(doc: MrsfDocument, id: string, anchor: AnchorFields): void {
  const comment = findComment(doc, id);
  if (!comment) return;
  for (const key of ["anchored_text", "x_reanchor_status", "x_reanchor_score", "x_prefix", "x_suffix", "selected_text_hash"]) {
    delete comment[key];
  }
  Object.assign(comment, anchor);
}

/** Removes every resolved thread; returns how many were removed. */
export function removeResolvedThreads(doc: MrsfDocument): number {
  const roots = doc.comments.filter((c) => c.reply_to === undefined && isResolved(c));
  for (const root of roots) deleteThread(doc, root.id);
  return roots.length;
}
