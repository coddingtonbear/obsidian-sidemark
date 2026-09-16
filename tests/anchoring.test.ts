import { describe, expect, it } from "vitest";
import { anchorFieldsFor, applyTrackedPosition, resolveComment } from "../src/anchoring";
import type { Comment } from "../src/model";

const base: Comment = { id: "c1", author: "a", timestamp: "2026-01-01T00:00:00Z", text: "t", resolved: false };
const text = "# Title\n\nThe quick brown fox jumps.\nAnother brown fox line.\n";

function commentOn(source: string, quote: string, occurrence = 0): Comment {
  let from = -1;
  for (let i = 0; i <= occurrence; i++) from = source.indexOf(quote, from + 1);
  return { ...base, ...anchorFieldsFor(source, from, from + quote.length) };
}

describe("anchorFieldsFor", () => {
  it("records the quote, its position, and surrounding context", () => {
    const fields = anchorFieldsFor(text, 13, 18);
    expect(fields).toMatchObject({
      selected_text: "quick",
      line: 3,
      end_line: 3,
      start_column: 4,
      end_column: 9,
      x_prefix: "# Title\n\nThe ",
      x_suffix: " brown fox jumps.\nAn",
    });
  });
});

describe("resolveComment", () => {
  it("finds an exact quote", () => {
    const c = commentOn(text, "quick");
    expect(resolveComment(c, text)).toEqual({ kind: "resolved", from: 13, to: 18, ambiguous: false, fuzzy: false });
  });

  it("follows text that moved", () => {
    const c = commentOn(text, "quick");
    const moved = "Intro.\n\n" + text;
    const r = resolveComment(c, moved);
    expect(r.kind === "resolved" && moved.slice(r.from, r.to)).toBe("quick");
  });

  it("picks the right duplicate using the recorded position", () => {
    const c = commentOn(text, "brown fox", 1);
    const r = resolveComment(c, text);
    expect(r).toMatchObject({ kind: "resolved", from: text.lastIndexOf("brown fox") });
  });

  it("uses x_prefix/x_suffix when there is no position to break a tie", () => {
    const c = commentOn(text, "brown fox", 1);
    for (const key of ["line", "end_line", "start_column", "end_column"]) delete c[key];
    const r = resolveComment(c, text);
    expect(r).toMatchObject({ kind: "resolved", from: text.lastIndexOf("brown fox"), ambiguous: false });
  });

  it("falls back to the tracked position after the quote itself was edited", () => {
    const c = commentOn(text, "quick");
    const edited = text.replace("quick", "slow");
    const from = edited.indexOf("slow");
    applyTrackedPosition(c, edited, from, from + 4);
    const r = resolveComment(c, edited);
    expect(r).toEqual({ kind: "resolved", from, to: from + 4, ambiguous: false, fuzzy: true, similarity: 1 });
  });

  it("reports passages that are gone as orphaned", () => {
    const c = commentOn(text, "quick");
    expect(resolveComment(c, "Something else entirely.\nNothing shared.\n")).toEqual({ kind: "orphaned" });
  });
});

describe("applyTrackedPosition", () => {
  it("updates positions and records drift without touching selected_text", () => {
    const c = commentOn(text, "quick");
    const edited = "New first line\n" + text.replace("quick", "quicker");
    const from = edited.indexOf("quicker");
    expect(applyTrackedPosition(c, edited, from, from + 7)).toBe(true);
    expect(c).toMatchObject({ line: 4, start_column: 4, end_column: 11, selected_text: "quick", anchored_text: "quicker" });
  });

  it("clears anchored_text once the passage matches again", () => {
    const c = { ...commentOn(text, "quick"), anchored_text: "quicker" };
    expect(applyTrackedPosition(c, text, 13, 18)).toBe(true);
    expect(c.anchored_text).toBeUndefined();
  });

  it("reports no change when nothing moved", () => {
    const c = commentOn(text, "quick");
    expect(applyTrackedPosition(c, text, 13, 18)).toBe(false);
  });
});

describe("resolveComment plausibility", () => {
  it("orphans a comment whose line now holds unrelated text", () => {
    const c = commentOn(text, "The quick brown fox jumps.");
    const replaced = "# Title\n\nCompletely different sentence here.\n";
    expect(resolveComment(c, replaced)).toEqual({ kind: "orphaned" });
  });

  it("keeps a lightly edited passage", () => {
    const c = commentOn(text, "The quick brown fox jumps.");
    const edited = text.replace("The quick brown fox jumps.", "The quick brown cat jumps.");
    expect(resolveComment(c, edited)).toMatchObject({ kind: "resolved", fuzzy: true });
  });
});
