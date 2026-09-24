import { anchorFieldsFor, type Resolution } from "./anchoring";
import type { ResolvedThread } from "./export";
import { selectedTextHash } from "./hash";
import { buildThreads, type Comment, isResolved, isSuggestionComment, type MrsfDocument, type Thread } from "./model";
import {
  addComment,
  addReply,
  deleteComment,
  deleteThread,
  editText,
  findComment,
  type NewEntry,
  setThreadResolved,
} from "./mutations";
import { rangeToLineColumns } from "./positions";
import type { SidecarState, UpdateResult } from "./store";

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
  unreadableSidecar: 40901,
  ambiguousQuote: 40902,
  textConflict: 40903,
  quoteNotFound: 42201,
  suggestionResolve: 42202,
} as const;

function error(errorCode: number, message: string, extra: Record<string, unknown> = {}): ApiResult {
  const body: ApiError & Record<string, unknown> = { errorCode, message, ...extra };
  return { status: Math.floor(errorCode / 100), body };
}

const unreadable = (detail: string) =>
  error(ErrorCodes.unreadableSidecar, `The note's comment file can't be read, so it can't be used: ${detail}`);
const unknown = (id: string) => error(ErrorCodes.unknownComment, `The note has no comment with the id "${id}".`);

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

function optionalAuthor(body: Record<string, unknown>): Fields<string | undefined> {
  const value = body.author;
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") return badBody('"author" must be a non-empty string.');
  return { ok: true, value: value.trim() };
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
   * A quote found more than once needs an `occurrence`.
   */
  async create(notePath: string, rawBody: unknown): Promise<ApiResult> {
    const body = objectBody(rawBody);
    if (!body.ok) return body.result;
    const text = requiredText(body.value, "text");
    if (!text.ok) return text.result;
    const quote = body.value.quote;
    if (typeof quote !== "string" || quote === "") return badBody('"quote" is required and must be a non-empty string.').result;
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
    const saved = await this.backend.update(notePath, (doc) => addComment(doc, entry, anchor));
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
   * whole thread. Suggestions are resolved by accepting or declining them in
   * Obsidian, so `resolved` is refused on a suggestion's thread.
   */
  async patch(notePath: string, id: string, rawBody: unknown): Promise<ApiResult> {
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
          result: error(ErrorCodes.suggestionResolve, "A suggestion is resolved by accepting or declining it in Obsidian."),
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

  /** `DELETE /<id>` — a thread's root takes the whole thread with it; a reply goes alone. */
  async remove(notePath: string, id: string): Promise<ApiResult> {
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
