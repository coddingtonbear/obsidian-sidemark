import { describe, expect, it } from "vitest";
import { buildExportNote, formatThread } from "../src/export";
import type { Thread } from "../src/model";

const ts = "2026-09-16T10:00:00Z";
const comment: Thread = {
  root: { id: "a", author: "Adam", timestamp: ts, text: "Tighten this", resolved: false, selected_text: "some words" },
  replies: [{ id: "b", author: "Claude", timestamp: ts, text: "Done", resolved: false, reply_to: "a" }],
};
const suggestion: Thread = {
  root: {
    id: "s",
    author: "Claude",
    timestamp: ts,
    text: "",
    resolved: true,
    type: "suggestion",
    selected_text: "old",
    x_suggestion: { replacement: "new", result: "accepted" },
  },
  replies: [],
};

describe("formatThread", () => {
  it("includes the quote and every entry", () => {
    const out = formatThread(comment, true);
    expect(out.startsWith("> some words\n\n")).toBe(true);
    expect(out).toContain("**Adam**");
    expect(out).toContain(": Done");
  });

  it("shows a suggestion's replacement and outcome, skipping its empty explanation", () => {
    const out = formatThread(suggestion, false);
    expect(out).toContain("**Suggested edit by Claude**");
    expect(out).toContain("— accepted:\n> new");
    expect(out).not.toContain("**Claude** (");
  });

  it("shows a suggested deletion without an empty replacement quote", () => {
    const deletion: Thread = {
      root: { ...suggestion.root, resolved: false, x_suggestion: { replacement: "" } },
      replies: [],
    };
    const out = formatThread(deletion, true);
    expect(out).toContain("> old\n\n**Suggested deletion by Claude**");
    expect(out).not.toContain(":\n>");
  });
});

describe("buildExportNote", () => {
  it("groups threads by state", () => {
    const out = buildExportNote(
      "Plan",
      [
        { thread: comment, resolution: { kind: "resolved", from: 0, to: 3, ambiguous: false, fuzzy: false } },
        { thread: suggestion, resolution: { kind: "orphaned" } },
      ],
      "2026-09-16"
    );
    expect(out).toContain("Exported from [[Plan]] on [[2026-09-16]].");
    expect(out?.indexOf("# Open")).toBeLessThan(out?.indexOf("# Resolved") ?? 0);
    expect(out).not.toContain("# Orphaned");
  });

  it("returns null with nothing to export", () => {
    expect(buildExportNote("Plan", [], "2026-09-16")).toBeNull();
  });
});
