import { parsePath } from "./path.js";
const KEY_ID = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
/**
 * The path of one item of the array at `base`: `base[_key=<id>]` when `item` is an object with an own string
 * `_key` that is a valid id (`[A-Za-z0-9_-]+`, not a forbidden name), else `base.<index>`. Prefer it when
 * rendering list items so a save still lands on the right item after a concurrent reorder (docs/paths.md).
 */
export function itemPath(base, item, index) {
    if (typeof item === "object" && item !== null && !Array.isArray(item) && Object.hasOwn(item, "_key")) {
        const key = item["_key"];
        if (typeof key === "string" && KEY_ID.test(key) && !FORBIDDEN.has(key))
            return `${base}[_key=${key}]`;
    }
    return `${base}.${index}`;
}
/**
 * Addressing: `data-edit-field="<docKey>:<json.path>"`, where the path may use
 * stable-key segments (`items[_key=abc].title`, see docs/paths.md). Pass `undefined` outside edit mode so anonymous HTML
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