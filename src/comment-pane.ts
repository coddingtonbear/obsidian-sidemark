/**
 * The pane each note's comments were last worked from — where a comment was
 * added, a highlight clicked, or a thread shown from the sidebar — so that with
 * a note open in several panes, the sidebar keeps showing threads in that one
 * pane while writing goes on in another. `P` identifies a pane (the editor).
 */
export class CommentPanes<P> {
  private readonly last = new Map<string, P>();

  remember(notePath: string, pane: P): void {
    this.last.set(notePath, pane);
  }

  /** The note's remembered pane, while it is still one of `open`, the panes showing the note now. */
  paneFor(notePath: string, open: readonly P[]): P | undefined {
    const pane = this.last.get(notePath);
    if (pane === undefined) return undefined;
    if (open.includes(pane)) return pane;
    // Closed, or showing another note: forget it rather than hold on to a pane that's gone.
    this.last.delete(notePath);
    return undefined;
  }

  renamed(from: string, to: string): void {
    const pane = this.last.get(from);
    if (pane === undefined) return;
    this.last.delete(from);
    this.last.set(to, pane);
  }

  forget(notePath: string): void {
    this.last.delete(notePath);
  }
}
