/** The one place the field-type union lives. */
export type EditFieldType = "text" | "richtext" | "media" | "select" | "number" | "url" | "date" | "tags" | "toggle";
/** Optional extras the chrome reads: the choices for a `select`, and a human label for the badge. */
export interface EditableAttrs {
    options?: readonly string[];
    label?: string;
}
/**
 * The path of one item of the array at `base`: `base[_key=<id>]` when `item` is an object with an own string
 * `_key` that is a valid id (`[A-Za-z0-9_-]+`, not a forbidden name), else `base.<index>`. Prefer it when
 * rendering list items so a save still lands on the right item after a concurrent reorder (docs/paths.md).
 */
export declare function itemPath(base: string, item: unknown, index: number): string;
/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`, where the path may use
 * stable-key segments (`items[_key=abc].title`, see docs/paths.md). Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export declare function editable(docKey: string | undefined): (path: string, type: EditFieldType, attrs?: EditableAttrs) => Record<string, string>;
//# sourceMappingURL=editable.d.ts.map