import { describe, expect, it } from "vitest";
import { type CommentEvent, diffComments, isCommentEventPayload } from "../src/comment-events";
import { type Comment, emptyDocument, type MrsfDocument } from "../src/model";
import { sidecarPathFor } from "../src/sidecar-path";
import { serializeSidecar } from "../src/sidecar-yaml";
import { type SidecarIO, SidecarStore, type StoreChange } from "../src/store";

const NOTE = "dir/Note.md";

function comment(id: string, extra: Partial<Comment> = {}): Comment {
  return { id, author: "Adam", timestamp: "2026-09-24T10:00:00Z", text: `text of ${id}`, resolved: false, ...extra };
}

function doc(...comments: Comment[]): MrsfDocument {
  return { ...emptyDocument(NOTE), comments };
}

const kinds = (events: CommentEvent[]) => events.map((e) => [e.type, e.payload.id, e.payload.thread]);

describe("diffComments", () => {
  it("reports nothing when nothing changed that it describes", () => {
    const before = doc(comment("a", { line: 1 }));
    const after = doc(comment("a", { line: 7, anchored_text: "moved" }));
    expect(diffComments(NOTE, before, after)).toEqual([]);
  });

  it("reports added comments and replies with their thread", () => {
    const events = diffComments(NOTE, doc(), doc(comment("a"), comment("b", { reply_to: "a" })));
    expect(kinds(events)).toEqual([
      ["comment-added", "a", "a"],
      ["comment-added", "b", "a"],
    ]);
    expect(events[1].payload).toEqual({
      path: NOTE,
      id: "b",
      thread: "a",
      author: "Adam",
      timestamp: "2026-09-24T10:00:00Z",
      text: "text of b",
    });
  });

  it("reports edits", () => {
    const events = diffComments(NOTE, doc(comment("a")), doc(comment("a", { text: "changed" })));
    expect(kinds(events)).toEqual([["comment-edited", "a", "a"]]);
    expect(events[0].payload.text).toBe("changed");
  });

  it("reports resolving and reopening once per thread", () => {
    const open = doc(comment("a"), comment("b", { reply_to: "a" }));
    const closed = doc(comment("a", { resolved: true }), comment("b", { reply_to: "a", resolved: true }));
    expect(kinds(diffComments(NOTE, open, closed))).toEqual([["comment-resolved", "a", "a"]]);
    expect(kinds(diffComments(NOTE, closed, open))).toEqual([["comment-reopened", "a", "a"]]);
  });

  it("counts a suggestion's recorded outcome as resolving it", () => {
    const pending = doc(comment("s", { type: "suggestion", x_suggestion: { replacement: "x" } }));
    const declined = doc(comment("s", { type: "suggestion", x_suggestion: { replacement: "x", result: "declined" } }));
    expect(kinds(diffComments(NOTE, pending, declined))).toEqual([["comment-resolved", "s", "s"]]);
  });

  it("reports deletions without their text", () => {
    const before = doc(comment("a"), comment("b", { reply_to: "a" }));
    const events = diffComments(NOTE, before, doc());
    expect(kinds(events)).toEqual([
      ["comment-deleted", "a", "a"],
      ["comment-deleted", "b", "a"],
    ]);
    expect(events[0].payload).not.toHaveProperty("text");
  });

  it("doesn't call a reply promoted to root by its parent's deletion resolved or reopened", () => {
    const before = doc(comment("a", { resolved: true }), comment("b", { reply_to: "a", resolved: false }));
    const after = doc(comment("b", { resolved: false }));
    expect(kinds(diffComments(NOTE, before, after))).toEqual([["comment-deleted", "a", "a"]]);
  });
});

describe("isCommentEventPayload", () => {
  it("accepts a payload and refuses anything else", () => {
    const [event] = diffComments(NOTE, doc(), doc(comment("a")));
    expect(isCommentEventPayload(event.payload)).toBe(true);
    expect(isCommentEventPayload({ ...event.payload, id: 1 })).toBe(false);
    expect(isCommentEventPayload(null)).toBe(false);
    expect(isCommentEventPayload("comment-added")).toBe(false);
  });
});

class MemoryIO implements SidecarIO {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async rename() {}
}

function setup() {
  const io = new MemoryIO();
  const store = new SidecarStore(io);
  const changes: StoreChange[] = [];
  store.onChange((c) => changes.push(c));
  const events = () => changes.flatMap((c) => (c.comments ? kinds(diffComments(c.notePath, c.comments.before, c.comments.after)) : []));
  const writeOutside = (d: MrsfDocument) => io.files.set(sidecarPathFor(NOTE), serializeSidecar(null, d));
  return { io, store, changes, events, writeOutside };
}

describe("SidecarStore changes as comment events", () => {
  it("reports the plugin's own writes", async () => {
    const { store, events } = setup();
    await store.update(NOTE, (d) => d.comments.push(comment("a")));
    await store.update(NOTE, (d) => d.comments.push(comment("b", { reply_to: "a" })));
    expect(events()).toEqual([
      ["comment-added", "a", "a"],
      ["comment-added", "b", "a"],
    ]);
  });

  it("reports outside changes to a loaded note", async () => {
    const { store, events, writeOutside } = setup();
    await store.load(NOTE);
    writeOutside(doc(comment("a")));
    await store.sidecarChanged(NOTE);
    expect(events()).toEqual([["comment-added", "a", "a"]]);
  });

  it("reports an outside change a write took in before its modify event arrived", async () => {
    const { store, events, writeOutside } = setup();
    await store.update(NOTE, (d) => d.comments.push(comment("a")));
    writeOutside(doc(comment("a"), comment("synced")));
    await store.update(NOTE, (d) => d.comments.push(comment("mine")));
    // The modify event for the file now matches the plugin's own write, so it's ignored.
    await store.sidecarChanged(NOTE);
    expect(events()).toEqual([
      ["comment-added", "a", "a"],
      ["comment-added", "synced", "synced"],
      ["comment-added", "mine", "mine"],
    ]);
  });

  it("reports deleting the sidecar as deleting its comments", async () => {
    const { io, store, events } = setup();
    await store.update(NOTE, (d) => d.comments.push(comment("a")));
    io.files.delete(sidecarPathFor(NOTE));
    await store.sidecarChanged(NOTE);
    expect(events()).toEqual([
      ["comment-added", "a", "a"],
      ["comment-deleted", "a", "a"],
    ]);
  });

  it("reports nothing for an outside change to a note whose comments were never loaded", async () => {
    const { store, changes, writeOutside } = setup();
    writeOutside(doc(comment("a")));
    await store.sidecarChanged(NOTE);
    expect(changes).toEqual([{ notePath: NOTE, origin: "external" }]);
  });

  it("reports nothing across a sidecar that can't be parsed, and picks up again after", async () => {
    const { io, store, changes, events, writeOutside } = setup();
    await store.update(NOTE, (d) => d.comments.push(comment("a")));
    io.files.set(sidecarPathFor(NOTE), "comments: [\n");
    await store.sidecarChanged(NOTE);
    expect(changes[1].comments).toBeUndefined();
    writeOutside(doc(comment("a"), comment("b")));
    await store.sidecarChanged(NOTE);
    expect(changes[2].comments).toBeUndefined();
    await store.update(NOTE, (d) => d.comments.push(comment("c")));
    expect(events()).toEqual([
      ["comment-added", "a", "a"],
      ["comment-added", "c", "c"],
    ]);
  });
});
