import type { App, PluginManifest } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { COMMENT_EVENT_TYPES } from "../src/comment-events";
import {
  addMcpTools,
  connectLocalRestApi,
  describeInOpenApi,
  type EventSource,
  type LocalRestApi,
  type McpToolDefinition,
  mountCommentsApi,
  registerCommentEvents,
  type StreamableEventDefinition,
  type SubresourceRequest,
  type SubresourceResponse,
  type SubresourceRouter,
} from "../src/rest-api";
import type { ApiResult, CommentsApi } from "../src/rest-comments";

const manifest = { id: "sidemark", name: "Sidemark", version: "1.3.1" } as PluginManifest;

function appWith(plugins: Record<string, unknown>): App {
  return { plugins: { plugins } } as unknown as App;
}

function hostWith(api: LocalRestApi) {
  const getPublicApi = vi.fn(() => api);
  return { host: { getPublicApi }, getPublicApi };
}

describe("connectLocalRestApi", () => {
  it("reports a missing host", () => {
    expect(connectLocalRestApi(appWith({}), manifest)).toEqual({ kind: "missing" });
    expect(connectLocalRestApi({} as App, manifest)).toEqual({ kind: "missing" });
    expect(connectLocalRestApi(appWith({ "obsidian-local-rest-api": {} }), manifest)).toEqual({ kind: "missing" });
  });

  it("connects to a host implementing version 3", () => {
    const api: LocalRestApi = { apiVersion: 3, unregister: vi.fn() };
    const { host, getPublicApi } = hostWith(api);
    expect(connectLocalRestApi(appWith({ "obsidian-local-rest-api": host }), manifest)).toEqual({ kind: "connected", api });
    expect(getPublicApi).toHaveBeenCalledWith(manifest);
    expect(api.unregister).not.toHaveBeenCalled();
  });

  it.each([
    [2, 2],
    [undefined, 1],
  ])("releases a host implementing version %s at once", (apiVersion, reported) => {
    const api: LocalRestApi = { apiVersion, unregister: vi.fn() };
    const { host } = hostWith(api);
    expect(connectLocalRestApi(appWith({ "obsidian-local-rest-api": host }), manifest)).toEqual({
      kind: "unsupported",
      version: reported,
    });
    expect(api.unregister).toHaveBeenCalledOnce();
  });
});

describe("registerCommentEvents", () => {
  const source: EventSource = { on: () => undefined, off: () => undefined };

  it("registers every comment event, serializing only real payloads", async () => {
    const added: [string, StreamableEventDefinition][] = [];
    const api: LocalRestApi = {
      apiVersion: 3,
      unregister: () => undefined,
      addStreamableEvent(event, definition) {
        // A method, as on the host, so a detached call would lose `this`.
        expect(this).toBe(api);
        added.push([event, definition]);
      },
    };
    expect(registerCommentEvents(api, source)).toBe(true);
    expect(added.map(([event]) => event)).toEqual([...COMMENT_EVENT_TYPES]);
    const { serialize, source: registered } = added[0][1];
    expect(registered).toBe(source);
    const payload = { path: "a.md", id: "c1", thread: "c1", author: "Adam", timestamp: "t", text: "hi" };
    expect(await serialize(payload)).toEqual(payload);
    expect(await serialize(payload)).not.toBe(payload);
    expect(await serialize({ path: "a.md" })).toBeNull();
  });

  it("registers nothing on a host that can't stream extension events", () => {
    expect(registerCommentEvents({ apiVersion: 3, unregister: () => undefined }, source)).toBe(false);
  });
});

describe("addMcpTools", () => {
  const tool = (name: string): McpToolDefinition => ({
    name,
    description: name,
    callback: () => Promise.resolve({ content: [] }),
  });

  it("skips a tool the host refuses and still offers the rest, without unregistering", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const added: string[] = [];
    const api: LocalRestApi = {
      apiVersion: 3,
      unregister: vi.fn(),
      addMcpTool: (definition) => {
        if (definition.name === "comments_list") throw new Error("Tool comments_list is already registered");
        added.push(definition.name);
      },
    };
    addMcpTools(api, [tool("comments_get"), tool("comments_list"), tool("comments_add")]);
    expect(added).toEqual(["comments_get", "comments_add"]);
    expect(api.unregister).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("does nothing on a host without MCP tools", () => {
    expect(() => addMcpTools({ apiVersion: 3, unregister: vi.fn() }, [tool("comments_list")])).not.toThrow();
  });
});

describe("describeInOpenApi", () => {
  const description = { tags: [{ name: "Sidemark Comments" }] };

  it("hands the description to the host", () => {
    const added: unknown[] = [];
    const api: LocalRestApi = {
      apiVersion: 3,
      unregister: vi.fn(),
      addOpenApiDescription(given) {
        expect(this).toBe(api);
        added.push(given);
      },
    };
    expect(describeInOpenApi(api, description)).toBe(true);
    expect(added).toEqual([description]);
  });

  it("logs a description the host refuses, without unregistering", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api: LocalRestApi = {
      apiVersion: 3,
      unregister: vi.fn(),
      addOpenApiDescription: () => {
        throw new Error('OpenAPI tag "Sidemark Comments" is already declared.');
      },
    };
    expect(describeInOpenApi(api, description)).toBe(false);
    expect(api.unregister).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("does nothing on a host that can't take descriptions", () => {
    expect(describeInOpenApi({ apiVersion: 3, unregister: vi.fn() }, description)).toBe(false);
  });
});

type Handler = (req: SubresourceRequest, res: SubresourceResponse) => void;

function fakeRouter() {
  const routes = new Map<string, Handler>();
  const add = (method: string) => (path: string, handler: Handler) => routes.set(`${method} ${path}`, handler);
  const router: SubresourceRouter = { get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
  return { router, routes };
}

function fakeResponse() {
  const sent: { status?: number; json?: unknown; ended?: boolean } = {};
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((r) => (resolve = r));
  const res: SubresourceResponse = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.json = body;
      resolve();
    },
    end() {
      sent.ended = true;
      resolve();
    },
  };
  return { res, sent, done };
}

function request(overrides: Partial<SubresourceRequest> = {}): SubresourceRequest {
  return { params: {}, query: {}, body: undefined, vaultFile: { path: "a.md" }, ...overrides };
}

describe("mountCommentsApi", () => {
  const ok = (body?: unknown): Promise<ApiResult> => Promise.resolve({ status: body === undefined ? 204 : 200, body });

  function mount(comments: Partial<Record<keyof CommentsApi, (...args: unknown[]) => Promise<ApiResult>>>) {
    const { router, routes } = fakeRouter();
    mountCommentsApi(router, comments as unknown as CommentsApi);
    return routes;
  }

  it("routes each method and path to the matching operation", async () => {
    const calls: unknown[][] = [];
    const record =
      (name: string, body?: unknown) =>
      (...args: unknown[]) => {
        calls.push([name, ...args]);
        return ok(body);
      };
    const routes = mount({
      list: record("list", { threads: [] }),
      create: record("create", {}),
      get: record("get", {}),
      patch: record("patch", {}),
      remove: record("remove"),
      reply: record("reply", {}),
      accept: record("accept", {}),
      decline: record("decline", {}),
    });
    expect([...routes.keys()].sort()).toEqual(
      ["DELETE /:id", "GET /", "GET /:id", "PATCH /:id", "POST /", "POST /:id/replies", "POST /:id/accept", "POST /:id/decline"].sort()
    );
    const run = async (key: string, req: SubresourceRequest) => {
      const { res, sent, done } = fakeResponse();
      routes.get(key)?.(req, res);
      await done;
      return sent;
    };
    expect(await run("GET /", request({ query: { resolved: "false" } }))).toEqual({ status: 200, json: { threads: [] } });
    await run("POST /", request({ body: { text: "hi" } }));
    await run("GET /:id", request({ params: { id: "c1" } }));
    await run("PATCH /:id", request({ params: { id: "c1" }, body: { resolved: true } }));
    expect(await run("DELETE /:id", request({ params: { id: "c1" } }))).toEqual({ status: 204, ended: true });
    await run("POST /:id/replies", request({ params: { id: "c1" }, body: { text: "yo" } }));
    await run("POST /:id/accept", request({ params: { id: "s1" } }));
    await run("POST /:id/decline", request({ params: { id: "s2" } }));
    expect(calls).toEqual([
      ["list", "a.md", { resolved: "false" }],
      ["create", "a.md", { text: "hi" }],
      ["get", "a.md", "c1"],
      ["patch", "a.md", "c1", { resolved: true }],
      ["remove", "a.md", "c1"],
      ["reply", "a.md", "c1", { text: "yo" }],
      ["accept", "a.md", "s1"],
      ["decline", "a.md", "s2"],
    ]);
  });

  it("answers 500 when an operation throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const routes = mount({ list: () => Promise.reject(new Error("boom")) });
    const { res, sent, done } = fakeResponse();
    routes.get("GET /")?.(request(), res);
    await done;
    expect(sent).toEqual({ status: 500, json: { errorCode: 50000, message: "Sidemark couldn't handle the request: boom" } });
    error.mockRestore();
  });
});
