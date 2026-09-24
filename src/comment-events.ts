import { buildThreads, type Comment, isResolved, type MrsfDocument } from "./model";

/**
 * Comment events, worked out by comparing a note's comments before and after
 * each change. Comparing, rather than announcing from the places Sidemark
 * changes comments, means comments that arrive by sync, from the `mrsf` CLI,
 * or from a hand edit of the YAML are reported too.
 */

export const COMMENT_EVENT_TYPES = [
  "comment-added",
  "comment-edited",
  "comment-resolved",
  "comment-reopened",
  "comment-deleted",
] as const;

export type CommentEventType = (typeof COMMENT_EVENT_TYPES)[number];

/**
 * What an event stream sends for each event (the host adds `emitter` and
 * `event`). A type rather than an interface, so it's a `Record<string, unknown>`.
 */
export type CommentEventPayload = {
  /** The note the comment is on. */
  path: string;
  id: string;
  /** The id of the thread's root comment; the same as `id` for a root. */
  thread: string;
  /** The comment's own author and timestamp; MRSF doesn't record who resolved or deleted it. */
  author: string;
  timestamp: string;
  /** The comment's text, left out of `comment-deleted`. */
  text?: string;
};

export interface CommentEvent {
  type: CommentEventType;
  payload: CommentEventPayload;
}

/** Each comment's thread root, as the sidebar groups them. */
function rootsById(doc: MrsfDocument): Map<string, Comment> {
  const roots = new Map<string, Comment>();
  for (const { root, replies } of buildThreads(doc)) {
    roots.set(root.id, root);
    for (const reply of replies) roots.set(reply.id, root);
  }
  return roots;
}

function payload(path: string, comment: Comment, root: Comment | undefined, withText: boolean): CommentEventPayload {
  return {
    path,
    id: comment.id,
    thread: root?.id ?? comment.id,
    author: String(comment.author),
    timestamp: String(comment.timestamp),
    ...(withText ? { text: String(comment.text) } : {}),
  };
}

/**
 * The events between two versions of a note's comments. Resolving is reported
 * once per thread, for its root, although MRSF marks every comment in it.
 */
export function diffComments(path: string, before: MrsfDocument, after: MrsfDocument): CommentEvent[] {
  const events: CommentEvent[] = [];
  const old = new Map(before.comments.map((c) => [c.id, c]));
  const current = new Set(after.comments.map((c) => c.id));
  const oldRoots = rootsById(before);
  const newRoots = rootsById(after);

  for (const comment of before.comments) {
    if (!current.has(comment.id)) {
      events.push({ type: "comment-deleted", payload: payload(path, comment, oldRoots.get(comment.id), false) });
    }
  }
  for (const comment of after.comments) {
    const previous = old.get(comment.id);
    const root = newRoots.get(comment.id);
    const describe = () => payload(path, comment, root, true);
    if (!previous) {
      events.push({ type: "comment-added", payload: describe() });
      continue;
    }
    if (previous.text !== comment.text) events.push({ type: "comment-edited", payload: describe() });
    // Only roots carry a thread's state; a reply that's newly a root (its parent was deleted) isn't a resolve.
    if (root === comment && oldRoots.get(comment.id) === previous && isResolved(previous) !== isResolved(comment)) {
      events.push({ type: isResolved(comment) ? "comment-resolved" : "comment-reopened", payload: describe() });
    }
  }
  return events;
}

/** Narrows a listener argument back to the payload it was triggered with. */
export function isCommentEventPayload(value: unknown): value is CommentEventPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ["path", "id", "thread", "author", "timestamp"].every((key) => typeof candidate[key] === "string");
}
