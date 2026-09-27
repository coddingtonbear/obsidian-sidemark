import { describe, expect, it } from "vitest";
import { resolveComment } from "../src/anchoring";
import { commentTools } from "../src/mcp-comments";
import { buildThreads } from "../src/model";
import type { McpToolDefinition, McpToolResult } from "../src/rest-api";
import { CommentsApi, ErrorCodes, type ThreadJson } from "../src/rest-comments";
import { type SidecarIO, SidecarStore } from "../src/store";

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

function setup() {
  const io = new MemoryIO();
  const store = new SidecarStore(io);
  let n = 0;
  const api = new CommentsApi({
    load: (p) => store.load(p),
    update: (p, mutate) => store.update(p, mutate, "external"),
    noteText: async () => TEXT,
    resolveThreads: async (p) =>
      buildThreads((await store.load(p)).doc).map((thread) => ({ thread, resolution: resolveComment(thread.root, TEXT) })),
    newEntry: (body, author) => ({ id: `c${++n}`, author: author ?? "Adam", timestamp: `2026-09-24T10:00:0${n}Z`, text: body }),
  });
  const resolved: string[] = [];
  const tools = new Map<string, McpToolDefinition>(
    commentTools(api, (path) => {
      resolved.push(path);
      return path === NOTE || path === `/${NOTE}` ? NOTE : null;
    }).map((t) => [t.name, t])
  );
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.callback(args);
  };
  return { io, store, tools, call, resolved };
}

function json<T>(result: McpToolResult): T {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0].text) as T;
}

describe("commentTools", () => {
  it("offers one tool per comments operation, each taking a note path", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual([
      "comments_list",
      "comments_get",
      "comments_add",
      "comments_reply",
      "comments_update",
      "comments_delete",
    ]);
    for (const tool of tools.values()) {
      expect(tool.inputSchema?.path).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
    }
    expect(tools.get("comments_list")?.annotations).toEqual({ readOnlyHint: true });
    expect(tools.get("comments_delete")?.annotations).toEqual({ destructiveHint: true });
  });

  it("adds, lists, replies to, resolves, and deletes comments", async () => {
    const { call } = setup();
    const added = await call("comments_add", { path: NOTE, text: "Nice", quote: "brown fox", author: "Claude" });
    expect(added.isError).toBeUndefined();
    const thread = json<ThreadJson>(added);
    expect(thread.root).toMatchObject({ id: "c1", author: "Claude", text: "Nice", selected_text: "brown fox" });
    expect(thread.anchor).toMatchObject({ status: "anchored", text: "brown fox" });

    const replied = json<{ comment: { id: string; reply_to: string } }>(
      await call("comments_reply", { path: NOTE, id: "c1", text: "Thanks" })
    );
    expect(replied.comment).toMatchObject({ id: "c2", reply_to: "c1" });

    await call("comments_update", { path: NOTE, id: "c1", resolved: true });
    const open = json<{ threads: ThreadJson[] }>(await call("comments_list", { path: NOTE, resolved: false }));
    expect(open.threads).toEqual([]);
    const all = json<{ threads: ThreadJson[] }>(await call("comments_list", { path: NOTE }));
    expect(all.threads.map((t) => [t.id, t.resolved, t.replies.map((r) => r.id)])).toEqual([["c1", true, ["c2"]]]);

    const got = json<{ comment: { id: string }; thread: ThreadJson }>(await call("comments_get", { path: NOTE, id: "c2" }));
    expect(got.comment.id).toBe("c2");
    expect(got.thread.id).toBe("c1");

    const deleted = await call("comments_delete", { path: NOTE, id: "c1" });
    expect(deleted).toEqual({ content: [{ type: "text", text: "Done." }] });
    expect(json<{ threads: ThreadJson[] }>(await call("comments_list", { path: NOTE })).threads).toEqual([]);
  });

  it("edits text, refusing a stale expected_text", async () => {
    const { call } = setup();
    await call("comments_add", { path: NOTE, text: "Nice", quote: "brown fox" });
    const stale = await call("comments_update", { path: NOTE, id: "c1", text: "Better", expected_text: "Not it" });
    expect(stale.isError).toBe(true);
    expect(json<{ errorCode: number; text: string }>(stale)).toMatchObject({ errorCode: ErrorCodes.textConflict, text: "Nice" });
    const edited = await call("comments_update", { path: NOTE, id: "c1", text: "Better", expected_text: "Nice" });
    expect(json<{ comment: { text: string } }>(edited).comment.text).toBe("Better");
  });

  it("reports the REST API's errors as tool errors the model can act on", async () => {
    const { call } = setup();
    const ambiguous = await call("comments_add", { path: NOTE, text: "Which?", quote: "fox" });
    expect(ambiguous.isError).toBe(true);
    expect(json<{ errorCode: number; matches: number }>(ambiguous)).toMatchObject({
      errorCode: ErrorCodes.ambiguousQuote,
      matches: 2,
    });
    const second = await call("comments_add", { path: NOTE, text: "This one", quote: "fox", occurrence: 2 });
    expect(json<ThreadJson>(second).anchor).toMatchObject({ status: "anchored", from: TEXT.lastIndexOf("fox") });

    const missing = await call("comments_get", { path: NOTE, id: "nope" });
    expect(missing.isError).toBe(true);
    expect(json<{ errorCode: number }>(missing).errorCode).toBe(ErrorCodes.unknownComment);
  });

  it("resolves the note path before doing anything, and refuses a missing note", async () => {
    const { call, io, resolved } = setup();
    const result = await call("comments_reply", { path: "Elsewhere.md", id: "c1", text: "Hi" });
    expect(result).toEqual({ content: [{ type: "text", text: 'There\'s no note at "Elsewhere.md".' }], isError: true });
    expect(resolved).toEqual(["Elsewhere.md"]);
    // No sidecar is created for a note that doesn't exist.
    expect(io.files.size).toBe(0);

    const viaAlias = await call("comments_add", { path: `/${NOTE}`, text: "Nice", quote: "brown fox" });
    expect(viaAlias.isError).toBeUndefined();
    expect([...io.files.keys()]).toEqual(["dir/Note.md.review.yaml"]);
  });

  it("refuses arguments that don't match the tool's schema", async () => {
    const { call, resolved } = setup();
    const result = await call("comments_add", { path: NOTE, text: "Nice", quote: "brown fox", occurrence: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Invalid arguments: /);
    expect(resolved).toEqual([]);
  });

  it("reports a failing backend as a tool error instead of throwing", async () => {
    const api = new CommentsApi({
      load: () => Promise.reject(new Error("disk on fire")),
      update: () => Promise.reject(new Error("disk on fire")),
      noteText: async () => TEXT,
      resolveThreads: async () => [],
      newEntry: (text) => ({ id: "c1", author: "Adam", timestamp: "2026-09-24T10:00:00Z", text }),
    });
    const [list] = commentTools(api, (path) => path);
    expect(await list.callback({ path: NOTE })).toEqual({
      content: [{ type: "text", text: "Sidemark couldn't handle the request: disk on fire" }],
      isError: true,
    });
  });
});
