import { parsePath } from "./path";

/** The one place the field-type union lives (SKINMENU rule 16). */
export type EditFieldType = "text" | "richtext" | "media" | "select" | "number" | "url" | "date" | "tags" | "toggle";

/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`. Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export function editable(docKey: string | undefined) {
  return (path: string, type: EditFieldType): Record<string, string> => {
    if (docKey === undefined) return {};
    parsePath(path);
    return { "data-edit-field": `${docKey}:${path}`, "data-edit-type": type };
  };
}
