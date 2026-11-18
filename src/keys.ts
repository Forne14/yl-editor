// List keys are the content's (ruling on #28, 2026-11-18): the schema requires a `_key` on every item, and existing
// content gets its keys once, from `addListKeys` in the registry entry's `migrate`. The chrome never invents a key for
// a stored item. See docs/chrome.md → Lists and docs/paths.md.
import { z } from "zod";
import { parsePath } from "./path.ts";

const KEY_ID = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** What the store says when an item has no usable `_key`. */
export const MISSING_KEY_MESSAGE =
  "Each item needs a _key: a short id of letters, digits, _ or -. Give new items one, and key existing content with addListKeys in the schema's migrate.";

const isKey = (value: unknown): value is string =>
  typeof value === "string" && KEY_ID.test(value) && !FORBIDDEN.has(value);

/**
 * An array of `item`s that each carry a `_key`, unique within the array. An item without one, or with one the paths
 * can't carry, fails validation with {@link MISSING_KEY_MESSAGE}, so the store refuses it: a write never creates an
 * unkeyed item, and a draft read of unkeyed content fails until the entry's `migrate` keys it (see `addListKeys`).
 */
export function keyedItems<Shape extends z.ZodRawShape>(item: z.ZodObject<Shape>) {
  return z
    .array(item.extend({ _key: z.custom<string>(isKey, { error: MISSING_KEY_MESSAGE }) }))
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        // zod's generics lose `_key` here; the schema above guarantees it.
        const entry = item as unknown as { _key: string };
        if (!seen.has(entry._key)) {
          seen.add(entry._key);
          return;
        }
        ctx.addIssue({
          code: "custom",
          path: [index, "_key"],
          message: `Each item's _key must be unique in its list: ${entry._key} is used twice.`,
        });
      });
    });
}

/**
 * Gives every item of the arrays at `paths` a `_key` where it has none, for a registry entry's `migrate`: bump the
 * entry's `version` and return `addListKeys(payload, [...])` for older versions. It is pure, as `migrate` must be:
 * the keys come from the item's place (`k0`, `k1`, …, skipping any already used), so every read before the first save
 * sees the same keys, and that save stores them. Items that already have a key, and items that aren't objects, are left
 * as they are. Paths are plain dotted paths (`artists`, `sections.menu`).
 */
export function addListKeys(payload: unknown, paths: readonly string[]): unknown {
  let result = payload;
  for (const path of paths) {
    const segments = parsePath(path);
    if (segments.some((segment) => typeof segment === "object")) {
      throw new Error(`addListKeys: ${path} must be a plain dotted path`);
    }
    result = keyAt(result, segments as (string | number)[]);
  }
  return result;
}

function keyAt(node: unknown, segments: readonly (string | number)[]): unknown {
  if (node === null || typeof node !== "object") return node;
  const [head, ...rest] = segments;
  if (head === undefined) return keyItems(node);
  const container = node as Record<string | number, unknown>;
  if (!Object.hasOwn(container, head)) return node;
  const child = keyAt(container[head], rest);
  if (child === container[head]) return node;
  return Array.isArray(node)
    ? node.map((entry, index) => (index === head ? child : entry))
    : { ...(node as object), [head]: child };
}

function keyItems(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const used = new Set(list.map((entry) => (entry as { _key?: unknown } | null)?._key).filter(isKey));
  if (
    list.every(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        isKey((entry as { _key?: unknown })._key),
    )
  ) {
    return list;
  }
  let next = 0;
  return list.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    if (isKey((entry as { _key?: unknown })._key)) return entry;
    while (used.has(`k${next}`)) next += 1;
    const key = `k${next}`;
    used.add(key);
    next += 1;
    return { ...entry, _key: key };
  });
}
