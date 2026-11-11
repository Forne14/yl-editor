function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function join(base, seg) {
    return base === "" ? String(seg) : `${base}.${seg}`;
}
function walk(before, after, path, out) {
    if (before === undefined && after === undefined)
        return;
    if (before === undefined) {
        out.push({ path, kind: "added", after });
        return;
    }
    if (after === undefined) {
        out.push({ path, kind: "removed", before });
        return;
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const len = Math.max(before.length, after.length);
        for (let i = 0; i < len; i++) {
            if (i >= before.length)
                out.push({ path: join(path, i), kind: "added", after: after[i] });
            else if (i >= after.length)
                out.push({ path: join(path, i), kind: "removed", before: before[i] });
            else
                walk(before[i], after[i], join(path, i), out);
        }
        return;
    }
    if (isRecord(before) && isRecord(after)) {
        for (const key of Object.keys(after))
            walk(before[key], after[key], join(path, key), out);
        for (const key of Object.keys(before)) {
            if (!Object.hasOwn(after, key))
                walk(before[key], undefined, join(path, key), out);
        }
        return;
    }
    if (before !== after)
        out.push({ path, kind: "changed", before, after });
}
/**
 * Structural diff of two JSON payloads. Paths use the `parsePath` grammar
 * (`hero.title`, `items.2.label`); the root value itself has path "".
 */
export function diffPayloads(before, after) {
    const out = [];
    walk(before, after, "", out);
    return out;
}
//# sourceMappingURL=diff.js.map