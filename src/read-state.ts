import { type Comment, isResolved, type Thread, timeOf } from "./model";

/**
 * Which comments you've read, kept in the plugin's data (so it syncs with
 * plugin settings) rather than in the sidecar, which is shared with everyone
 * who reviews the note.
 *
 * Only what can't be worked out is stored: your own comments always count as
 * read, and so does anything dated before tracking began (`since`), so a
 * thread only needs an entry once someone else has commented on it since.
 * Entries exist only for open threads, and are dropped when their thread is
 * resolved or deleted or their note goes away, so the whole record stays
 * smaller than the open comments in the vault's sidecars.
 */
export interface ReadState {
  /** When tracking began (ISO 8601). */
  since: string;
  /** Note path → thread (root comment id) → what's been read in it. */
  notes: Record<string, Record<string, ThreadRead>>;
}

export interface ThreadRead {
  /** `commentKey`s of the comments read. */
  seen: string[];
  /** Marked unread by hand: every comment by someone else counts as new. */
  unread?: true;
  /** When this device last changed the entry (ms since the epoch), for merging with other devices. */
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThreadRead(value: unknown): ThreadRead | null {
  if (!isRecord(value) || !Array.isArray(value.seen)) return null;
  const seen = value.seen.filter((key): key is string => typeof key === "string");
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0;
  return value.unread === true ? { seen, unread: true, at } : { seen, at };
}

/**
 * Turns whatever was stored into a valid read state. With nothing usable
 * stored, tracking begins `now`, so comments that already exist aren't new.
 */
export function parseReadState(value: unknown, now: Date): ReadState {
  const raw = isRecord(value) ? value : {};
  const since = typeof raw.since === "string" && Number.isFinite(Date.parse(raw.since)) ? raw.since : now.toISOString();
  const notes: ReadState["notes"] = {};
  if (isRecord(raw.notes)) {
    for (const [notePath, threads] of Object.entries(raw.notes)) {
      if (!isRecord(threads)) continue;
      const parsed: Record<string, ThreadRead> = {};
      for (const [rootId, read] of Object.entries(threads)) {
        const thread = parseThreadRead(read);
        if (thread) parsed[rootId] = thread;
      }
      if (Object.keys(parsed).length > 0) notes[notePath] = parsed;
    }
  }
  return { since, notes };
}

/** A short, stable key for a comment id: its 32-bit FNV-1a hash, as 8 hex digits. */
export function commentKey(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function threadComments(thread: Thread): Comment[] {
  return [thread.root, ...thread.replies];
}

/** Comments that can't be read without an entry: by someone else, and dated since tracking began. */
function needsEntry(state: ReadState, comment: Comment, me: string): boolean {
  return String(comment.author) !== me && timeOf(comment) >= Date.parse(state.since);
}

/** The ids of an open thread's comments you haven't read; a resolved thread has none. */
export function unreadIds(state: ReadState, notePath: string, thread: Thread, me: string): Set<string> {
  const unread = new Set<string>();
  if (isResolved(thread.root)) return unread;
  const read = state.notes[notePath]?.[thread.root.id];
  const seen = new Set(read?.seen);
  for (const comment of threadComments(thread)) {
    if (String(comment.author) === me) continue;
    if (read?.unread || (needsEntry(state, comment, me) && !seen.has(commentKey(comment.id)))) unread.add(comment.id);
  }
  return unread;
}

function setThread(state: ReadState, notePath: string, rootId: string, read: ThreadRead | null): void {
  const threads = state.notes[notePath] ?? {};
  if (read) threads[rootId] = read;
  else delete threads[rootId];
  if (Object.keys(threads).length > 0) state.notes[notePath] = threads;
  else delete state.notes[notePath];
}

/** Marks every comment in a thread read; returns whether anything changed. */
export function markRead(state: ReadState, notePath: string, thread: Thread, me: string, now = Date.now()): boolean {
  if (unreadIds(state, notePath, thread, me).size === 0) return false;
  const seen = threadComments(thread)
    .filter((comment) => needsEntry(state, comment, me))
    .map((comment) => commentKey(comment.id));
  // Kept even when empty, so a merge with another device knows this was read after any "unread" there.
  setThread(state, notePath, thread.root.id, { seen, at: now });
  return true;
}

/** Marks a thread unread, so each comment in it by someone else counts as new. */
export function markUnread(state: ReadState, notePath: string, rootId: string, now = Date.now()): void {
  setThread(state, notePath, rootId, { seen: [], unread: true, at: now });
}

/**
 * Drops what a note's current threads no longer need: entries for threads
 * that were resolved or deleted, and keys of deleted comments. Returns
 * whether anything was dropped.
 */
export function pruneNote(state: ReadState, notePath: string, threads: Thread[]): boolean {
  const entries = state.notes[notePath];
  if (!entries) return false;
  const open = new Map(threads.filter((t) => !isResolved(t.root)).map((t) => [t.root.id, t]));
  let changed = false;
  for (const [rootId, read] of Object.entries(entries)) {
    const thread = open.get(rootId);
    if (!thread) {
      setThread(state, notePath, rootId, null);
      changed = true;
      continue;
    }
    const existing = new Set(threadComments(thread).map((comment) => commentKey(comment.id)));
    const seen = read.seen.filter((key) => existing.has(key));
    if (seen.length !== read.seen.length) {
      setThread(state, notePath, rootId, { ...read, seen });
      changed = true;
    }
  }
  return changed;
}

/** Follows a note to its new path; returns whether it had anything recorded. */
export function renameNote(state: ReadState, from: string, to: string): boolean {
  const entries = state.notes[from];
  if (!entries) return false;
  delete state.notes[from];
  state.notes[to] = entries;
  return true;
}

export function removeNote(state: ReadState, notePath: string): boolean {
  if (!state.notes[notePath]) return false;
  delete state.notes[notePath];
  return true;
}

/** Drops notes that no longer exist (moved or deleted outside Obsidian); returns whether any were. */
export function sweep(state: ReadState, exists: (notePath: string) => boolean): boolean {
  let changed = false;
  for (const notePath of Object.keys(state.notes)) {
    if (!exists(notePath)) changed = removeNote(state, notePath) || changed;
  }
  return changed;
}

/**
 * Combines read state saved on another device with this one's. For each
 * thread, the more recent change wins when either marked it unread; two
 * plain read records are combined, since a comment read on either device is
 * read.
 */
export function mergeReadStates(local: ReadState, remote: ReadState): ReadState {
  const since = Date.parse(remote.since) < Date.parse(local.since) ? remote.since : local.since;
  const merged: ReadState = { since, notes: {} };
  for (const notePath of new Set([...Object.keys(local.notes), ...Object.keys(remote.notes)])) {
    const a = local.notes[notePath] ?? {};
    const b = remote.notes[notePath] ?? {};
    const threads: Record<string, ThreadRead> = {};
    for (const rootId of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[rootId];
      const y = b[rootId];
      if (!x || !y) {
        threads[rootId] = (x ?? y) as ThreadRead;
      } else if (x.unread || y.unread) {
        threads[rootId] = y.at > x.at ? y : x;
      } else {
        threads[rootId] = { seen: [...new Set([...x.seen, ...y.seen])], at: Math.max(x.at, y.at) };
      }
    }
    merged.notes[notePath] = threads;
  }
  return merged;
}
