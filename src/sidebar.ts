import {
  type HoverParent,
  type HoverPopover,
  ItemView,
  Keymap,
  MarkdownRenderer,
  Menu,
  Notice,
  type PaneType,
  setIcon,
  setTooltip,
  type TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { resolveAuthorColor } from "./author-color";
import { confirmAction } from "./confirm-action";
import { formatThread, formatTs, type ResolvedThread } from "./export";
import type SidemarkPlugin from "./main";
import { type Comment, isResolved, suggestionOf, threadActivity } from "./model";
import {
  type AnchorFields,
  addComment,
  addReply,
  addSuggestion,
  deleteComment,
  deleteThread,
  editText,
  reopenSuggestion,
  retarget,
  setThreadResolved,
  type SuggestionFailure,
} from "./mutations";
import { shouldSubmitComment } from "./settings-model";
import { formatSidebarTimestamp, shortTimestamp } from "./timestamp";
import { wordDiff } from "./word-diff";

export const VIEW_TYPE_SIDEMARK = "sidemark-sidebar";

export interface Draft {
  filePath: string;
  anchor: AnchorFields;
  kind: "comment" | "suggestion";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Renders `before` → `after` as one passage with the changed words struck out or marked as added. */
function renderDiff(el: HTMLElement, before: string, after: string): void {
  el.empty();
  for (const part of wordDiff(before, after)) {
    const cls = part.kind === "same" ? undefined : part.kind === "del" ? "sm-diff-del" : "sm-diff-ins";
    el.createSpan({ text: part.text, cls });
  }
}

export function suggestionFailureMessage(reason: SuggestionFailure | "no-editor" | "orphaned" | "changed" | "ambiguous"): string {
  switch (reason) {
    case "no-editor":
      return "Open this note in an editor before accepting the suggestion.";
    case "orphaned":
      return "The original passage no longer exists. Re-anchor the suggestion before accepting it.";
    case "ambiguous":
      return "This passage appears more than once in the note. Re-anchor the suggestion before accepting it.";
    case "changed":
      return "The passage has changed since the suggestion was made. Re-anchor it before accepting.";
    case "invalid-suggestion":
      return "The suggestion data is invalid; its replacement must be text.";
    case "already-resolved":
      return "This suggestion has already been resolved.";
    case "not-suggestion":
      return "This comment is not an edit suggestion.";
    case "missing":
      return "The suggestion no longer exists.";
  }
}

export class SidemarkSidebar extends ItemView implements HoverParent {
  hoverPopover: HoverPopover | null = null;
  private draft: Draft | null = null;
  private showResolved: boolean;
  /** The thread shown as selected; it stays selected across re-renders. */
  private focusedId: string | null = null;
  /** A thread to scroll into view on the next render (set when its card doesn't exist yet). */
  private pendingScrollId: string | null = null;
  private renderQueued = false;
  private rendering: Promise<void> = Promise.resolve();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SidemarkPlugin
  ) {
    super(leaf);
    this.showResolved = plugin.settings.showResolvedByDefault;
  }

  getViewType(): string {
    return VIEW_TYPE_SIDEMARK;
  }

  getDisplayText(): string {
    return "Comments";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("file-open", () => this.requestRender(true)));
    this.register(
      this.plugin.store.onChange((change) => {
        if (change.notePath === this.app.workspace.getActiveFile()?.path) this.requestRender(false);
      })
    );
    this.registerInterval(window.setInterval(() => this.refreshTimestamps(), 60_000));
    this.registerDomEvent(this.contentEl, "keydown", (e) => {
      if (e.key !== "Escape" || (e.target instanceof Element && e.target.closest("textarea, input"))) return;
      this.clearFocus();
    });
    this.requestRender(true);
  }

  /** Called when live anchor positions for a note changed. */
  anchorsChanged(notePath: string): void {
    if (notePath === this.app.workspace.getActiveFile()?.path) this.requestRender(false);
  }

  startDraft(draft: Draft): void {
    this.draft = draft;
    this.requestRender(true);
  }

  /** Marks a thread as selected, scrolling to it unless `scroll` is false. */
  focusThread(id: string, scroll = true): void {
    this.focusedId = id;
    const card = this.applyFocus();
    if (!scroll) return;
    if (card) {
      card.scrollIntoView({ block: "nearest" });
    } else {
      this.pendingScrollId = id;
      this.requestRender(true);
    }
  }

  clearFocus(): void {
    if (this.focusedId === null) return;
    this.focusedId = null;
    this.applyFocus();
  }

  /** Updates the selected card in place; returns it if it's rendered. */
  private applyFocus(): HTMLElement | null {
    let focused: HTMLElement | null = null;
    for (const card of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".sm-card[data-sm-id]"))) {
      const match = card.dataset.smId === this.focusedId;
      card.toggleClass("sm-focused", match);
      card.toggleClass("sm-expanded", match || card.hasClass("sm-has-input"));
      if (match) focused = card;
    }
    return focused;
  }

  toggleResolved(): void {
    this.showResolved = !this.showResolved;
    this.requestRender(true);
  }

  settingsChanged(resetResolved: boolean): void {
    if (resetResolved) this.showResolved = this.plugin.settings.showResolvedByDefault;
    this.requestRender(true);
  }

  /** Whether re-rendering now would throw away text the user is typing. */
  private hasPendingInput(): boolean {
    return Array.from(this.contentEl.querySelectorAll("textarea")).some(
      (t) => t.value.length > 0 || t.classList.contains("sm-edit-input")
    );
  }

  /** Coalesces render requests; unforced ones wait while the user is typing. */
  requestRender(force: boolean): void {
    if (!force && this.hasPendingInput()) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    this.rendering = this.rendering.then(async () => {
      this.renderQueued = false;
      try {
        await this.render();
      } catch (e) {
        console.error("Sidemark: sidebar render failed", e);
      }
    });
  }

  private async render(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const threads = file && file.extension === "md" ? await this.plugin.resolveThreads(file) : null;
    const state = file ? this.plugin.store.peek(file.path) : undefined;

    const container = this.contentEl;
    const prevScroll = container.scrollTop;
    container.empty();
    container.addClass("sm-sidebar");

    if (!file || !threads) {
      container.createDiv({ text: "No active Markdown note.", cls: "sm-empty" });
      return;
    }
    if (state?.error) {
      container.createDiv({
        text: `This note's comment file can't be read, so it won't be changed: ${state.error}`,
        cls: "sm-error",
      });
    }

    const header = container.createDiv({ cls: "sm-header" });
    header.createSpan({ text: "Comments", cls: "sm-title" });
    const toggle = header.createEl("button", {
      text: this.showResolved ? "Hide resolved" : "Show resolved",
      cls: "sm-toggle",
    });
    toggle.onclick = () => this.toggleResolved();

    if (this.draft && this.draft.filePath === file.path) this.renderDraft(container, file, this.draft);
    else this.draft = null;

    const open = this.sorted(threads.filter((t) => !isResolved(t.thread.root) && t.resolution.kind === "resolved"));
    const orphans = this.sorted(threads.filter((t) => !isResolved(t.thread.root) && t.resolution.kind === "orphaned"));
    const done = this.sorted(threads.filter((t) => isResolved(t.thread.root)));

    if (!open.length && !orphans.length && !(this.showResolved && done.length) && !this.draft) {
      container.createDiv({
        text: done.length
          ? "No open comments. Use “Show resolved” to see resolved ones."
          : "No comments yet. Select text and use “Add comment”.",
        cls: "sm-empty",
      });
      return;
    }

    for (const t of open) this.renderThread(container, file, t);
    if (orphans.length) {
      container.createDiv({ text: "Orphaned — passage not found", cls: "sm-section" });
      for (const t of orphans) this.renderThread(container, file, t);
    }
    if (this.showResolved && done.length) {
      container.createDiv({ text: "Resolved", cls: "sm-section" });
      for (const t of done) this.renderThread(container, file, t);
    }
    container.scrollTop = prevScroll;
  }

  private sorted(items: ResolvedThread[]): ResolvedThread[] {
    const order = this.plugin.settings.sidebarSortOrder;
    if (order === "document") {
      const start = (t: ResolvedThread) => (t.resolution.kind === "resolved" ? t.resolution.from : Number.MAX_SAFE_INTEGER);
      return [...items].sort((a, b) => start(a) - start(b));
    }
    const direction = order === "newest" ? -1 : 1;
    return [...items].sort((a, b) => direction * (threadActivity(a.thread) - threadActivity(b.thread)));
  }

  private submitHint(action: string): string {
    return this.plugin.settings.submitShortcut === "enter"
      ? `(Enter = ${action}, Esc = cancel)`
      : `(Cmd/Ctrl+Enter = ${action}, Esc = cancel)`;
  }

  private shouldSubmit(event: KeyboardEvent): boolean {
    return shouldSubmitComment(event, this.plugin.settings.submitShortcut);
  }

  private cancelDraft(): void {
    this.draft = null;
    this.requestRender(true);
  }

  private renderDraft(container: HTMLElement, file: TFile, draft: Draft): void {
    // A draft is always shown in full.
    const card = container.createDiv({ cls: "sm-card sm-draft sm-expanded" });
    card.createDiv({ text: draft.anchor.selected_text, cls: "sm-quote" });
    if (draft.kind === "suggestion") {
      this.renderSuggestionDraft(card, file, draft);
      return;
    }
    const input = card.createEl("textarea", {
      cls: "sm-input",
      attr: { placeholder: `Comment… ${this.submitHint("save")}`, rows: "3", "aria-label": "New comment" },
    });
    window.setTimeout(() => input.focus(), 0);
    let saving = false;
    input.onkeydown = (e) => {
      if (e.key === "Escape") {
        this.cancelDraft();
      } else if (this.shouldSubmit(e)) {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || saving) return;
        saving = true;
        void this.plugin
          .updateComments(file, (doc) => addComment(doc, this.plugin.newEntry(text), draft.anchor))
          .then((ok) => {
            saving = false;
            if (!ok) return;
            input.value = "";
            this.cancelDraft();
          });
      }
    };
  }

  private renderSuggestionDraft(card: HTMLElement, file: TFile, draft: Draft): void {
    card.createDiv({ text: "Suggested replacement", cls: "sm-field-label" });
    const replacement = card.createEl("textarea", {
      cls: "sm-input",
      attr: { placeholder: "Leave empty to suggest deleting the text", rows: "3", "aria-label": "Suggested replacement" },
    });
    replacement.value = draft.anchor.selected_text;
    const deletionHint = card.createDiv({ text: "This suggests deleting the selected text.", cls: "sm-field-hint" });
    const preview = card.createDiv({ cls: "sm-suggestion-diff sm-draft-preview", attr: { "aria-label": "Preview of the change" } });
    const updateHint = (): void => {
      deletionHint.hidden = replacement.value.length > 0;
      preview.hidden = replacement.value === draft.anchor.selected_text;
      if (!preview.hidden) renderDiff(preview, draft.anchor.selected_text, replacement.value);
    };
    updateHint();
    replacement.addEventListener("input", updateHint);
    card.createDiv({ text: "Explanation (optional)", cls: "sm-field-label" });
    const note = card.createEl("textarea", {
      cls: "sm-input",
      attr: { placeholder: "Why this change?", rows: "2", "aria-label": "Suggestion explanation" },
    });
    const actions = card.createDiv({ cls: "sm-actions" });
    const save = actions.createEl("button", { text: "Add suggestion", cls: "mod-cta" });
    const cancel = actions.createEl("button", { text: "Cancel" });

    const submit = (): void => {
      if (save.disabled) return;
      if (replacement.value === draft.anchor.selected_text) {
        new Notice("The replacement is identical to the original text.");
        replacement.focus();
        return;
      }
      save.disabled = true;
      const proposed = replacement.value;
      const explanation = note.value.trim();
      void this.plugin
        .updateComments(file, (doc) => addSuggestion(doc, this.plugin.newEntry(explanation), draft.anchor, proposed))
        .then((ok) => {
          if (ok) {
            replacement.value = "";
            note.value = "";
            this.cancelDraft();
          } else {
            save.disabled = false;
          }
        });
    };

    save.onclick = submit;
    cancel.onclick = () => this.cancelDraft();
    for (const field of [replacement, note]) {
      field.onkeydown = (e) => {
        if (e.key === "Escape") this.cancelDraft();
        else if (this.shouldSubmit(e)) {
          e.preventDefault();
          submit();
        }
      };
    }
    window.setTimeout(() => {
      replacement.focus();
      replacement.select();
    }, 0);
  }

  private paintAuthor(el: HTMLElement, author: string): void {
    el.dataset.smAuthor = author;
    if (!this.plugin.settings.colorAuthorNames) return;
    const overrides = this.plugin.settings.authorColorOverrides;
    el.style.setProperty("--sm-author-color-light", resolveAuthorColor(author, overrides, "light"));
    el.style.setProperty("--sm-author-color-dark", resolveAuthorColor(author, overrides, "dark"));
    el.addClass("sm-author-colored");
  }

  private async confirmed(title: string, message: string, confirmLabel: string): Promise<boolean> {
    if (!this.plugin.settings.confirmDestructiveActions) return true;
    return confirmAction(this.app, { title, message, confirmLabel });
  }

  private showMenu(trigger: HTMLElement, build: (menu: Menu) => void): void {
    const menu = new Menu();
    build(menu);
    trigger.setAttr("aria-expanded", "true");
    menu.onHide(() => trigger.setAttr("aria-expanded", "false"));
    const rect = trigger.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.bottom, left: true }, trigger.ownerDocument);
  }

  /** A small icon button for a card's header. */
  private addIconButton(
    controls: HTMLElement,
    options: { icon: string; label: string; cls?: string; unavailable?: string | null; run: (button: HTMLButtonElement) => void }
  ): HTMLButtonElement {
    const button = controls.createEl("button", {
      cls: ["sm-entry-action", "clickable-icon", ...(options.cls ? [options.cls] : [])],
      attr: { "aria-label": options.label },
    });
    setIcon(button, options.icon);
    if (options.unavailable) {
      // Not `disabled`: disabled buttons get no hover events, so the reason couldn't be shown.
      button.addClass("sm-action-unavailable");
      button.setAttr("aria-disabled", "true");
      setTooltip(button, `${options.label}: ${options.unavailable}`);
      button.onclick = () => new Notice(options.unavailable ?? "");
    } else {
      setTooltip(button, options.label);
      button.onclick = () => options.run(button);
    }
    return button;
  }

  private reopenThread(file: TFile, root: Comment, isSuggestion: boolean): void {
    void this.plugin.updateComments(file, (doc) => {
      if (isSuggestion) reopenSuggestion(doc, root.id);
      else setThreadResolved(doc, root.id, false);
    });
  }

  private addMenuTrigger(
    controls: HTMLElement,
    label: string,
    items: { title: string; icon: string; warning?: boolean; run: () => void }[]
  ): void {
    const trigger = controls.createEl("button", {
      cls: "sm-entry-menu-trigger clickable-icon",
      attr: { "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false" },
    });
    setIcon(trigger, "ellipsis");
    trigger.onclick = () =>
      this.showMenu(trigger, (menu) => {
        for (const item of items) {
          menu.addItem((menuItem) => {
            menuItem.setTitle(item.title).setIcon(item.icon).onClick(item.run);
            if (item.warning) menuItem.setWarning(true);
          });
        }
      });
  }

  private resolveThread(file: TFile, rootId: string): void {
    void (async () => {
      const remove = this.plugin.settings.resolveBehavior === "remove";
      if (remove && !(await this.confirmed("Resolve comment?", "This permanently removes the thread.", "Resolve"))) {
        return;
      }
      await this.plugin.updateComments(file, (doc) => {
        if (remove) deleteThread(doc, rootId);
        else setThreadResolved(doc, rootId, true);
      });
    })();
  }

  private renderThread(container: HTMLElement, file: TFile, item: ResolvedThread): void {
    const { thread, resolution } = item;
    const { root } = thread;
    const suggestion = suggestionOf(root);
    const claimsSuggestion = root.x_suggestion !== undefined;
    const isDeletion = suggestion?.replacement === "";
    const isOpen = !isResolved(root);
    const rootText = String(root.text ?? "");
    const cls = ["sm-card"];
    if (!isOpen) cls.push("sm-resolved");
    if (resolution.kind === "orphaned" && isOpen) cls.push("sm-orphan");
    if (claimsSuggestion) cls.push("sm-suggestion-card");
    if (resolution.kind === "resolved" && resolution.ambiguous) cls.push("sm-ambiguous");
    if (root.id === this.focusedId) cls.push("sm-focused", "sm-expanded");
    // Unselected cards are compact: CSS hides everything marked sm-full-only unless the card is expanded.
    const card = container.createDiv({ cls: cls.join(" ") });
    card.dataset.smId = root.id;
    if (root.id === this.pendingScrollId) {
      this.pendingScrollId = null;
      window.setTimeout(() => card.scrollIntoView({ block: "nearest" }), 0);
    }
    card.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button, textarea, a, input")) return;
      this.focusThread(root.id, false);
    });
    const copyItem = {
      title: "Copy",
      icon: "copy",
      run: () => void navigator.clipboard.writeText(formatThread(thread, true)).then(() => new Notice("Thread copied.")),
    };
    const reveal = resolution.kind === "resolved" ? () => this.plugin.revealThread(file, root.id) : null;
    const quoteText = root.selected_text ?? "";

    let warning: string | null = null;
    if (isOpen && resolution.kind === "orphaned") {
      warning = claimsSuggestion ? "Original passage not found." : "The commented passage can't be found.";
    } else if (isOpen && resolution.kind === "resolved" && resolution.ambiguous) {
      warning = "This passage appears more than once in the note.";
    } else if (isOpen && claimsSuggestion && resolution.kind === "resolved" && resolution.fuzzy) {
      warning = "The passage has changed since this suggestion was made.";
    }

    if (claimsSuggestion) {
      const heading = card.createDiv({ cls: "sm-suggestion-heading sm-full-only" });
      heading.createSpan({ text: isDeletion ? "Suggested deletion" : "Suggested edit", cls: "sm-suggestion-title" });
      if (suggestion?.result) {
        heading.createSpan({
          text: suggestion.result === "accepted" ? "Accepted" : "Declined",
          cls: `sm-suggestion-result sm-suggestion-${suggestion.result}`,
        });
      }
    }

    // Header: author, time, compact badges and the thread's actions.
    const header = card.createDiv({ cls: "sm-meta sm-card-header" });
    const author = String(root.author);
    this.paintAuthor(header.createSpan({ text: author, cls: "sm-author" }), author);
    this.addTimestamp(header, String(root.timestamp), "sm-full-only");
    this.addShortTimestamp(header, String(root.timestamp));
    if (thread.replies.length > 0) {
      const count = header.createSpan({ cls: "sm-badge sm-compact-only" });
      setIcon(count.createSpan({ cls: "sm-badge-icon" }), "message-square");
      count.createSpan({ text: String(thread.replies.length) });
      setTooltip(count, `${thread.replies.length} ${thread.replies.length === 1 ? "reply" : "replies"}`);
    }
    if (warning) {
      const badge = header.createSpan({ cls: "sm-badge sm-badge-warning sm-compact-only" });
      setIcon(badge, "alert-triangle");
      setTooltip(badge, warning);
    }
    const controls = header.createDiv({ cls: "sm-entry-controls" });
    const menuItems: { title: string; icon: string; warning?: boolean; run: () => void }[] = [copyItem];
    if (claimsSuggestion) {
      if (isOpen && suggestion && !suggestion.result) {
        const decide = (result: "accepted" | "declined") => (button: HTMLButtonElement) => {
          button.disabled = true;
          void this.plugin.decideSuggestionIn(file, root.id, result).then((ok) => {
            if (!ok) button.disabled = false;
          });
        };
        let unavailable: string | null = null;
        if (resolution.kind === "orphaned") unavailable = suggestionFailureMessage("orphaned");
        else if (resolution.ambiguous) unavailable = suggestionFailureMessage("ambiguous");
        else if (resolution.fuzzy) unavailable = suggestionFailureMessage("changed");
        this.addIconButton(controls, { icon: "check", label: "Accept suggestion", cls: "sm-accept", unavailable, run: decide("accepted") });
        this.addIconButton(controls, { icon: "x", label: "Decline suggestion", cls: "sm-decline", run: decide("declined") });
      } else if (!isOpen || suggestion?.result) {
        this.addIconButton(controls, { icon: "rotate-ccw", label: "Reopen suggestion", run: () => this.reopenThread(file, root, true) });
      }
      if (rootText.length > 0) {
        menuItems.push({
          title: "Delete explanation",
          icon: "eraser",
          warning: true,
          run: () =>
            void (async () => {
              if (!(await this.confirmed("Delete explanation?", "This permanently removes this entry.", "Delete"))) return;
              await this.plugin.updateComments(file, (doc) => editText(doc, root.id, rootText, ""));
            })(),
        });
      }
      menuItems.push({
        title: "Delete suggestion",
        icon: "trash-2",
        warning: true,
        run: () =>
          void (async () => {
            if (!(await this.confirmed("Delete suggestion?", "This permanently removes the suggestion and its discussion.", "Delete"))) return;
            await this.plugin.updateComments(file, (doc) => deleteThread(doc, root.id));
          })(),
      });
    } else {
      if (isOpen) {
        this.addIconButton(controls, { icon: "check", label: "Resolve comment", cls: "sm-accept", run: () => this.resolveThread(file, root.id) });
      } else {
        this.addIconButton(controls, { icon: "rotate-ccw", label: "Reopen comment", run: () => this.reopenThread(file, root, false) });
      }
      menuItems.push({
        title: "Delete comment",
        icon: "trash-2",
        warning: true,
        run: () =>
          void (async () => {
            if (!(await this.confirmed("Delete comment?", "This permanently removes the comment and all of its replies.", "Delete"))) return;
            await this.plugin.updateComments(file, (doc) => deleteThread(doc, root.id));
          })(),
      });
    }
    this.addMenuTrigger(controls, claimsSuggestion ? "More options for suggestion" : "More options for comment", menuItems);

    // What the thread is about.
    if (claimsSuggestion) {
      const change = card.createDiv({ cls: "sm-suggestion-diff" });
      if (suggestion) renderDiff(change, quoteText, suggestion.replacement);
      else change.setText(quoteText);
      if (reveal) {
        change.addClass("sm-quote-link");
        change.onclick = reveal;
      }
      if (!suggestion) card.createDiv({ text: "Invalid suggestion data.", cls: "sm-suggestion-warning sm-full-only" });
    } else {
      const quote = card.createDiv({ text: quoteText, cls: "sm-quote" });
      if (reveal) {
        quote.addClass("sm-quote-link");
        quote.onclick = reveal;
      }
      if (isOpen && resolution.kind === "resolved" && resolution.fuzzy && root.anchored_text !== undefined) {
        card.createDiv({ text: `Now reads: "${truncate(root.anchored_text, 80)}"`, cls: "sm-drift sm-full-only" });
      }
    }
    if (warning) card.createDiv({ text: warning, cls: "sm-suggestion-warning sm-full-only" });

    if (!claimsSuggestion || rootText.length > 0) this.renderEntry(card, file, root, root, claimsSuggestion, copyItem);
    for (const reply of thread.replies) this.renderEntry(card, file, root, reply, claimsSuggestion, copyItem);

    // The only bottom action repairs a thread's anchor; decisions live in the header.
    if (isOpen && (resolution.kind === "orphaned" || resolution.ambiguous || (claimsSuggestion && resolution.fuzzy))) {
      const actions = card.createDiv({ cls: "sm-actions sm-full-only" });
      const reanchor = actions.createEl("button", { text: "Re-anchor to selection" });
      reanchor.onclick = () => void this.reanchorFromSelection(file, root.id);
    }

    if (isOpen) {
      const reply = card.createEl("textarea", {
        cls: "sm-input sm-full-only",
        attr: { placeholder: `Reply… ${this.submitHint("send")}`, rows: "2", "aria-label": "Reply" },
      });
      reply.addEventListener("input", () => this.setPendingInput(card, reply.value.length > 0));
      reply.onkeydown = (e) => {
        if (e.key === "Escape") {
          reply.value = "";
          this.setPendingInput(card, false);
          reply.blur();
        } else if (this.shouldSubmit(e)) {
          e.preventDefault();
          const text = reply.value.trim();
          if (!text || reply.disabled) return;
          reply.disabled = true;
          void this.plugin
            .updateComments(file, (doc) => addReply(doc, root.id, this.plugin.newEntry(text)))
            .then((ok) => {
              reply.disabled = false;
              if (!ok) return;
              reply.value = "";
              this.setPendingInput(card, false);
              // The render triggered by the save was skipped while the reply was still in the box.
              this.requestRender(false);
            });
        }
      };
    }
  }

  /** A card with unsent text stays expanded even when another thread is selected. */
  private setPendingInput(card: HTMLElement, pending: boolean): void {
    card.toggleClass("sm-has-input", pending);
    card.toggleClass("sm-expanded", pending || card.dataset.smId === this.focusedId);
  }

  private renderEntry(
    card: HTMLElement,
    file: TFile,
    root: Comment,
    entry: Comment,
    inSuggestion: boolean,
    copyItem: { title: string; icon: string; run: () => void }
  ): void {
    const isRoot = entry === root;
    const author = String(entry.author);
    const text = String(entry.text ?? "");
    // The root's author, time and actions are in the card header; replies only show when expanded.
    const row = card.createDiv({ cls: isRoot ? "sm-entry sm-root-entry" : "sm-entry sm-reply sm-full-only" });
    if (!isRoot) {
      const meta = row.createDiv({ cls: "sm-meta" });
      this.paintAuthor(meta.createSpan({ text: author, cls: "sm-author" }), author);
      this.addTimestamp(meta, String(entry.timestamp));
      const controls = meta.createDiv({ cls: "sm-entry-controls" });
      this.addMenuTrigger(controls, `More options for reply by ${author}`, [
        copyItem,
        {
          title: "Delete reply",
          icon: "trash-2",
          warning: true,
          run: () =>
            void (async () => {
              if (!(await this.confirmed("Delete reply?", "This permanently removes this entry.", "Delete"))) return;
              await this.plugin.updateComments(file, (doc) => deleteComment(doc, entry.id));
            })(),
        },
      ]);
    }

    const textEl = row.createDiv({
      cls: "sm-text sm-text-editable",
      attr: { tabindex: "0", title: "Double-click to edit", "aria-label": `Comment by ${author}. Double-click or press Enter to edit.` },
    });
    // MRSF says comment text is plain text; rendering it as Markdown anyway is
    // a deliberate deviation so wikilinks and formatting work in Obsidian.
    void MarkdownRenderer.render(this.app, text, textEl, file.path, this);
    this.wireCommentLinks(textEl, file);

    const beginEdit = (): void => {
      this.setPendingInput(card, true);
      const input = row.createEl("textarea", {
        cls: "sm-input sm-edit-input",
        attr: { rows: "3", "aria-label": `Edit comment by ${author}` },
      });
      input.value = text;
      textEl.replaceWith(input);
      const editActions = row.createDiv({ cls: "sm-actions sm-edit-actions" });
      const save = editActions.createEl("button", { text: "Save", cls: "mod-cta" });
      const cancel = editActions.createEl("button", { text: "Cancel" });
      const submit = (): void => {
        if (save.disabled) return;
        const next = input.value.trim();
        if (!next && !(isRoot && inSuggestion)) {
          new Notice("Comment cannot be empty.");
          input.focus();
          return;
        }
        if (next === text) {
          this.requestRender(true);
          return;
        }
        save.disabled = true;
        cancel.disabled = true;
        let failure: string | null = null;
        void this.plugin
          .updateComments(file, (doc) => {
            const result = editText(doc, entry.id, text, next);
            if (!result.ok) failure = result.reason;
          })
          .then((ok) => {
            if (!ok) {
              save.disabled = false;
              cancel.disabled = false;
              return;
            }
            if (failure === "conflict") new Notice("This comment changed while you were editing it. Your edit was not saved.");
            else if (failure === "missing") new Notice("This comment no longer exists. Your edit was not saved.");
            this.requestRender(true);
          });
      };
      save.onclick = submit;
      cancel.onclick = () => this.requestRender(true);
      input.onkeydown = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this.requestRender(true);
        } else if (this.shouldSubmit(e)) {
          e.preventDefault();
          submit();
        }
      };
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    textEl.ondblclick = (e) => {
      if (e.target instanceof Element && e.target.closest("a")) return;
      e.preventDefault();
      beginEdit();
    };
    textEl.onkeydown = (e) => {
      if (e.target !== textEl) return;
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        beginEdit();
      }
    };
  }

  /**
   * Links rendered by MarkdownRenderer outside a Markdown view are inert, so
   * clicks and hover previews on internal links are wired up here.
   */
  private wireCommentLinks(textEl: HTMLElement, file: TFile): void {
    const findInternalLink = (evt: Event): HTMLAnchorElement | null => {
      const link = evt.target instanceof Element ? evt.target.closest("a.internal-link") : null;
      return link instanceof HTMLAnchorElement && textEl.contains(link) ? link : null;
    };
    const targetOf = (link: HTMLAnchorElement): string | null => link.getAttribute("data-href") ?? link.getAttribute("href");
    const open = (evt: MouseEvent, newLeaf: PaneType | boolean): void => {
      const link = findInternalLink(evt);
      const target = link ? targetOf(link) : null;
      if (!target) return;
      evt.preventDefault();
      evt.stopPropagation();
      void this.app.workspace.openLinkText(target, file.path, newLeaf);
    };
    textEl.addEventListener("click", (evt) => open(evt, Keymap.isModEvent(evt)));
    textEl.addEventListener("auxclick", (evt) => {
      if (evt.button === 1) open(evt, true);
    });
    textEl.addEventListener("mouseover", (evt) => {
      const link = findInternalLink(evt);
      const target = link ? targetOf(link) : null;
      if (!link || !target) return;
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: this.plugin.manifest.id,
        hoverParent: this,
        targetEl: link,
        linktext: target,
        sourcePath: file.path,
      });
    });
  }

  private addTimestamp(container: HTMLElement, timestamp: string, extraCls?: string): void {
    const formatted = formatSidebarTimestamp(timestamp, this.plugin.settings.timestampDisplay);
    if (formatted === null) return;
    const element = container.createSpan({ text: formatted, cls: extraCls ? `sm-ts ${extraCls}` : "sm-ts" });
    element.dataset.smTimestamp = timestamp;
    if (this.plugin.settings.timestampDisplay !== "full") setTooltip(element, formatTs(timestamp));
  }

  /** The compact card's time ("3h"), with the full time on hover. */
  private addShortTimestamp(container: HTMLElement, timestamp: string): void {
    if (this.plugin.settings.timestampDisplay === "hidden") return;
    const element = container.createSpan({ text: shortTimestamp(timestamp), cls: "sm-ts sm-ts-short sm-compact-only" });
    element.dataset.smShortTimestamp = timestamp;
    setTooltip(element, formatTs(timestamp));
  }

  private refreshTimestamps(): void {
    for (const element of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".sm-ts[data-sm-short-timestamp]"))) {
      const timestamp = element.dataset.smShortTimestamp;
      if (timestamp) element.setText(shortTimestamp(timestamp));
    }
    for (const element of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".sm-ts[data-sm-timestamp]"))) {
      const timestamp = element.dataset.smTimestamp;
      if (!timestamp) continue;
      const formatted = formatSidebarTimestamp(timestamp, this.plugin.settings.timestampDisplay);
      if (formatted !== null) element.setText(formatted);
    }
  }

  private async reanchorFromSelection(file: TFile, id: string): Promise<void> {
    const anchor = await this.plugin.selectionAnchor(file);
    if (!anchor) {
      new Notice("Select the new passage in the editor first.");
      return;
    }
    await this.plugin.updateComments(file, (doc) => retarget(doc, id, anchor));
  }
}

export function isSidebar(view: unknown): view is SidemarkSidebar {
  return view instanceof SidemarkSidebar;
}
