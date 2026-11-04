/** The one place the field-type union lives. */
export type EditFieldType = "text" | "richtext" | "media" | "select" | "number" | "url" | "date" | "tags" | "toggle";
/** Optional extras the chrome reads: the choices for a `select`, and a human label for the badge. */
export interface EditableAttrs {
    options?: readonly string[];
    label?: string;
}
/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`. Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export declare function editable(docKey: string | undefined): (path: string, type: EditFieldType, attrs?: EditableAttrs) => Record<string, string>;
//# sourceMappingURL=editable.d.ts.map