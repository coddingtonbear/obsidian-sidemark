import type { ChangeSet } from "@codemirror/state";

/** An anchor's live position in an open editor. */
export interface TrackedAnchor {
  id: string;
  from: number;
  to: number;
}

/**
 * Maps anchor ranges through an editor change. `from` sticks to the character
 * after it and `to` to the character before it, so text typed exactly at an
 * edge doesn't grow into the anchor. Fully deleted ranges are dropped (and
 * later show up as orphaned).
 */
export function mapAnchors(anchors: TrackedAnchor[], changes: ChangeSet): TrackedAnchor[] {
  return anchors
    .map((a) => ({ id: a.id, from: changes.mapPos(a.from, 1), to: changes.mapPos(a.to, -1) }))
    .filter((a) => a.to > a.from);
}

/**
 * Heuristic: a change replacing more than half the old document is probably an
 * external whole-file replacement (e.g. `vault.modify` after a sync), where
 * position mapping can't be trusted and anchors must be resolved from scratch.
 */
export function isFullReplace(changes: ChangeSet): boolean {
  let covered = 0;
  changes.iterChangedRanges((fromA, toA) => {
    covered += toA - fromA;
  });
  return changes.length > 0 && covered / changes.length > 0.5;
}
