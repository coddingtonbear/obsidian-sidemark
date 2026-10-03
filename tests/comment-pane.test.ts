import { describe, expect, it } from "vitest";
import { CommentPanes, revealPane, selectionPane } from "../src/comment-pane";

// Panes are compared by identity, as editors are.
const left = { name: "left" };
const right = { name: "right" };

describe("CommentPanes", () => {
  it("has no pane for a note whose comments haven't been worked from any", () => {
    expect(new CommentPanes<object>().paneFor("note.md", [left, right])).toBeUndefined();
  });

  it("gives the pane last remembered for the note, whichever order the panes come in", () => {
    const panes = new CommentPanes<object>();
    panes.remember("note.md", right);
    expect(panes.paneFor("note.md", [left, right])).toBe(right);
    expect(panes.paneFor("note.md", [right, left])).toBe(right);
  });

  it("follows the most recent pane", () => {
    const panes = new CommentPanes<object>();
    panes.remember("note.md", right);
    panes.remember("note.md", left);
    expect(panes.paneFor("note.md", [left, right])).toBe(left);
  });

  it("keeps each note's pane separately", () => {
    const panes = new CommentPanes<object>();
    panes.remember("a.md", left);
    panes.remember("b.md", right);
    expect(panes.paneFor("a.md", [left, right])).toBe(left);
    expect(panes.paneFor("b.md", [left, right])).toBe(right);
  });

  it("forgets a pane that no longer shows the note, even if it shows it again later", () => {
    const panes = new CommentPanes<object>();
    panes.remember("note.md", right);
    expect(panes.paneFor("note.md", [left])).toBeUndefined();
    expect(panes.paneFor("note.md", [left, right])).toBeUndefined();
  });

  it("follows a renamed note", () => {
    const panes = new CommentPanes<object>();
    panes.remember("old.md", right);
    panes.renamed("old.md", "new.md");
    expect(panes.paneFor("new.md", [left, right])).toBe(right);
    expect(panes.paneFor("old.md", [left, right])).toBeUndefined();
  });

  it("forgets a deleted note", () => {
    const panes = new CommentPanes<object>();
    panes.remember("note.md", right);
    panes.forget("note.md");
    expect(panes.paneFor("note.md", [left, right])).toBeUndefined();
  });
});

describe("revealPane", () => {
  const following =
    (...optedOut: object[]) =>
    (pane: object) =>
      !optedOut.includes(pane);

  it("takes the first preferred pane that follows", () => {
    expect(revealPane([left, right], following(), [right, left])).toBe(right);
  });

  it("passes over a preferred pane that opted out", () => {
    expect(revealPane([left, right], following(right), [right])).toBe(left);
    expect(revealPane([left, right], following(left), [left, undefined])).toBe(right);
  });

  it("falls back to the first following pane when no preference applies", () => {
    expect(revealPane([left, right], following(left), [])).toBe(right);
  });

  it("ignores a preferred pane that doesn't show the note", () => {
    const elsewhere = { name: "elsewhere" };
    expect(revealPane([left, right], following(), [elsewhere])).toBe(left);
  });

  it("still reveals in an opted-out pane when it's the only one on the note", () => {
    expect(revealPane([right], following(right), [right])).toBe(right);
  });

  it("treats every pane as a candidate when all of them opted out", () => {
    expect(revealPane([left, right], following(left, right), [right])).toBe(right);
    expect(revealPane([left, right], following(left, right), [])).toBe(left);
  });

  it("has no pane when the note isn't open", () => {
    expect(revealPane([], following(), [left])).toBeUndefined();
  });
});

describe("selectionPane", () => {
  const selectedIn =
    (...selected: object[]) =>
    (pane: object) =>
      selected.includes(pane);

  it("takes the only pane with a selection, whichever pane comes first", () => {
    expect(selectionPane([left, right], selectedIn(right), [])).toBe(right);
  });

  it("has no pane when nothing is selected anywhere", () => {
    expect(selectionPane([left, right], selectedIn(), [left, right])).toBeUndefined();
  });

  it("prefers the first preferred pane with a selection", () => {
    expect(selectionPane([left, right], selectedIn(left, right), [right, left])).toBe(right);
  });

  it("passes over a preferred pane without a selection", () => {
    expect(selectionPane([left, right], selectedIn(left), [right, undefined])).toBe(left);
  });

  it("ignores a preferred pane that doesn't show the note", () => {
    const elsewhere = { name: "elsewhere" };
    expect(selectionPane([left, right], selectedIn(left, elsewhere), [elsewhere])).toBe(left);
  });
});
