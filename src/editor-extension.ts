import { type Range, StateEffect, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { applyTrackedPosition, PERSIST_MIN_SIMILARITY, resolveComment } from "./anchoring";
import { buildThreads, type Comment, suggestionOf } from "./model";
import type { SidecarStore } from "./store";
import { type AnchorStyle, applyTableHighlights, rangesTouchTable } from "./table-highlight";
import { isFullReplace, mapAnchors, type TrackedAnchor } from "./tracking";

/** How long typing must pause before tracked positions are written to the sidecar. */
const WRITE_DEBOUNCE_MS = 800;

/** Asks a tracker to rebuild its anchors from the store. */
const resyncEffect = StateEffect.define<null>();

export interface EditorHost {
  readonly store: SidecarStore;
  openSidebar(focusId?: string): unknown;
  /** Lets the sidebar read live anchor positions; returns an unregister function. */
  registerTracker(tracker: AnchorTracker): () => void;
  /** Tells the sidebar that anchor positions for a note changed materially. */
  anchorsChanged(notePath: string): void;
  /** The cursor moved into a comment's highlighted passage (`id`) or out of all of them (null). */
  threadAtCursor(notePath: string, id: string | null): void;
  /** Whether open suggestions are shown in the note as struck-out text followed by their replacement. */
  showSuggestionsInline(): boolean;
}

/** A suggestion's replacement, shown after the passage it would replace. */
class ReplacementWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly text: string,
    readonly active: boolean
  ) {
    super();
  }

  eq(other: ReplacementWidget): boolean {
    return other.id === this.id && other.text === this.text && other.active === this.active;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "sm-suggestion-insert" + (this.active ? " sm-suggestion-insert-active" : "");
    span.textContent = this.text;
    span.setAttribute("data-sm-id", this.id);
    span.setAttribute("aria-label", `Suggested replacement: ${this.text}`);
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** The anchoring fields that, when changed by someone else, force a fresh resolution. */
function anchorSignature(comment: Comment): string {
  return JSON.stringify([
    comment.line,
    comment.end_line,
    comment.start_column,
    comment.end_column,
    comment.selected_text,
    comment.anchored_text,
  ]);
}

function sameAnchors(a: TrackedAnchor[], b: TrackedAnchor[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.from === b[i].from && x.to === b[i].to);
}

/**
 * Tracks the open comment anchors of the note shown in one editor: highlights
 * them, maps them through every edit, and writes their fresh positions back to
 * the sidecar once typing pauses.
 */
export class AnchorTracker {
  decorations: DecorationSet = Decoration.none;
  anchors: TrackedAnchor[] = [];
  notePath: string | null = null;
  private dirty = false;
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private unregister: (() => void) | null = null;
  private destroyed = false;
  /** The thread whose passage contains the cursor, shown with a stronger highlight. */
  private activeId: string | null = null;
  /** Anchor signature of each comment as last seen in (or written to) the sidecar. */
  private readonly signatures = new Map<string, string>();
  /** Open edit suggestions (highlighted differently), with the replacement text and the passage it was made for. */
  private readonly suggestions = new Map<string, { replacement: string | null; original: string }>();
  /** Comments whose position is only a guess (ambiguous or weak fuzzy match) and must not be saved. */
  private readonly unconfirmed = new Set<string>();

  constructor(
    readonly view: EditorView,
    private readonly host: EditorHost
  ) {
    this.unregister = host.registerTracker(this);
    this.attach(this.currentPath(), view.state.doc.toString());
    this.scheduleTableHighlight();
  }

  private currentPath(): string | null {
    const file = this.view.state.field(editorInfoField, false)?.file;
    return file && file.extension === "md" ? file.path : null;
  }

  /**
   * Points the tracker at a note; Obsidian reuses editors when a pane switches
   * files. `previousText` is the document the current anchors refer to.
   */
  private attach(notePath: string | null, previousText: string): void {
    this.flush(previousText);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.notePath = notePath;
    this.anchors = [];
    this.signatures.clear();
    this.unconfirmed.clear();
    this.decorations = Decoration.none;
    if (!notePath) return;
    this.subscribe();
    void this.host.store.load(notePath).then(() => this.requestResync());
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.host.store.onChange((change) => {
      if (change.notePath === this.notePath && change.origin !== "tracking") this.requestResync();
    });
  }

  /** Rebuilds decorations, e.g. after a display setting changed. */
  refresh(): void {
    this.requestResync();
  }

  /** Follows a rename of the tracked note, keeping the live anchors. */
  noteRenamed(newPath: string): void {
    this.flush();
    this.notePath = newPath;
    this.subscribe();
  }

  private requestResync(): void {
    if (this.destroyed) return;
    // Store callbacks run outside CodeMirror updates, so dispatching here is safe.
    this.view.dispatch({ effects: resyncEffect.of(null) });
  }

  destroy(): void {
    this.flush();
    this.destroyed = true;
    this.unsubscribe?.();
    this.unregister?.();
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.viewportChanged) this.scheduleTableHighlight();
    const path = this.currentPath();
    if (path !== this.notePath) {
      this.attach(path, u.startState.doc.toString());
      return;
    }
    if (!this.notePath) return;
    const text = u.state.doc.toString();
    const resync = u.transactions.some((tr) => tr.effects.some((e) => e.is(resyncEffect)));

    if (u.docChanged) {
      if (isFullReplace(u.changes)) {
        this.resync(text, true);
      } else {
        const mapped = mapAnchors(this.anchors, u.changes);
        const ranges: { from: number; to: number }[] = [];
        u.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => ranges.push({ from: fromB, to: toB }));
        if (rangesTouchTable(text, text.length, ranges)) {
          // Obsidian reformats a whole table on edit, which collapses anchors
          // inside it; recover those by their text instead of losing them.
          const survived = new Set(mapped.map((a) => a.id));
          this.anchors = mapped;
          this.recoverMissing(text, survived);
        } else {
          this.anchors = mapped;
        }
        this.markDirty();
      }
    }
    if (resync) {
      this.resync(text, false);
      this.scheduleTableHighlight();
    }
    if (u.selectionSet || u.docChanged || resync) this.updateActive(u.state.selection.main.head, u.selectionSet);
    this.decorations = this.buildDecorations(u.state.doc);
  }

  /**
   * Finds the innermost highlighted passage containing `pos` and announces it
   * when it changes. A cursor move outside every passage is always announced,
   * so a thread selected by clicking its card is deselected too.
   */
  private updateActive(pos: number, moved: boolean): void {
    let best: TrackedAnchor | null = null;
    for (const a of this.anchors) {
      if (pos < a.from || pos > a.to) continue;
      if (!best || a.to - a.from < best.to - best.from) best = a;
    }
    const id = best?.id ?? null;
    if (id === this.activeId && !(id === null && moved)) return;
    this.activeId = id;
    if (this.notePath) this.host.threadAtCursor(this.notePath, id);
  }

  private openRoots(): Comment[] {
    const state = this.notePath ? this.host.store.peek(this.notePath) : undefined;
    if (!state) return [];
    return buildThreads(state.doc)
      .map((thread) => thread.root)
      .filter((root) => !root.resolved);
  }

  private recoverMissing(text: string, present: Set<string>): void {
    for (const root of this.openRoots()) {
      if (present.has(root.id)) continue;
      const r = resolveComment(root, text);
      if (r.kind === "resolved") this.anchors.push({ id: root.id, from: r.from, to: r.to });
    }
    this.anchors.sort((a, b) => a.from - b.from);
  }

  /**
   * Rebuilds anchors from the store. Comments whose anchoring fields are
   * unchanged keep their live positions (more current than the file); new or
   * externally re-targeted comments are resolved from scratch.
   */
  private resync(text: string, force: boolean): void {
    const previous = new Map(this.anchors.map((a) => [a.id, a]));
    const next: TrackedAnchor[] = [];
    let moved = false;
    const seen = new Set<string>();
    this.suggestions.clear();
    for (const root of this.openRoots()) {
      seen.add(root.id);
      if (root.x_suggestion !== undefined) {
        this.suggestions.set(root.id, { replacement: suggestionOf(root)?.replacement ?? null, original: root.selected_text ?? "" });
      }
      const signature = anchorSignature(root);
      const live = previous.get(root.id);
      if (!force && live && this.signatures.get(root.id) === signature) {
        next.push(live);
        continue;
      }
      this.signatures.set(root.id, signature);
      const r = resolveComment(root, text);
      this.unconfirmed.delete(root.id);
      if (r.kind !== "resolved") continue;
      next.push({ id: root.id, from: r.from, to: r.to });
      if (r.ambiguous || (r.fuzzy && (r.similarity ?? 0) < PERSIST_MIN_SIMILARITY)) {
        this.unconfirmed.add(root.id);
        continue;
      }
      const probe: Comment = { ...root };
      if (applyTrackedPosition(probe, text, r.from, r.to)) moved = true;
    }
    for (const id of [...this.signatures.keys()]) if (!seen.has(id)) this.signatures.delete(id);
    for (const id of [...this.unconfirmed]) if (!seen.has(id)) this.unconfirmed.delete(id);
    next.sort((a, b) => a.from - b.from);
    const changed = !sameAnchors(next, this.anchors);
    this.anchors = next;
    // Positions found by resolution (e.g. after the note changed on disk) are persisted too.
    if (moved) this.markDirty();
    if (changed && this.notePath) this.host.anchorsChanged(this.notePath);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /**
   * Writes pending positions now (also used before switching notes or
   * closing). `text` must be the document the anchors refer to.
   */
  flush(text: string = this.view.state.doc.toString()): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.notePath || this.destroyed) return;
    this.dirty = false;
    const notePath = this.notePath;
    const anchors = this.anchors.filter((a) => !this.unconfirmed.has(a.id));
    const expected = new Map(anchors.map((a) => [a.id, this.signatures.get(a.id)]));
    void this.host.store
      .update(
        notePath,
        (doc) => {
          for (const anchor of anchors) {
            const comment = doc.comments.find((c) => c.id === anchor.id);
            if (!comment || comment.resolved) continue;
            // Someone else re-targeted this comment since we last looked; their change wins.
            const signature = anchorSignature(comment);
            const current = this.notePath === notePath ? this.signatures.get(anchor.id) : undefined;
            if (signature !== expected.get(anchor.id) && signature !== current) continue;
            applyTrackedPosition(comment, text, anchor.from, anchor.to);
            if (this.notePath === notePath) this.signatures.set(comment.id, anchorSignature(comment));
          }
        },
        "tracking"
      )
      .then(() => this.host.anchorsChanged(notePath));
  }

  /** The highlight classes of an anchor and, for a suggestion shown in place, its replacement text. */
  private styleOf(a: TrackedAnchor, doc: Text): AnchorStyle {
    const suggestion = this.suggestions.get(a.id);
    let className = "sm-highlight";
    if (suggestion) className += " sm-highlight-suggestion";
    // Only a passage that still reads as it did can be shown as replaced.
    const insert =
      suggestion &&
      suggestion.replacement !== null &&
      this.host.showSuggestionsInline() &&
      doc.sliceString(a.from, a.to) === suggestion.original
        ? suggestion.replacement
        : null;
    if (insert !== null) className += " sm-suggestion-strike";
    if (a.id === this.activeId) className += " sm-highlight-active";
    return { className, insert: insert || null };
  }

  private buildDecorations(doc: Text): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const a of this.anchors) {
      if (a.from >= a.to || a.to > doc.length) continue;
      const { className, insert } = this.styleOf(a, doc);
      ranges.push(Decoration.mark({ class: className, attributes: { "data-sm-id": a.id } }).range(a.from, a.to));
      if (insert) {
        const active = a.id === this.activeId;
        ranges.push(Decoration.widget({ widget: new ReplacementWidget(a.id, insert, active), side: 1 }).range(a.to));
      }
    }
    return Decoration.set(ranges, true);
  }

  /** Live Preview renders tables as widgets that swallow mark decorations, so those highlights are drawn into the DOM directly. */
  private scheduleTableHighlight(): void {
    this.view.requestMeasure({
      key: "sm-table-highlight",
      read: () => null,
      write: () => {
        const doc = this.view.state.doc;
        const text = doc.toString();
        applyTableHighlights(this.view, this.anchors, text, text.length, (id) => void this.host.openSidebar(id), (a) =>
          this.styleOf(a, doc)
        );
      },
    });
  }
}

export function buildEditorExtension(host: EditorHost) {
  return ViewPlugin.define((view) => new AnchorTracker(view, host), {
    decorations: (tracker) => tracker.decorations,
    eventHandlers: {
      mousedown(event: MouseEvent) {
        const target = event.target instanceof Element ? event.target.closest(".sm-highlight, .sm-suggestion-insert") : null;
        const id = target?.getAttribute("data-sm-id");
        if (id) void host.openSidebar(id);
        return false;
      },
    },
  });
}
