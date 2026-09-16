import { describe, expect, it } from "vitest";
import { suggestionEdit } from "../src/suggestion-edit";

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
