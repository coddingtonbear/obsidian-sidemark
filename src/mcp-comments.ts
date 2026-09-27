import { z, type ZodTypeAny } from "zod";
import type { McpToolDefinition, McpToolResult } from "./rest-api";
import type { ApiResult, CommentsApi } from "./rest-comments";

/**
 * The comments API as MCP tools, registered with Local REST API's MCP server.
 * Each tool is the matching REST request (rest-comments.ts does the work), with
 * the note named by a `path` argument instead of the URL.
 */

/** Finds the note a tool call names: its normalized vault path, or null when there's no such note. */
export type NoteResolver = (path: string) => string | null;

const path = z.string().describe("Path of the note relative to the vault root, e.g. Projects/Plan.md");
const id = z.string().describe("A comment's id, as listed by comments_list");
const author = z
  .string()
  .optional()
  .describe("Who the comment is from, e.g. Claude. Defaults to the author name set in Sidemark.");

function text(content: string): McpToolResult {
  return { content: [{ type: "text", text: content }] };
}

function failure(message: string): McpToolResult {
  return { ...text(message), isError: true };
}

/** A REST result as a tool result: its JSON body, flagged as an error for a 4xx or 5xx. */
function toolResult(result: ApiResult): McpToolResult {
  const content = text(result.body === undefined ? "Done." : JSON.stringify(result.body, null, 2));
  return result.status >= 400 ? { ...content, isError: true } : content;
}

type NoteShape = Record<string, ZodTypeAny> & { path: typeof path };

/**
 * A tool whose note must exist. Its arguments are parsed with its own schema:
 * the host validates them too, but hands them over untyped.
 */
function tool<S extends NoteShape>(
  resolveNote: NoteResolver,
  definition: Omit<McpToolDefinition, "inputSchema" | "callback"> & {
    inputSchema: S;
    run: (notePath: string, args: z.infer<z.ZodObject<S>>) => Promise<ApiResult>;
  }
): McpToolDefinition {
  const { run, ...rest } = definition;
  const schema = z.object(definition.inputSchema);
  return {
    ...rest,
    callback: async (rawArgs) => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) return failure(`Invalid arguments: ${parsed.error.message}`);
      const requested = path.parse(rawArgs.path);
      const notePath = resolveNote(requested);
      if (notePath === null) return failure(`There's no note at "${requested}".`);
      try {
        return toolResult(await run(notePath, parsed.data));
      } catch (e) {
        return failure(`Sidemark couldn't handle the request: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/** Sidemark's MCP tools, in the order they're registered. */
export function commentTools(comments: CommentsApi, resolveNote: NoteResolver): McpToolDefinition[] {
  return [
    tool(resolveNote, {
      name: "comments_list",
      title: "List a note's comments",
      description:
        "Lists the comment threads on a note (Sidemark comments, kept in the note's .review.yaml sidecar). " +
        "Each thread has its first comment (`root`), its replies, whether it is resolved, and `anchor`: where the " +
        "commented passage is in the note now, or `orphaned` when it can no longer be found. Suggested edits appear " +
        "as threads too; they can only be accepted or declined in Obsidian.",
      inputSchema: {
        path,
        resolved: z.boolean().optional().describe("Only resolved threads (true) or only open ones (false). Omit for all."),
      },
      annotations: { readOnlyHint: true },
      run: (notePath, { resolved }) => comments.list(notePath, resolved === undefined ? {} : { resolved: String(resolved) }),
    }),
    tool(resolveNote, {
      name: "comments_get",
      title: "Get a comment",
      description: "Returns one comment on a note and the whole thread it belongs to.",
      inputSchema: { path, id },
      annotations: { readOnlyHint: true },
      run: (notePath, args) => comments.get(notePath, args.id),
    }),
    tool(resolveNote, {
      name: "comments_add",
      title: "Comment on a passage",
      description:
        "Starts a comment thread on a passage of a note. `quote` is the passage, copied exactly from the note; " +
        "when it appears more than once, `occurrence` says which (counting from 1). Returns the new thread.",
      inputSchema: {
        path,
        text: z.string().describe("The comment (Markdown)"),
        quote: z.string().describe("The passage to comment on, exactly as it appears in the note"),
        occurrence: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Which match of `quote` to comment on, counting from 1. Required when the quote appears more than once."),
        author,
      },
      run: (notePath, { text, quote, occurrence, author }) => comments.create(notePath, { text, quote, occurrence, author }),
    }),
    tool(resolveNote, {
      name: "comments_reply",
      title: "Reply to a comment",
      description: "Adds a reply to a comment's thread.",
      inputSchema: { path, id, text: z.string().describe("The reply (Markdown)"), author },
      run: (notePath, { id, text, author }) => comments.reply(notePath, id, { text, author }),
    }),
    tool(resolveNote, {
      name: "comments_update",
      title: "Edit or resolve a comment",
      description:
        "Edits a comment's text, resolves or reopens its thread, or both. Pass `expected_text` with `text` to " +
        "have the edit refused if the comment was changed since you read it. A suggested edit's thread can't be " +
        "resolved here; that happens by accepting or declining it in Obsidian.",
      inputSchema: {
        path,
        id,
        text: z.string().optional().describe("The comment's new text"),
        expected_text: z.string().optional().describe("The text you expect the comment to have now"),
        resolved: z.boolean().optional().describe("true resolves the thread; false reopens it"),
      },
      annotations: { idempotentHint: true },
      run: (notePath, { id, text, expected_text, resolved }) => comments.patch(notePath, id, { text, expected_text, resolved }),
    }),
    tool(resolveNote, {
      name: "comments_delete",
      title: "Delete a comment",
      description:
        "Deletes a comment. Deleting a thread's first comment deletes the whole thread; deleting a reply removes only that reply.",
      inputSchema: { path, id },
      annotations: { destructiveHint: true },
      run: (notePath, args) => comments.remove(notePath, args.id),
    }),
  ];
}
