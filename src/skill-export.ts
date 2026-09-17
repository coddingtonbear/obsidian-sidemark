import { Platform } from "obsidian";

/**
 * The bundled `sidemark-comments` Claude Code skill.
 *
 * `SKILL_MARKDOWN` is a verbatim copy of `sidemark-comments/SKILL.md` from
 * https://github.com/coddingtonbear/skills, where the skill lives. Shipping a copy
 * inside the plugin is what lets a desktop user install it from the settings panel
 * without cloning that repository; the copy is made by hand, so it has to be
 * refreshed here whenever the skill changes there.
 */
export const SKILL_MARKDOWN = `---
name: sidemark-comments
description: >-
  Read, add, reply to, resolve, and act on comments and edit suggestions stored
  in Sidemark / MRSF sidecar files — a \`<note>.md.review.yaml\` file next to a
  Markdown note, as written by the Sidemark Obsidian plugin, the Sidemark VS
  Code extension, and the \`mrsf\` CLI. Use whenever a note has a
  \`.review.yaml\` sidecar, when a user asks to comment on, annotate, review, or
  suggest edits to a note that uses Sidemark, or when a user asks to reply to,
  resolve, accept, or decline a Sidemark comment or suggestion.
---

# Sidemark comments: MRSF review sidecars

Sidemark keeps a note's comments **out of the note**. They live in a sidecar
file beside it: \`Projects/Plan.md\` has its comments in
\`Projects/Plan.md.review.yaml\` (the full note filename plus \`.review.yaml\`).
The format is [MRSF v1.0](https://github.com/wictorwilen/MRSF) with a few
Sidemark extension fields. **Commenting never touches the note.** The only
time the note changes is when a suggestion is accepted.

Sidemark watches both files, so anything written to the sidecar shows up in
Obsidian's editor and sidebar immediately.

## Telling that a note uses Sidemark

- **A \`<note>.md.review.yaml\` file beside the note** is the direct signal: the
  note has Sidemark comments, and this skill applies.
- **No sidecar on the note, but the vault uses Sidemark** — other
  \`.review.yaml\` files exist in it, or it has a
  \`.obsidian/plugins/sidemark/\` directory — means Sidemark is the vault's
  convention. Comment by creating the note's first sidecar (see Writing to
  the sidecar).
- **Neither** means nothing says this vault keeps comments in sidecars. Ask
  before writing one into it, in case the user's comments live somewhere
  else.

## The file

\`\`\`yaml
mrsf_version: "1.0"
document: Projects/Plan.md
comments:
  - id: 0818f29c-400a-4124-8420-185d6fdc18fa
    author: Adam
    timestamp: 2026-09-16T08:53:51.151Z
    text: Is this too cliché? See [[Style guide]]
    resolved: false
    line: 7
    end_line: 7
    start_column: 4
    end_column: 15
    selected_text: quick brown
    selected_text_hash: <sha-256 hex of selected_text>
    x_prefix: "The "
    x_suffix: " fox jumps over the "
  - id: 27f0f28c-0559-4c46-8951-5d2359b8bb6c
    author: Claude
    timestamp: 2026-09-16T08:54:12.000Z
    text: Agreed, rewording.
    resolved: false
    reply_to: 0818f29c-400a-4124-8420-185d6fdc18fa
\`\`\`

Top level: \`mrsf_version\` (\`"1.0"\`, quoted), \`document\` (the note's path
relative to the vault root), \`comments\` (a flat list; threads are formed by
\`reply_to\`).

### Fields on each comment

| Field | Meaning |
| --- | --- |
| \`id\` | Required. Unique and opaque. Sidemark writes a random UUID; do the same. |
| \`author\` | Required. Display name. MRSF recommends \`Display Name (identifier)\`; in practice match what's already in the vault (see Authoring). |
| \`timestamp\` | Required. ISO 8601 with a timezone, e.g. \`2026-09-17T16:40:00.000Z\`. Take it from \`date\`, never from memory. |
| \`text\` | Required. The comment. Sidemark renders it as Markdown, so \`[[wikilinks]]\` work. Empty on a suggestion that has no explanation. |
| \`resolved\` | Required boolean. |
| \`reply_to\` | On a reply: the \`id\` of the comment it answers. Replies carry no position fields. |
| \`line\`, \`end_line\` | 1-based line numbers, \`end_line\` inclusive. Counted over the raw file, **including frontmatter**. |
| \`start_column\`, \`end_column\` | 0-based offsets within \`line\` and \`end_line\`. \`end_column\` is exclusive: \`"The quick brown"\` → \`quick brown\` is \`start_column: 4\`, \`end_column: 15\`. Counted in UTF-16 code units (JavaScript string indices), so an emoji counts as 2. |
| \`selected_text\` | The exact text the reviewer selected. **Never change it** after creation; it's the original quote, used to find the passage again. |
| \`selected_text_hash\` | Lowercase hex SHA-256 of \`selected_text\`. Sidemark writes it on new comments. |
| \`anchored_text\` | What the passage reads *now*, when it no longer matches \`selected_text\` (the text was edited). Written by Sidemark and \`mrsf reanchor\`; leave it alone. |
| \`type\`, \`severity\` | Optional MRSF categories. \`type: suggestion\` marks an edit suggestion. |
| \`commit\` | Optional git SHA stamped by the \`mrsf\` CLI. Harmless; leave it. |

### Sidemark's extension fields

| Field | Meaning |
| --- | --- |
| \`x_prefix\` / \`x_suffix\` | Up to 20 characters immediately before and after the quote (fewer at the start or end of the file; they may cross line breaks). They tell identical quotes apart, like a W3C TextQuoteSelector's \`prefix\`/\`suffix\`. |
| \`x_suggestion\` | \`{ replacement, result? }\` on a root comment with \`type: suggestion\`. \`replacement\` is the proposed text; an **empty \`replacement\` proposes deleting** the passage. \`result\` is \`accepted\` or \`declined\` once decided. The root's \`text\` is the optional explanation. |
| \`x_reanchor_status\`, \`x_reanchor_score\` | Written by \`mrsf reanchor\`. Leave them. |

Keep every field you don't recognize. Other MRSF tools write their own
\`x_*\` fields.

### Sidemark's conventions

- **A thread** is a root (no \`reply_to\`) plus every comment whose \`reply_to\`
  chain leads back to it. The sidebar shows replies oldest first.
- **Resolving a thread resolves its replies too**: set \`resolved: true\` on the
  root and on every reply. Reopening sets them all back to \`false\`.
- **A suggestion with a \`result\` counts as resolved**, even if \`resolved\` is
  still false.
- **A root with neither \`line\` nor \`selected_text\` shows as orphaned** in
  Sidemark. MRSF allows document-level comments, but Sidemark has nowhere to
  put them, so always anchor a root comment to a passage.
- **Deleting a thread's root deletes the whole thread.** Deleting a reply
  re-attaches its own replies to its parent (MRSF §9.1).

## Reading comments

1. Read the note and its sidecar.
2. Build the threads from \`reply_to\`.
3. Find each root's passage: look for \`selected_text\` in the note; when it
   occurs more than once, pick the occurrence whose surrounding text matches
   \`x_prefix\`/\`x_suffix\`, then the one at \`line\`/\`start_column\`. If
   \`anchored_text\` is present, the passage was edited since the comment and
   now reads \`anchored_text\`. If neither is found, the comment is orphaned;
   say so rather than guessing at a location.
4. Skip resolved threads unless asked about them.

When summarizing for the user, quote the passage, then the thread.

## Writing to the sidecar

**Edit the YAML in place.** Sidemark and the \`mrsf\` tools both preserve
formatting and YAML comments in the parts of a sidecar they don't change, and
a hand-edited sidecar should get the same care: add or change only the
entries involved, and leave everything else byte for byte.

- **Never write a sidecar you couldn't parse.** If the file isn't valid YAML
  or isn't shaped like the example above, stop and tell the user what's
  wrong. Sidemark itself refuses to overwrite such a file.
- **Creating a sidecar**: when the note has none, create it with
  \`mrsf_version: "1.0"\`, \`document: <note path from the vault root>\`, and the
  new comment in \`comments\`.
- **Quote strings YAML would misread**: text starting with a special
  character, containing \`: \` or \` #\`, or that looks like a number, boolean,
  or date. When in doubt, double-quote it.
- **In an Obsidian vault, go through the vault tools** you'd use for any other
  vault file (for example the Obsidian MCP server's read and write tools),
  unless you've been told the vault may be written to directly on disk.
- **The \`mrsf\` CLI** (\`npx @mrsf/cli\`) is the other route when the vault is
  on local disk. Run it **from the vault root** so \`document\` paths match:

  \`\`\`sh
  npx @mrsf/cli list --json --open "Projects/Plan.md"
  npx @mrsf/cli add "Projects/Plan.md" -a "Claude" -t "Consider a table here" \\
    -l 12 --start-column 4 --end-column 21 --selected-text "the three options"
  npx @mrsf/cli add "Projects/Plan.md" -a "Claude" -t "Done." --reply-to <id>
  npx @mrsf/cli resolve --cascade "Projects/Plan.md.review.yaml" <id>
  npx @mrsf/cli validate "Projects/Plan.md.review.yaml"
  \`\`\`

  Its gaps, as of \`@mrsf/cli\` 0.7.1:

  - **Always pass \`--selected-text\`.** Without it, \`add\` fills
    \`selected_text\` from the line *above* the one given (an off-by-one in
    \`populateSelectedText\`), and on line 1 it fills nothing. Passing it
    skips \`selected_text_hash\`; that field is optional, so add it by hand
    only if you want parity with Sidemark.
  - It doesn't write \`x_prefix\`/\`x_suffix\`. Add them by hand after \`add\`
    when the quote isn't unique in the note.
  - A sidecar it *creates* gets \`document: Plan.md\` (the bare filename).
    Change it to the vault-relative path. Sidemark also corrects it the next
    time it saves that sidecar.
  - \`resolve --cascade\` reaches only *direct* replies, and \`resolve --undo\`
    reopens only the one comment. Set \`resolved\` on the rest of the thread
    by hand.
  - It has no notion of \`x_suggestion\`. Write suggestions by hand, or with
    \`--type suggestion --ext 'x_suggestion={"replacement":"…"}'\`.

## Authoring

- **Author name**: use the name the user asks for. Otherwise use \`Claude\`,
  unless the vault's sidecars already show a convention for AI authors;
  follow that.
- **New comment** on a passage: compute \`line\`, \`end_line\`, \`start_column\`,
  \`end_column\` from the note's raw text (frontmatter included), set
  \`selected_text\` to the exact passage, \`selected_text_hash\` to its SHA-256,
  and \`x_prefix\`/\`x_suffix\` to up to 20 characters around it. Add
  \`id\`, \`author\`, \`timestamp\`, \`text\`, \`resolved: false\`. Double-check the
  columns by slicing: the note's text at that range must equal
  \`selected_text\` exactly.
- **Reply**: \`id\`, \`author\`, \`timestamp\`, \`text\`, \`resolved: false\`,
  \`reply_to: <id of the comment answered>\`. No position fields. Append it to
  the end of \`comments\`.
- **Suggestion**: a new root comment, anchored as above, with
  \`type: suggestion\`, \`x_suggestion: { replacement: <proposed text> }\`, and
  the reason in \`text\` (or \`text: ""\`). Use \`replacement: ""\` to propose a
  deletion. **Don't edit the note** when suggesting.
- Keep comments short and specific. One concern per thread.

## Acting on comments

- **Resolve** only when asked (or when the user's instructions say to resolve
  what you've addressed): set \`resolved: true\` on the root and all its
  replies. Don't delete resolved threads; Sidemark keeps them as history and
  has its own command to remove them. Only delete a thread when the user
  asks.
- **Reopen**: set \`resolved: false\` on the root and its replies; on a
  suggestion, also remove \`x_suggestion.result\`.
- **Accept a suggestion** only when the user asks:
  1. Find the passage (as in Reading comments). Refuse if it's orphaned or
     ambiguous, or if the note's text there no longer equals the text the
     suggestion was made against (\`anchored_text\` if present, otherwise
     \`selected_text\`); tell the user instead.
  2. Replace exactly that range in the note with \`x_suggestion.replacement\`.
  3. In the sidecar, set \`x_suggestion.result: accepted\` and
     \`resolved: true\` on the root and its replies. If the user's Sidemark
     setting is to remove resolved threads (\`resolveBehavior: remove\` in the
     vault's \`.obsidian/plugins/sidemark/data.json\`), delete the thread
     instead.
  4. Other open comments whose passages moved are re-anchored by Sidemark the
     next time the note is open; you don't need to recompute their positions.
     If Obsidian isn't running, \`npx @mrsf/cli reanchor "<note>"\` does the
     same.
- **Decline a suggestion**: leave the note alone; set
  \`x_suggestion.result: declined\` and resolve the thread (or delete it, under
  \`resolveBehavior: remove\`).
- **Addressing a comment by editing the note** (the user asked you to act on
  the feedback): make the edit, reply in the thread saying what changed, and
  resolve it only if asked to.
`;

/** Directory the skill is installed into, relative to the user's home directory. */
export const SKILL_DIRECTORY_SEGMENTS = [".claude", "skills", "sidemark-comments"];

/** Filename Claude Code expects a skill's instructions in. */
export const SKILL_FILE_NAME = "SKILL.md";

/** The slice of `node:fs` the export needs, typed here so no Node types are pulled in. */
export interface NodeFsLike {
  mkdirSync(directory: string, options: { recursive: boolean }): void;
  writeFileSync(file: string, data: string, encoding: string): void;
}

/** The slice of `node:os` the export needs. */
export interface NodeOsLike {
  homedir(): string;
}

/** The slice of `node:path` the export needs. */
export interface NodePathLike {
  join(...parts: string[]): string;
}

/** The Node modules the export writes through — injected so the write stays testable. */
export interface SkillExportHost {
  fs: NodeFsLike;
  os: NodeOsLike;
  path: NodePathLike;
}

export const DESKTOP_ONLY_MESSAGE = "Skill export is only available in the desktop app.";

// `require` is provided by Obsidian's desktop (Electron) runtime and absent on mobile.
declare const require: ((module: string) => unknown) | undefined;

/**
 * Resolves the Node modules the export needs, or throws on a runtime that has none
 * (mobile). Kept apart from the write so tests never touch the real filesystem.
 */
export function resolveDesktopHost(): SkillExportHost {
  if (!Platform.isDesktop || !Platform.isDesktopApp || typeof require !== "function") {
    throw new Error(DESKTOP_ONLY_MESSAGE);
  }
  return {
    fs: require("fs") as NodeFsLike,
    os: require("os") as NodeOsLike,
    path: require("path") as NodePathLike,
  };
}

/** Writes the bundled skill into the user's home directory and returns the path written. */
export function writeSkillFile(host: SkillExportHost): string {
  const directory = host.path.join(host.os.homedir(), ...SKILL_DIRECTORY_SEGMENTS);
  host.fs.mkdirSync(directory, { recursive: true });
  const file = host.path.join(directory, SKILL_FILE_NAME);
  host.fs.writeFileSync(file, SKILL_MARKDOWN, "utf8");
  return file;
}

/**
 * Writes the skill to `~/.claude/skills/sidemark-comments/SKILL.md` (desktop only).
 * Returns the path written; throws when the runtime can't write outside the vault.
 */
export function exportSkill(): string {
  return writeSkillFile(resolveDesktopHost());
}
