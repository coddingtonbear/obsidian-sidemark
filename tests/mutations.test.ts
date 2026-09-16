import { describe, expect, it } from "vitest";
import { buildThreads, emptyDocument, suggestionOf, type MrsfDocument } from "../src/model";
import {
  addComment,
  addReply,
  addSuggestion,
  deleteComment,
  deleteThread,
  editText,
  finishSuggestion,
  removeResolvedThreads,
  reopenSuggestion,
  retarget,
  setThreadResolved,
} from "../src/mutations";

const ts = "2026-09-16T10:00:00Z";
const anchor = { selected_text: "quick", line: 1, end_line: 1, start_column: 4, end_column: 9 };

function entry(id: string, text = "text", timestamp = ts) {
  return { id, author: "Adam", timestamp, text };
}

function sample(): MrsfDocument {
  const doc = emptyDocument("Note.md");
  addComment(doc, entry("root"), anchor);
  addReply(doc, "root", entry("r1", "first", "2026-09-16T10:01:00Z"));
  addReply(doc, "root", entry("r2", "second", "2026-09-16T10:02:00Z"));
  return doc;
}

describe("threads", () => {
  it("groups replies under their root, oldest first", () => {
    const threads = buildThreads(sample());
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("root");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("flattens nested replies and promotes replies whose parent is missing", () => {
    const doc = sample();
    doc.comments.push({ ...entry("nested"), resolved: false, reply_to: "r1" });
    doc.comments.push({ ...entry("stray"), resolved: false, reply_to: "gone" });
    const threads = buildThreads(doc);
    expect(threads.map((t) => t.root.id)).toEqual(["root", "stray"]);
    expect(threads[0].replies.map((r) => r.id)).toContain("nested");
  });

  it("survives reply_to cycles", () => {
    const doc = emptyDocument("Note.md");
    doc.comments.push({ ...entry("a"), resolved: false, reply_to: "b" });
    doc.comments.push({ ...entry("b"), resolved: false, reply_to: "a" });
    expect(buildThreads(doc).flatMap((t) => [t.root, ...t.replies])).toHaveLength(2);
  });
});

describe("mutations", () => {
  it("resolves and reopens a whole thread", () => {
    const doc = sample();
    setThreadResolved(doc, "root", true);
    expect(doc.comments.every((c) => c.resolved)).toBe(true);
    setThreadResolved(doc, "root", false);
    expect(doc.comments.every((c) => !c.resolved)).toBe(true);
  });

  it("edits text only when it hasn't changed underneath", () => {
    const doc = sample();
    expect(editText(doc, "r1", "stale", "new")).toEqual({ ok: false, reason: "conflict" });
    expect(editText(doc, "nope", "first", "new")).toEqual({ ok: false, reason: "missing" });
    expect(editText(doc, "r1", "first", "new")).toEqual({ ok: true });
    expect(doc.comments[1].text).toBe("new");
  });

  it("deletes a thread with all its replies", () => {
    const doc = sample();
    doc.comments.push({ ...entry("nested"), resolved: false, reply_to: "r1" });
    deleteThread(doc, "root");
    expect(doc.comments).toEqual([]);
  });

  it("deletes a single comment by promoting its replies (MRSF §9.1)", () => {
    const doc = sample();
    doc.comments.push({ ...entry("nested"), resolved: false, reply_to: "r1" });
    deleteComment(doc, "r1");
    expect(doc.comments.find((c) => c.id === "nested")?.reply_to).toBe("root");
    deleteComment(doc, "root");
    const r2 = doc.comments.find((c) => c.id === "r2");
    expect(r2?.reply_to).toBeUndefined();
    expect(r2).toMatchObject(anchor);
  });

  it("removes resolved threads only", () => {
    const doc = sample();
    addComment(doc, entry("other"), anchor);
    setThreadResolved(doc, "root", true);
    expect(removeResolvedThreads(doc)).toBe(1);
    expect(doc.comments.map((c) => c.id)).toEqual(["other"]);
  });

  it("retargets a comment, clearing stale drift markers", () => {
    const doc = sample();
    Object.assign(doc.comments[0], { anchored_text: "quack", x_reanchor_status: "fuzzy", x_prefix: "old" });
    retarget(doc, "root", { selected_text: "brown", line: 2, end_line: 2, start_column: 0, end_column: 5 });
    expect(doc.comments[0]).toMatchObject({ selected_text: "brown", line: 2 });
    expect(doc.comments[0].anchored_text).toBeUndefined();
    expect(doc.comments[0].x_reanchor_status).toBeUndefined();
    expect(doc.comments[0].x_prefix).toBeUndefined();
  });
});

describe("suggestions", () => {
  function withSuggestion(): MrsfDocument {
    const doc = emptyDocument("Note.md");
    addSuggestion(doc, entry("s", ""), anchor, "slow");
    addReply(doc, "s", entry("s-r"));
    return doc;
  }

  it("stores the replacement in x_suggestion with type suggestion", () => {
    const doc = withSuggestion();
    expect(doc.comments[0]).toMatchObject({ type: "suggestion", x_suggestion: { replacement: "slow" } });
    expect(suggestionOf(doc.comments[0])).toEqual({ replacement: "slow" });
  });

  it("keeps accepted suggestions as resolved history", () => {
    const doc = withSuggestion();
    expect(finishSuggestion(doc, "s", "accepted", "keep")).toMatchObject({ ok: true });
    expect(doc.comments[0]).toMatchObject({ resolved: true, x_suggestion: { replacement: "slow", result: "accepted" } });
    expect(doc.comments[1].resolved).toBe(true);
    expect(finishSuggestion(doc, "s", "declined", "keep")).toEqual({ ok: false, reason: "already-resolved" });
  });

  it("removes finished suggestions when configured to", () => {
    const doc = withSuggestion();
    finishSuggestion(doc, "s", "declined", "remove");
    expect(doc.comments).toEqual([]);
  });

  it("reopens a finished suggestion", () => {
    const doc = withSuggestion();
    finishSuggestion(doc, "s", "accepted", "keep");
    reopenSuggestion(doc, "s");
    expect(doc.comments[0]).toMatchObject({ resolved: false, x_suggestion: { replacement: "slow" } });
    expect(suggestionOf(doc.comments[0])?.result).toBeUndefined();
  });

  it("rejects malformed suggestion data", () => {
    const doc = emptyDocument("Note.md");
    addComment(doc, entry("bad"), anchor);
    doc.comments[0].x_suggestion = { replacement: 5 };
    expect(finishSuggestion(doc, "bad", "accepted", "keep")).toEqual({ ok: false, reason: "invalid-suggestion" });
    expect(finishSuggestion(doc, "plain", "accepted", "keep")).toEqual({ ok: false, reason: "missing" });
  });
});
