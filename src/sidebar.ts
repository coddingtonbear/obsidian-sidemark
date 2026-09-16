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
import { type Comment, suggestionOf, threadActivity } from "./model";
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
import { formatSidebarTimestamp } from "./timestamp";
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

export function suggestionFailureMessage(reason: SuggestionFailure | "no-editor" | "orphaned" | "changed"): string {
  switch (reason) {
    case "no-editor":
      return "Open this note in an editor before accepting the suggestion.";
    case "orphaned":
      return "The original passage no longer exists. Re-anchor the suggestion before accepting it.";
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
    this.registerInterval(
      window.setInterval(() => {
        if (this.plugin.settings.timestampDisplay === "relative") this.refreshTimestamps();
      }, 60_000)
    );
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
    const exportBtn = header.createEl("button", { text: "Export", cls: "sm-toggle" });
    exportBtn.onclick = () => void this.plugin.exportComments(file);

    if (this.draft && this.draft.filePath === file.path) this.renderDraft(container, file, this.draft);
    else this.draft = null;

    const open = this.sorted(threads.filter((t) => !t.thread.root.resolved && t.resolution.kind === "resolved"));
    const orphans = this.sorted(threads.filter((t) => !t.thread.root.resolved && t.resolution.kind === "orphaned"));
    const done = this.sorted(threads.filter((t) => t.thread.root.resolved));

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
    const card = container.createDiv({ cls: "sm-card sm-draft" });
    card.createDiv({ text: `"${truncate(draft.anchor.selected_text, 80)}"`, cls: "sm-quote" });
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
    const isOpen = !root.resolved;
    const cls = ["sm-card"];
    if (root.resolved) cls.push("sm-resolved");
    if (resolution.kind === "orphaned" && isOpen) cls.push("sm-orphan");
    if (claimsSuggestion) cls.push("sm-suggestion-card");
    if (resolution.kind === "resolved" && resolution.ambiguous) cls.push("sm-ambiguous");
    const card = container.createDiv({ cls: cls.join(" ") });
    card.dataset.smId = root.id;
    if (root.id === this.focusedId) card.addClass("sm-focused");
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

    if (claimsSuggestion) {
      const heading = card.createDiv({ cls: "sm-suggestion-heading" });
      heading.createSpan({ text: isDeletion ? "Suggested deletion" : "Suggested edit", cls: "sm-suggestion-title" });
      if (suggestion?.result) {
        heading.createSpan({
          text: suggestion.result === "accepted" ? "Accepted" : "Declined",
          cls: `sm-suggestion-result sm-suggestion-${suggestion.result}`,
        });
      }
      const meta = card.createDiv({ cls: "sm-meta" });
      this.paintAuthor(meta.createSpan({ text: String(root.author), cls: "sm-author" }), String(root.author));
      this.addTimestamp(meta, String(root.timestamp));
      const controls = meta.createDiv({ cls: "sm-entry-controls" });
      this.addMenuTrigger(controls, "More options for suggestion", [
        copyItem,
        {
          title: "Delete suggestion",
          icon: "trash-2",
          warning: true,
          run: () =>
            void (async () => {
              if (!(await this.confirmed("Delete suggestion?", "This permanently removes the suggestion and its discussion.", "Delete"))) return;
              await this.plugin.updateComments(file, (doc) => deleteThread(doc, root.id));
            })(),
        },
      ]);
      const change = card.createDiv({ cls: "sm-suggestion-diff" });
      if (suggestion) renderDiff(change, quoteText, suggestion.replacement);
      else change.setText(quoteText);
      if (reveal) {
        change.addClass("sm-quote-link");
        change.onclick = reveal;
      }
      if (!suggestion) card.createDiv({ text: "Invalid suggestion data.", cls: "sm-suggestion-warning" });
      if (isOpen && resolution.kind === "orphaned") {
        card.createDiv({ text: "Original passage not found.", cls: "sm-suggestion-warning" });
      } else if (isOpen && resolution.kind === "resolved" && resolution.fuzzy) {
        card.createDiv({
          text: "The passage has changed since this suggestion was made.",
          cls: "sm-suggestion-warning",
        });
      }
    } else {
      const quote = card.createDiv({ text: `"${truncate(quoteText, 80)}"`, cls: "sm-quote" });
      if (reveal) {
        quote.addClass("sm-quote-link");
        quote.onclick = reveal;
      }
      if (isOpen && resolution.kind === "resolved" && resolution.fuzzy && root.anchored_text !== undefined) {
        card.createDiv({ text: `Now reads: "${truncate(root.anchored_text, 80)}"`, cls: "sm-drift" });
      }
    }

    const entries: Comment[] = [];
    if (!claimsSuggestion || String(root.text ?? "").length > 0) entries.push(root);
    entries.push(...thread.replies);
    for (const entry of entries) {
      this.renderEntry(card, file, thread.root, entry, claimsSuggestion, copyItem);
    }

    const actions = card.createDiv({ cls: "sm-actions" });
    if (claimsSuggestion && isOpen && suggestion && !suggestion.result) {
      const accept = actions.createEl("button", { text: "Accept", cls: "mod-cta" });
      accept.disabled = resolution.kind !== "resolved" || resolution.ambiguous;
      const decline = actions.createEl("button", { text: "Decline" });
      const decide = (result: "accepted" | "declined", button: HTMLButtonElement): void => {
        const wasDisabled = accept.disabled;
        accept.disabled = decline.disabled = true;
        void this.plugin.decideSuggestionIn(file, root.id, result).then((ok) => {
          if (ok) return;
          accept.disabled = wasDisabled;
          decline.disabled = false;
          button.focus();
        });
      };
      accept.onclick = () => decide("accepted", accept);
      decline.onclick = () => decide("declined", decline);
    } else if (!isOpen) {
      const reopen = actions.createEl("button", { text: "Reopen" });
      reopen.onclick = () =>
        void this.plugin.updateComments(file, (doc) => {
          if (claimsSuggestion) reopenSuggestion(doc, root.id);
          else setThreadResolved(doc, root.id, false);
        });
    }
    if (isOpen && (resolution.kind === "orphaned" || resolution.ambiguous || (claimsSuggestion && resolution.fuzzy))) {
      const reanchor = actions.createEl("button", { text: "Re-anchor to selection" });
      reanchor.onclick = () => void this.reanchorFromSelection(file, root.id);
    }
    if (!actions.hasChildNodes()) actions.remove();

    if (isOpen) {
      const reply = card.createEl("textarea", {
        cls: "sm-input",
        attr: { placeholder: `Reply… ${this.submitHint("send")}`, rows: "2", "aria-label": "Reply" },
      });
      reply.onkeydown = (e) => {
        if (e.key === "Escape") {
          reply.value = "";
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
              if (ok) reply.value = "";
            });
        }
      };
    }
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
    const row = card.createDiv({ cls: "sm-entry" });
    const meta = row.createDiv({ cls: "sm-meta" });
    this.paintAuthor(meta.createSpan({ text: author, cls: "sm-author" }), author);
    if (!(isRoot && inSuggestion)) this.addTimestamp(meta, String(entry.timestamp));
    const controls = meta.createDiv({ cls: "sm-entry-controls" });
    if (isRoot && !inSuggestion && !root.resolved) {
      const resolveBtn = controls.createEl("button", {
        cls: "sm-entry-action clickable-icon",
        attr: { "aria-label": "Resolve comment" },
      });
      setIcon(resolveBtn, "check");
      setTooltip(resolveBtn, "Resolve");
      resolveBtn.onclick = () => this.resolveThread(file, root.id);
    }
    const deleteLabel = isRoot ? (inSuggestion ? "Delete explanation" : "Delete comment") : "Delete reply";
    const deleteMessage = isRoot && !inSuggestion
      ? "This permanently removes the comment and all of its replies."
      : "This permanently removes this entry.";
    this.addMenuTrigger(controls, `More options for comment by ${author}`, [
      copyItem,
      {
        title: deleteLabel,
        icon: "trash-2",
        warning: true,
        run: () =>
          void (async () => {
            if (!(await this.confirmed(`${deleteLabel}?`, deleteMessage, "Delete"))) return;
            await this.plugin.updateComments(file, (doc) => {
              if (!isRoot) deleteComment(doc, entry.id);
              else if (inSuggestion) editText(doc, entry.id, text, "");
              else deleteThread(doc, entry.id);
            });
          })(),
      },
    ]);

    const textEl = row.createDiv({
      cls: "sm-text sm-text-editable",
      attr: { tabindex: "0", title: "Double-click to edit", "aria-label": `Comment by ${author}. Double-click or press Enter to edit.` },
    });
    // MRSF says comment text is plain text; rendering it as Markdown anyway is
    // a deliberate deviation so wikilinks and formatting work in Obsidian.
    void MarkdownRenderer.render(this.app, text, textEl, file.path, this);
    this.wireCommentLinks(textEl, file);

    const beginEdit = (): void => {
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

  private addTimestamp(container: HTMLElement, timestamp: string): void {
    const formatted = formatSidebarTimestamp(timestamp, this.plugin.settings.timestampDisplay);
    if (formatted === null) return;
    const element = container.createSpan({ text: formatted, cls: "sm-ts" });
    element.dataset.smTimestamp = timestamp;
    if (this.plugin.settings.timestampDisplay !== "full") setTooltip(element, formatTs(timestamp));
  }

  private refreshTimestamps(): void {
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
