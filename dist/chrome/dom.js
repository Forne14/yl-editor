// Small DOM helpers. No innerHTML anywhere: every string the chrome shows goes in as text, so a document key or a
// server message can never become markup.
export function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (value === undefined || value === false)
            continue;
        node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false)
            continue;
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}
export function button(label, onClick, variant, attributes = {}) {
    const className = variant ? `cms-btn cms-btn--${variant}` : "cms-btn";
    const node = element("button", { type: "button", class: className, ...attributes }, [label]);
    node.addEventListener("click", onClick);
    return node;
}
/** Collects teardown callbacks so `destroy()` can prove it removed every listener it added. */
export class Disposer {
    callbacks = [];
    listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this.callbacks.push(() => target.removeEventListener(type, handler, options));
    }
    add(callback) {
        this.callbacks.push(callback);
    }
    dispose() {
        while (this.callbacks.length > 0)
            this.callbacks.pop()?.();
    }
}
let idCounter = 0;
export function uniqueId(prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}
const KEYED_PART = /^(.+)\[_key=([A-Za-z0-9_-]+)\]$/;
function ownChild(node, segment) {
    if (node === null || typeof node !== "object")
        return undefined;
    const property = Array.isArray(node) && /^\d+$/.test(segment) ? Number(segment) : segment;
    return Object.hasOwn(node, property) ? node[property] : undefined;
}
/**
 * Reads a value at a path (`a.b.0.c`, `items[_key=abc].title`; see docs/paths.md), own properties only, so a key
 * like `__proto__` never walks the prototype. Not `getAt` from src/path.ts: that module pulls zod in at runtime, and
 * the island stays free of it.
 */
export function valueAtPath(root, path) {
    let node = root;
    for (const part of path.split(".")) {
        const keyed = KEYED_PART.exec(part);
        if (!keyed) {
            node = ownChild(node, part);
            continue;
        }
        const items = ownChild(node, keyed[1] ?? "");
        node = Array.isArray(items) ? items.find((item) => ownChild(item, "_key") === keyed[2]) : undefined;
    }
    return node;
}
//# sourceMappingURL=dom.js.map