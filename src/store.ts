import { parseSidecarContentLenient } from "@mrsf/cli/browser";
import { emptyDocument, type MrsfDocument } from "./model";
import { sidecarPathFor } from "./sidecar-path";
import { serializeSidecar } from "./sidecar-yaml";

/** File access the store needs; the plugin backs it with the Obsidian vault. */
export interface SidecarIO {
  /** The file's text, or null when it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Creates or overwrites the file. */
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Whether a file (such as a note) exists at `path`. */
  exists(path: string): Promise<boolean>;
}

/** What happened to a sidecar when its note was renamed. */
export type RenameOutcome = "moved" | "updated" | "none" | "conflict";

/**
 * Who caused a change: the plugin's own UI, the editor's live anchor
 * tracking, or something outside the plugin (a sync, an agent, a hand edit).
 */
export type ChangeOrigin = "local" | "tracking" | "external";

export interface StoreChange {
  notePath: string;
  origin: ChangeOrigin;
  /**
   * The note's comments before and after the change, when both are known:
   * absent when either side couldn't be parsed, or when an outside change
   * reached a note whose comments hadn't been loaded yet.
   */
  comments?: { before: MrsfDocument; after: MrsfDocument };
}

/** The last readable comments the store knew for a note, to compare a change against. */
function baseline(state: SidecarState | undefined): MrsfDocument | undefined {
  return state && !state.error ? state.doc : undefined;
}

export interface SidecarState {
  doc: MrsfDocument;
  /** Set when the sidecar exists but couldn't be fully parsed; such files are never written. */
  error?: string;
}

export type UpdateResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parse(notePath: string, raw: string | null): SidecarState {
  // An empty file holds no comments, so treat it like a missing one rather than as damaged.
  if (raw === null || raw.trim() === "") return { doc: emptyDocument(notePath) };
  const parsed = parseSidecarContentLenient(raw, sidecarPathFor(notePath));
  if (parsed.error || !parsed.doc) {
    return { doc: parsed.doc ?? emptyDocument(notePath), error: parsed.error ?? "Unreadable sidecar" };
  }
  const seen = new Set<string>();
  for (const comment of parsed.doc.comments) {
    // Comments are addressed by id, so a duplicate would make any write ambiguous.
    if (seen.has(comment.id)) return { doc: parsed.doc, error: `More than one comment has the id "${comment.id}"` };
    seen.add(comment.id);
  }
  return { doc: parsed.doc };
}

/** Queue key shared by every rename and delete, so overlapping moves run in order. */
const LIFECYCLE_QUEUE = "\u0000lifecycle";

/** Caches, reads, and writes the MRSF sidecar of each note. */
export class SidecarStore {
  private readonly cache = new Map<string, SidecarState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** What the plugin last wrote to each sidecar path (null = deleted), to recognize its own modify events. */
  private readonly written = new Map<string, string | null>();
  private readonly listeners = new Set<(change: StoreChange) => void>();

  constructor(private readonly io: SidecarIO) {}

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  /** The cached state, if the note's sidecar has been loaded. */
  peek(notePath: string): SidecarState | undefined {
    return this.cache.get(notePath);
  }

  async load(notePath: string): Promise<SidecarState> {
    const cached = this.cache.get(notePath);
    if (cached) return cached;
    return this.enqueue(notePath, async () => {
      const again = this.cache.get(notePath);
      if (again) return again;
      const state = parse(notePath, await this.io.read(sidecarPathFor(notePath)));
      this.cache.set(notePath, state);
      return state;
    });
  }

  /** Runs `task` after every earlier task for the same note, so read-modify-write cycles never interleave. */
  private enqueue<T>(notePath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(notePath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const settled = run.catch(() => undefined);
    this.queues.set(notePath, settled);
    void settled.then(() => {
      if (this.queues.get(notePath) === settled) this.queues.delete(notePath);
    });
    return run;
  }

  /**
   * Applies `mutate` to the note's comments and saves the result. The sidecar
   * is re-read first so changes made outside the plugin aren't overwritten.
   * The file is created on the first comment and deleted with the last.
   */
  update<T>(notePath: string, mutate: (doc: MrsfDocument) => T, origin: ChangeOrigin = "local"): Promise<UpdateResult<T>> {
    return this.enqueue(notePath, async () => {
      const path = sidecarPathFor(notePath);
      const raw = await this.io.read(path);
      const state = parse(notePath, raw);
      if (state.error) {
        this.cache.set(notePath, state);
        return { ok: false, error: state.error } as const;
      }
      const doc = state.doc;
      // Compared against what was last known rather than what was just read, so
      // an outside change this write takes in (before its modify event arrives,
      // which then matches this write and is ignored) is still reported.
      const before = baseline(this.cache.get(notePath)) ?? structuredClone(doc);
      const value = mutate(doc);
      doc.document = notePath;
      if (doc.comments.length === 0) {
        if (raw !== null) {
          this.written.set(path, null);
          await this.io.remove(path);
        }
      } else {
        const next = serializeSidecar(raw, doc);
        if (next !== raw) {
          this.written.set(path, next);
          await this.io.write(path, next);
        }
      }
      this.cache.set(notePath, { doc });
      this.emit({ notePath, origin, comments: { before, after: doc } });
      return { ok: true, value } as const;
    });
  }

  /**
   * Called when a sidecar file changed on disk. Ignores the plugin's own
   * writes; anything else is re-read and announced as an external change.
   */
  async sidecarChanged(notePath: string): Promise<void> {
    const path = sidecarPathFor(notePath);
    await this.enqueue(notePath, async () => {
      const raw = await this.io.read(path);
      if (this.written.has(path) && this.written.get(path) === raw) return;
      this.written.delete(path);
      if (!this.cache.has(notePath) && raw === null) return;
      const before = baseline(this.cache.get(notePath));
      const state = parse(notePath, raw);
      this.cache.set(notePath, state);
      const after = baseline(state);
      this.emit({ notePath, origin: "external", ...(before && after ? { comments: { before, after } } : {}) });
    });
  }

  /**
   * Moves a note's sidecar along with the note and updates its `document`
   * field. `folderMoved` says the sidecar already moved with a renamed folder.
   * Renames and deletes share one queue so chains and swaps apply in order.
   */
  async noteRenamed(oldNotePath: string, newNotePath: string, folderMoved = false): Promise<RenameOutcome> {
    const from = sidecarPathFor(oldNotePath);
    const to = sidecarPathFor(newNotePath);
    const outcome = await this.enqueue(LIFECYCLE_QUEUE, () =>
      this.enqueue(oldNotePath, async (): Promise<RenameOutcome> => {
        this.cache.delete(oldNotePath);
        const source = (await this.io.read(from)) !== null;
        const target = (await this.io.read(to)) !== null;
        if (source && target) return "conflict";
        if (source) {
          await this.io.rename(from, to);
          return "moved";
        }
        return target && folderMoved ? "updated" : "none";
      })
    );
    if (outcome === "moved" || outcome === "updated") {
      this.cache.delete(newNotePath);
      await this.update(newNotePath, () => undefined, "external");
    }
    return outcome;
  }

  /** Deletes a note's sidecar along with the note, unless the note has come back in the meantime. */
  async noteDeleted(notePath: string): Promise<void> {
    const path = sidecarPathFor(notePath);
    await this.enqueue(LIFECYCLE_QUEUE, () =>
      this.enqueue(notePath, async () => {
        this.cache.delete(notePath);
        if (await this.io.exists(notePath)) return;
        if ((await this.io.read(path)) === null) return;
        this.written.set(path, null);
        await this.io.remove(path);
      })
    );
  }

  forget(notePath: string): void {
    this.cache.delete(notePath);
  }
}
