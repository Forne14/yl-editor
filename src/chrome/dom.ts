// Small DOM helpers. No innerHTML anywhere: every string the chrome shows goes in as text, so a document key or a
// server message can never become markup.

type Attributes = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;

// Classes on host markup. Invariants:
// - Every chrome class on a host element (a field, a list, an item, a group wrapper) goes on through `addHostClass` and
//   comes off through `removeHostClass`. One element can be dressed by more than one part (an item that is also a
//   field), each letting go in its own order, so whether the class attribute was the host's is decided once, by the
//   first add, and kept here per element, not per part.
// - The attribute is removed only when the chrome created it and no class is left on it; then the element is forgotten,
//   so a later add decides afresh; an add that finds an empty `class=""` also decides afresh (the host emptied it). The host's own attribute (even `class=""`) is never removed.
// - Weak: an element that left the page isn't held. Bounded by the host elements the chrome has dressed and not let go.
const classAttributeIsOurs = new WeakSet<Element>();

/** Adds chrome classes to a host element, remembering whether its class attribute was the host's. */
export function addHostClass(node: Element, ...names: string[]): void {
  if (!node.hasAttribute("class")) classAttributeIsOurs.add(node);
  // An empty attribute with no chrome class on it is the host's now (it emptied what we left): a later remove keeps it.
  else if (node.classList.length === 0) classAttributeIsOurs.delete(node);
  node.classList.add(...names);
}

/** Takes chrome classes back off a host element; the class attribute goes too if the chrome made it and it is empty. */
export function removeHostClass(node: Element, ...names: string[]): void {
  node.classList.remove(...names);
  if (node.classList.length > 0 || !classAttributeIsOurs.has(node)) return;
  node.removeAttribute("class");
  classAttributeIsOurs.delete(node);
}

export function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes: Attributes = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  variant?: "primary" | "danger" | "ghost",
  attributes: Attributes = {},
): HTMLButtonElement {
  const className = variant ? `cms-btn cms-btn--${variant}` : "cms-btn";
  const node = element("button", { type: "button", class: className, ...attributes }, [label]);
  node.addEventListener("click", onClick);
  return node;
}

/** Collects teardown callbacks so `destroy()` can prove it removed every listener it added. */
export class Disposer {
  private readonly callbacks: (() => void)[] = [];

  listen<Target extends EventTarget>(
    target: Target,
    type: string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.callbacks.push(() => target.removeEventListener(type, handler, options));
  }

  add(callback: () => void): void {
    this.callbacks.push(callback);
  }

  dispose(): void {
    while (this.callbacks.length > 0) this.callbacks.pop()?.();
  }
}

let idCounter = 0;
export function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** A `_key` id, as docs/paths.md defines it: the one copy the browser bundle uses. */
export const KEY_ID = "[A-Za-z0-9_-]+";
const KEY_PATTERN = new RegExp(`^${KEY_ID}$`);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Whether `value` is a `_key` the paths accept: a string of the id alphabet, and not a name they refuse. */
export function isItemKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value) && !FORBIDDEN_KEYS.has(value);
}
const KEYED_PART = new RegExp(`^(.+)\\[_key=(${KEY_ID})\\]$`);

function ownChild(node: unknown, segment: string): unknown {
  if (node === null || typeof node !== "object") return undefined;
  const property = Array.isArray(node) && /^\d+$/.test(segment) ? Number(segment) : segment;
  return Object.hasOwn(node, property) ? (node as Record<string | number, unknown>)[property] : undefined;
}

/**
 * Reads a value at a path (`a.b.0.c`, `items[_key=abc].title`; see docs/paths.md), own properties only, so a key
 * like `__proto__` never walks the prototype. Not `getAt` from src/path.ts: that module pulls zod in at runtime, and
 * the island stays free of it.
 */
export function valueAtPath(root: unknown, path: string): unknown {
  let node: unknown = root;
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
