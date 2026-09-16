/**
 * MRSF positions: 1-based lines, 0-based columns (UTF-16 code units, which is
 * what JavaScript string indices and CodeMirror offsets use), counted over the
 * raw file text including any frontmatter.
 */
export interface LineColumnRange {
  line: number;
  end_line: number;
  start_column: number;
  end_column: number;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineColumnAt(starts: number[], offset: number): { line: number; column: number } {
  // Binary search for the last line start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] };
}

export function rangeToLineColumns(text: string, from: number, to: number): LineColumnRange {
  const starts = lineStarts(text);
  const start = lineColumnAt(starts, from);
  const end = lineColumnAt(starts, to);
  return { line: start.line, end_line: end.line, start_column: start.column, end_column: end.column };
}

export function lineColumnToOffset(text: string, line: number, column: number): number {
  const starts = lineStarts(text);
  const index = Math.min(Math.max(line, 1), starts.length) - 1;
  const lineEnd = index + 1 < starts.length ? starts[index + 1] - 1 : text.length;
  return Math.min(starts[index] + Math.max(column, 0), lineEnd);
}
