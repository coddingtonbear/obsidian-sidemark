import { anchorFieldsFor, type Resolution } from "./anchoring";
import type { ResolvedThread } from "./export";
import { selectedTextHash } from "./hash";
import { buildThreads, type Comment, isResolved, isSuggestionComment, type MrsfDocument, type SuggestionResult, type Thread } from "./model";
import {
  addComment,
  addReply,
  addSuggestion,
  deleteComment,
  deleteThread,
  descendantIds,
  editText,
  findComment,
  finishSuggestion,
  type NewEntry,
  openSuggestion,
  type ResolveBehavior,
  setThreadResolved,
  type SuggestionFailure,
} from "./mutations";
import { rangeToLineColumns } from "./positions";
import type { SidecarState, UpdateResult } from "./store";
import { suggestionEdit } from "./suggestion-edit";

/**
 * The comments sub-resource Sidemark adds to Local REST API
 * (`/vault/<note>/comments/…` and `/active/comments/…`). Everything here works
 * on note paths and plain values so it can be tested without Obsidian or
 * Express; rest-api.ts connects it to the host's router.
 */

/** What the comments API needs from the plugin. */
export interface CommentsBackend {
  load(notePath: string): Promise<SidecarState>;
  update<T>(notePath: string, mutate: (doc: MrsfDocument) => T): Promise<UpdateResult<T>>;
  /** The note's current text, as the editor has it when the note is open. */
  noteText(notePath: string): Promise<string>;
  /** Every thread of the note with where its passage currently is. */
  resolveThreads(notePath: string): Promise<ResolvedThread[]>;
  /** A new comment's id, author, and timestamp; `author` overrides the plugin's author name. */
  newEntry(text: string, author?: string): NewEntry;
  /**
   * Replaces `[from, to)` of the note's text (as `noteText` reads it) with
   * `insert`, if that range still reads `expected`; through the editor when the
   * note is open, so the edit can be undone there. False when it doesn't match.
   */
  replacePassage(notePath: string, from: number, to: number, expected: string, insert: string): Promise<boolean>;
  /** Whether a decided suggestion is kept as a resolved thread or removed. */
  resolveBehavior(): ResolveBehavior;
}

export interface ApiResult {
  status: number;
  /** Sent as JSON; absent for 204. */
  body?: unknown;
}

/** Local REST API's error shape: a five-digit code (HTTP status and a suffix) and a message. */
export interface ApiError {
  errorCode: number;
  message: string;
}

export type AnchorJson =
  | {
      status: "anchored";
      from: number;
      to: number;
      line: number;
      end_line: number;
      start_column: number;
      end_column: number;
      /** The passage as it is now, which may differ from the comment's `selected_text`. */
      text: string;
      ambiguous: boolean;
      fuzzy: boolean;
    }
  | { status: "orphaned" };

export interface ThreadJson {
  id: string;
  resolved: boolean;
  anchor: AnchorJson;
  root: Comment;
  /** Every reply in the thread, nested ones included, oldest first. */
  replies: Comment[];
}

export const ErrorCodes = {
  invalidBody: 40001,
  invalidQuery: 40002,
  unknownComment: 40401,
  notANote: 40402,
  unreadableSidecar: 40901,
  ambiguousQuote: 40902,
  textConflict: 40903,
  suggestionDecided: 40904,
  passageOrphaned: 40905,
  passageAmbiguous: 40906,
  passageChanged: 40907,
  quoteNotFound: 42201,
  suggestionResolve: 42202,
  notASuggestion: 42203,
  invalidSuggestion: 42204,
} as const;

function error(errorCode: number, message: string, extra: Record<string, unknown> = {}): ApiResult {
  const body: ApiError & Record<string, unknown> = { errorCode, message, ...extra };
  return { status: Math.floor(errorCode / 100), body };
}

const unreadable = (detail: string) =>
  error(ErrorCodes.unreadableSidecar, `The note's comment file can't be read, so it can't be used: ${detail}`);
const unknown = (id: string) => error(ErrorCodes.unknownComment, `The note has no comment with the id "${id}".`);

/**
 * The rest of Sidemark only treats `.md` files as notes (see sidecar-path.ts),
 * so a comment file for anything else would never show up in the sidebar.
 */
function notANote(notePath: string): ApiResult | null {
  if (notePath.endsWith(".md")) return null;
  return error(ErrorCodes.notANote, `Only Markdown notes have comments; "${notePath}" isn't one.`);
}

function anchorJson(text: string, resolution: Resolution): AnchorJson {
  if (resolution.kind === "orphaned") return { status: "orphaned" };
  const { from, to, ambiguous, fuzzy } = resolution;
  return { status: "anchored", from, to, ...rangeToLineColumns(text, from, to), text: text.slice(from, to), ambiguous, fuzzy };
}

function threadJson(text: string, { thread, resolution }: ResolvedThread): ThreadJson {
  return {
    id: thread.root.id,
    resolved: isResolved(thread.root),
    anchor: anchorJson(text, resolution),
    root: thread.root,
    replies: thread.replies,
  };
}

/** The thread a comment belongs to, as the sidebar groups them. */
function threadOf(doc: MrsfDocument, id: string): Thread | undefined {
  return buildThreads(doc).find((t) => t.root.id === id || t.replies.some((r) => r.id === id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Invalid = { ok: false; result: ApiResult };
type Fields<T> = { ok: true; value: T } | Invalid;

const badBody = (message: string): Invalid => ({ ok: false, result: error(ErrorCodes.invalidBody, message) });

/** A JSON object body, as parsed by the host for `Content-Type: application/json`. */
function objectBody(body: unknown): Fields<Record<string, unknown>> {
  if (!isRecord(body)) return badBody("The request body must be a JSON object sent with Content-Type: application/json.");
  return { ok: true, value: body };
}

function optionalString(body: Record<string, unknown>, key: string): Fields<string | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return badBody(`"${key}" must be a string.`);
  return { ok: true, value };
}

function requiredText(body: Record<string, unknown>, key: string): Fields<string> {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") return badBody(`"${key}" is required and must be a non-empty string.`);
  return { ok: true, value };
}

/** A suggestion's explanation: optional, as in the sidebar, and stored trimmed. */
function explanation(body: Record<string, unknown>): Fields<string> {
  const value = optionalString(body, "text");
  return value.ok ? { ok: true, value: (value.value ?? "").trim() } : value;
}

function optionalAuthor(body: Record<string, unknown>): Fields<string | undefined> {
  const value = body.author;
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") return badBody('"author" must be a non-empty string.');
  return { ok: true, value: value.trim() };
}

export interface DecisionJson {
  result: SuggestionResult;
  /** The suggestion's first comment as recorded now; null when its thread was removed. */
  comment: Comment | null;
}

function decided(result: SuggestionResult, comment: Comment | null): ApiResult {
  const body: DecisionJson = { result, comment };
  return { status: 200, body };
}

/** Why a suggestion can't be accepted or declined, as a refusal. */
function undecidable(id: string, reason: SuggestionFailure | "orphaned" | "ambiguous" | "changed"): ApiResult {
  switch (reason) {
    case "missing":
      return unknown(id);
    case "not-suggestion":
      return error(ErrorCodes.notASuggestion, `The comment "${id}" isn't a suggested edit's first comment.`);
    case "invalid-suggestion":
      return error(ErrorCodes.invalidSuggestion, "The suggestion's data is invalid; its replacement must be text.");
    case "already-resolved":
      return error(ErrorCodes.suggestionDecided, "The suggestion has already been accepted, declined, or resolved.");
    case "orphaned":
      return error(ErrorCodes.passageOrphaned, "The suggested passage can no longer be found in the note.");
    case "ambiguous":
      return error(ErrorCodes.passageAmbiguous, "The suggested passage appears more than once in the note, so which one to change isn't clear.");
    case "changed":
      return error(ErrorCodes.passageChanged, "The suggested passage has changed since the suggestion was made.");
  }
}

/** Every offset where `quote` starts in `text`, overlapping matches included. */
export function quoteOffsets(text: string, quote: string): number[] {
  const offsets: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) offsets.push(i);
  return offsets;
}

export class CommentsApi {
  constructor(private readonly backend: CommentsBackend) {}

  /** `GET /` — the note's threads; `?resolved=true|false` filters them. */
  async list(notePath: string, query: Record<string, unknown>): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const filter = query.resolved;
    if (filter !== undefined && filter !== "true" && filter !== "false") {
      return error(ErrorCodes.invalidQuery, '"resolved" must be "true" or "false".');
    }
    const state = await this.backend.load(notePath);
    if (state.error) return unreadable(state.error);
    const text = await this.backend.noteText(notePath);
    const threads = (await this.backend.resolveThreads(notePath))
      .map((t) => threadJson(text, t))
      .filter((t) => filter === undefined || t.resolved === (filter === "true"));
    return { status: 200, body: { threads } };
  }

  /** `GET /<id>` — one comment and the whole thread it belongs to. */
  async get(notePath: string, id: string): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const state = await this.backend.load(notePath);
    if (state.error) return unreadable(state.error);
    const comment = findComment(state.doc, id);
    if (!comment) return unknown(id);
    const text = await this.backend.noteText(notePath);
    const resolved = (await this.backend.resolveThreads(notePath)).find(
      (t) => t.thread.root.id === id || t.thread.replies.some((r) => r.id === id)
    );
    if (!resolved) return unknown(id);
    return { status: 200, body: { comment, thread: threadJson(text, resolved) } };
  }

  /**
   * `POST /` — a new comment on the `occurrence`-th (1-based) match of `quote`.
   * A quote found more than once needs an `occurrence`. With `replacement`, the
   * comment is a suggested edit, and `text` is its optional explanation.
   */
  async create(notePath: string, rawBody: unknown): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const body = objectBody(rawBody);
    if (!body.ok) return body.result;
    // Sidecar fields a caller might copy from a listed suggestion; dropping them would quietly make a plain comment.
    for (const key of ["type", "x_suggestion"]) {
      if (key in body.value) return badBody(`"${key}" can't be set; send "replacement" to suggest an edit.`).result;
    }
    const replacement = optionalString(body.value, "replacement");
    if (!replacement.ok) return replacement.result;
    const text = replacement.value === undefined ? requiredText(body.value, "text") : explanation(body.value);
    if (!text.ok) return text.result;
    const quote = body.value.quote;
    if (typeof quote !== "string" || quote === "") return badBody('"quote" is required and must be a non-empty string.').result;
    if (replacement.value === quote) return badBody('"replacement" is identical to the quote, so it suggests no change.').result;
    const occurrence = body.value.occurrence;
    if (occurrence !== undefined && (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1)) {
      return badBody('"occurrence" must be a whole number of 1 or more.').result;
    }
    const author = optionalAuthor(body.value);
    if (!author.ok) return author.result;

    const note = await this.backend.noteText(notePath);
    const offsets = quoteOffsets(note, quote);
    if (offsets.length === 0) return error(ErrorCodes.quoteNotFound, "The quote doesn't appear in the note.");
    if (occurrence === undefined && offsets.length > 1) {
      return error(
        ErrorCodes.ambiguousQuote,
        `The quote appears ${offsets.length} times in the note; say which one with "occurrence".`,
        { matches: offsets.length }
      );
    }
    const index = (occurrence ?? 1) - 1;
    if (index >= offsets.length) {
      return error(ErrorCodes.quoteNotFound, `The quote appears only ${offsets.length} time(s) in the note.`, {
        matches: offsets.length,
      });
    }
    const from = offsets[index];
    const to = from + quote.length;
    const fields = anchorFieldsFor(note, from, to);
    const anchor = { ...fields, selected_text_hash: await selectedTextHash(fields.selected_text) };
    const entry = this.backend.newEntry(text.value, author.value);
    const proposed = replacement.value;
    const saved = await this.backend.update(notePath, (doc) =>
      proposed === undefined ? addComment(doc, entry, anchor) : addSuggestion(doc, entry, anchor, proposed)
    );
    if (!saved.ok) return unreadable(saved.error);
    const thread: ThreadJson = {
      id: saved.value.id,
      resolved: false,
      anchor: anchorJson(note, { kind: "resolved", from, to, ambiguous: false, fuzzy: false }),
      root: saved.value,
      replies: [],
    };
    return { status: 201, body: thread };
  }

  /** `POST /<id>/replies` — a reply to the comment `id`. */
  async reply(notePath: string, id: string, rawBody: unknown): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const body = objectBody(rawBody);
    if (!body.ok) return body.result;
    const text = requiredText(body.value, "text");
    if (!text.ok) return text.result;
    const author = optionalAuthor(body.value);
    if (!author.ok) return author.result;
    const entry = this.backend.newEntry(text.value, author.value);
    const saved = await this.backend.update(notePath, (doc) => (findComment(doc, id) ? addReply(doc, id, entry) : null));
    if (!saved.ok) return unreadable(saved.error);
    if (!saved.value) return unknown(id);
    return { status: 201, body: { comment: saved.value } };
  }

  /**
   * `PATCH /<id>` — `{text, expected_text?}` edits the comment, refusing with 409
   * when `expected_text` no longer matches; `{resolved}` resolves or reopens its
   * whole thread. Suggestions are resolved by accepting or declining them, so
   * `resolved` is refused on a suggestion's thread.
   */
  async patch(notePath: string, id: string, rawBody: unknown): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const body = objectBody(rawBody);
    if (!body.ok) return body.result;
    const text = body.value.text === undefined ? { ok: true as const, value: undefined } : requiredText(body.value, "text");
    if (!text.ok) return text.result;
    const expected = optionalString(body.value, "expected_text");
    if (!expected.ok) return expected.result;
    const resolved = body.value.resolved;
    if (resolved !== undefined && typeof resolved !== "boolean") return badBody('"resolved" must be true or false.').result;
    if (text.value === undefined && resolved === undefined) return badBody('Send "text", "resolved", or both.').result;
    if (expected.value !== undefined && text.value === undefined) return badBody('"expected_text" only goes with "text".').result;

    type Outcome = { ok: true; comment: Comment } | { ok: false; result: ApiResult };
    const saved = await this.backend.update(notePath, (doc): Outcome => {
      const comment = findComment(doc, id);
      const thread = threadOf(doc, id);
      if (!comment || !thread) return { ok: false, result: unknown(id) };
      // Check everything before changing anything, so a refused request changes nothing.
      if (text.value !== undefined && expected.value !== undefined && comment.text !== expected.value) {
        return {
          ok: false,
          result: error(ErrorCodes.textConflict, "The comment's text has changed since expected_text was read.", {
            text: comment.text,
          }),
        };
      }
      if (resolved !== undefined && isSuggestionComment(thread.root)) {
        return {
          ok: false,
          result: error(ErrorCodes.suggestionResolve, "A suggestion is resolved by accepting or declining it (POST …/accept or …/decline)."),
        };
      }
      if (text.value !== undefined) editText(doc, id, comment.text, text.value);
      if (resolved !== undefined) setThreadResolved(doc, thread.root.id, resolved);
      return { ok: true, comment };
    });
    if (!saved.ok) return unreadable(saved.error);
    if (!saved.value.ok) return saved.value.result;
    return { status: 200, body: { comment: saved.value.comment } };
  }

  /**
   * `POST /<id>/accept` — replaces the suggested passage in the note with the
   * suggestion's replacement and records it as accepted (or removes its thread,
   * when Sidemark is set to remove resolved threads). Refused, changing nothing,
   * when the passage can't be found, appears more than once, or no longer reads
   * as it did when the suggestion was made.
   */
  async accept(notePath: string, id: string): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const state = await this.backend.load(notePath);
    if (state.error) return unreadable(state.error);
    const check = openSuggestion(state.doc, id);
    if (!check.ok) return undecidable(id, check.reason);
    const quoted = findComment(state.doc, id)?.selected_text;
    const text = await this.backend.noteText(notePath);
    const resolution = (await this.backend.resolveThreads(notePath)).find((t) => t.thread.root.id === id)?.resolution;
    if (!resolution || resolution.kind === "orphaned") return undecidable(id, "orphaned");
    if (resolution.ambiguous) return undecidable(id, "ambiguous");
    if (text.slice(resolution.from, resolution.to) !== quoted) return undecidable(id, "changed");

    // Recorded before the note is edited, so a comment file that can't be written never leaves an unrecorded edit behind.
    type Recorded =
      | { ok: true; replacement: string; thread: Comment[]; comment: Comment | null }
      | { ok: false; reason: SuggestionFailure | "changed" };
    const behavior = this.backend.resolveBehavior();
    const saved = await this.backend.update(notePath, (doc): Recorded => {
      if (findComment(doc, id)?.selected_text !== quoted) return { ok: false, reason: "changed" };
      const ids = descendantIds(doc, id).add(id);
      const thread = structuredClone(doc.comments.filter((c) => ids.has(c.id)));
      const outcome = finishSuggestion(doc, id, "accepted", behavior);
      if (!outcome.ok) return outcome;
      return { ok: true, replacement: outcome.suggestion.replacement, thread, comment: findComment(doc, id) ?? null };
    });
    if (!saved.ok) return unreadable(saved.error);
    const recorded = saved.value;
    if (!recorded.ok) return undecidable(id, recorded.reason);

    const restore = () =>
      this.backend.update(notePath, (doc) => {
        const ids = new Set(recorded.thread.map((c) => c.id));
        doc.comments = doc.comments.filter((c) => !ids.has(c.id));
        doc.comments.push(...recorded.thread);
      });
    const edit = suggestionEdit(text, resolution.from, resolution.to, recorded.replacement);
    let replaced: boolean;
    try {
      replaced = await this.backend.replacePassage(notePath, edit.from, edit.to, text.slice(edit.from, edit.to), edit.insert);
    } catch (e) {
      await restore();
      throw e;
    }
    if (!replaced) {
      // The note changed after it was read.
      await restore();
      return undecidable(id, "changed");
    }
    return decided("accepted", recorded.comment);
  }

  /**
   * `POST /<id>/decline` — records the suggestion as declined without touching
   * the note (or removes its thread, when Sidemark is set to remove resolved threads).
   */
  async decline(notePath: string, id: string): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const behavior = this.backend.resolveBehavior();
    type Recorded = { ok: true; comment: Comment | null } | { ok: false; reason: SuggestionFailure };
    const saved = await this.backend.update(notePath, (doc): Recorded => {
      const outcome = finishSuggestion(doc, id, "declined", behavior);
      return outcome.ok ? { ok: true, comment: findComment(doc, id) ?? null } : outcome;
    });
    if (!saved.ok) return unreadable(saved.error);
    if (!saved.value.ok) return undecidable(id, saved.value.reason);
    return decided("declined", saved.value.comment);
  }

  /** `DELETE /<id>` — a thread's root takes the whole thread with it; a reply goes alone. */
  async remove(notePath: string, id: string): Promise<ApiResult> {
    const refused = notANote(notePath);
    if (refused) return refused;
    const saved = await this.backend.update(notePath, (doc) => {
      const thread = threadOf(doc, id);
      if (!thread) return false;
      if (thread.root.id === id) deleteThread(doc, id);
      else deleteComment(doc, id);
      return true;
    });
    if (!saved.ok) return unreadable(saved.error);
    if (!saved.value) return unknown(id);
    return { status: 204 };
  }
}
