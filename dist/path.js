import { PathError } from "./types.js";
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
export function parsePath(path) {
    if (path.length === 0)
        throw new PathError("Empty path");
    return path.split(".").map((part) => {
        if (part.length === 0)
            throw new PathError(`Empty segment in ${path}`);
        if (FORBIDDEN.has(part))
            throw new PathError(`Forbidden segment ${part}`);
        return /^\d+$/.test(part) ? Number(part) : part;
    });
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkSegment(seg) {
    if (typeof seg === "number") {
        if (!Number.isInteger(seg) || seg < 0)
            throw new PathError(`Invalid index ${seg}`);
    }
    else if (FORBIDDEN.has(seg)) {
        throw new PathError(`Forbidden segment ${seg}`);
    }
}
/** Own-property child lookup; never follows the prototype chain. */
function childOf(node, seg) {
    if (typeof seg === "number")
        return Array.isArray(node) && Object.hasOwn(node, seg) ? node[seg] : undefined;
    return isRecord(node) && Object.hasOwn(node, seg) ? node[seg] : undefined;
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
        const next = childOf(node, seg);
        if (next === undefined || next === null || typeof next !== "object")
            throw new PathError(`No container at ${String(seg)}`);
        node = next;
    }
    return [clone, node, path[path.length - 1]];
}
export function setAt(root, path, value) {
    const [clone, parent, last] = parentOf(root, path);
    if (typeof last === "number") {
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