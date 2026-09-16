import { describe, expect, it } from "vitest";
import { convertTandemEntries, mergeTandemComments, parseTandemNote } from "../src/tandem-migration";

const block = {
  a1b2: {
    anchor: { exact: "brown fox", prefix: "The quick ", suffix: " jumps", pos: 14 },
    status: "open",
    thread: [
      { author: "Adam", ts: "2026-09-01T10:00:00Z", text: "Which fox?" },
      { author: "Claude", ts: "2026-09-01T11:00:00Z", text: "The brown one." },
    ],
  },
  c3d4: {
    anchor: { exact: "lazy dog" },
    status: "open",
    thread: [{ author: "Claude", ts: "2026-09-02T10:00:00Z", text: "Too informal" }],
    suggestion: { replacement: "sleepy dog", author: "Claude", ts: "2026-09-02T10:00:00Z" },
  },
  e5f6: {
    anchor: { exact: "old words" },
    status: "resolved",
    thread: [{ author: "Adam", ts: "2026-09-03T10:00:00Z", text: "Nice" }],
    suggestion: { replacement: "new words", author: "Claude", ts: "2026-09-03T09:00:00Z", result: "accepted" },
  },
};

const prose = "# Title\n\nThe quick brown fox jumps over the lazy dog.\nnew words here.";
const note = `${prose}\n\`\`\`tandem-comments\n// Schema: {...}\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

describe("parseTandemNote", () => {
  it("returns none for notes without a block", () => {
    expect(parseTandemNote("just prose\n")).toEqual({ kind: "none" });
  });

  it("strips the block and keeps content after it", () => {
    const parsed = parseTandemNote(note + "[^1]: a footnote\n");
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.text).toBe(prose + "\n[^1]: a footnote\n");
      expect(parsed.entries.map(([id]) => id)).toEqual(["a1b2", "c3d4", "e5f6"]);
    }
  });

  it("keeps the note newline-terminated", () => {
    const parsed = parseTandemNote(note);
    expect(parsed.kind === "ok" && parsed.text).toBe(prose + "\n");
  });

  it("reports broken JSON instead of guessing", () => {
    expect(parseTandemNote("text\n```tandem-comments\n{ nope\n```\n").kind).toBe("invalid");
    expect(parseTandemNote("text\n```tandem-comments\n{}\n").kind).toBe("invalid");
  });
});

describe("convertTandemEntries", () => {
  const parsed = parseTandemNote(note);
  if (parsed.kind !== "ok") throw new Error("fixture should parse");
  const comments = convertTandemEntries(parsed.text, parsed.entries, ids());

  it("turns the first thread entry into the root and the rest into replies", () => {
    expect(comments[0]).toMatchObject({
      id: "id-1",
      author: "Adam",
      text: "Which fox?",
      resolved: false,
      selected_text: "brown fox",
      line: 3,
      start_column: 10,
      end_column: 19,
      x_tandem_id: "a1b2",
    });
    expect(comments[1]).toMatchObject({ id: "id-2", author: "Claude", reply_to: "id-1", text: "The brown one." });
  });

  it("turns a suggestion's matching first entry into its explanation", () => {
    expect(comments[2]).toMatchObject({
      author: "Claude",
      text: "Too informal",
      type: "suggestion",
      x_suggestion: { replacement: "sleepy dog" },
      selected_text: "lazy dog",
    });
    expect(comments.filter((c) => c.reply_to === comments[2].id)).toEqual([]);
  });

  it("keeps accepted suggestions as unanchored resolved history with their replies", () => {
    const accepted = comments.find((c) => c.x_tandem_id === "e5f6");
    expect(accepted).toMatchObject({ resolved: true, text: "", x_suggestion: { replacement: "new words", result: "accepted" } });
    expect(accepted?.line).toBeUndefined();
    const reply = comments.find((c) => c.reply_to === accepted?.id);
    expect(reply).toMatchObject({ author: "Adam", text: "Nice", resolved: true });
  });

  it("keeps the Tandem context for passages it can't find", () => {
    const [entry] = parsed.entries;
    const orphan = convertTandemEntries("unrelated text", [entry], ids())[0];
    expect(orphan).toMatchObject({ selected_text: "brown fox", x_prefix: "The quick ", x_suffix: " jumps" });
    expect(orphan.line).toBeUndefined();
  });
});

describe("mergeTandemComments", () => {
  const parsed = parseTandemNote(note);
  if (parsed.kind !== "ok") throw new Error("fixture should parse");
  const firstRun = convertTandemEntries(parsed.text, parsed.entries, ids());

  it("adds everything to an empty sidecar", () => {
    const merge = mergeTandemComments([], firstRun);
    expect(merge).toEqual({ added: firstRun, conflicts: [] });
  });

  it("adds nothing when a re-run finds the same threads", () => {
    const again = convertTandemEntries(parsed.text, parsed.entries, () => `new-${Math.random()}`);
    expect(mergeTandemComments(firstRun, again)).toEqual({ added: [], conflicts: [] });
  });

  it("adds replies written in Tandem since the last run to the existing thread", () => {
    const entries = parsed.entries.map(([id, c]): typeof parsed.entries[number] =>
      id === "a1b2" ? [id, { ...c, thread: [...c.thread, { author: "Leon", ts: "2026-09-05T10:00:00Z", text: "Late reply" }] }] : [id, c]
    );
    let n = 0;
    const again = convertTandemEntries(parsed.text, entries, () => `late-${++n}`);
    const merge = mergeTandemComments(firstRun, again);
    expect(merge.conflicts).toEqual([]);
    expect(merge.added).toEqual([expect.objectContaining({ text: "Late reply", reply_to: firstRun[0].id })]);
  });

  it("reports threads resolved on only one side", () => {
    const entries = parsed.entries.map(([id, c]): typeof parsed.entries[number] => (id === "a1b2" ? [id, { ...c, status: "resolved" }] : [id, c]));
    const again = convertTandemEntries(parsed.text, entries, ids());
    expect(mergeTandemComments(firstRun, again).conflicts).toEqual(["a1b2"]);
  });
});
