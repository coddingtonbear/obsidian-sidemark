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

/**
 * The pane to reveal a thread in, among `open`, the panes showing the note:
 * the first of `preferred` that is open and follows selected comments, failing
 * that the first open pane that does. Panes that opted out are passed over
 * unless none of the note's panes follow, in which case all of them are
 * candidates again — a thread is never left with nowhere to be revealed.
 */
export function revealPane<P>(
  open: readonly P[],
  follows: (pane: P) => boolean,
  preferred: readonly (P | undefined)[]
): P | undefined {
  const following = open.filter(follows);
  const candidates = following.length > 0 ? following : open;
  for (const pane of preferred) {
    if (pane !== undefined && candidates.includes(pane)) return pane;
  }
  return candidates[0];
}

/**
 * The pane to take a selection from, among `open`, the panes showing the note:
 * the first of `preferred` that is open with text selected, failing that the
 * first open pane with text selected. Editors keep their selection when they
 * lose focus, so several panes can have one; `preferred` decides between them.
 */
export function selectionPane<P>(
  open: readonly P[],
  hasSelection: (pane: P) => boolean,
  preferred: readonly (P | undefined)[]
): P | undefined {
  for (const pane of preferred) {
    if (pane !== undefined && open.includes(pane) && hasSelection(pane)) return pane;
  }
  return open.find(hasSelection);
}
