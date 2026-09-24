import type { App, PluginManifest } from "obsidian";
import { COMMENT_EVENT_TYPES, isCommentEventPayload } from "./comment-events";
import type { ApiResult, CommentsApi } from "./rest-comments";

/**
 * Sidemark's connection to Obsidian Local REST API's extension API.
 *
 * The types below are the slice of the host's `publicApi.d.ts` Sidemark uses,
 * written out here rather than taken from the `obsidian-local-rest-api`
 * package: that would bring in express, zod, and their types for a handful of
 * members. Everything is optional at runtime, so a host that's missing, too
 * old, or lacking a member leaves Sidemark working as it does without one.
 */

export const LOCAL_REST_API_PLUGIN_ID = "obsidian-local-rest-api";

/** The event the host triggers on the workspace when it has (re)loaded. */
export const LOCAL_REST_API_LOADED_EVENT = "obsidian-local-rest-api:loaded";

/** The extension API version that added vault sub-resources and streamable events. */
export const REQUIRED_API_VERSION = 3;

/** The sub-resource name: `/vault/<note>/comments/…` and `/active/comments/…`. */
export const COMMENTS_SUBRESOURCE = "comments";

/** The parts of an Express request a comments route reads. */
export interface SubresourceRequest {
  params: Record<string, string>;
  query: Record<string, unknown>;
  /** Parsed JSON for `application/json` bodies; a string or buffer for others. */
  body: unknown;
  /** Set by the host: the note the request is about. */
  vaultFile: { path: string };
}

/** The parts of an Express response a comments route writes. */
export interface SubresourceResponse {
  status(code: number): SubresourceResponse;
  json(body: unknown): unknown;
  end(): unknown;
}

type RouteHandler = (req: SubresourceRequest, res: SubresourceResponse) => void;

/** The parts of the Express `Router` that `addVaultSubresource` returns. */
export interface SubresourceRouter {
  get(path: string, handler: RouteHandler): unknown;
  post(path: string, handler: RouteHandler): unknown;
  patch(path: string, handler: RouteHandler): unknown;
  delete(path: string, handler: RouteHandler): unknown;
}

/** An `Events`-like object: Obsidian's `Events`, or anything with the same `on`/`off`. */
export interface EventSource {
  on(name: string, callback: (...data: unknown[]) => unknown): unknown;
  off(name: string, callback: (...data: unknown[]) => unknown): void;
}

/** The host's `StreamableEventDefinition`. */
export interface StreamableEventDefinition {
  source: EventSource;
  /** What a stream sends for one occurrence; null sends nothing. */
  serialize(...args: unknown[]): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

/** The members of the host's `LocalRestApiPublicApi` Sidemark uses. */
export interface LocalRestApi {
  /** Missing on hosts older than version 2, which implement version 1. */
  readonly apiVersion?: number;
  addVaultSubresource?(name: string): SubresourceRouter;
  addStreamableEvent?(event: string, definition: StreamableEventDefinition): void;
  unregister(): void;
}

interface LocalRestApiHost {
  getPublicApi(manifest: PluginManifest): LocalRestApi;
}

/** Obsidian's plugin registry, which the `obsidian` typings leave out. */
interface AppWithPlugins {
  plugins?: { plugins?: Record<string, unknown> };
}

function isHost(value: unknown): value is LocalRestApiHost {
  return typeof value === "object" && value !== null && typeof (value as Partial<LocalRestApiHost>).getPublicApi === "function";
}

export type Connection =
  | { kind: "connected"; api: LocalRestApi }
  | { kind: "missing" }
  | { kind: "unsupported"; version: number };

/**
 * Registers Sidemark with the running Local REST API, if there is one that
 * implements at least `REQUIRED_API_VERSION`. An older host's handle is
 * released straight away, so nothing is left registered with it.
 */
export function connectLocalRestApi(app: App, manifest: PluginManifest): Connection {
  const host = (app as unknown as AppWithPlugins).plugins?.plugins?.[LOCAL_REST_API_PLUGIN_ID];
  if (!isHost(host)) return { kind: "missing" };
  const api = host.getPublicApi(manifest);
  const version = api.apiVersion ?? 1;
  if (version < REQUIRED_API_VERSION) {
    api.unregister();
    return { kind: "unsupported", version };
  }
  return { kind: "connected", api };
}

function send(res: SubresourceResponse, result: ApiResult): void {
  if (result.body === undefined) res.status(result.status).end();
  else res.status(result.status).json(result.body);
}

/** Answers a request with `handle`'s result, or a 500 if it throws. */
function route(handle: (req: SubresourceRequest) => Promise<ApiResult>): RouteHandler {
  return (req, res) => {
    handle(req).then(
      (result) => send(res, result),
      (e: unknown) => {
        console.error("Sidemark: REST API request failed", e);
        send(res, {
          status: 500,
          body: { errorCode: 50000, message: `Sidemark couldn't handle the request: ${e instanceof Error ? e.message : String(e)}` },
        });
      }
    );
  };
}

/**
 * Makes each comment event streamable (`POST /events/<Sidemark's id>/comment-added/`
 * and so on). `source` is triggered with the event type and its payload.
 * Returns false, registering nothing, when the host can't stream extension events.
 */
export function registerCommentEvents(api: LocalRestApi, source: EventSource): boolean {
  if (typeof api.addStreamableEvent !== "function") return false;
  for (const type of COMMENT_EVENT_TYPES) {
    api.addStreamableEvent(type, {
      source,
      serialize: (payload) => (isCommentEventPayload(payload) ? { ...payload } : null),
    });
  }
  return true;
}

/** Adds the comment routes to the host's router for the comments sub-resource. */
export function mountCommentsApi(router: SubresourceRouter, comments: CommentsApi): void {
  router.get("/", route((req) => comments.list(req.vaultFile.path, req.query)));
  router.post("/", route((req) => comments.create(req.vaultFile.path, req.body)));
  router.get("/:id", route((req) => comments.get(req.vaultFile.path, req.params.id)));
  router.patch("/:id", route((req) => comments.patch(req.vaultFile.path, req.params.id, req.body)));
  router.delete("/:id", route((req) => comments.remove(req.vaultFile.path, req.params.id)));
  router.post("/:id/replies", route((req) => comments.reply(req.vaultFile.path, req.params.id, req.body)));
}
