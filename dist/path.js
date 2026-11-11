import { PathError } from "./types.js";
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const KEY_ID = /^[A-Za-z0-9_-]+$/;
const KEYED_PART = /^(.+)\[_key=([A-Za-z0-9_-]+)\]$/;
const KEY_MARKER = "[_key=";
function isKeySegment(seg) {
    return typeof seg === "object" && seg !== null;
}
function plainSegment(part, path) {
    if (part.length === 0)
        throw new PathError(`Empty segment in ${path}`);
    if (FORBIDDEN.has(part))
        throw new PathError(`Forbidden segment ${part}`);
    return /^\d+$/.test(part) ? Number(part) : part;
}
function keySegment(id) {
    if (!KEY_ID.test(id))
        throw new PathError(`Invalid _key ${JSON.stringify(id)}`);
    if (FORBIDDEN.has(id))
        throw new PathError(`Forbidden _key ${id}`);
    return { key: id };
}
/**
 * Parses `a.b.0.c` and `items[_key=abc].title` into segments. A `name[_key=<id>]` part yields the segment
 * for `name` followed by a `{ key: id }` segment. Throws `PathError` on any malformed or forbidden part.
 */
export function parsePath(path) {
    if (path.length === 0)
        throw new PathError("Empty path");
    return path.split(".").flatMap((part) => {
        if (!part.includes(KEY_MARKER))
            return [plainSegment(part, path)];
        const match = KEYED_PART.exec(part);
        if (match === null)
            throw new PathError(`Malformed keyed segment ${part}`);
        const [, name = "", id = ""] = match;
        if (name.includes(KEY_MARKER))
            throw new PathError(`Malformed keyed segment ${part}`);
        return [plainSegment(name, path), keySegment(id)];
    });
}
/**
 * The inverse of `parsePath`: `parsePath(formatPath(s))` deep-equals `s`, and `formatPath(parsePath(p)) === p`
 * for every canonical path (no leading zeros in indices). Throws `PathError` for segment lists the grammar
 * cannot express: a key segment first or right after another key segment, a name that is empty, all digits,
 * or contains `.` or `[_key=`, a forbidden name or `_key`, or a negative or fractional index.
 */
export function formatPath(segments) {
    if (segments.length === 0)
        throw new PathError("Empty path");
    let out = "";
    segments.forEach((seg, i) => {
        if (isKeySegment(seg)) {
            const prev = segments[i - 1];
            if (prev === undefined || isKeySegment(prev))
                throw new PathError("A key segment must follow a name or index");
            checkSegment(seg);
            out += `${KEY_MARKER}${seg.key}]`;
            return;
        }
        if (typeof seg === "string" &&
            (seg.length === 0 || seg.includes(".") || seg.includes(KEY_MARKER) || /^\d+$/.test(seg)))
            throw new PathError(`Segment ${JSON.stringify(seg)} cannot be formatted`);
        checkSegment(seg);
        out += (i === 0 ? "" : ".") + String(seg);
    });
    return out;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkSegment(seg) {
    if (isKeySegment(seg)) {
        if (typeof seg.key !== "string")
            throw new PathError("Invalid _key");
        keySegment(seg.key);
    }
    else if (typeof seg === "number") {
        if (!Number.isInteger(seg) || seg < 0)
            throw new PathError(`Invalid index ${seg}`);
    }
    else if (FORBIDDEN.has(seg)) {
        throw new PathError(`Forbidden segment ${seg}`);
    }
}
/** Index of the first element of `node` whose own `_key` is `key`; -1 when `node` is not an array or none match. */
function keyedIndex(node, key) {
    if (!Array.isArray(node))
        return -1;
    return node.findIndex((el) => isRecord(el) && Object.hasOwn(el, "_key") && el["_key"] === key);
}
/** Own-property child lookup; never follows the prototype chain. */
function childOf(node, seg) {
    if (isKeySegment(seg)) {
        const i = keyedIndex(node, seg.key);
        return i === -1 ? undefined : node[i];
    }
    if (typeof seg === "number")
        return Array.isArray(node) && Object.hasOwn(node, seg) ? node[seg] : undefined;
    return isRecord(node) && Object.hasOwn(node, seg) ? node[seg] : undefined;
}
function label(seg) {
    return isKeySegment(seg) ? `[_key=${seg.key}]` : String(seg);
}
/** Throws `PathError` when `seg` is a key segment and `node` has no element with that `_key`. */
function requireKeyed(node, seg) {
    if (isKeySegment(seg) && keyedIndex(node, seg.key) === -1)
        throw new PathError(`No item with _key=${seg.key}`);
}
export function getAt(root, path) {
    let node = root;
    for (const seg of path) {
        try {
            checkSegment(seg);
        }
        catch {
            return undefined;
        }
        node = childOf(node, seg);
    }
    return node;
}
/** Walks to the parent of the last segment in a clone; returns [clone, parent, last]. */
function parentOf(root, path) {
    if (path.length === 0)
        throw new PathError("Empty path");
    path.forEach(checkSegment);
    const clone = structuredClone(root);
    let node = clone;
    for (const seg of path.slice(0, -1)) {
        requireKeyed(node, seg);
        const next = childOf(node, seg);
        if (next === undefined || next === null || typeof next !== "object")
            throw new PathError(`No container at ${label(seg)}`);
        node = next;
    }
    return [clone, node, path[path.length - 1]];
}
export function setAt(root, path, value) {
    const [clone, parent, last] = parentOf(root, path);
    if (isKeySegment(last)) {
        if (!Array.isArray(parent))
            throw new PathError("Key into a non-array");
        requireKeyed(parent, last);
        parent[keyedIndex(parent, last.key)] = value;
    }
    else if (typeof last === "number") {
        if (!Array.isArray(parent))
            throw new PathError("Index into a non-array");
        if (last >= parent.length)
            throw new PathError(`Index ${last} out of range`);
        parent[last] = value;
    }
    else {
        if (!isRecord(parent))
            throw new PathError("Key into a non-object");
        parent[last] = value;
    }
    return clone;
}
export function applyArrayOp(root, path, op) {
    const [clone, parent, last] = parentOf(root, path);
    requireKeyed(parent, last);
    const target = childOf(parent, last);
    if (!Array.isArray(target))
        throw new PathError("Array operation on a non-array");
    const inRange = (i, max) => Number.isInteger(i) && i >= 0 && i <= max;
    switch (op.kind) {
        case "insert":
            if (!inRange(op.index, target.length))
                throw new PathError(`Insert index ${op.index} out of range`);
            target.splice(op.index, 0, op.value);
            break;
        case "move": {
            if (!inRange(op.from, target.length - 1) || !inRange(op.to, target.length - 1))
                throw new PathError("Move out of range");
            const [item] = target.splice(op.from, 1);
            target.splice(op.to, 0, item);
            break;
        }
        case "remove":
            if (!inRange(op.index, target.length - 1))
                throw new PathError(`Remove index ${op.index} out of range`);
            target.splice(op.index, 1);
            break;
    }
    return clone;
}
//# sourceMappingURL=path.js.map