// Small DOM helpers. No innerHTML anywhere: every string the chrome shows goes in as text, so a document key or a
// server message can never become markup.

type Attributes = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined | false;

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

/** Reads a value at a dotted path, own properties only, so a key like `__proto__` never walks the prototype. */
export function valueAtPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    const property = Array.isArray(node) && /^\d+$/.test(segment) ? Number(segment) : segment;
    if (!Object.hasOwn(node, property)) return undefined;
    node = (node as Record<string | number, unknown>)[property];
  }
  return node;
}
