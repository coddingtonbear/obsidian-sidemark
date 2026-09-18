import { describe, expect, it } from "vitest";
import { draftSlot, threadStart } from "../src/draft-slot";
import type { ResolvedThread } from "../src/export";

function at(id: string, from: number): ResolvedThread {
  return {
    thread: { root: { id, author: "Adam", timestamp: "2026-09-18T11:00:00Z", text: "", resolved: false }, replies: [] },
    resolution: { kind: "resolved", from, to: from + 3, ambiguous: false, fuzzy: false },
  };
}

// Open threads as the sidebar lists them in document order.
const open = [at("a", 10), at("b", 40), at("c", 90)];

describe("draftSlot", () => {
  it("places the draft between the threads above and below its passage", () => {
    expect(draftSlot("document", 25, open)).toBe(1);
    expect(draftSlot("document", 60, open)).toBe(2);
  });

  it("places the draft first when its passage is above every thread", () => {
    expect(draftSlot("document", 0, open)).toBe(0);
  });

  it("places the draft last when its passage is below every thread", () => {
    expect(draftSlot("document", 200, open)).toBe(open.length);
  });

  it("places the draft after a thread that starts at the same place", () => {
    expect(draftSlot("document", 40, open)).toBe(2);
  });

  it("places the draft alone when there are no open threads", () => {
    expect(draftSlot("document", 25, [])).toBe(0);
  });

  it("places the draft first when sorted newest first, and last when oldest first", () => {
    expect(draftSlot("newest", 60, open)).toBe(0);
    expect(draftSlot("oldest", 0, open)).toBe(open.length);
  });
});

describe("threadStart", () => {
  it("sorts a thread with no passage after every anchored one", () => {
    const orphan: ResolvedThread = { thread: at("o", 0).thread, resolution: { kind: "orphaned" } };
    expect(threadStart(orphan)).toBeGreaterThan(threadStart(at("z", 1_000_000)));
  });
});
