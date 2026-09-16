import { Document, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode, type YAMLMap } from "yaml";
import type { Comment, MrsfDocument } from "./model";

const TO_STRING_OPTIONS = { lineWidth: 0 } as const;

function sameValue(node: unknown, value: unknown): boolean {
  const current = node !== null && typeof node === "object" && "toJSON" in node
    ? (node as { toJSON(): unknown }).toJSON()
    : node;
  return JSON.stringify(current) === JSON.stringify(value);
}

/**
 * Updates `map` in place so it holds exactly `value`'s keys, touching only the
 * entries that changed. Untouched entries keep their YAML comments and scalar
 * styles; changed scalars keep their node (and so their style) where possible.
 */
function reconcileMap(
  doc: Document,
  map: YAMLMap,
  value: Record<string, unknown>,
  deleteMissing: boolean
): boolean {
  let changed = false;
  for (const pair of [...map.items]) {
    if (!deleteMissing) break;
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key !== "string" || !(key in value) || value[key] === undefined) {
      map.delete(pair.key);
      changed = true;
    }
  }
  for (const [key, next] of Object.entries(value)) {
    if (next === undefined) continue;
    const existing = map.get(key, true);
    if (existing !== undefined && sameValue(existing, next)) continue;
    changed = true;
    if (isScalar(existing) && (next === null || typeof next !== "object")) {
      existing.value = next;
    } else {
      map.set(key, doc.createNode(next));
    }
  }
  return changed;
}

function freshYaml(next: MrsfDocument): string {
  return new Document(next).toString(TO_STRING_OPTIONS);
}

/**
 * Serializes `next`, preserving the formatting of `previous` (the sidecar's
 * current text) wherever the data didn't change. MRSF §10.1 asks for this so
 * hand edits and YAML comments survive tool writes; MRSF's own writer does it
 * with Node-only code, so this is a browser-safe equivalent built on `yaml`'s
 * Document API.
 */
export function serializeSidecar(previous: string | null, next: MrsfDocument): string {
  if (previous === null) return freshYaml(next);
  const parsed = parseDocument(previous);
  if (parsed.errors.length > 0) return freshYaml(next);
  const doc: Document = parsed;
  const root = doc.contents;
  if (!isMap(root)) return freshYaml(next);

  const { comments, ...topLevel } = next;
  const existingComments = root.get("comments", true);
  // MRSF's lenient parser drops unknown top-level keys, so a key missing from
  // `next` doesn't mean it should be deleted; top-level keys are only ever set.
  let changed = reconcileMap(doc, root, topLevel, false);

  if (!isSeq(existingComments)) {
    root.set("comments", doc.createNode(comments));
    return doc.toString(TO_STRING_OPTIONS);
  }

  // Nodes are paired with comments by id; repeated ids pair up in order of appearance.
  const nodesById = new Map<string, YAMLMap[]>();
  for (const item of existingComments.items) {
    if (!isMap(item)) continue;
    const id = item.get("id");
    if (typeof id === "string") nodesById.set(id, [...(nodesById.get(id) ?? []), item]);
  }
  const items = comments.map((comment: Comment): YamlNode => {
    const node = nodesById.get(comment.id)?.shift();
    if (!node) return doc.createNode(comment);
    if (reconcileMap(doc, node, comment, true)) changed = true;
    return node;
  });
  if (items.length !== existingComments.items.length || items.some((item, i) => item !== existingComments.items[i])) {
    existingComments.items = items;
    changed = true;
  }
  // Re-stringifying can still reflow untouched scalars, so an unchanged document keeps its exact text.
  return changed ? doc.toString(TO_STRING_OPTIONS) : previous;
}
