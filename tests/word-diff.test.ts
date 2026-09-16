import { describe, expect, it } from "vitest";
import { type DiffPart, wordDiff } from "../src/word-diff";

const side = (parts: DiffPart[], skip: "del" | "ins") =>
  parts
    .filter((p) => p.kind !== skip)
    .map((p) => p.text)
    .join("");

function check(before: string, after: string): DiffPart[] {
  const parts = wordDiff(before, after);
  expect(side(parts, "ins")).toBe(before);
  expect(side(parts, "del")).toBe(after);
  return parts;
}

describe("wordDiff", () => {
  it("marks just the changed word", () => {
    expect(check("the quick brown fox", "the slow brown fox")).toEqual([
      { kind: "same", text: "the " },
      { kind: "del", text: "quick" },
      { kind: "ins", text: "slow" },
      { kind: "same", text: " brown fox" },
    ]);
  });

  it("reports insertions and deletions of words", () => {
    expect(check("a very big dog", "a big dog")).toEqual([
      { kind: "same", text: "a " },
      { kind: "del", text: "very " },
      { kind: "same", text: "big dog" },
    ]);
    expect(check("a big dog", "a big, friendly dog")).toEqual([
      { kind: "same", text: "a big" },
      { kind: "ins", text: ", friendly" },
      { kind: "same", text: " dog" },
    ]);
  });

  it("joins neighbouring changed words into one replacement", () => {
    expect(check("one two three four", "one 2 3 four")).toEqual([
      { kind: "same", text: "one " },
      { kind: "del", text: "two three" },
      { kind: "ins", text: "2 3" },
      { kind: "same", text: " four" },
    ]);
  });

  it("handles a full deletion, an empty original and identical text", () => {
    expect(check("gone", "")).toEqual([{ kind: "del", text: "gone" }]);
    expect(check("", "new")).toEqual([{ kind: "ins", text: "new" }]);
    expect(check("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });

  it("keeps multi-line text and punctuation intact", () => {
    check("Line one.\nLine two!", "Line 1.\n\nLine two?");
    check("café naïve", "cafe naïve");
  });
});
