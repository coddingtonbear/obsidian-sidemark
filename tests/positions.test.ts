import { describe, expect, it } from "vitest";
import { lineColumnToOffset, rangeToLineColumns } from "../src/positions";

const text = "---\ntitle: x\n---\nfirst line\nsecond line\n";

describe("positions", () => {
  it("uses 1-based lines and 0-based columns over the raw file, frontmatter included", () => {
    const from = text.indexOf("second");
    expect(rangeToLineColumns(text, from, from + 6)).toEqual({
      line: 5,
      end_line: 5,
      start_column: 0,
      end_column: 6,
    });
  });

  it("handles ranges spanning lines", () => {
    const from = text.indexOf("line\nsecond");
    expect(rangeToLineColumns(text, from, from + 11)).toEqual({
      line: 4,
      end_line: 5,
      start_column: 6,
      end_column: 6,
    });
  });

  it("converts back to offsets, clamping to the line", () => {
    expect(lineColumnToOffset(text, 5, 0)).toBe(text.indexOf("second"));
    expect(lineColumnToOffset(text, 4, 999)).toBe(text.indexOf("\nsecond"));
    expect(lineColumnToOffset(text, 99, 0)).toBe(text.length);
  });
});
