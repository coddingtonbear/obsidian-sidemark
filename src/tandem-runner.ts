import { newCommentId } from "@mrsf/cli/browser";
import { Notice, type TFile } from "obsidian";
import { confirmAction } from "./confirm-action";
import { selectedTextHash } from "./hash";
import type SidemarkPlugin from "./main";
import { convertTandemEntries, mergeTandemComments, parseTandemNote } from "./tandem-migration";

type NoteOutcome = { converted: true; threads: number } | { converted: false; reason: string };

const MARKER = "```tandem-comments";

async function migrateNote(plugin: SidemarkPlugin, file: TFile): Promise<NoteOutcome> {
  const { vault } = plugin.app;
  const raw = await vault.read(file);
  const parsed = parseTandemNote(raw);
  if (parsed.kind === "none") return { converted: false, reason: "its tandem-comments block wasn't recognized" };
  if (parsed.kind === "invalid") return { converted: false, reason: parsed.error };

  const comments = convertTandemEntries(parsed.text, parsed.entries, newCommentId);
  for (const comment of comments) {
    if (comment.reply_to === undefined && comment.selected_text !== undefined) {
      comment.selected_text_hash = await selectedTextHash(comment.selected_text);
    }
  }

  // A previous, unfinished run may already have copied some of these threads.
  let conflicts: string[] = [];
  const saved = await plugin.store.update(file.path, (doc) => {
    const merge = mergeTandemComments(doc.comments, comments);
    conflicts = merge.conflicts;
    doc.comments.push(...merge.added);
  });
  if (!saved.ok) return { converted: false, reason: `its comment file can't be read (${saved.error})` };
  if (conflicts.length > 0) {
    return {
      converted: false,
      reason: `thread(s) ${conflicts.join(", ")} were changed in both formats since the last conversion; the block was kept`,
    };
  }

  // Only strip the block once the sidecar demonstrably holds every thread.
  const verified = await plugin.store.update(file.path, (doc) => new Set(doc.comments.map((c) => c.x_tandem_id)));
  const missing = parsed.entries.filter(([id]) => !(verified.ok && verified.value.has(id)));
  if (missing.length > 0) return { converted: false, reason: "the converted comments couldn't be verified" };

  let stripped = false;
  await vault.process(file, (current) => {
    if (current !== raw) return current;
    stripped = true;
    return parsed.text;
  });
  if (!stripped) {
    return { converted: false, reason: "the note changed during conversion; run the conversion again to finish" };
  }
  return { converted: true, threads: parsed.entries.length };
}

/** Moves every note's Tandem Comments block into a Sidemark sidecar, after confirmation. */
export async function migrateTandemComments(plugin: SidemarkPlugin): Promise<void> {
  const { vault } = plugin.app;
  const candidates: TFile[] = [];
  for (const file of vault.getMarkdownFiles()) {
    if ((await vault.cachedRead(file)).includes(MARKER)) candidates.push(file);
  }
  if (candidates.length === 0) {
    new Notice("No notes contain tandem-comments blocks.");
    return;
  }
  const count = `${candidates.length} note${candidates.length === 1 ? "" : "s"}`;
  const confirmed = await confirmAction(plugin.app, {
    title: "Convert Tandem Comments?",
    message:
      `${count} ${candidates.length === 1 ? "contains" : "contain"} Tandem Comments. Their comments and suggestions will be moved into ` +
      "Sidemark comment files (Note.md.review.yaml) and the tandem-comments blocks removed from the notes. " +
      "Consider backing up your vault first.",
    confirmLabel: `Convert ${count}`,
  });
  if (!confirmed) return;

  const progress = new Notice(`Converting ${count}…`, 0);
  let converted = 0;
  let threads = 0;
  const failures: string[] = [];
  for (const file of candidates) {
    try {
      const outcome = await migrateNote(plugin, file);
      if (outcome.converted) {
        converted++;
        threads += outcome.threads;
      } else {
        failures.push(`${file.path}: ${outcome.reason}`);
      }
    } catch (e) {
      failures.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  progress.hide();
  const summary = `Converted ${threads} thread${threads === 1 ? "" : "s"} in ${converted} note${converted === 1 ? "" : "s"}.`;
  if (failures.length === 0) {
    new Notice(summary);
    return;
  }
  console.warn("Sidemark: some notes weren't converted", failures);
  new Notice(`${summary}\n${failures.length} not converted:\n${failures.slice(0, 5).join("\n")}`, 15000);
}
