/** The parts of a DOM Selection this module reads (a Selection has them all). */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
}

/** An element that can say whether a node is inside it (an HTMLElement can). */
export interface Container {
  contains(node: Node | null): boolean;
}

/**
 * Whether the user has text selected inside `container`. A click that ends a
 * drag-to-select fires like any other click, and a card treats a click as
 * "select this thread", which scrolls the note to its passage; a card skips
 * that when the click only finished selecting text in it.
 */
export function hasTextSelectedIn(selection: SelectionLike | null, container: Container): boolean {
  if (!selection || selection.isCollapsed) return false;
  return container.contains(selection.anchorNode) || container.contains(selection.focusNode);
}
