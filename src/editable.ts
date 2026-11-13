import { parsePath } from "./path.ts";

/** The one place the field-type union lives. */
export type EditFieldType = "text" | "richtext" | "media" | "select" | "number" | "url" | "date" | "tags" | "toggle";

/**
 * Optional extras the chrome reads: the choices for a `select`, a human label for the badge, and the heading levels a
 * `richtext` field allows (`data-edit-headings`; none by default).
 */
export interface EditableAttrs {
  options?: readonly string[];
  label?: string;
  headings?: readonly (2 | 3)[];
}

const KEY_ID = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The path of one item of the array at `base`: `base[_key=<id>]` when `item` is an object with an own string
 * `_key` that is a valid id (`[A-Za-z0-9_-]+`, not a forbidden name), else `base.<index>`. Prefer it when
 * rendering list items so a save still lands on the right item after a concurrent reorder (docs/paths.md).
 */
export function itemPath(base: string, item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && !Array.isArray(item) && Object.hasOwn(item, "_key")) {
    const key: unknown = (item as Record<string, unknown>)["_key"];
    if (typeof key === "string" && KEY_ID.test(key) && !FORBIDDEN.has(key)) return `${base}[_key=${key}]`;
  }
  return `${base}.${index}`;
}

/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`, where the path may use
 * stable-key segments (`items[_key=abc].title`, see docs/paths.md). Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export function editable(docKey: string | undefined) {
  return (path: string, type: EditFieldType, attrs?: EditableAttrs): Record<string, string> => {
    if (docKey === undefined) return {};
    parsePath(path);
    const result: Record<string, string> = { "data-edit-field": `${docKey}:${path}`, "data-edit-type": type };
    if (attrs?.options !== undefined) result["data-edit-options"] = JSON.stringify(attrs.options);
    if (attrs?.label !== undefined) result["data-edit-label"] = attrs.label;
    if (attrs?.headings !== undefined && attrs.headings.length > 0)
      result["data-edit-headings"] = attrs.headings.join(" ");
    return result;
  };
}
