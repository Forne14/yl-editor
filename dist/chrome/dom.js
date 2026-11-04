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
/** Reads a value at a dotted path, own properties only, so a key like `__proto__` never walks the prototype. */
export function valueAtPath(root, path) {
    let node = root;
    for (const segment of path.split(".")) {
        if (node === null || typeof node !== "object")
            return undefined;
        const property = Array.isArray(node) && /^\d+$/.test(segment) ? Number(segment) : segment;
        if (!Object.hasOwn(node, property))
            return undefined;
        node = node[property];
    }
    return node;
}
//# sourceMappingURL=dom.js.map