import { describe, expect, it } from "vitest";
import { hasTextSelectedIn, type Container, type SelectionLike } from "../src/text-selection";

// Nodes are only compared by identity here, so plain objects stand in for them.
const inside = {} as Node;
const outside = {} as Node;
const card: Container = { contains: (node) => node === inside };

function selection(anchorNode: Node | null, focusNode: Node | null, isCollapsed = false): SelectionLike {
  return { anchorNode, focusNode, isCollapsed };
}

describe("hasTextSelectedIn", () => {
  it("is true for text selected within the container", () => {
    expect(hasTextSelectedIn(selection(inside, inside), card)).toBe(true);
  });

  it("is true for a selection that starts or ends in the container", () => {
    expect(hasTextSelectedIn(selection(inside, outside), card)).toBe(true);
    expect(hasTextSelectedIn(selection(outside, inside), card)).toBe(true);
  });

  it("is false for a plain click, which leaves a collapsed selection", () => {
    expect(hasTextSelectedIn(selection(inside, inside, true), card)).toBe(false);
  });

  it("is false for text selected elsewhere, such as in the note", () => {
    expect(hasTextSelectedIn(selection(outside, outside), card)).toBe(false);
  });

  it("is false with no selection at all", () => {
    expect(hasTextSelectedIn(null, card)).toBe(false);
    expect(hasTextSelectedIn(selection(null, null), card)).toBe(false);
  });
});
