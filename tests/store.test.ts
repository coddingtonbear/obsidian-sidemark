import { parseSidecarContent } from "@mrsf/cli/browser";
import { describe, expect, it } from "vitest";
import { addComment } from "../src/mutations";
import { type SidecarIO, SidecarStore, type StoreChange } from "../src/store";

class MemoryIO implements SidecarIO {
  files = new Map<string, string>();
  writes = 0;
  async read(path: string) {
    await Promise.resolve();
    return this.files.get(path) ?? null;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async write(path: string, content: string) {
    this.writes++;
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async rename(from: string, to: string) {
    const content = this.files.get(from);
    if (content === undefined) throw new Error("missing");
    this.files.delete(from);
    this.files.set(to, content);
  }
}

const entry = (id: string) => ({ id, author: "Adam", timestamp: "2026-09-16T10:00:00Z", text: "hello" });
const anchor = { selected_text: "x", line: 1, end_line: 1, start_column: 0, end_column: 1 };

function setup() {
  const io = new MemoryIO();
  const store = new SidecarStore(io);
  const changes: StoreChange[] = [];
  store.onChange((c) => changes.push(c));
  return { io, store, changes };
}

describe("SidecarStore", () => {
  it("creates the sidecar on the first comment and deletes it with the last", async () => {
    const { io, store, changes } = setup();
    expect((await store.load("dir/Note.md")).doc.comments).toEqual([]);
    await store.update("dir/Note.md", (doc) => addComment(doc, entry("a"), anchor));
    const written = parseSidecarContent(io.files.get("dir/Note.md.review.yaml") ?? "");
    expect(written).toMatchObject({ mrsf_version: "1.0", document: "dir/Note.md", comments: [{ id: "a" }] });
    await store.update("dir/Note.md", (doc) => {
      doc.comments = [];
    });
    expect(io.files.has("dir/Note.md.review.yaml")).toBe(false);
    expect(changes.map((c) => c.origin)).toEqual(["local", "local"]);
  });

  it("re-reads the file before each update so outside edits survive", async () => {
    const { io, store } = setup();
    await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    io.files.set(
      "Note.md.review.yaml",
      (io.files.get("Note.md.review.yaml") ?? "") +
        "  - id: agent\n    author: Claude\n    timestamp: '2026-09-16T11:00:00Z'\n    text: from outside\n    resolved: false\n"
    );
    await store.update("Note.md", (doc) => addComment(doc, entry("b"), anchor));
    expect(store.peek("Note.md")?.doc.comments.map((c) => c.id)).toEqual(["a", "agent", "b"]);
  });

  it("refuses to write over a sidecar it can't fully parse", async () => {
    const { io, store } = setup();
    io.files.set("Note.md.review.yaml", "mrsf_version: '1.0'\ncomments: not-a-list\n");
    const result = await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    expect(result.ok).toBe(false);
    expect(io.files.get("Note.md.review.yaml")).toBe("mrsf_version: '1.0'\ncomments: not-a-list\n");
    expect(store.peek("Note.md")?.error).toBeTruthy();
  });

  it("skips writing when nothing changed", async () => {
    const { io, store } = setup();
    await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    const writes = io.writes;
    await store.update("Note.md", () => undefined);
    expect(io.writes).toBe(writes);
  });

  it("ignores its own writes but reports outside changes", async () => {
    const { io, store, changes } = setup();
    await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    await store.sidecarChanged("Note.md");
    expect(changes.map((c) => c.origin)).toEqual(["local"]);
    io.files.set("Note.md.review.yaml", (io.files.get("Note.md.review.yaml") ?? "").replace("hello", "edited"));
    await store.sidecarChanged("Note.md");
    expect(changes.map((c) => c.origin)).toEqual(["local", "external"]);
    expect(store.peek("Note.md")?.doc.comments[0].text).toBe("edited");
  });

  it("moves the sidecar with a renamed note and updates document", async () => {
    const { io, store } = setup();
    await store.update("Old.md", (doc) => addComment(doc, entry("a"), anchor));
    await store.noteRenamed("Old.md", "folder/New.md");
    expect(io.files.has("Old.md.review.yaml")).toBe(false);
    expect(parseSidecarContent(io.files.get("folder/New.md.review.yaml") ?? "").document).toBe("folder/New.md");
  });

  it("doesn't clobber an existing sidecar at the rename target", async () => {
    const { io, store } = setup();
    await store.update("Old.md", (doc) => addComment(doc, entry("a"), anchor));
    io.files.set("New.md.review.yaml", "existing");
    expect(await store.noteRenamed("Old.md", "New.md")).toBe("conflict");
    expect(io.files.get("New.md.review.yaml")).toBe("existing");
    expect(io.files.has("Old.md.review.yaml")).toBe(true);
  });

  it("does nothing for notes without a sidecar", async () => {
    const { io, store } = setup();
    await store.noteRenamed("Old.md", "New.md");
    expect(io.files.size).toBe(0);
  });

  it("fixes document when the sidecar already moved with its folder", async () => {
    const { io, store } = setup();
    await store.update("a/Note.md", (doc) => addComment(doc, entry("x"), anchor));
    await io.rename("a/Note.md.review.yaml", "b/Note.md.review.yaml");
    expect(await store.noteRenamed("a/Note.md", "b/Note.md", true)).toBe("updated");
    expect(parseSidecarContent(io.files.get("b/Note.md.review.yaml") ?? "").document).toBe("b/Note.md");
  });

  it("leaves a stale sidecar alone when the renamed note had none", async () => {
    const { io, store } = setup();
    await store.update("Stale.md", (doc) => addComment(doc, entry("s"), anchor));
    const stale = io.files.get("Stale.md.review.yaml");
    expect(await store.noteRenamed("Old.md", "Stale.md")).toBe("none");
    expect(io.files.get("Stale.md.review.yaml")).toBe(stale);
  });

  it("applies overlapping renames in order (a swap through a temporary name)", async () => {
    const { io, store } = setup();
    await store.update("A.md", (doc) => addComment(doc, entry("from-a"), anchor));
    await store.update("B.md", (doc) => addComment(doc, entry("from-b"), anchor));
    await Promise.all([
      store.noteRenamed("A.md", "tmp.md"),
      store.noteRenamed("B.md", "A.md"),
      store.noteRenamed("tmp.md", "B.md"),
    ]);
    expect(parseSidecarContent(io.files.get("A.md.review.yaml") ?? "")).toMatchObject({ document: "A.md", comments: [{ id: "from-b" }] });
    expect(parseSidecarContent(io.files.get("B.md.review.yaml") ?? "")).toMatchObject({ document: "B.md", comments: [{ id: "from-a" }] });
    expect(io.files.has("tmp.md.review.yaml")).toBe(false);
  });

  it("applies a quick chain of renames in order", async () => {
    const { io, store } = setup();
    await store.update("A.md", (doc) => addComment(doc, entry("a"), anchor));
    await Promise.all([store.noteRenamed("A.md", "B.md"), store.noteRenamed("B.md", "C.md")]);
    expect([...io.files.keys()]).toEqual(["C.md.review.yaml"]);
    expect(parseSidecarContent(io.files.get("C.md.review.yaml") ?? "").document).toBe("C.md");
  });

  it("treats duplicate comment ids as unreadable rather than risk overwriting one", async () => {
    const { io, store } = setup();
    const raw =
      "mrsf_version: '1.0'\ndocument: Note.md\ncomments:\n" +
      "  - {id: x, author: A, timestamp: '2026-01-01T00:00:00Z', text: first, resolved: false}\n" +
      "  - {id: x, author: B, timestamp: '2026-01-01T00:00:00Z', text: second, resolved: false}\n";
    io.files.set("Note.md.review.yaml", raw);
    expect((await store.update("Note.md", () => undefined)).ok).toBe(false);
    expect(io.files.get("Note.md.review.yaml")).toBe(raw);
  });

  it("treats an empty sidecar file as having no comments", async () => {
    const { io, store } = setup();
    io.files.set("Note.md.review.yaml", "");
    expect((await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor))).ok).toBe(true);
    expect(parseSidecarContent(io.files.get("Note.md.review.yaml") ?? "").comments).toHaveLength(1);
  });

  it("keeps the sidecar when the deleted note has already come back", async () => {
    const { io, store } = setup();
    await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    io.files.set("Note.md", "restored");
    await store.noteDeleted("Note.md");
    expect(io.files.has("Note.md.review.yaml")).toBe(true);
  });

  it("deletes the sidecar with its note", async () => {
    const { io, store } = setup();
    await store.update("Note.md", (doc) => addComment(doc, entry("a"), anchor));
    await store.noteDeleted("Note.md");
    expect(io.files.size).toBe(0);
  });

  it("serializes concurrent updates", async () => {
    const { store } = setup();
    await Promise.all(["a", "b", "c"].map((id) => store.update("Note.md", (doc) => addComment(doc, entry(id), anchor))));
    expect(store.peek("Note.md")?.doc.comments.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
