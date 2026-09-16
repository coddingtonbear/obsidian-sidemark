import { anchorFieldsFor } from "./anchoring";
import type { Comment } from "./model";

/**
 * Converts Tandem Comments data (a ```tandem-comments JSON block near the end
 * of a note) into MRSF comments. The block format is described in the Tandem
 * Comments plugin's `store.ts`; this module reimplements just enough of it to
 * read the block and strip it from the note.
 */

const FENCE_OPEN = "```tandem-comments";

interface TandemAnchor {
  exact: string;
  prefix?: string;
  suffix?: string;
  pos?: number;
}

interface TandemEntry {
  author: string;
  ts: string;
  text: string;
}

interface TandemComment {
  anchor: TandemAnchor;
  status: "open" | "resolved";
  thread: TandemEntry[];
  suggestion?: { replacement: string; author: string; ts: string; result?: "accepted" | "declined" };
}

export interface TandemConversion {
  /** The note's text with the comment block removed. */
  text: string;
  comments: Comment[];
}

export type TandemParseResult =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; text: string; entries: [string, TandemComment][] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readEntry(value: unknown): TandemEntry | null {
  if (!isRecord(value)) return null;
  return { author: str(value.author, "Unknown"), ts: str(value.ts), text: str(value.text) };
}

function readComment(value: unknown): TandemComment | null {
  if (!isRecord(value) || !isRecord(value.anchor) || typeof value.anchor.exact !== "string") return null;
  const anchor: TandemAnchor = { exact: value.anchor.exact };
  if (typeof value.anchor.prefix === "string") anchor.prefix = value.anchor.prefix;
  if (typeof value.anchor.suffix === "string") anchor.suffix = value.anchor.suffix;
  if (typeof value.anchor.pos === "number") anchor.pos = value.anchor.pos;
  const thread = Array.isArray(value.thread)
    ? value.thread.map(readEntry).filter((e): e is TandemEntry => e !== null)
    : [];
  const comment: TandemComment = { anchor, status: value.status === "resolved" ? "resolved" : "open", thread };
  const s = value.suggestion;
  if (isRecord(s) && typeof s.replacement === "string") {
    comment.suggestion = { replacement: s.replacement, author: str(s.author, "Unknown"), ts: str(s.ts) };
    if (s.result === "accepted" || s.result === "declined") comment.suggestion.result = s.result;
  }
  return comment;
}

/** Finds and parses a note's tandem-comments block, returning the note text without it. */
export function parseTandemNote(raw: string): TandemParseResult {
  const idx = raw.lastIndexOf("\n" + FENCE_OPEN + "\n");
  let proseEnd: number;
  let bodyStart: number;
  if (idx >= 0) {
    proseEnd = idx;
    bodyStart = idx + FENCE_OPEN.length + 2;
  } else if (raw.startsWith(FENCE_OPEN + "\n")) {
    proseEnd = 0;
    bodyStart = FENCE_OPEN.length + 1;
  } else {
    return { kind: "none" };
  }
  const rest = raw.slice(bodyStart);
  // The block's closing fence is the first line that is exactly ``` (JSON can't contain one).
  let closeIdx = rest.indexOf("\n```");
  while (closeIdx >= 0 && closeIdx + 4 < rest.length && rest[closeIdx + 4] !== "\n") {
    closeIdx = rest.indexOf("\n```", closeIdx + 1);
  }
  if (closeIdx < 0) return { kind: "invalid", error: "The tandem-comments block is not closed." };
  const body = rest.slice(0, closeIdx);
  const trailing = closeIdx + 5 <= rest.length ? rest.slice(closeIdx + 5) : "";

  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("//") || lines[i].trim() === "")) i++;
  let data: unknown;
  try {
    data = JSON.parse(lines.slice(i).join("\n"));
  } catch (e) {
    return { kind: "invalid", error: e instanceof Error ? e.message : String(e) };
  }
  if (!isRecord(data)) return { kind: "invalid", error: "The tandem-comments block is not a JSON object." };

  const entries: [string, TandemComment][] = [];
  for (const [id, value] of Object.entries(data)) {
    const comment = readComment(value);
    if (!comment) return { kind: "invalid", error: `Comment "${id}" is malformed.` };
    entries.push([id, comment]);
  }
  const prose = raw.slice(0, proseEnd);
  const separator = prose && trailing && !prose.endsWith("\n") && !trailing.startsWith("\n") ? "\n" : "";
  let text = prose + separator + trailing;
  // The newline before the fence belonged to the block; keep the note newline-terminated.
  if (!trailing && prose && !prose.endsWith("\n")) text += "\n";
  return { kind: "ok", text, entries };
}

/** Tandem's own resolution: exact quote, disambiguated by prefix/suffix, then by closeness to pos. */
function resolveTandemAnchor(text: string, anchor: TandemAnchor): { from: number; to: number } | null {
  const { exact } = anchor;
  if (!exact) return null;
  const matches: number[] = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) matches.push(i);
  if (matches.length === 0) return null;
  let candidates = matches;
  if (candidates.length > 1) {
    const filtered = candidates.filter((m) => {
      if (anchor.prefix && text.slice(Math.max(0, m - anchor.prefix.length), m) !== anchor.prefix) return false;
      if (anchor.suffix && text.slice(m + exact.length, m + exact.length + anchor.suffix.length) !== anchor.suffix) {
        return false;
      }
      return true;
    });
    if (filtered.length > 0) candidates = filtered;
  }
  let best = candidates[0];
  if (anchor.pos != null && candidates.length > 1) {
    const pos = anchor.pos;
    best = candidates.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a));
  }
  return { from: best, to: best + exact.length };
}

/**
 * Builds MRSF comments from parsed Tandem data. `newId` supplies comment IDs;
 * each root keeps its Tandem ID in `x_tandem_id` so a re-run can skip it.
 */
export function convertTandemEntries(
  text: string,
  entries: [string, TandemComment][],
  newId: () => string
): Comment[] {
  const out: Comment[] = [];
  for (const [tandemId, tandem] of entries) {
    const resolved = tandem.status === "resolved";
    const acceptedHistory = resolved && tandem.suggestion?.result === "accepted";
    // An accepted suggestion's quote describes text that no longer exists.
    const range = acceptedHistory ? null : resolveTandemAnchor(text, tandem.anchor);
    const anchor: Partial<Comment> = range
      ? anchorFieldsFor(text, range.from, range.to)
      : { selected_text: tandem.anchor.exact };
    if (!range) {
      if (tandem.anchor.prefix) anchor.x_prefix = tandem.anchor.prefix;
      if (tandem.anchor.suffix) anchor.x_suffix = tandem.anchor.suffix;
    }

    let replies = tandem.thread;
    let root: Comment;
    const rootId = newId();
    if (tandem.suggestion) {
      const { suggestion } = tandem;
      // Tandem stores a suggestion's optional explanation as its first thread
      // entry, with the suggestion's own author and timestamp.
      const first = replies[0];
      const hasNote = first !== undefined && first.author === suggestion.author && first.ts === suggestion.ts;
      if (hasNote) replies = replies.slice(1);
      const data: Record<string, string> = { replacement: suggestion.replacement };
      if (suggestion.result) data.result = suggestion.result;
      root = {
        id: rootId,
        author: suggestion.author,
        timestamp: suggestion.ts,
        text: hasNote ? first.text : "",
        resolved,
        type: "suggestion",
        ...anchor,
        x_suggestion: data,
        x_tandem_id: tandemId,
      };
    } else {
      const first = replies[0];
      replies = replies.slice(1);
      root = {
        id: rootId,
        author: first?.author ?? "Unknown",
        timestamp: first?.ts ?? "",
        text: first?.text ?? "",
        resolved,
        ...anchor,
        x_tandem_id: tandemId,
      };
    }
    out.push(root);
    for (const reply of replies) {
      out.push({ id: newId(), author: reply.author, timestamp: reply.ts, text: reply.text, resolved, reply_to: rootId });
    }
  }
  return out;
}

export interface TandemMerge {
  /** Comments to append to the sidecar. */
  added: Comment[];
  /** Threads whose state differs between the note and the sidecar; the block must not be removed. */
  conflicts: string[];
}

function suggestionResultOf(comment: Comment): unknown {
  const data = comment.x_suggestion;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).result : undefined;
}

/**
 * Combines freshly converted Tandem threads with a sidecar that may already
 * hold some of them from an earlier, unfinished conversion. New threads are
 * added whole; for known threads only replies missing from the sidecar are
 * added. A known thread whose resolved state or suggestion outcome differs is
 * reported as a conflict, since either side may be the newer one.
 */
export function mergeTandemComments(existing: Comment[], converted: Comment[]): TandemMerge {
  const knownRoots = new Map<string, Comment>();
  for (const comment of existing) {
    if (typeof comment.x_tandem_id === "string" && comment.reply_to === undefined) {
      knownRoots.set(comment.x_tandem_id, comment);
    }
  }
  const added: Comment[] = [];
  const conflicts: string[] = [];
  const sameEntry = (a: Comment, b: Comment) => a.author === b.author && a.timestamp === b.timestamp && a.text === b.text;
  for (const root of converted.filter((c) => c.reply_to === undefined)) {
    const replies = converted.filter((c) => c.reply_to === root.id);
    const tandemId = typeof root.x_tandem_id === "string" ? root.x_tandem_id : undefined;
    const known = tandemId ? knownRoots.get(tandemId) : undefined;
    if (!known) {
      added.push(root, ...replies);
      continue;
    }
    if (known.resolved !== root.resolved || suggestionResultOf(known) !== suggestionResultOf(root)) {
      conflicts.push(tandemId ?? root.id);
    }
    const knownReplies = existing.filter((c) => c.reply_to === known.id);
    for (const reply of replies) {
      if (!knownReplies.some((k) => sameEntry(k, reply))) added.push({ ...reply, reply_to: known.id });
    }
  }
  return { added, conflicts };
}
