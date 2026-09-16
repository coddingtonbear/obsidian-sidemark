import { parseSidecarContent } from "@mrsf/cli/browser";
import { describe, expect, it } from "vitest";
import type { MrsfDocument } from "../src/model";
import { serializeSidecar } from "../src/sidecar-yaml";

const handWritten = `# Review notes for the plan
mrsf_version: "1.0"
document: Plan.md
x_owner: adam # top-level extension
comments:
  - id: c1
    author: 'Adam (adam)'
    timestamp: '2026-09-16T10:00:00Z'
    text: >-
      A folded comment
      over two lines.
    resolved: false
    line: 3
    x_custom: keep me # tool-specific
  - id: c2
    author: Claude
    timestamp: '2026-09-16T10:05:00Z'
    text: "Second"
    resolved: false
    reply_to: c1
`;

describe("serializeSidecar", () => {
  it("writes a fresh file that MRSF can parse", () => {
    const doc: MrsfDocument = {
      mrsf_version: "1.0",
      document: "Plan.md",
      comments: [{ id: "a", author: "x", timestamp: "2026-01-01T00:00:00Z", text: "hi\nthere", resolved: false }],
    };
    expect(parseSidecarContent(serializeSidecar(null, doc))).toEqual(doc);
  });

  it("leaves unchanged content byte-for-byte identical", () => {
    const doc = parseSidecarContent(handWritten);
    expect(serializeSidecar(handWritten, doc)).toBe(handWritten);
  });

  it("changes only what changed, keeping comments and styles elsewhere", () => {
    const doc = parseSidecarContent(handWritten);
    doc.comments[1].resolved = true;
    doc.comments[0].line = 4;
    const out = serializeSidecar(handWritten, doc);
    expect(out).toContain("# Review notes for the plan");
    expect(out).toContain("x_custom: keep me # tool-specific");
    expect(out).toContain("text: >-\n");
    expect(out).toContain("author: 'Adam (adam)'");
    expect(out).toContain("line: 4");
    expect(parseSidecarContent(out)).toEqual(doc);
  });

  it("adds, removes, and reorders comments", () => {
    const doc = parseSidecarContent(handWritten);
    doc.comments = [
      doc.comments[1],
      { id: "c3", author: "New", timestamp: "2026-09-16T11:00:00Z", text: "Third", resolved: false },
    ];
    delete doc.comments[0].reply_to;
    const out = serializeSidecar(handWritten, doc);
    expect(parseSidecarContent(out)).toEqual(doc);
    expect(out).not.toContain("c1");
  });

  it("keeps top-level keys the lenient parser drops", () => {
    const doc: MrsfDocument = { mrsf_version: "1.0", document: "Plan.md", comments: parseSidecarContent(handWritten).comments };
    const out = serializeSidecar(handWritten, doc);
    expect(out).toContain("x_owner: adam # top-level extension");
  });

  it("pairs repeated ids in order instead of overwriting the first", () => {
    const raw =
      "comments:\n  - {id: x, text: first}\n  - {id: x, text: second}\n";
    const doc = { mrsf_version: "1.0", document: "N.md", comments: parseSidecarContent(raw).comments };
    const out = parseSidecarContent(serializeSidecar(raw, doc));
    expect(out.comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("starts over when the previous text isn't valid YAML", () => {
    const doc = parseSidecarContent(handWritten);
    expect(parseSidecarContent(serializeSidecar("comments: [", doc))).toEqual(doc);
  });
});
