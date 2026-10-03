import { describe, expect, it } from "vitest";
import { replaceInText, suggestionEdit } from "../src/suggestion-edit";

function apply(text: string, quote: string, replacement: string): string {
  const from = text.indexOf(quote);
  const edit = suggestionEdit(text, from, from + quote.length, replacement);
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

describe("suggestionEdit", () => {
  it("replaces the passage", () => {
    expect(apply("The quick fox", "quick", "slow")).toBe("The slow fox");
  });

  it("deletes a word between spaces without leaving a double space", () => {
    expect(apply("The quick fox", "quick", "")).toBe("The fox");
  });

  it("leaves surrounding whitespace alone when the deletion isn't between two spaces", () => {
    expect(apply("The quick fox", "quick ", "")).toBe("The fox");
    expect(apply("The quick, fox", "quick", "")).toBe("The , fox");
    expect(apply("quick fox", "quick", "")).toBe(" fox");
  });

  it("keeps spaces around a replacement", () => {
    expect(apply("a  b", " ", "x")).toBe("ax b");
  });
});

describe("replaceInText", () => {
  it("replaces the range when it reads as expected", () => {
    expect(replaceInText("The quick fox", 4, 9, "quick", "slow")).toBe("The slow fox");
  });

  it("refuses a range that no longer reads as expected", () => {
    expect(replaceInText("The quick fox", 4, 9, "quiet", "slow")).toBeNull();
  });

  it("counts a CRLF as one character and keeps the file's line endings", () => {
    const raw = "One\r\ntwo three\r\nfour";
    const lf = raw.replace(/\r\n/g, "\n");
    const from = lf.indexOf("three\nfour");
    expect(replaceInText(raw, from, from + 10, "three\nfour", "3\n4")).toBe("One\r\ntwo 3\r\n4");
  });

  it("leaves line endings outside the range alone in a file that mixes them", () => {
    const raw = "a\nb\r\nc";
    expect(replaceInText(raw, 4, 5, "c", "C")).toBe("a\nb\r\nC");
  });
});
