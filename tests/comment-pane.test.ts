import { describe, expect, it } from "vitest";
import { CommentPanes, selectionPane } from "../src/comment-pane";

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
