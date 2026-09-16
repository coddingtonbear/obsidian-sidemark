export type DiffKind = "same" | "del" | "ins";

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/** Above this many token pairs the comparison gives up and reports a whole replacement. */
const MAX_CELLS = 4_000_000;

/** Words, runs of whitespace, and single punctuation marks. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function push(parts: DiffPart[], kind: DiffKind, text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/**
 * Word-level differences between `before` and `after`, in order. Deletions
 * come before insertions at the same spot. Concatenating the "same" and "del"
 * parts gives `before`; the "same" and "ins" parts give `after`.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const raw: DiffPart[] = [];
  push(raw, "same", a.slice(0, start).join(""));
  if (midA.length * midB.length > MAX_CELLS) {
    push(raw, "del", midA.join(""));
    push(raw, "ins", midB.join(""));
  } else {
    // Longest common subsequence over the differing middle.
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    let del = "";
    let ins = "";
    const flush = (): void => {
      push(raw, "del", del);
      push(raw, "ins", ins);
      del = "";
      ins = "";
    };
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        flush();
        push(raw, "same", midA[i]);
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[i + 1][j] >= lcs[i][j + 1])) {
        del += midA[i++];
      } else {
        ins += midB[j++];
      }
    }
    flush();
  }
  push(raw, "same", a.slice(endA).join(""));
  return mergeShortSame(raw);
}

/**
 * Folds a whitespace-only unchanged part that sits between two changes into
 * them, so "a b" → "x y" reads as one replacement rather than two.
 */
function mergeShortSame(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    const prev = out[out.length - 1];
    const next = parts[k + 1];
    if (part.kind === "same" && /^\s+$/.test(part.text) && prev && prev.kind !== "same" && next && next.kind !== "same") {
      // Re-open the previous change group and absorb the whitespace into both sides.
      const group: DiffPart[] = [];
      while (out.length && out[out.length - 1].kind !== "same") group.unshift(out.pop() as DiffPart);
      let del = group.filter((g) => g.kind === "del").map((g) => g.text).join("") + part.text;
      let ins = group.filter((g) => g.kind === "ins").map((g) => g.text).join("") + part.text;
      k++;
      while (k < parts.length && parts[k].kind !== "same") {
        if (parts[k].kind === "del") del += parts[k].text;
        else ins += parts[k].text;
        k++;
      }
      k--;
      push(out, "del", del);
      push(out, "ins", ins);
      continue;
    }
    push(out, part.kind, part.text);
  }
  return out;
}
