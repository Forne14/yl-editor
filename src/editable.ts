import { parsePath } from "./path.ts";

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
export function editable(docKey: string | undefined) {
  return (path: string, type: EditFieldType, attrs?: EditableAttrs): Record<string, string> => {
    if (docKey === undefined) return {};
    parsePath(path);
    const result: Record<string, string> = { "data-edit-field": `${docKey}:${path}`, "data-edit-type": type };
    if (attrs?.options !== undefined) result["data-edit-options"] = JSON.stringify(attrs.options);
    if (attrs?.label !== undefined) result["data-edit-label"] = attrs.label;
    return result;
  };
}
