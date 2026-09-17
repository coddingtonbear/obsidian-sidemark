import { parseSidecarContent } from "@mrsf/cli/browser";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type StateEffect, type Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorFieldsFor } from "../src/anchoring";
import { AnchorTracker, type EditorHost, suggestionHistory } from "../src/editor-extension";
import type { Comment, MrsfDocument } from "../src/model";
import {
  addComment,
  descendantIds,
  finishSuggestion,
  reopenSuggestion,
  type ResolveBehavior,
  retarget,
  undoAcceptedSuggestion,
} from "../src/mutations";
import { suggestionEdit } from "../src/suggestion-edit";
import { serializeSidecar } from "../src/sidecar-yaml";
import { type SidecarIO, SidecarStore } from "../src/store";
import { editorInfoField, type MockFileInfo } from "./mocks/obsidian";

class MemoryIO implements SidecarIO {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async rename(from: string, to: string) {
    const content = this.files.get(from);
    if (content === undefined) throw new Error("missing");
    this.files.delete(from);
    this.files.set(to, content);
  }
}

const NOTE = "Note.md";
const TEXT = "# Title\n\nThe quick brown fox jumps.\nSecond line here.\n";
const ts = "2026-09-16T10:00:00Z";

function commentOn(text: string, quote: string, id: string): Comment {
  const from = text.indexOf(quote);
  return { id, author: "Adam", timestamp: ts, text: "note", resolved: false, ...anchorFieldsFor(text, from, from + quote.length) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

class Harness {
  state: EditorState;
  readonly io = new MemoryIO();
  readonly store = new SidecarStore(this.io);
  readonly tracker: AnchorTracker;
  readonly threadAtCursor = vi.fn();
  inline = true;
  resolveBehavior: ResolveBehavior = "keep";
  file: NonNullable<MockFileInfo["file"]>;

  constructor(text: string, comments: Comment[], path = NOTE) {
    this.file = { path, extension: "md" };
    const doc: MrsfDocument = { mrsf_version: "1.0", document: path, comments };
    this.io.files.set(`${path}.review.yaml`, serializeSidecar(null, doc));
    this.state = this.createState(text);
    const view = {
      get state() {
        return harness.state;
      },
      requestMeasure: vi.fn(),
      dispatch: (spec: TransactionSpec) => this.apply(spec),
    };
    const harness = this;
    const host: EditorHost = {
      store: this.store,
      openSidebar: vi.fn(),
      registerTracker: () => () => undefined,
      anchorsChanged: vi.fn(),
      threadAtCursor: this.threadAtCursor,
      showSuggestionsInline: () => harness.inline,
      decideSuggestion: vi.fn(),
      // Mirrors the plugin, which runs the same mutations through the store.
      undoAccept: (notePath, id, thread) => {
        void harness.store.update(notePath, (doc) => undoAcceptedSuggestion(doc, id, thread));
      },
      redoAccept: (notePath, id) => {
        void harness.store.update(notePath, (doc) => finishSuggestion(doc, id, "accepted", harness.resolveBehavior));
      },
    };
    this.tracker = new AnchorTracker(view as unknown as EditorView, host);
  }

  private createState(text: string): EditorState {
    const file = this.file;
    return EditorState.create({
      doc: text,
      extensions: [editorInfoField.init(() => ({ file })), history(), suggestionHistory],
    });
  }

  text(): string {
    return this.state.doc.toString();
  }

  apply(spec: TransactionSpec): void {
    this.dispatch(this.state.update(spec));
  }

  private dispatch(tr: Transaction): void {
    const startState = tr.startState;
    this.state = tr.state;
    this.tracker.update({
      startState,
      state: this.state,
      transactions: [tr],
      changes: tr.changes,
      docChanged: tr.docChanged,
      selectionSet: tr.selection !== undefined,
      viewportChanged: false,
    } as unknown as ViewUpdate);
  }

  /**
   * Accepts a suggestion the way the plugin does: record the outcome, then
   * apply the replacement through the tracker so it carries the accept.
   */
  async acceptSuggestion(id: string): Promise<void> {
    const text = this.text();
    const anchor = this.tracker.anchors.find((a) => a.id === id);
    if (!anchor) throw new Error(`no live anchor for "${id}"`);
    const state = this.store.peek(NOTE);
    if (!state) throw new Error("sidecar not loaded");
    const root = state.doc.comments.find((c) => c.id === id);
    const replacement = (root?.x_suggestion as { replacement: string } | undefined)?.replacement ?? "";
    const ids = descendantIds(state.doc, id).add(id);
    const thread = structuredClone(state.doc.comments.filter((c) => ids.has(c.id)));
    await this.store.update(NOTE, (doc) => finishSuggestion(doc, id, "accepted", this.resolveBehavior));
    await settle();
    this.tracker.applyAccept(suggestionEdit(text, anchor.from, anchor.to, replacement), id, thread);
    await settle();
  }

  async undo(): Promise<void> {
    undo({ state: this.state, dispatch: (tr) => this.dispatch(tr) });
    await settle();
  }

  async redo(): Promise<void> {
    redo({ state: this.state, dispatch: (tr) => this.dispatch(tr) });
    await settle();
  }

  /** Simulates Obsidian loading a different note into the same editor. */
  switchTo(path: string, text: string): void {
    const startState = this.state;
    this.file = { path, extension: "md" };
    this.state = this.createState(text);
    const tr = startState.update({ changes: { from: 0, to: startState.doc.length, insert: text } });
    this.tracker.update({
      startState,
      state: this.state,
      transactions: [tr],
      changes: tr.changes,
      docChanged: true,
      selectionSet: false,
      viewportChanged: false,
    } as unknown as ViewUpdate);
  }

  /**
   * Simulates another program (a sync, an agent, a hand edit) replacing the
   * sidecar on disk, and Obsidian's `modify` event reaching the plugin.
   * `comments: null` deletes the file.
   */
  async editSidecarOnDisk(comments: Comment[] | null, path = NOTE): Promise<void> {
    const sidecarPath = `${path}.review.yaml`;
    if (comments === null) this.io.files.delete(sidecarPath);
    else this.io.files.set(sidecarPath, serializeSidecar(null, { mrsf_version: "1.0", document: path, comments }));
    await this.store.sidecarChanged(path);
    await settle();
  }

  sidecar(path = NOTE): MrsfDocument {
    return parseSidecarContent(this.io.files.get(`${path}.review.yaml`) ?? "");
  }

  /** Each decoration as [text it covers or widget text, classes]. */
  decorated(): [string, string][] {
    const out: [string, string][] = [];
    const iter = this.tracker.decorations.iter();
    for (; iter.value; iter.next()) {
      const spec = iter.value.spec as { class?: string; widget?: { text: string } };
      if (spec.widget) out.push([`+${spec.widget.text}`, "widget"]);
      else out.push([this.text().slice(iter.from, iter.to), spec.class ?? ""]);
    }
    return out;
  }

  highlighted(): string[] {
    return this.tracker.anchors.map((a) => this.text().slice(a.from, a.to));
  }

  insert(at: number, text: string, effects: StateEffect<unknown>[] = []): void {
    this.apply({ changes: { from: at, insert: text }, effects });
  }
}

describe("AnchorTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves open comments when the note loads", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a"), { ...commentOn(TEXT, "Second", "b"), resolved: true }]);
    await settle();
    expect(h.highlighted()).toEqual(["quick brown"]);
  });

  it("follows edits and writes fresh positions once typing pauses", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.insert(0, "Intro\n");
    expect(h.highlighted()).toEqual(["quick brown"]);
    expect(h.sidecar().comments[0].line).toBe(3);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(h.sidecar().comments[0]).toMatchObject({ line: 4, start_column: 4, end_column: 15 });
  });

  it("records drift when the quoted text itself is edited", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.apply({ changes: { from: TEXT.indexOf("quick"), to: TEXT.indexOf("quick") + 5, insert: "slow" } });
    vi.advanceTimersByTime(1000);
    await settle();
    expect(h.highlighted()).toEqual(["slow brown"]);
    expect(h.sidecar().comments[0]).toMatchObject({ selected_text: "quick brown", anchored_text: "slow brown" });
  });

  it("keeps live positions when other comments are added", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.insert(0, "Intro\n");
    const text = h.text();
    await h.store.update(NOTE, (doc) => {
      addComment(doc, { id: "b", author: "A", timestamp: ts, text: "x" }, anchorFieldsFor(text, text.indexOf("Second"), text.indexOf("Second") + 6));
    });
    await settle();
    expect(h.highlighted()).toEqual(["quick brown", "Second"]);
  });

  it("re-resolves a comment re-targeted by someone else", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    const from = TEXT.indexOf("Second");
    await h.store.update(NOTE, (doc) => retarget(doc, "a", { ...anchorFieldsFor(TEXT, from, from + 6), selected_text: "Second" }));
    await settle();
    expect(h.highlighted()).toEqual(["Second"]);
  });

  it("stops highlighting resolved threads", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    await h.store.update(NOTE, (doc) => {
      doc.comments[0].resolved = true;
    });
    await settle();
    expect(h.highlighted()).toEqual([]);
  });

  describe("when the sidecar is changed outside the plugin", () => {
    it("highlights a comment added on disk", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
      await settle();
      await h.editSidecarOnDisk([commentOn(TEXT, "quick brown", "a"), commentOn(TEXT, "Second", "b")]);
      expect(h.highlighted()).toEqual(["quick brown", "Second"]);
    });

    it("stops highlighting a comment resolved or removed on disk", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a"), commentOn(TEXT, "Second", "b")]);
      await settle();
      await h.editSidecarOnDisk([{ ...commentOn(TEXT, "quick brown", "a"), resolved: true }]);
      expect(h.highlighted()).toEqual([]);
    });

    it("clears every highlight when the sidecar is deleted", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
      await settle();
      await h.editSidecarOnDisk(null);
      expect(h.highlighted()).toEqual([]);
      expect(h.decorated()).toEqual([]);
    });

    it("moves a highlight re-targeted on disk", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
      await settle();
      await h.editSidecarOnDisk([commentOn(TEXT, "Second", "a")]);
      expect(h.highlighted()).toEqual(["Second"]);
    });

    it("shows a suggestion's new replacement", async () => {
      const suggestion = { ...commentOn(TEXT, "quick brown", "s"), type: "suggestion", x_suggestion: { replacement: "slow brown" } };
      const h = new Harness(TEXT, [suggestion]);
      await settle();
      await h.editSidecarOnDisk([{ ...suggestion, x_suggestion: { replacement: "quick red" } }]);
      expect(h.decorated()).toEqual([
        ["quick brown", "sm-highlight sm-highlight-suggestion sm-suggestion-inline"],
        ["brown", "sm-suggestion-strike"],
        ["+red", "widget"],
      ]);
    });

    it("keeps live positions of unchanged comments while the note has unsaved edits", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
      await settle();
      h.insert(0, "Intro\n");
      // Written against the note as saved, before the insertion above.
      await h.editSidecarOnDisk([commentOn(TEXT, "quick brown", "a"), { ...commentOn(TEXT, "Second", "b"), text: "new" }]);
      expect(h.highlighted()).toEqual(["quick brown", "Second"]);
    });

    it("isn't overwritten by positions still waiting to be saved", async () => {
      const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
      await settle();
      h.insert(0, "Intro\n");
      await h.editSidecarOnDisk([{ ...commentOn(TEXT, "quick brown", "a"), text: "edited elsewhere" }, commentOn(TEXT, "Second", "b")]);
      vi.advanceTimersByTime(1000);
      await settle();
      const comments = h.sidecar().comments;
      expect(comments.map((c) => [c.id, c.text])).toEqual([
        ["a", "edited elsewhere"],
        ["b", "note"],
      ]);
      expect(comments[0]).toMatchObject({ line: 4, start_column: 4 });
    });
  });

  it("saves pending positions for the previous note when the editor switches notes", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.insert(0, "Intro\n");
    const other = "Other note.\n";
    h.io.files.set("Other.md.review.yaml", serializeSidecar(null, { mrsf_version: "1.0", document: "Other.md", comments: [commentOn(other, "Other", "o")] }));
    h.switchTo("Other.md", other);
    await settle();
    expect(h.sidecar().comments[0]).toMatchObject({ line: 4, start_column: 4 });
    expect(h.highlighted()).toEqual(["Other"]);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(h.sidecar().comments[0]).toMatchObject({ line: 4, start_column: 4 });
  });

  it("re-resolves everything after a whole-document replacement", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    const replaced = "Completely new start.\n\nAnd then: The quick brown fox jumps.\n";
    h.apply({ changes: { from: 0, to: h.text().length, insert: replaced } });
    expect(h.highlighted()).toEqual(["quick brown"]);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(h.sidecar().comments[0]).toMatchObject({ line: 3 });
  });

  it("keeps writing positions across consecutive flushes", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.insert(0, "One\n");
    h.tracker.flush();
    h.insert(0, "Two\n");
    h.tracker.flush();
    await settle();
    expect(h.sidecar().comments[0].line).toBe(5);
  });

  it("doesn't overwrite a re-target that lands just before its write", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    h.insert(0, "Intro\n");
    // Someone else re-targets the comment directly on disk, then the tracker flushes.
    const retargeted = parseSidecarContent(h.io.files.get("Note.md.review.yaml") ?? "");
    Object.assign(retargeted.comments[0], { selected_text: "Second", line: 4, end_line: 4, start_column: 0, end_column: 6 });
    h.io.files.set("Note.md.review.yaml", serializeSidecar(null, retargeted));
    h.tracker.flush();
    await settle();
    expect(h.sidecar().comments[0]).toMatchObject({ selected_text: "Second", line: 4, start_column: 0 });
    expect(h.sidecar().comments[0].anchored_text).toBeUndefined();
  });

  it("doesn't save a guessed position for an ambiguous quote", async () => {
    const text = "fox one\nfox two\n";
    const comment: Comment = { id: "a", author: "A", timestamp: ts, text: "x", resolved: false, selected_text: "fox" };
    const h = new Harness(text, [comment]);
    await settle();
    expect(h.highlighted()).toEqual(["fox"]);
    h.insert(text.length, "more\n");
    vi.advanceTimersByTime(1000);
    await settle();
    expect(h.sidecar().comments[0].line).toBeUndefined();
    expect(h.tracker.isAmbiguous("a")).toBe(true);
  });

  it("stops treating a quote as ambiguous once it's re-targeted", async () => {
    const text = "fox one\nfox two\n";
    const comment: Comment = { id: "a", author: "A", timestamp: ts, text: "x", resolved: false, selected_text: "fox" };
    const h = new Harness(text, [comment]);
    await settle();
    await h.store.update(NOTE, (doc) => retarget(doc, "a", anchorFieldsFor(text, 8, 11)));
    await settle();
    expect(h.tracker.isAmbiguous("a")).toBe(false);
  });

  it("announces the thread under the cursor and marks its highlight active", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a"), commentOn(TEXT, "Second", "b")]);
    await settle();
    h.apply({ selection: { anchor: TEXT.indexOf("brown") } });
    expect(h.threadAtCursor).toHaveBeenLastCalledWith(NOTE, "a");
    const active: string[] = [];
    h.tracker.decorations.between(0, h.text().length, (from, to, deco) => {
      if (String(deco.spec.class).includes("sm-highlight-active")) active.push(h.text().slice(from, to));
    });
    expect(active).toEqual(["quick brown"]);
    h.apply({ selection: { anchor: TEXT.indexOf("Second") + 2 } });
    expect(h.threadAtCursor).toHaveBeenLastCalledWith(NOTE, "b");
    h.apply({ selection: { anchor: 0 } });
    expect(h.threadAtCursor).toHaveBeenLastCalledWith(NOTE, null);
    h.apply({ selection: { anchor: 1 } });
    expect(h.threadAtCursor).toHaveBeenCalledTimes(4);
    h.apply({ changes: { from: h.text().length, insert: "x" } });
    expect(h.threadAtCursor).toHaveBeenCalledTimes(4);
  });

  it("shows a thread selected in the sidebar as active until the cursor moves", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a"), commentOn(TEXT, "Second", "b")]);
    await settle();
    h.threadAtCursor.mockClear();
    h.tracker.showThread("b");
    expect(h.decorated()).toEqual([
      ["quick brown", "sm-highlight"],
      ["Second", "sm-highlight sm-highlight-active"],
    ]);
    // Other changes (e.g. a reply being saved) don't clear it or announce anything.
    await h.store.update(NOTE, (doc) => {
      doc.comments.push({ id: "r", author: "A", timestamp: ts, text: "reply", resolved: false, reply_to: "b" });
    });
    await settle();
    h.insert(0, "x");
    expect(h.decorated()[1][1]).toContain("sm-highlight-active");
    expect(h.threadAtCursor).not.toHaveBeenCalled();
    // Moving the cursor takes over again.
    h.apply({ selection: { anchor: h.text().indexOf("quick") + 1 } });
    expect(h.decorated()[0][1]).toContain("sm-highlight-active");
    expect(h.threadAtCursor).toHaveBeenLastCalledWith(NOTE, "a");
    h.tracker.showThread(null);
    expect(h.decorated().some(([, cls]) => cls.includes("active"))).toBe(false);
  });

  it("marks suggestion highlights differently", async () => {
    const suggestion = { ...commentOn(TEXT, "Second", "s"), type: "suggestion", x_suggestion: { replacement: "2nd" } };
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a"), suggestion]);
    h.inline = false;
    await settle();
    h.tracker.refresh();
    expect(h.decorated()).toEqual([
      ["quick brown", "sm-highlight"],
      ["Second", "sm-highlight sm-highlight-suggestion"],
    ]);
  });

  it("shows an open suggestion in the note by striking out the changed words and adding the new ones", async () => {
    const suggestion = { ...commentOn(TEXT, "quick brown", "s"), type: "suggestion", x_suggestion: { replacement: "slow brown" } };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    expect(h.decorated()).toEqual([
      ["quick", "sm-suggestion-strike"],
      ["quick brown", "sm-highlight sm-highlight-suggestion sm-suggestion-inline"],
      ["+slow", "widget"],
    ]);
  });

  it("shows a suggested deletion as struck-out text alone", async () => {
    const suggestion = { ...commentOn(TEXT, "Second", "s"), type: "suggestion", x_suggestion: { replacement: "" } };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    expect(h.decorated()).toEqual([
      ["Second", "sm-suggestion-strike"],
      ["Second", "sm-highlight sm-highlight-suggestion sm-suggestion-inline"],
    ]);
  });

  it("falls back to a plain suggestion highlight once the passage has changed", async () => {
    const suggestion = { ...commentOn(TEXT, "quick brown", "s"), type: "suggestion", x_suggestion: { replacement: "slow" } };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    h.apply({ changes: { from: TEXT.indexOf("quick"), to: TEXT.indexOf("quick") + 5, insert: "QUICK" } });
    expect(h.decorated()).toEqual([["QUICK brown", "sm-highlight sm-highlight-suggestion"]]);
  });

  it("finds the open suggestion at a position, skipping plain comments and decided suggestions", async () => {
    const open = { ...commentOn(TEXT, "quick brown fox", "s"), type: "suggestion", x_suggestion: { replacement: "cat" } };
    const inner = { ...commentOn(TEXT, "brown", "t"), type: "suggestion", x_suggestion: { replacement: "red" } };
    const decided = { ...commentOn(TEXT, "Second", "d"), type: "suggestion", x_suggestion: { replacement: "2nd", result: "declined" } };
    const h = new Harness(TEXT, [open, inner, decided, commentOn(TEXT, "Title", "c")]);
    await settle();
    expect(h.tracker.openSuggestions().map((a) => a.id)).toEqual(["s", "t"]);
    expect(h.tracker.suggestionAt(TEXT.indexOf("quick"))?.id).toBe("s");
    expect(h.tracker.suggestionAt(TEXT.indexOf("brown") + 2)?.id).toBe("t");
    expect(h.tracker.suggestionAt(TEXT.indexOf(" jumps"))?.id).toBe("s");
    expect(h.tracker.suggestionAt(TEXT.indexOf("Title"))).toBeNull();
    expect(h.tracker.suggestionAt(TEXT.indexOf("Second"))).toBeNull();
  });

  it("doesn't track a suggestion that records an outcome, even if it isn't marked resolved", async () => {
    const suggestion = { ...commentOn(TEXT, "Second", "s"), type: "suggestion", x_suggestion: { replacement: "2nd", result: "accepted" } };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    expect(h.decorated()).toEqual([]);
  });

  it("tells CodeMirror how many lines a multi-line replacement takes", async () => {
    const suggestion = { ...commentOn(TEXT, "Second", "s"), type: "suggestion", x_suggestion: { replacement: "Two\nlines\nhere" } };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    const widgets: number[] = [];
    const iter = h.tracker.decorations.iter();
    for (; iter.value; iter.next()) {
      const widget = (iter.value.spec as { widget?: { lineBreaks: number } }).widget;
      if (widget) widgets.push(widget.lineBreaks);
    }
    expect(widgets).toEqual([2]);
  });

  it("doesn't preview a decided suggestion", async () => {
    const suggestion = {
      ...commentOn(TEXT, "Second", "s"),
      resolved: true,
      type: "suggestion",
      x_suggestion: { replacement: "2nd", result: "declined" },
    };
    const h = new Harness(TEXT, [suggestion]);
    await settle();
    expect(h.decorated()).toEqual([]);
  });

  it("follows a renamed note", async () => {
    const h = new Harness(TEXT, [commentOn(TEXT, "quick brown", "a")]);
    await settle();
    // Obsidian renames the editor's TFile in place.
    h.file.path = "Renamed.md";
    h.tracker.noteRenamed("Renamed.md");
    await h.store.noteRenamed(NOTE, "Renamed.md");
    const text = h.text();
    await h.store.update("Renamed.md", (doc) => {
      addComment(doc, { id: "b", author: "A", timestamp: ts, text: "x" }, anchorFieldsFor(text, text.indexOf("Second"), text.indexOf("Second") + 6));
    });
    await settle();
    expect(h.highlighted()).toEqual(["quick brown", "Second"]);
  });

  describe("undoing an accepted suggestion", () => {
    const suggestionOn = (quote: string, replacement: string, id = "s"): Comment => ({
      ...commentOn(TEXT, quote, id),
      type: "suggestion",
      x_suggestion: { replacement },
    });

    /** The suggestion's recorded outcome, or "gone" when its thread was removed (with the last one, the sidecar itself). */
    const outcome = (h: Harness, id = "s"): string => {
      if (!h.io.files.has(`${NOTE}.review.yaml`)) return "gone";
      const comment = h.sidecar().comments.find((c) => c.id === id);
      if (!comment) return "gone";
      return String((comment.x_suggestion as { result?: string } | undefined)?.result ?? "open");
    };

    it("reopens the suggestion when the edit is undone, and accepts it again on redo", async () => {
      const h = new Harness(TEXT, [suggestionOn("quick brown", "slow red")]);
      await settle();
      await h.acceptSuggestion("s");
      expect(h.text()).toContain("The slow red fox");
      expect(outcome(h)).toBe("accepted");

      await h.undo();
      expect(h.text()).toBe(TEXT);
      expect(outcome(h)).toBe("open");
      expect(h.sidecar().comments[0].resolved).toBe(false);
      // Reopened, so it is tracked and previewed in the note again.
      expect(h.highlighted()).toEqual(["quick brown"]);

      await h.redo();
      expect(h.text()).toContain("The slow red fox");
      expect(outcome(h)).toBe("accepted");
      expect(h.highlighted()).toEqual([]);
    });

    it("restores a thread that accepting removed", async () => {
      const h = new Harness(TEXT, [suggestionOn("quick brown", "slow red"), { ...commentOn(TEXT, "quick brown", "r"), reply_to: "s" }]);
      h.resolveBehavior = "remove";
      await settle();
      await h.acceptSuggestion("s");
      expect(outcome(h)).toBe("gone");

      await h.undo();
      expect(h.text()).toBe(TEXT);
      expect(outcome(h)).toBe("open");
      // The replies come back with it, not just the root.
      expect(h.sidecar().comments.map((c) => c.id)).toEqual(["s", "r"]);
      expect(h.highlighted()).toEqual(["quick brown"]);

      await h.redo();
      expect(outcome(h)).toBe("gone");
    });

    it("leaves a suggestion that was decided some other way in the meantime", async () => {
      const h = new Harness(TEXT, [suggestionOn("quick brown", "slow red")]);
      await settle();
      await h.acceptSuggestion("s");
      // Declined from the sidebar (or by another editor) after the accept.
      await h.store.update(NOTE, (doc) => {
        reopenSuggestion(doc, "s");
        finishSuggestion(doc, "s", "declined", "keep");
      });
      await settle();

      await h.undo();
      expect(h.text()).toBe(TEXT);
      expect(outcome(h)).toBe("declined");
    });

    it("undoes the accept on its own, without reverting what was typed just before it", async () => {
      const h = new Harness(TEXT, [suggestionOn("Second", "2nd")]);
      await settle();
      h.insert(0, "Intro\n");
      await settle();
      await h.acceptSuggestion("s");
      expect(h.text()).toContain("2nd line here.");

      await h.undo();
      expect(h.text()).toBe("Intro\n" + TEXT);
      expect(outcome(h)).toBe("open");
    });
  });
});
