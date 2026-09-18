import type { ResolvedThread } from "./export";
import type { SidebarSortOrder } from "./settings-model";

/** Where a thread's passage starts; threads without one sort after every anchored thread. */
export function threadStart(item: ResolvedThread): number {
  return item.resolution.kind === "resolved" ? item.resolution.from : Number.MAX_SAFE_INTEGER;
}

/**
 * The index in `open` (the open threads, already sorted by `order`) at which a
 * new comment's draft card goes: where the comment will show once it's saved.
 * In document order that's after every thread starting at or above its passage;
 * a new comment is the newest thread, so it goes first when sorted newest first
 * and last when sorted oldest first.
 */
export function draftSlot(order: SidebarSortOrder, draftFrom: number, open: readonly ResolvedThread[]): number {
  if (order === "newest") return 0;
  if (order === "oldest") return open.length;
  const index = open.findIndex((item) => threadStart(item) > draftFrom);
  return index === -1 ? open.length : index;
}
