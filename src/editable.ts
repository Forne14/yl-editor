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
 * What a list's chrome reads (see docs/chrome.md, "Lists"). `label` names the list in its tag, `noun` and `plural`
 * fill the button text and messages ("Add artist", "No artists yet"). `min` and `max` bound Add and Remove. `order`
 * is `"manual"` (Move up and Move down) or `"data"` (the host sorts, e.g. by date: no move buttons). `duplicate`
 * turns Duplicate on. `itemLabel` is the field name, relative to an item, whose text names the item in messages.
 */
export interface EditableListAttrs {
  label?: string;
  noun?: string;
  plural?: string;
  min?: number;
  max?: number;
  order?: "manual" | "data";
  duplicate?: boolean;
  itemLabel?: string;
}

/** The attribute functions `editable` returns: one per field, plus `list` and `item` for keyed lists. */
export interface Editable {
  (path: string, type: EditFieldType, attrs?: EditableAttrs): Record<string, string>;
  /** The list element's attributes. Its items are the elements carrying `item(...)`. */
  list(path: string, attrs?: EditableListAttrs): Record<string, string>;
  /** One item's attributes, addressed with `itemPath` so a keyed item survives a concurrent reorder. */
  item(listPath: string, item: unknown, index: number): Record<string, string>;
}

function limit(value: number | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of 0 or more`);
  return String(value);
}

/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`, where the path may use
 * stable-key segments (`items[_key=abc].title`, see docs/paths.md). Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export function editable(docKey: string | undefined): Editable {
  const field = (path: string, type: EditFieldType, attrs?: EditableAttrs): Record<string, string> => {
    if (docKey === undefined) return {};
    parsePath(path);
    const result: Record<string, string> = { "data-edit-field": `${docKey}:${path}`, "data-edit-type": type };
    if (attrs?.options !== undefined) result["data-edit-options"] = JSON.stringify(attrs.options);
    if (attrs?.label !== undefined) result["data-edit-label"] = attrs.label;
    if (attrs?.headings !== undefined && attrs.headings.length > 0)
      result["data-edit-headings"] = attrs.headings.join(" ");
    return result;
  };
  const list = (path: string, attrs: EditableListAttrs = {}): Record<string, string> => {
    if (docKey === undefined) return {};
    parsePath(path);
    const min = limit(attrs.min, "min");
    const max = limit(attrs.max, "max");
    if (attrs.min !== undefined && attrs.max !== undefined && attrs.min > attrs.max)
      throw new RangeError("min must not be more than max");
    const result: Record<string, string> = { "data-edit-list": `${docKey}:${path}` };
    if (attrs.label !== undefined) result["data-edit-list-label"] = attrs.label;
    if (attrs.noun !== undefined) result["data-edit-list-noun"] = attrs.noun;
    if (attrs.plural !== undefined) result["data-edit-list-plural"] = attrs.plural;
    if (min !== undefined) result["data-edit-list-min"] = min;
    if (max !== undefined) result["data-edit-list-max"] = max;
    if (attrs.order !== undefined) result["data-edit-list-order"] = attrs.order;
    if (attrs.duplicate === true) result["data-edit-list-duplicate"] = "";
    if (attrs.itemLabel !== undefined) result["data-edit-list-item-label"] = attrs.itemLabel;
    return result;
  };
  const item = (listPath: string, value: unknown, index: number): Record<string, string> => {
    if (docKey === undefined) return {};
    const path = itemPath(listPath, value, index);
    parsePath(path);
    return { "data-edit-item": `${docKey}:${path}` };
  };
  return Object.assign(field, { list, item });
}
