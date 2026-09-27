import { describe, expect, it } from "vitest";
import { COMMENT_EVENT_TYPES } from "../src/comment-events";
import { COMMENTS_TAG, commentsOpenApiDescription, type OpenApiObject } from "../src/openapi";
import { mountCommentsApi, type SubresourceRouter } from "../src/rest-api";
import { type CommentsApi, ErrorCodes } from "../src/rest-comments";

const METHODS = ["get", "post", "patch", "delete", "put"] as const;
const PREFIXES = ["/vault/{filename}/comments", "/active/comments"];

/** Schemas the host's own spec declares, which a description may refer to. */
const HOST_SCHEMAS = ["Error"];

const description = commentsOpenApiDescription("sidemark");
const paths = description.paths ?? {};

function isObject(value: unknown): value is OpenApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operations(): { key: string; path: string; item: OpenApiObject; operation: OpenApiObject }[] {
  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method];
      return isObject(operation) ? [{ key: `${method.toUpperCase()} ${path}`, path, item, operation }] : [];
    })
  );
}

/** Every `$ref` anywhere inside `value`. */
function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => (key === "$ref" && typeof child === "string" ? [child] : refsIn(child)));
}

function parameterNames(holder: OpenApiObject, location: string): string[] {
  const parameters = Array.isArray(holder.parameters) ? holder.parameters : [];
  return parameters.filter(isObject).flatMap((p) => (p.in === location && typeof p.name === "string" ? [p.name] : []));
}

describe("commentsOpenApiDescription", () => {
  it("describes exactly the routes that are mounted, under a note and under the active note", () => {
    const mounted: string[] = [];
    const add = (method: string) => (path: string) => mounted.push(`${method} ${path.replace(/:(\w+)/g, "{$1}")}`);
    const router: SubresourceRouter = { get: add("GET"), post: add("POST"), patch: add("PATCH"), delete: add("DELETE") };
    mountCommentsApi(router, {} as CommentsApi);

    const expected = PREFIXES.flatMap((prefix) => mounted.map((route) => route.replace(" /", ` ${prefix}/`)));
    expect(
      operations()
        .map((o) => o.key)
        .sort()
    ).toEqual(expected.sort());
  });

  it("declares every path parameter a path names, and no others", () => {
    for (const [path, item] of Object.entries(paths)) {
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(parameterNames(item, "path").sort(), path).toEqual(named.sort());
    }
  });

  it("refers only to schemas it declares or the host does", () => {
    const declared = Object.keys(description.components?.schemas ?? {});
    const known = new Set([...declared, ...HOST_SCHEMAS].map((name) => `#/components/schemas/${name}`));
    const refs = refsIn(description);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((r) => !known.has(r))).toEqual([]);
    // Prefixed, so they can't collide with the host's or another plugin's.
    expect(declared.filter((name) => !name.startsWith("Sidemark"))).toEqual([]);
  });

  it("tags every operation with its one tag and gives each a unique operationId", () => {
    expect(description.tags?.map((t) => t.name)).toEqual([COMMENTS_TAG]);
    const ids = operations().map(({ operation }) => {
      expect(operation.tags).toEqual([COMMENTS_TAG]);
      expect(typeof operation.summary).toBe("string");
      return operation.operationId;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents every error code under the status it's sent with", () => {
    const documented = new Set<string>();
    for (const { operation } of operations()) {
      if (!isObject(operation.responses)) continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (!isObject(response) || typeof response.description !== "string") continue;
        for (const [code] of response.description.matchAll(/\b\d{5}\b/g)) {
          expect(code.slice(0, 3), `${code} under ${status}`).toBe(status);
          documented.add(code);
        }
      }
    }
    expect([...documented].sort()).toEqual(Object.values(ErrorCodes).map(String).sort());
  });

  it("names every comment event and the emitter they're streamed under", () => {
    const text = commentsOpenApiDescription("some-id").tags?.[0].description ?? "";
    for (const type of COMMENT_EVENT_TYPES) expect(text).toContain(`\`${type}\``);
    expect(text).toContain("POST /events/some-id/{event}/");
  });

  it("is plain data the host can copy", () => {
    expect(structuredClone(description)).toEqual(description);
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
  });
});
