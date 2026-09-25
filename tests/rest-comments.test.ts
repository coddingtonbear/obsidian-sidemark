import { describe, expect, it } from "vitest";
import { resolveComment } from "../src/anchoring";
import { buildThreads, type Comment } from "../src/model";
import { addComment, addSuggestion } from "../src/mutations";
import { type ApiError, type ApiResult, CommentsApi, ErrorCodes, quoteOffsets, type ThreadJson } from "../src/rest-comments";
import { sidecarPathFor } from "../src/sidecar-path";
import { type SidecarIO, SidecarStore, type StoreChange } from "../src/store";

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

const NOTE = "dir/Note.md";
const TEXT = "# Title\n\nThe quick brown fox jumps over the lazy dog. The fox again.\n";

function setup(text = TEXT) {
  const io = new MemoryIO();
  const store = new SidecarStore(io);
  const changes: StoreChange[] = [];
  store.onChange((c) => changes.push(c));
  let n = 0;
  const api = new CommentsApi({
    load: (p) => store.load(p),
    update: (p, mutate) => store.update(p, mutate, "external"),
    noteText: async () => text,
    resolveThreads: async (p) =>
      buildThreads((await store.load(p)).doc).map((thread) => ({ thread, resolution: resolveComment(thread.root, text) })),
    newEntry: (body, author) => ({ id: `c${++n}`, author: author ?? "Adam", timestamp: `2026-09-24T10:00:0${n}Z`, text: body }),
  });
  return { io, store, api, changes };
}

function bodyOf<T>(result: ApiResult): T {
  return result.body as T;
}

function expectError(result: ApiResult, code: number): ApiError & Record<string, unknown> {
  expect(result.status).toBe(Math.floor(code / 100));
  const body = bodyOf<ApiError & Record<string, unknown>>(result);
  expect(body.errorCode).toBe(code);
  return body;
}

async function seed() {
  const ctx = setup();
  const created = await ctx.api.create(NOTE, { text: "Nice", quote: "brown fox" });
  const reply = await ctx.api.reply(NOTE, "c1", { text: "Thanks", author: "Claude" });
  return { ...ctx, created, reply };
}

describe("quoteOffsets", () => {
  it("finds every match, overlapping ones included", () => {
    expect(quoteOffsets("aaaa", "aa")).toEqual([0, 1, 2]);
    expect(quoteOffsets("abc", "x")).toEqual([]);
  });
});

describe("CommentsApi.create", () => {
  it("anchors a new comment on the quote and saves it", async () => {
    const { api, io, store, changes } = setup();
    const result = await api.create(NOTE, { text: "Nice", quote: "brown fox" });
    expect(result.status).toBe(201);
    const thread = bodyOf<ThreadJson>(result);
    const from = TEXT.indexOf("brown fox");
    expect(thread.anchor).toEqual({
      status: "anchored",
      from,
      to: from + 9,
      line: 3,
      end_line: 3,
      start_column: 10,
      end_column: 19,
      text: "brown fox",
      ambiguous: false,
      fuzzy: false,
    });
    expect(thread.root).toMatchObject({ id: "c1", author: "Adam", text: "Nice", selected_text: "brown fox", resolved: false });
    expect(thread.root.selected_text_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(io.files.has(sidecarPathFor(NOTE))).toBe(true);
    expect((await store.load(NOTE)).doc.comments).toHaveLength(1);
    expect(changes).toEqual([{ notePath: NOTE, origin: "external" }]);
  });

  it("uses the author from the body", async () => {
    const { api } = setup();
    const thread = bodyOf<ThreadJson>(await api.create(NOTE, { text: "Hi", quote: "lazy", author: "  Claude " }));
    expect(thread.root.author).toBe("Claude");
  });

  it("asks which match when the quote appears more than once", async () => {
    const { api, io } = setup();
    const body = expectError(await api.create(NOTE, { text: "Hi", quote: "fox" }), ErrorCodes.ambiguousQuote);
    expect(body.matches).toBe(2);
    expect(io.files.size).toBe(0);
  });

  it("anchors on the chosen occurrence", async () => {
    const { api } = setup();
    const thread = bodyOf<ThreadJson>(await api.create(NOTE, { text: "Hi", quote: "fox", occurrence: 2 }));
    expect(thread.anchor).toMatchObject({ status: "anchored", from: TEXT.lastIndexOf("fox") });
  });

  it("refuses a quote that isn't in the note, or an occurrence past the last match", async () => {
    const { api } = setup();
    expectError(await api.create(NOTE, { text: "Hi", quote: "cat" }), ErrorCodes.quoteNotFound);
    expectError(await api.create(NOTE, { text: "Hi", quote: "fox", occurrence: 3 }), ErrorCodes.quoteNotFound);
  });

  it.each([
    ["a non-object body", "text"],
    ["a missing text", { quote: "fox" }],
    ["a blank text", { text: "  ", quote: "fox" }],
    ["a missing quote", { text: "Hi" }],
    ["a zero occurrence", { text: "Hi", quote: "fox", occurrence: 0 }],
    ["a fractional occurrence", { text: "Hi", quote: "fox", occurrence: 1.5 }],
    ["a blank author", { text: "Hi", quote: "lazy", author: " " }],
  ])("refuses %s", async (_label, body) => {
    const { api, io } = setup();
    expectError(await api.create(NOTE, body), ErrorCodes.invalidBody);
    expect(io.files.size).toBe(0);
  });
});

describe("CommentsApi.list and get", () => {
  it("lists threads with their replies and current anchors", async () => {
    const { api } = await seed();
    const result = await api.list(NOTE, {});
    expect(result.status).toBe(200);
    const { threads } = bodyOf<{ threads: ThreadJson[] }>(result);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "c1", resolved: false, anchor: { status: "anchored", text: "brown fox" } });
    expect(threads[0].replies.map((r) => [r.id, r.author, r.reply_to])).toEqual([["c2", "Claude", "c1"]]);
  });

  it("filters by resolved state", async () => {
    const { api } = await seed();
    await api.create(NOTE, { text: "Done", quote: "lazy" });
    await api.patch(NOTE, "c3", { resolved: true });
    const ids = async (resolved: string) =>
      bodyOf<{ threads: ThreadJson[] }>(await api.list(NOTE, { resolved })).threads.map((t) => t.id);
    expect(await ids("false")).toEqual(["c1"]);
    expect(await ids("true")).toEqual(["c3"]);
    expectError(await api.list(NOTE, { resolved: "yes" }), ErrorCodes.invalidQuery);
  });

  it("reports an orphaned anchor", async () => {
    const { api, store } = setup();
    await store.update(NOTE, (doc) =>
      addComment(doc, { id: "x", author: "A", timestamp: "2026-09-24T10:00:00Z", text: "Gone" }, { selected_text: "not in the note" })
    );
    const { threads } = bodyOf<{ threads: ThreadJson[] }>(await api.list(NOTE, {}));
    expect(threads[0].anchor).toEqual({ status: "orphaned" });
  });

  it("returns a comment with its whole thread, by root or reply id", async () => {
    const { api } = await seed();
    for (const id of ["c1", "c2"]) {
      const result = await api.get(NOTE, id);
      expect(result.status).toBe(200);
      const body = bodyOf<{ comment: Comment; thread: ThreadJson }>(result);
      expect(body.comment.id).toBe(id);
      expect(body.thread.id).toBe("c1");
      expect(body.thread.replies).toHaveLength(1);
    }
    expectError(await api.get(NOTE, "nope"), ErrorCodes.unknownComment);
  });

  it("refuses to use a sidecar that can't be read", async () => {
    const { api, io } = setup();
    io.files.set(sidecarPathFor(NOTE), "mrsf_version: '1.0'\ndocument: dir/Note.md\ncomments: [\n");
    expectError(await api.list(NOTE, {}), ErrorCodes.unreadableSidecar);
    expectError(await api.get(NOTE, "c1"), ErrorCodes.unreadableSidecar);
    expectError(await api.create(NOTE, { text: "Hi", quote: "lazy" }), ErrorCodes.unreadableSidecar);
  });
});

describe("CommentsApi.reply", () => {
  it("adds a reply to the comment", async () => {
    const { reply } = await seed();
    expect(reply.status).toBe(201);
    expect(bodyOf<{ comment: Comment }>(reply).comment).toMatchObject({ id: "c2", reply_to: "c1", text: "Thanks" });
  });

  it("refuses a reply to an unknown comment without writing anything", async () => {
    const { api, io } = setup();
    expectError(await api.reply(NOTE, "nope", { text: "Hi" }), ErrorCodes.unknownComment);
    expect(io.files.size).toBe(0);
  });
});

describe("CommentsApi.patch", () => {
  it("edits the text, checking expected_text when given", async () => {
    const { api, store } = await seed();
    const result = await api.patch(NOTE, "c1", { text: "Very nice", expected_text: "Nice" });
    expect(result.status).toBe(200);
    expect(bodyOf<{ comment: Comment }>(result).comment.text).toBe("Very nice");
    const conflict = expectError(await api.patch(NOTE, "c1", { text: "Other", expected_text: "Nice" }), ErrorCodes.textConflict);
    expect(conflict.text).toBe("Very nice");
    expect((await store.load(NOTE)).doc.comments.find((c) => c.id === "c1")?.text).toBe("Very nice");
    expect((await api.patch(NOTE, "c1", { text: "Unchecked" })).status).toBe(200);
  });

  it("resolves and reopens the whole thread, even through a reply's id", async () => {
    const { api, store } = await seed();
    await api.patch(NOTE, "c2", { resolved: true });
    expect((await store.load(NOTE)).doc.comments.map((c) => c.resolved)).toEqual([true, true]);
    await api.patch(NOTE, "c1", { resolved: false });
    expect((await store.load(NOTE)).doc.comments.map((c) => c.resolved)).toEqual([false, false]);
  });

  it("changes nothing when one part of the request is refused", async () => {
    const { api, store } = await seed();
    expectError(await api.patch(NOTE, "c1", { text: "New", expected_text: "Stale", resolved: true }), ErrorCodes.textConflict);
    expect((await store.load(NOTE)).doc.comments[0]).toMatchObject({ text: "Nice", resolved: false });
  });

  it("refuses to resolve a suggestion", async () => {
    const { api, store } = setup();
    await store.update(NOTE, (doc) =>
      addSuggestion(doc, { id: "s", author: "A", timestamp: "2026-09-24T10:00:00Z", text: "" }, { selected_text: "lazy" }, "sleepy")
    );
    expectError(await api.patch(NOTE, "s", { resolved: true }), ErrorCodes.suggestionResolve);
    expect((await store.load(NOTE)).doc.comments[0].resolved).toBe(false);
    expect((await api.patch(NOTE, "s", { text: "Reads better" })).status).toBe(200);
  });

  it.each([
    ["an empty change", {}],
    ["expected_text without text", { expected_text: "Nice", resolved: true }],
    ["a non-boolean resolved", { resolved: "yes" }],
    ["a blank text", { text: "" }],
  ])("refuses %s", async (_label, body) => {
    const { api } = await seed();
    expectError(await api.patch(NOTE, "c1", body), ErrorCodes.invalidBody);
  });

  it("refuses an unknown comment", async () => {
    const { api } = await seed();
    expectError(await api.patch(NOTE, "nope", { resolved: true }), ErrorCodes.unknownComment);
  });
});

describe("CommentsApi.remove", () => {
  it("deletes a reply on its own", async () => {
    const { api, store } = await seed();
    expect((await api.remove(NOTE, "c2")).status).toBe(204);
    expect((await store.load(NOTE)).doc.comments.map((c) => c.id)).toEqual(["c1"]);
  });

  it("deletes a root with its thread, and the sidecar with the last comment", async () => {
    const { api, io } = await seed();
    expect((await api.remove(NOTE, "c1")).status).toBe(204);
    expect(io.files.has(sidecarPathFor(NOTE))).toBe(false);
  });

  it("refuses an unknown comment", async () => {
    const { api } = await seed();
    expectError(await api.remove(NOTE, "nope"), ErrorCodes.unknownComment);
  });
});

describe("CommentsApi on a file that isn't a Markdown note", () => {
  const IMAGE = "dir/image.png";

  it("refuses every operation without reading or writing a comment file", async () => {
    const { api, io } = setup();
    const results = [
      await api.list(IMAGE, {}),
      await api.get(IMAGE, "c1"),
      await api.create(IMAGE, { text: "Nice", quote: "brown fox" }),
      await api.reply(IMAGE, "c1", { text: "Thanks" }),
      await api.patch(IMAGE, "c1", { resolved: true }),
      await api.remove(IMAGE, "c1"),
    ];
    for (const result of results) expectError(result, ErrorCodes.notANote);
    expect(io.files.size).toBe(0);
  });
});
