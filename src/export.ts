import type { Resolution } from "./anchoring";
import { type Comment, suggestionOf, type Thread } from "./model";

export function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function entryLine(comment: Comment): string {
  return `**${String(comment.author)}** (${formatTs(String(comment.timestamp))}): ${String(comment.text)}`;
}

/** A thread as Markdown, for copying to the clipboard or exporting. */
export function formatThread(thread: Thread, includeQuote: boolean): string {
  const { root } = thread;
  const suggestion = suggestionOf(root);
  const parts: string[] = [];
  if (includeQuote && root.selected_text) parts.push(quote(root.selected_text));
  if (suggestion) {
    const outcome = suggestion.result ? ` — ${suggestion.result}` : "";
    parts.push(
      `**Suggested edit by ${String(root.author)}** (${formatTs(String(root.timestamp))})${outcome}:\n${quote(suggestion.replacement)}`
    );
  }
  const entries = [...(suggestion && !root.text ? [] : [root]), ...thread.replies].map(entryLine);
  if (entries.length > 0) parts.push(entries.join("\n"));
  return parts.join("\n\n");
}

export interface ResolvedThread {
  thread: Thread;
  resolution: Resolution;
}

/** A standalone note listing a note's threads, or null when there is nothing to export. */
export function buildExportNote(sourceName: string, threads: ResolvedThread[], date: string): string | null {
  const startOf = (t: ResolvedThread) => (t.resolution.kind === "resolved" ? t.resolution.from : 0);
  const open = threads
    .filter((t) => !t.thread.root.resolved && t.resolution.kind === "resolved")
    .sort((a, b) => startOf(a) - startOf(b));
  const orphans = threads.filter((t) => !t.thread.root.resolved && t.resolution.kind === "orphaned");
  const done = threads.filter((t) => t.thread.root.resolved);
  if (!open.length && !orphans.length && !done.length) return null;
  const format = (t: ResolvedThread) => formatThread(t.thread, true);
  const sections = [`Exported from [[${sourceName}]] on [[${date}]].`];
  if (open.length) sections.push("# Open", ...open.map(format));
  if (done.length) sections.push("# Resolved", ...done.map(format));
  if (orphans.length) sections.push("# Orphaned", ...orphans.map(format));
  return sections.join("\n\n") + "\n";
}
