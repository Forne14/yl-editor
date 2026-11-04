import { parsePath } from "./path.js";
/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`. Pass `undefined` outside edit mode so anonymous HTML
 * carries no editor attributes at all (spec §3.4).
 */
export function editable(docKey) {
    return (path, type, attrs) => {
        if (docKey === undefined)
            return {};
        parsePath(path);
        const result = { "data-edit-field": `${docKey}:${path}`, "data-edit-type": type };
        if (attrs?.options !== undefined)
            result["data-edit-options"] = JSON.stringify(attrs.options);
        if (attrs?.label !== undefined)
            result["data-edit-label"] = attrs.label;
        return result;
    };
}
//# sourceMappingURL=editable.js.map