import type { EditorView } from "@codemirror/view";
import type { TrackedAnchor } from "./tracking";

/**
 * Live Preview renders tables as widgets that replace the source with a
 * <table>, and CodeMirror doesn't draw mark decorations inside replaced
 * ranges, so highlights would vanish in tables. This module finds the cell an
 * anchor is in and draws the highlight directly into the rendered table.
 * (Adapted from Tandem Comments.)
 */

/** A raw cell: source offsets of the content between two pipes (untrimmed). */
export interface Cell {
  /** 0-based row within the table block (the delimiter row is 1 and has no cells). */
  row: number;
  /** 0-based column. */
  col: number;
  from: number;
  to: number;
}

export interface ParsedTable {
  from: number;
  to: number;
  cells: Cell[];
}

/** A GFM table delimiter row, e.g. `| --- | :--: |`. */
const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

interface Line {
  text: string;
  from: number;
}

function splitLines(text: string, limit: number): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const part of text.slice(0, limit).split("\n")) {
    lines.push({ text: part, from });
    from += part.length + 1; // +1 for the removed "\n"
  }
  return lines;
}

/**
 * Splits a table row into cell content spans (document offsets). Empty edge
 * segments from enclosing pipes are dropped, so columns count from the first
 * real cell.
 */
function splitRow(line: Line): { from: number; to: number }[] {
  const segments: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === "\\") {
      i++; // skip an escaped pipe (\|)
      continue;
    }
    if (line.text[i] === "|") {
      segments.push({ start, end: i });
      start = i + 1;
    }
  }
  segments.push({ start, end: line.text.length });
  // Enclosing pipes produce empty edge segments; drop them.
  if (segments.length > 1 && line.text.slice(segments[0].start, segments[0].end).trim() === "") {
    segments.shift();
  }
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (line.text.slice(last.start, last.end).trim() === "") segments.pop();
  }
  return segments.map((s) => ({ from: line.from + s.start, to: line.from + s.end }));
}

/** Finds every GFM table block in [0, limit). */
export function findTables(text: string, limit: number = text.length): ParsedTable[] {
  const lines = splitLines(text, limit);
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (!delim || !header.text.includes("|") || !DELIMITER.test(delim.text)) continue;
    // GFM requires the header and delimiter to have the same column count,
    // which rules out e.g. a setext heading (`some | text` followed by `---`).
    if (splitRow(header).length !== splitRow(delim).length) continue;

    let end = i; // last line belonging to the block
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].text.trim() === "" || !lines[j].text.includes("|")) break;
      end = j;
    }
    if (end < i + 2) end = i; // header + delimiter without a body is still a table

    const cells: Cell[] = [];
    for (let r = i; r <= end; r++) {
      if (r === i + 1) continue; // the delimiter row has no cells
      const rowIndex = r - i;
      splitRow(lines[r]).forEach((span, col) => cells.push({ row: rowIndex, col, ...span }));
    }
    const last = lines[end];
    tables.push({ from: header.from, to: last.from + last.text.length, cells });
    i = end;
  }
  return tables;
}

/**
 * Whether any changed range touches a table. Obsidian reformats edited tables
 * (column alignment, new rows), which makes position mapping unreliable, so
 * anchors lost in such an edit are recovered by their text instead.
 */
export function rangesTouchTable(
  text: string,
  proseLen: number,
  ranges: { from: number; to: number }[]
): boolean {
  const tables = findTables(text, proseLen);
  return tables.some((t) => ranges.some((r) => r.from <= t.to && r.to >= t.from));
}

/** The cell whose content span contains `pos`, or null (e.g. on the delimiter row). */
export function locateCell(table: ParsedTable, pos: number): Cell | null {
  for (const c of table.cells) {
    if (pos >= c.from && pos < c.to) return c;
  }
  return null;
}

/**
 * The visible text of an inline Markdown span, with syntax stripped so it
 * matches the rendered cell's textContent (e.g. `**Price**` → `Price`). The
 * anchored source text includes syntax, but the table DOM only has rendered
 * text, so that's what gets searched for.
 */
export function visibleText(md: string): string {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[target|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[target]] → target
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [Label](url) / ![alt](url) → Label
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // **bold** / __bold__
    .replace(/(\*|_)(.+?)\1/g, "$2") // *italic* / _italic_
    .replace(/~~(.+?)~~/g, "$1") // ~~strikethrough~~
    .replace(/==(.+?)==/g, "$1") // ==highlight==
    .replace(/`([^`]+)`/g, "$1"); // `code`
}

/** The rendered <table> whose source position falls inside the table block. */
function findDomTable(view: EditorView, table: ParsedTable): HTMLTableElement | null {
  const tables = view.contentDOM.querySelectorAll("table");
  for (const el of Array.from(tables)) {
    let pos: number;
    try {
      pos = view.posAtDOM(el);
    } catch {
      continue;
    }
    if (pos >= table.from && pos <= table.to) return el as HTMLTableElement;
  }
  return null;
}

/** The rendered cell for a source (row, col): row 0 is the header, row ≥ 2 is body row row-2. */
function domCell(domTable: HTMLTableElement, cell: Cell): HTMLTableCellElement | null {
  if (cell.row === 0) {
    const headerRow = domTable.tHead?.rows[0] ?? domTable.rows[0];
    return (headerRow?.cells[cell.col] as HTMLTableCellElement) ?? null;
  }
  const body = domTable.tBodies[0];
  return (body?.rows[cell.row - 2]?.cells[cell.col] as HTMLTableCellElement) ?? null;
}

/** Wraps [start, start+len) of the element's text in <span class="sm-highlight">, across text nodes. */
function wrapRange(
  root: HTMLElement,
  start: number,
  len: number,
  id: string,
  onClick: (id: string) => void
): boolean {
  const doc = root.ownerDocument;
  const end = start + len;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; s: number; e: number }[] = [];
  let pos = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const node = n as Text;
    const nodeLen = node.nodeValue?.length ?? 0;
    const nodeStart = pos;
    const nodeEnd = pos + nodeLen;
    if (nodeEnd > start && nodeStart < end) {
      targets.push({ node, s: Math.max(0, start - nodeStart), e: Math.min(nodeLen, end - nodeStart) });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }
  if (targets.length === 0) return false;
  for (const t of targets) {
    const range = doc.createRange();
    range.setStart(t.node, t.s);
    range.setEnd(t.node, t.e);
    const span = doc.createElement("span");
    span.className = "sm-highlight";
    span.dataset.smId = id;
    span.dataset.smTable = "1";
    // CodeMirror's event handlers don't reach the table widget's DOM, so the
    // listener goes on the span. The event is swallowed so the widget doesn't
    // switch to its editing mode, where the highlight would disappear; click
    // elsewhere in the cell to edit it.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    span.addEventListener("pointerdown", (e) => {
      swallow(e);
      onClick(id);
    });
    span.addEventListener("mousedown", swallow);
    span.addEventListener("click", swallow);
    try {
      range.surroundContents(span);
    } catch {
      return false;
    }
  }
  return true;
}

/** Removes every table highlight this module injected (before re-applying). */
export function clearTableHighlights(view: EditorView): void {
  view.contentDOM.querySelectorAll<HTMLElement>("span.sm-highlight[data-sm-table]").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

/**
 * Draws the highlight of every anchor inside a rendered table directly into
 * the table DOM. Idempotent: previous highlights are cleared first.
 */
export function applyTableHighlights(
  view: EditorView,
  anchors: TrackedAnchor[],
  text: string,
  proseLen: number,
  onClick: (id: string) => void
): void {
  clearTableHighlights(view);
  const tables = findTables(text, proseLen);
  if (tables.length === 0) return;
  for (const a of anchors) {
    // Guard each anchor so one odd case doesn't break the other highlights.
    try {
      const table = tables.find((t) => a.from >= t.from && a.to <= t.to);
      if (!table) continue;
      const cell = locateCell(table, a.from);
      if (!cell) continue;
      const domTable = findDomTable(view, table);
      if (!domTable) continue;
      const cellEl = domCell(domTable, cell);
      if (!cellEl) continue;
      // Source offsets don't match the rendered cell text: inline Markdown
      // syntax is removed when rendered, and syntax before the anchor shifts
      // the offset. So search the rendered text instead of computing.
      const visible = visibleText(text.slice(a.from, a.to));
      if (!visible) continue;
      const k = cellEl.textContent?.indexOf(visible) ?? -1;
      if (k >= 0) wrapRange(cellEl, k, visible.length, a.id, onClick);
    } catch {
      // Ignore; this anchor just isn't highlighted in this pass.
    }
  }
}
