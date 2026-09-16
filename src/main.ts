import { newCommentId } from "@mrsf/cli/browser";
import {
  type Editor,
  MarkdownView,
  Notice,
  normalizePath,
  Plugin,
  TFile,
  TFolder,
  type TAbstractFile,
} from "obsidian";
import { anchorFieldsFor, type Resolution, resolveComment } from "./anchoring";
import { detectOsUsername, resolveAuthorName, AUTHOR_OVERRIDE_KEY, FALLBACK_AUTHOR } from "./author";
import { confirmAction } from "./confirm-action";
import { type AnchorTracker, buildEditorExtension, type EditorHost } from "./editor-extension";
import { buildExportNote, type ResolvedThread } from "./export";
import { selectedTextHash } from "./hash";
import { buildThreads, type Comment, isResolved, type MrsfDocument, suggestionOf, type SuggestionResult } from "./model";
import {
  type AnchorFields,
  finishSuggestion,
  findComment,
  type NewEntry,
  openSuggestion,
  removeResolvedThreads,
  descendantIds,
  type SuggestionFailure,
} from "./mutations";
import { SidemarkSettingTab } from "./settings";
import { DEFAULT_SETTINGS, parseSettings, settingsEffects, type SidemarkSettings } from "./settings-model";
import { notePathFor } from "./sidecar-path";
import {
  type Draft,
  isSidebar,
  type SidemarkSidebar,
  SidemarkSidebar as SidebarView,
  suggestionFailureMessage,
  VIEW_TYPE_SIDEMARK,
} from "./sidebar";
import { type RenameOutcome, SidecarStore } from "./store";
import { suggestionEdit } from "./suggestion-edit";
import { migrateTandemComments } from "./tandem-runner";
import { VaultSidecarIO } from "./vault-io";

interface AcceptPlan {
  from: number;
  to: number;
  original: string;
  replacement: string;
  /** The suggestion's thread as it was before accepting, for rolling back. */
  thread: Comment[];
}

export type AcceptResult = { ok: true } | { ok: false; reason: SuggestionFailure | "no-editor" | "orphaned" | "changed" };

export default class SidemarkPlugin extends Plugin implements EditorHost {
  settings: SidemarkSettings = DEFAULT_SETTINGS;
  store!: SidecarStore;
  private readonly trackers = new Set<AnchorTracker>();

  async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    this.store = new SidecarStore(new VaultSidecarIO(this.app));
    this.applyHighlightAppearance();

    this.registerHoverLinkSource(this.manifest.id, { display: this.manifest.name, defaultMod: false });
    this.registerView(VIEW_TYPE_SIDEMARK, (leaf) => new SidebarView(leaf, this));
    this.registerEditorExtension(buildEditorExtension(this));
    this.addSettingTab(new SidemarkSettingTab(this.app, this));
    this.addRibbonIcon("message-square", "Open comments", () => void this.openSidebar());

    this.addCommand({
      id: "add-comment",
      name: "Add comment",
      icon: "message-square-plus",
      editorCallback: (editor, ctx) => {
        if (ctx.file) void this.startDraft(ctx.file, editor, "comment");
      },
    });
    this.addCommand({
      id: "suggest-edit",
      name: "Suggest edit",
      icon: "replace",
      editorCallback: (editor, ctx) => {
        if (ctx.file) void this.startDraft(ctx.file, editor, "suggestion");
      },
    });
    this.addCommand({
      id: "accept-suggestion",
      name: "Accept suggestion at cursor",
      icon: "check",
      editorCheckCallback: (checking, editor, ctx) => this.suggestionCommand(checking, editor, ctx.file, "accepted"),
    });
    this.addCommand({
      id: "decline-suggestion",
      name: "Decline suggestion at cursor",
      icon: "x",
      editorCheckCallback: (checking, editor, ctx) => this.suggestionCommand(checking, editor, ctx.file, "declined"),
    });
    this.addCommand({
      id: "next-suggestion",
      name: "Go to next suggestion",
      icon: "arrow-down",
      editorCheckCallback: (checking, editor, ctx) => this.jumpToSuggestion(checking, editor, ctx.file, 1),
    });
    this.addCommand({
      id: "previous-suggestion",
      name: "Go to previous suggestion",
      icon: "arrow-up",
      editorCheckCallback: (checking, editor, ctx) => this.jumpToSuggestion(checking, editor, ctx.file, -1),
    });
    this.addCommand({
      id: "open-sidebar",
      name: "Open comment sidebar",
      icon: "message-square",
      callback: () => void this.openSidebar(),
    });
    this.addCommand({
      id: "toggle-resolved",
      name: "Show or hide resolved threads",
      icon: "check-check",
      callback: () => void this.openSidebar().then((view) => view?.toggleResolved()),
    });
    this.addCommand({
      id: "remove-resolved",
      name: "Remove resolved threads from active note",
      icon: "trash-2",
      checkCallback: (checking) => {
        const file = this.activeNote();
        if (!file) return false;
        if (!checking) void this.removeResolved(file);
        return true;
      },
    });
    this.addCommand({
      id: "export-comments",
      name: "Export comments of active note",
      icon: "file-output",
      checkCallback: (checking) => {
        const file = this.activeNote();
        if (!file) return false;
        if (!checking) void this.exportComments(file);
        return true;
      },
    });
    this.addCommand({
      id: "migrate-tandem-comments",
      name: "Convert Tandem Comments in all notes",
      icon: "arrow-right-left",
      callback: () => void this.migrateTandem(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!editor.somethingSelected() || !file) return;
        menu.addItem((item) =>
          item
            .setTitle("Add comment")
            .setIcon("message-square")
            .onClick(() => void this.startDraft(file, editor, "comment"))
        );
        menu.addItem((item) =>
          item
            .setTitle("Suggest edit")
            .setIcon("replace")
            .onClick(() => void this.startDraft(file, editor, "suggestion"))
        );
      })
    );
    this.registerEvent(this.app.workspace.on("window-open", (win) => this.applyHighlightAppearanceTo(win.doc)));

    // Vault events also fire for every file while the vault first loads; only react afterwards.
    this.app.workspace.onLayoutReady(() => {
      void this.ensureSidebar();
      this.registerEvent(this.app.vault.on("modify", (file) => this.onFileChanged(file)));
      this.registerEvent(this.app.vault.on("create", (file) => this.onFileChanged(file)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)));
    });
  }

  onunload(): void {
    for (const doc of this.allDocuments()) {
      doc.body.style.removeProperty("--sm-highlight-color");
      doc.body.style.removeProperty("--sm-highlight-opacity");
    }
  }

  // ── Settings ──────────────────────────────────────────────

  async updateSettings(patch: Partial<SidemarkSettings>): Promise<void> {
    const previous = this.settings;
    this.settings = parseSettings({ ...previous, ...patch });
    await this.saveData(this.settings);
    const effects = settingsEffects(previous, this.settings);
    if (effects.refreshHighlights) this.applyHighlightAppearance();
    if (effects.refreshEditors) for (const tracker of this.trackers) tracker.refresh();
    if (effects.refreshSidebar) {
      for (const view of this.sidebars()) view.settingsChanged(effects.resetResolvedVisibility);
    }
  }

  currentAuthor(): string {
    return resolveAuthorName(this.authorOverride(), detectOsUsername());
  }

  detectedAuthor(): string {
    return detectOsUsername() ?? FALLBACK_AUTHOR;
  }

  /** Device-local display-name override ("" when unset); deliberately not synced. */
  authorOverride(): string {
    const value: unknown = this.app.loadLocalStorage(AUTHOR_OVERRIDE_KEY);
    return typeof value === "string" ? value : "";
  }

  setAuthorOverride(value: string): void {
    this.app.saveLocalStorage(AUTHOR_OVERRIDE_KEY, value.trim() || null);
  }

  private allDocuments(): Set<Document> {
    const docs = new Set<Document>([activeDocument]);
    this.app.workspace.iterateAllLeaves((leaf) => docs.add(leaf.view.containerEl.ownerDocument));
    return docs;
  }

  private applyHighlightAppearance(): void {
    for (const doc of this.allDocuments()) this.applyHighlightAppearanceTo(doc);
  }

  private applyHighlightAppearanceTo(doc: Document): void {
    doc.body.style.setProperty("--sm-highlight-color", this.settings.highlightColor);
    doc.body.style.setProperty("--sm-highlight-opacity", `${this.settings.highlightOpacity}%`);
  }

  // ── Editor host ───────────────────────────────────────────

  registerTracker(tracker: AnchorTracker): () => void {
    this.trackers.add(tracker);
    return () => this.trackers.delete(tracker);
  }

  anchorsChanged(notePath: string): void {
    for (const view of this.sidebars()) view.anchorsChanged(notePath);
  }

  threadAtCursor(notePath: string, id: string | null): void {
    if (this.app.workspace.getActiveFile()?.path !== notePath) return;
    for (const view of this.sidebars()) {
      if (id) view.focusThread(id);
      else view.clearFocus();
    }
  }

  showSuggestionsInline(): boolean {
    return this.settings.showSuggestionsInline;
  }

  decideSuggestion(notePath: string, id: string, result: SuggestionResult): void {
    const file = this.app.vault.getFileByPath(notePath);
    if (file) void this.decideSuggestionIn(file, id, result);
  }

  /** Accepts or declines a suggestion, telling the user why when that isn't possible. */
  async decideSuggestionIn(file: TFile, id: string, result: SuggestionResult): Promise<boolean> {
    if (result === "accepted") {
      const outcome = await this.acceptSuggestion(file, id);
      if (!outcome.ok) new Notice(suggestionFailureMessage(outcome.reason));
      return outcome.ok;
    }
    const behavior = this.settings.resolveBehavior;
    if (
      behavior === "remove" &&
      this.settings.confirmDestructiveActions &&
      !(await confirmAction(this.app, {
        title: "Decline suggestion?",
        message: "This permanently removes the suggestion.",
        confirmLabel: "Decline",
      }))
    ) {
      return false;
    }
    let failure: SuggestionFailure | null = null;
    const saved = await this.updateComments(file, (doc) => {
      const outcome = finishSuggestion(doc, id, "declined", behavior);
      if (!outcome.ok) failure = outcome.reason;
    });
    if (failure) new Notice(suggestionFailureMessage(failure));
    return saved && !failure;
  }

  private suggestionCommand(checking: boolean, editor: Editor, file: TFile | null, result: SuggestionResult): boolean {
    if (!file) return false;
    const anchor = this.trackerFor(file.path)?.suggestionAt(editor.posToOffset(editor.getCursor()));
    if (!anchor) return false;
    if (!checking) void this.decideSuggestionIn(file, anchor.id, result);
    return true;
  }

  /** Selects the next (or previous) open suggestion after the cursor, wrapping around the note. */
  private jumpToSuggestion(checking: boolean, editor: Editor, file: TFile | null, direction: 1 | -1): boolean {
    const suggestions = file ? (this.trackerFor(file.path)?.openSuggestions() ?? []) : [];
    if (suggestions.length === 0) return false;
    if (checking) return true;
    const cursor = editor.posToOffset(editor.getCursor(direction === 1 ? "to" : "from"));
    const target =
      direction === 1
        ? (suggestions.find((a) => a.from >= cursor) ?? suggestions[0])
        : ([...suggestions].reverse().find((a) => a.to <= cursor && a.from < cursor) ?? suggestions[suggestions.length - 1]);
    const from = editor.offsetToPos(target.from);
    const to = editor.offsetToPos(target.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    return true;
  }

  /**
   * Adds the comment panel to the right sidebar (without revealing it) the
   * first time the plugin runs in a vault; after that, Obsidian's saved layout
   * owns it, so a panel the user closed stays closed. Extra copies are removed:
   * when the plugin is reloaded, Obsidian restores its saved panels only after
   * the layout is ready.
   */
  private async ensureSidebar(): Promise<void> {
    const leaves = () => this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEMARK);
    if (!this.settings.sidebarAdded && leaves().length === 0) {
      await this.app.workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE_SIDEMARK, active: false });
    }
    if (!this.settings.sidebarAdded) await this.updateSettings({ sidebarAdded: true });
    window.setTimeout(() => {
      for (const extra of leaves().slice(1)) extra.detach();
    }, 2000);
  }

  private trackerFor(notePath: string): AnchorTracker | undefined {
    for (const tracker of this.trackers) if (tracker.notePath === notePath) return tracker;
    return undefined;
  }

  private trackersFor(notePath: string): AnchorTracker[] {
    return [...this.trackers].filter((tracker) => tracker.notePath === notePath);
  }

  private sidebars(): SidemarkSidebar[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_SIDEMARK)
      .map((leaf) => leaf.view)
      .filter(isSidebar);
  }

  async openSidebar(focusId?: string): Promise<SidemarkSidebar | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SIDEMARK)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return null;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_SIDEMARK, active: true });
    }
    await workspace.revealLeaf(leaf);
    const view = isSidebar(leaf.view) ? leaf.view : null;
    if (view && focusId) view.focusThread(focusId);
    return view;
  }

  private activeNote(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file : null;
  }

  private markdownViewFor(file: TFile): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view;
    }
    return null;
  }

  private async noteText(file: TFile): Promise<string> {
    const view = this.markdownViewFor(file);
    if (view) return view.editor.getValue();
    // The editor always works with LF line endings; match it for files read from disk.
    return (await this.app.vault.read(file)).replace(/\r\n/g, "\n");
  }

  // ── Comment operations used by the sidebar ────────────────

  newEntry(text: string): NewEntry {
    return { id: newCommentId(), author: this.currentAuthor(), timestamp: new Date().toISOString(), text };
  }

  async updateComments(file: TFile, mutate: (doc: MrsfDocument) => unknown): Promise<boolean> {
    try {
      const result = await this.store.update(file.path, mutate);
      if (!result.ok) new Notice(`Comments weren't saved; the comment file can't be read: ${result.error}`);
      return result.ok;
    } catch (e) {
      console.error("Sidemark: saving comments failed", e);
      new Notice(`Comments weren't saved: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Every thread of a note with where its passage currently is. */
  async resolveThreads(file: TFile): Promise<ResolvedThread[]> {
    const state = await this.store.load(file.path);
    const text = await this.noteText(file);
    const tracked = new Map((this.trackerFor(file.path)?.anchors ?? []).map((a) => [a.id, a]));
    return buildThreads(state.doc).map((thread) => {
      const { root } = thread;
      const live = tracked.get(root.id);
      let resolution: Resolution;
      if (live && !isResolved(root)) {
        resolution = {
          kind: "resolved",
          from: live.from,
          to: live.to,
          ambiguous: false,
          fuzzy: text.slice(live.from, live.to) !== root.selected_text,
        };
      } else if (suggestionOf(root)?.result === "accepted") {
        // The quote of an accepted suggestion describes text that was replaced.
        resolution = { kind: "orphaned" };
      } else {
        resolution = resolveComment(root, text);
      }
      return { thread, resolution };
    });
  }

  private async anchorFromEditor(editor: Editor): Promise<AnchorFields | null> {
    if (!editor.somethingSelected()) return null;
    const text = editor.getValue();
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    if (from === to) return null;
    const fields = anchorFieldsFor(text, from, to);
    return { ...fields, selected_text_hash: await selectedTextHash(fields.selected_text) };
  }

  async selectionAnchor(file: TFile): Promise<AnchorFields | null> {
    const view = this.markdownViewFor(file);
    return view ? this.anchorFromEditor(view.editor) : null;
  }

  private async startDraft(file: TFile, editor: Editor, kind: Draft["kind"]): Promise<void> {
    const anchor = await this.anchorFromEditor(editor);
    if (!anchor) {
      new Notice("Select some text first.");
      return;
    }
    const view = await this.openSidebar();
    view?.startDraft({ filePath: file.path, anchor, kind });
  }

  async revealThread(file: TFile, id: string): Promise<void> {
    let view = this.markdownViewFor(file);
    if (!view) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      view = leaf.view instanceof MarkdownView ? leaf.view : null;
    }
    if (!view) return;
    const editor = view.editor;
    const live = this.trackerFor(file.path)?.anchors.find((a) => a.id === id);
    let range: { from: number; to: number } | null = live ?? null;
    if (!range) {
      const comment = findComment((await this.store.load(file.path)).doc, id);
      const r = comment ? resolveComment(comment, editor.getValue()) : null;
      range = r?.kind === "resolved" ? r : null;
    }
    if (!range) {
      new Notice("The commented passage can't be found.");
      return;
    }
    await this.app.workspace.revealLeaf(view.leaf);
    const from = editor.offsetToPos(range.from);
    const to = editor.offsetToPos(range.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  /**
   * Records the suggestion as accepted, then replaces the passage in the
   * editor. Recording first means a comment file that can't be written never
   * leaves an unrecorded edit behind; if the passage changed in the meantime,
   * the recording is rolled back. Undoing the edit restores the text but leaves
   * the suggestion marked accepted; the sidebar's "Reopen" brings it back.
   */
  async acceptSuggestion(file: TFile, id: string): Promise<AcceptResult> {
    const view = this.markdownViewFor(file);
    if (!view) return { ok: false, reason: "no-editor" };
    const editor = view.editor;

    // Filled in by the update callback (a holder object, since TypeScript can't see assignments made there).
    const result: { outcome: AcceptResult; plan: AcceptPlan | null } = { outcome: { ok: false, reason: "missing" }, plan: null };
    const saved = await this.updateComments(file, (doc) => {
      const check = openSuggestion(doc, id);
      const comment = findComment(doc, id);
      if (!check.ok || !comment) {
        result.outcome = check.ok ? { ok: false, reason: "missing" } : check;
        return;
      }
      const text = editor.getValue();
      let range: { from: number; to: number } | null = this.trackerFor(file.path)?.anchors.find((a) => a.id === id) ?? null;
      if (!range) {
        const r = resolveComment(comment, text);
        range = r.kind === "resolved" && !r.ambiguous ? r : null;
      }
      if (!range) {
        result.outcome = { ok: false, reason: "orphaned" };
        return;
      }
      if (text.slice(range.from, range.to) !== comment.selected_text) {
        result.outcome = { ok: false, reason: "changed" };
        return;
      }
      const ids = descendantIds(doc, id).add(id);
      result.plan = {
        from: range.from,
        to: range.to,
        original: comment.selected_text,
        replacement: check.suggestion.replacement,
        thread: structuredClone(doc.comments.filter((c) => ids.has(c.id))),
      };
      finishSuggestion(doc, id, "accepted", this.settings.resolveBehavior);
    });
    const accepted = result.plan;
    if (!saved || !accepted) return saved ? result.outcome : { ok: false, reason: "missing" };
    const { from, to, original, replacement, thread } = accepted;

    // The passage may have been edited while the comment file was being written.
    if (editor.getValue().slice(from, to) !== original) {
      await this.updateComments(file, (doc) => {
        const restored = new Map(thread.map((c) => [c.id, c]));
        doc.comments = doc.comments.filter((c) => !restored.has(c.id));
        doc.comments.push(...thread);
      });
      return { ok: false, reason: "changed" };
    }
    const edit = suggestionEdit(editor.getValue(), from, to, replacement);
    editor.transaction({
      changes: [{ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.insert }],
    });
    editor.setCursor(editor.offsetToPos(edit.from + edit.insert.length));
    return { ok: true };
  }

  private async removeResolved(file: TFile): Promise<void> {
    if (
      this.settings.confirmDestructiveActions &&
      !(await confirmAction(this.app, {
        title: "Remove resolved threads?",
        message: "This permanently removes every resolved thread from this note's comments.",
        confirmLabel: "Remove threads",
      }))
    ) {
      return;
    }
    let count = 0;
    const ok = await this.updateComments(file, (doc) => {
      count = removeResolvedThreads(doc);
    });
    if (ok) new Notice(count > 0 ? `Removed ${count} resolved thread${count === 1 ? "" : "s"}.` : "No resolved threads.");
  }

  async exportComments(file: TFile): Promise<void> {
    const threads = await this.resolveThreads(file);
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const content = buildExportNote(file.basename, threads, date);
    if (!content) {
      new Notice("No comments to export.");
      return;
    }
    const folder = file.parent && !file.parent.isRoot() ? file.parent.path + "/" : "";
    const path = normalizePath(`${folder}${file.basename} – Comments.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let exported: TFile;
    if (existing instanceof TFile) {
      // An export is a snapshot, so exporting again replaces the previous one.
      await this.app.vault.modify(existing, content);
      exported = existing;
    } else if (existing) {
      new Notice(`Can't export: ${path} is a folder.`);
      return;
    } else {
      exported = await this.app.vault.create(path, content);
    }
    await this.openExport(exported);
    new Notice(`Comments exported to ${path}`);
  }

  /** Shows the export, reusing a tab that already has it open. */
  private async openExport(file: TFile): Promise<void> {
    const { workspace } = this.app;
    const open = workspace.getLeavesOfType("markdown").find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);
    if (open) {
      await workspace.revealLeaf(open);
      workspace.setActiveLeaf(open, { focus: true });
      return;
    }
    await workspace.getLeaf("tab").openFile(file);
  }

  async migrateTandem(): Promise<void> {
    await migrateTandemComments(this);
  }

  // ── Keeping sidecars with their notes ─────────────────────

  private reportRename(outcome: RenameOutcome, notePath: string): void {
    if (outcome !== "conflict") return;
    new Notice(
      `Sidemark: "${notePath}" already had a comment file, so the renamed note's comments were left at their old path.`,
      15000
    );
  }

  private onFileChanged(file: TAbstractFile): void {
    const notePath = notePathFor(file.path);
    if (notePath) void this.store.sidecarChanged(notePath);
  }

  private onFileDeleted(file: TAbstractFile): void {
    const notePath = notePathFor(file.path);
    if (notePath) {
      void this.store.sidecarChanged(notePath);
    } else if (file instanceof TFile && file.extension === "md") {
      void this.store.noteDeleted(file.path);
    }
  }

  private onFileRenamed(file: TAbstractFile, oldPath: string): void {
    if (notePathFor(file.path) || notePathFor(oldPath)) return;
    if (file instanceof TFile && file.extension === "md") {
      for (const tracker of this.trackersFor(oldPath)) tracker.noteRenamed(file.path);
      void this.store.noteRenamed(oldPath, file.path).then((outcome) => this.reportRename(outcome, file.path));
    } else if (file instanceof TFolder) {
      // Sidecars moved with the folder; their `document` fields still name the old path.
      const visit = (folder: TFolder): void => {
        for (const child of folder.children) {
          if (child instanceof TFolder) visit(child);
          else if (child instanceof TFile && child.extension === "md") {
            const previous = oldPath + child.path.slice(file.path.length);
            for (const tracker of this.trackersFor(previous)) tracker.noteRenamed(child.path);
            void this.store.noteRenamed(previous, child.path, true).then((outcome) => this.reportRename(outcome, child.path));
          }
        }
      };
      visit(file);
    }
  }
}
