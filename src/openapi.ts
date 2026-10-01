import { COMMENT_EVENT_TYPES } from "./comment-events";
import { COMMENTS_SUBRESOURCE } from "./rest-api";
import { ErrorCodes } from "./rest-comments";

/**
 * What Sidemark adds to the OpenAPI spec Local REST API publishes: the comments
 * sub-resource's routes under `/vault/{filename}` and `/active`, the shapes they
 * send, and a tag that also describes the comment events.
 *
 * The types are the host's `OpenApiDescription`, written out here for the same
 * reason as the rest of its API in rest-api.ts.
 */

export interface OpenApiObject {
  [key: string]: unknown;
}

export interface OpenApiTag extends OpenApiObject {
  name: string;
  description?: string;
}

export interface OpenApiDescription {
  paths?: Record<string, OpenApiObject>;
  components?: Record<string, Record<string, OpenApiObject>>;
  tags?: OpenApiTag[];
}

/** Prefixed, since the host refuses a tag or component another plugin already declares. */
export const COMMENTS_TAG = "Sidemark Comments";

const SCHEMAS = {
  comment: "SidemarkComment",
  anchor: "SidemarkAnchor",
  thread: "SidemarkThread",
} as const;

const ref = (schema: string): OpenApiObject => ({ $ref: `#/components/schemas/${schema}` });

/** The host's own error shape: `errorCode` and `message`. */
const HOST_ERROR = ref("Error");

const commentSchema: OpenApiObject = {
  type: "object",
  description:
    "A comment as its note's Sidemark (MRSF) sidecar stores it. Fields this doesn't list, such as the `x_`-prefixed extensions other tools write, are passed through.",
  required: ["id", "author", "timestamp", "text", "resolved"],
  additionalProperties: true,
  properties: {
    id: { type: "string", description: "The comment's id, unique within its note." },
    author: { type: "string", example: "Claude" },
    timestamp: { type: "string", format: "date-time" },
    text: { type: "string", description: "The comment; for a suggestion, its optional explanation." },
    resolved: { type: "boolean", description: "Set on every comment of a resolved thread." },
    reply_to: { type: "string", description: "The id of the comment this one replies to; absent on a thread's first comment." },
    type: { type: "string", description: "`suggestion` for a suggested edit.", example: "suggestion" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    line: { type: "integer", description: "The 1-based line the passage started on when the comment was last anchored." },
    end_line: { type: "integer" },
    start_column: { type: "integer", description: "0-based column within `line`." },
    end_column: { type: "integer" },
    selected_text: { type: "string", description: "The passage the comment was made on." },
    selected_text_hash: { type: "string", description: "SHA-256 of `selected_text`, in hex." },
    anchored_text: { type: "string", description: "The passage as last found, when it differs from `selected_text`." },
    x_suggestion: {
      type: "object",
      description: "A suggested edit: replace the passage with `replacement`.",
      required: ["replacement"],
      properties: {
        replacement: { type: "string" },
        result: { type: "string", enum: ["accepted", "declined"], description: "Absent until the suggestion is acted on." },
      },
    },
  },
};

const anchorSchema: OpenApiObject = {
  description: "Where a thread's passage is in the note as it is now.",
  oneOf: [
    {
      type: "object",
      title: "Anchored",
      required: ["status", "from", "to", "line", "end_line", "start_column", "end_column", "text", "ambiguous", "fuzzy"],
      properties: {
        status: { type: "string", enum: ["anchored"] },
        from: { type: "integer", description: "Offset of the passage's start in the note's text." },
        to: { type: "integer", description: "Offset just past the passage's end." },
        line: { type: "integer", description: "1-based." },
        end_line: { type: "integer" },
        start_column: { type: "integer", description: "0-based." },
        end_column: { type: "integer" },
        text: { type: "string", description: "The passage as it is now, which may differ from the comment's `selected_text`." },
        ambiguous: { type: "boolean", description: "The passage was found in more than one place, and this is the likeliest." },
        fuzzy: { type: "boolean", description: "The passage has changed, and this is the closest match." },
      },
    },
    {
      type: "object",
      title: "Orphaned",
      description: "The passage can't be found in the note anymore.",
      required: ["status"],
      properties: { status: { type: "string", enum: ["orphaned"] } },
    },
  ],
};

const threadSchema: OpenApiObject = {
  type: "object",
  required: ["id", "resolved", "anchor", "root", "replies"],
  properties: {
    id: { type: "string", description: "The id of the thread's first comment." },
    resolved: { type: "boolean", description: "True for a resolved thread and for a suggestion that was accepted or declined." },
    anchor: ref(SCHEMAS.anchor),
    root: ref(SCHEMAS.comment),
    replies: {
      type: "array",
      description: "Every reply in the thread, nested ones included, oldest first.",
      items: ref(SCHEMAS.comment),
    },
  },
};

const json = (schema: OpenApiObject): OpenApiObject => ({ "application/json": { schema } });

function object(properties: Record<string, OpenApiObject>, required: string[] = Object.keys(properties)): OpenApiObject {
  return { type: "object", required, properties };
}

/** A refusal: the host's error shape, plus whatever `extra` the refusal adds to it. */
function refusal(description: string, extra?: Record<string, OpenApiObject>): OpenApiObject {
  const schema = extra ? { allOf: [HOST_ERROR, { type: "object", properties: extra }] } : HOST_ERROR;
  return { description, content: json(schema) };
}

const code = (errorCode: number) => `\`${errorCode}\``;

/** The host answers for a file that doesn't exist, before the request reaches Sidemark. */
const MISSING_FILE = "A file that doesn't exist gets Local REST API's own 404.";
const NOT_FOUND_NOTE = `The file isn't a Markdown note (${code(ErrorCodes.notANote)}). ${MISSING_FILE}`;
const NOT_FOUND_COMMENT = `The file isn't a Markdown note (${code(ErrorCodes.notANote)}), or the note has no comment with this id (${code(ErrorCodes.unknownComment)}). ${MISSING_FILE}`;
const UNREADABLE = `The note's comment file can't be parsed (${code(ErrorCodes.unreadableSidecar)}), so it's left untouched; \`message\` carries the parse error.`;
const INVALID_BODY = `The body isn't a JSON object, or a field is missing or of the wrong type (${code(ErrorCodes.invalidBody)}).`;

const matches: OpenApiObject = { type: "integer", description: "How many times the quote appears in the note." };

const authorProperty: OpenApiObject = {
  type: "string",
  description: "Who the comment is from. Defaults to the author name set in Sidemark.",
  example: "Claude",
};

const idParameter: OpenApiObject = {
  name: "id",
  in: "path",
  required: true,
  description: "A comment's id.",
  schema: { type: "string" },
};

const filenameParameter: OpenApiObject = {
  name: "filename",
  in: "path",
  required: true,
  description: "Path to the note (relative to your vault root).",
  schema: { type: "string", format: "path" },
};

interface Target {
  /** The note's own path in the API. */
  prefix: string;
  parameters: OpenApiObject[];
  /** How summaries name the note. */
  note: string;
  /** Distinguishes the operation ids of the two targets. */
  operationSuffix: string;
}

const TARGETS: Target[] = [
  { prefix: "/vault/{filename}", parameters: [filenameParameter], note: "a note", operationSuffix: "" },
  { prefix: "/active", parameters: [], note: "the active note", operationSuffix: "Active" },
];

function pathsFor({ prefix, parameters, note, operationSuffix }: Target): Record<string, OpenApiObject> {
  const operation = (id: string, rest: OpenApiObject): OpenApiObject => ({
    tags: [COMMENTS_TAG],
    operationId: `sidemark${id}${operationSuffix}`,
    ...rest,
  });
  const base = `${prefix}/${COMMENTS_SUBRESOURCE}`;
  return {
    [`${base}/`]: {
      parameters,
      get: operation("ListComments", {
        summary: `List the comment threads of ${note}`,
        description:
          "Returns every thread with its first comment, its replies, and where its passage is now. Suggested edits are listed with the other threads.",
        parameters: [
          {
            name: "resolved",
            in: "query",
            required: false,
            description: "`false` for only the open threads, `true` for only the resolved ones.",
            schema: { type: "string", enum: ["true", "false"] },
          },
        ],
        responses: {
          "200": { description: "The note's threads.", content: json(object({ threads: { type: "array", items: ref(SCHEMAS.thread) } })) },
          "400": refusal(`\`resolved\` is neither \`true\` nor \`false\` (${code(ErrorCodes.invalidQuery)}).`),
          "404": refusal(NOT_FOUND_NOTE),
          "409": refusal(UNREADABLE),
        },
      }),
      post: operation("AddComment", {
        summary: `Add a comment to ${note}`,
        description:
          "Anchors a new comment on the passage `quote`, which must appear in the note exactly as given. When it appears more than once, `occurrence` chooses one. With `replacement`, the comment is a suggested edit that can be accepted in Obsidian, and `text` becomes its optional explanation.",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["quote"],
            // `text` is optional only for a suggestion, so one of the two has to be sent.
            anyOf: [{ required: ["text"] }, { required: ["replacement"] }],
            properties: {
              text: {
                type: "string",
                description: "The comment; required unless `replacement` is sent, when it's the suggestion's optional explanation.",
                example: "Consider a table here",
              },
              quote: { type: "string", description: "The passage to comment on.", example: "the three options" },
              occurrence: { type: "integer", minimum: 1, description: "Which match of `quote` to anchor on, counting from 1." },
              replacement: {
                type: "string",
                description: "Makes the comment a suggested edit: the text to replace the passage with. Empty suggests deleting it; it can't equal `quote`.",
              },
              author: authorProperty,
            },
          }),
        },
        responses: {
          "201": { description: "The new comment's thread.", content: json(ref(SCHEMAS.thread)) },
          "400": refusal(INVALID_BODY),
          "404": refusal(NOT_FOUND_NOTE),
          "409": refusal(
            `The quote appears more than once and no \`occurrence\` was given (${code(ErrorCodes.ambiguousQuote)}), or the comment file can't be parsed (${code(ErrorCodes.unreadableSidecar)}).`,
            { matches }
          ),
          "422": refusal(
            `The quote doesn't appear in the note, or appears fewer than \`occurrence\` times (${code(ErrorCodes.quoteNotFound)}).`,
            { matches }
          ),
        },
      }),
    },
    [`${base}/{id}`]: {
      parameters: [...parameters, idParameter],
      get: operation("GetComment", {
        summary: `Get a comment of ${note}`,
        responses: {
          "200": {
            description: "The comment and the whole thread it belongs to.",
            content: json(object({ comment: ref(SCHEMAS.comment), thread: ref(SCHEMAS.thread) })),
          },
          "404": refusal(NOT_FOUND_COMMENT),
          "409": refusal(UNREADABLE),
        },
      }),
      patch: operation("UpdateComment", {
        summary: `Edit a comment of ${note}, or resolve or reopen its thread`,
        description:
          "`text` edits the comment; `resolved` resolves or reopens the whole thread the comment belongs to. Send either or both. A suggestion is resolved by accepting or declining it in Obsidian, so `resolved` is refused on a suggestion's thread. A refused request changes nothing.",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            minProperties: 1,
            properties: {
              text: { type: "string", description: "The comment's new text." },
              expected_text: {
                type: "string",
                description: "The text the edit was based on. When the comment no longer reads this, the edit is refused. Only goes with `text`.",
              },
              resolved: { type: "boolean", description: "`true` resolves the thread and `false` reopens it." },
            },
          }),
        },
        responses: {
          "200": { description: "The comment as it is now.", content: json(object({ comment: ref(SCHEMAS.comment) })) },
          "400": refusal(INVALID_BODY),
          "404": refusal(NOT_FOUND_COMMENT),
          "409": refusal(
            `The comment's text isn't \`expected_text\` anymore (${code(ErrorCodes.textConflict)}), or the comment file can't be parsed (${code(ErrorCodes.unreadableSidecar)}).`,
            { text: { type: "string", description: "The comment's text as it is now." } }
          ),
          "422": refusal(`\`resolved\` was sent for a suggestion's thread (${code(ErrorCodes.suggestionResolve)}).`),
        },
      }),
      delete: operation("DeleteComment", {
        summary: `Delete a comment of ${note}`,
        description: "Deleting a thread's first comment deletes the whole thread; deleting a reply deletes only that reply.",
        responses: {
          "204": { description: "Deleted." },
          "404": refusal(NOT_FOUND_COMMENT),
          "409": refusal(UNREADABLE),
        },
      }),
    },
    [`${base}/{id}/replies`]: {
      parameters: [...parameters, idParameter],
      post: operation("ReplyToComment", {
        summary: `Reply to a comment of ${note}`,
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["text"],
            properties: { text: { type: "string", description: "The reply." }, author: authorProperty },
          }),
        },
        responses: {
          "201": { description: "The reply.", content: json(object({ comment: ref(SCHEMAS.comment) })) },
          "400": refusal(INVALID_BODY),
          "404": refusal(NOT_FOUND_COMMENT),
          "409": refusal(UNREADABLE),
        },
      }),
    },
  };
}

function tagDescription(pluginId: string): string {
  const events = COMMENT_EVENT_TYPES.map((type) => `\`${type}\``).join(", ");
  return [
    "Comments and suggested edits on your notes, added by the [Sidemark](https://github.com/coddingtonbear/obsidian-sidemark) plugin. They're kept in a `.review.yaml` file next to each note, and changes made here show up in Sidemark's sidebar immediately.",
    "Only Markdown notes have comments. Suggested edits can be read and added here but only accepted or declined in Obsidian, since that edits the note.",
    "#### Events",
    `Sidemark adds these events to the event streams, with \`${pluginId}\` as the emitter (\`POST /events/${pluginId}/{event}/\`): ${events}.`,
    "Each carries the note's `path`, the comment's `id`, its `thread` (the id of the thread's first comment), and the comment's `author`, `timestamp`, and `text` (left out of `comment-deleted`). A thread's resolving or reopening is reported once, for its first comment.",
  ].join("\n\n");
}

/** Everything Sidemark documents; `pluginId` is Sidemark's own, which its events are streamed under. */
export function commentsOpenApiDescription(pluginId: string): OpenApiDescription {
  return {
    paths: Object.assign({}, ...TARGETS.map(pathsFor)) as Record<string, OpenApiObject>,
    components: {
      schemas: {
        [SCHEMAS.comment]: commentSchema,
        [SCHEMAS.anchor]: anchorSchema,
        [SCHEMAS.thread]: threadSchema,
      },
    },
    tags: [{ name: COMMENTS_TAG, description: tagDescription(pluginId) }],
  };
}
