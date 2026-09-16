import { describe, expect, it } from "vitest";
import { notePathFor, sidecarPathFor } from "../src/sidecar-path";

describe("sidecar paths", () => {
  it("appends the MRSF suffix to the full note path", () => {
    expect(sidecarPathFor("docs/Plan.md")).toBe("docs/Plan.md.review.yaml");
  });

  it("round-trips back to the note path", () => {
    expect(notePathFor("docs/Plan.md.review.yaml")).toBe("docs/Plan.md");
  });

  it("rejects paths that aren't Markdown sidecars", () => {
    expect(notePathFor("docs/Plan.md")).toBeNull();
    expect(notePathFor("docs/data.json.review.yaml")).toBeNull();
  });
});
