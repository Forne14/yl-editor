// Field groups: the plain fields inside a `[data-edit-group]` wrapper are drawn as one dashed outline with thin dashed
// lines between the fields, the way a list is (docs/specs/artefacts/2026-11-field-groups.html, rulings G1-G10 on #44).
// The host's wrapper is borrowed: the chrome adds a class and its own `.cms-root` children, positions them only through
// custom properties (CSP-safe), and `detach` takes every one of them back out.
//
// Invariants:
// - A group is a wrapper with at least two fields the chrome knows. Fewer draws nothing and adds nothing.
// - Never a group inside a group (the outermost wins), a group holding a list, or a group inside a list item: each is
//   dropped at scan time with one console warning per element.
// - `paint` is the only writer of separators and positions; `schedule` coalesces any number of requests into one paint
//   per animation frame. `detach` cancels the frame, disconnects the observer, and removes every node and class added.
// - The crossing check (`createOutlineWatch`) only reads boxes and warns once per pair of elements per mount; it never
//   changes the page, so a recheck cannot trigger another one.
import { element } from "./dom.ts";
import { boxOf, cellLines, layOut, px, type Box } from "./lists.ts";

export interface GroupRecord {
  element: HTMLElement;
  detach?: () => void;
  /** Draws the group now. Nothing until it is attached. */
  paint: () => void;
  /** Draws it on the next animation frame; any number of calls before then are one paint. */
  schedule: () => void;
}

/** The elements already warned about, so a rescan doesn't repeat a warning. */
const told = new WeakSet<Element>();

/** `<section id="hero" data-edit-group>`: enough for a developer to find the element. */
function describe(node: Element): string {
  const attributes = [...node.attributes]
    .filter((attribute) => attribute.name === "id" || attribute.name.startsWith("data-edit-"))
    .map((attribute) => (attribute.value === "" ? attribute.name : `${attribute.name}="${attribute.value}"`));
  return `<${[node.localName, ...attributes].join(" ")}>`;
}

function warnOnce(node: Element, message: string): void {
  if (told.has(node)) return;
  told.add(node);
  console.warn(`[yl-editor] ${describe(node)} ${message} See docs/chrome.md → Groups.`);
}

/** Every `[data-edit-group]` under `root` the chrome will draw, in page order. */
export function scanGroups(root: HTMLElement): GroupRecord[] {
  const records: GroupRecord[] = [];
  const candidates = [
    ...(root.matches("[data-edit-group]") ? [root] : []),
    ...root.querySelectorAll<HTMLElement>("[data-edit-group]"),
  ];
  for (const target of candidates) {
    if (target.closest(".cms-root")) continue;
    if (target.closest("[data-edit-item]")) {
      warnOnce(target, "is inside a list item, so it is ignored: the item's fields already share the list's outline.");
      continue;
    }
    const list = target.matches("[data-edit-list]") ? target : target.querySelector("[data-edit-list]");
    if (list) {
      warnOnce(target, `holds the list ${describe(list)}, so it is ignored: its fields keep their own outlines.`);
      continue;
    }
    if (records.some((outer) => outer.element.contains(target))) {
      warnOnce(target, "is inside another data-edit-group, so it is ignored: the outer group draws all its fields.");
      continue;
    }
    records.push({ element: target, paint: () => undefined, schedule: () => undefined });
  }
  return records;
}

/**
 * Draws the group: a frame, and a line between its fields from their boxes. `recordOf` answers for a field element the
 * chrome knows (`editable` false for a locked one); an element it doesn't know isn't a member.
 */
export function attachGroup(
  record: GroupRecord,
  recordOf: (element: HTMLElement) => { editable: boolean } | undefined,
): void {
  record.detach?.();
  const host = record.element;
  const members = [...host.querySelectorAll<HTMLElement>("[data-edit-field]")].filter(
    (node) => !node.closest(".cms-root") && recordOf(node) !== undefined,
  );
  if (members.length < 2) return;

  const hadClass = host.hasAttribute("class");
  const childTag = host.tagName === "UL" || host.tagName === "OL" ? "li" : "div";
  host.classList.add("cms-group");
  const frame = element(childTag, { class: "cms-root cms-group__frame", "aria-hidden": "true" });
  host.prepend(frame);
  const separators: HTMLElement[] = [];

  const separator = (axis: "v" | "h", x: number, y: number, length: number) => {
    const sep = element(childTag, { class: `cms-root cms-group__sep cms-group__sep--${axis}`, "aria-hidden": "true" });
    sep.style.setProperty("--cms-sep-x", px(x));
    sep.style.setProperty("--cms-sep-top", px(y));
    sep.style.setProperty("--cms-sep-length", px(length));
    host.append(sep);
    separators.push(sep);
  };

  const paint = () => {
    for (const node of separators.splice(0)) node.remove();
    host.classList.toggle(
      "cms-group--locked",
      members.every((node) => recordOf(node)?.editable !== true),
    );
    const origin = host.getBoundingClientRect();
    const pad = Number.parseFloat(getComputedStyle(frame).getPropertyValue("--cms-list-pad")) || 12;
    // Inside the frame's 2px border.
    const edge = { left: -pad + 2, right: origin.width + pad - 2 };
    const top = -pad + 2;
    const bottom = origin.height + pad - 2;
    const cells = members
      .map((node) => ({ box: boxOf(node, origin) }))
      .filter(({ box }) => box.r - box.l > 0 && box.b - box.t > 0);
    // A line is fields sharing a stretch of height; one on top of another are lines of their own (a column).
    const { lines } = layOut(
      cells.map((cell) => cell.box),
      cells,
    );
    lines.forEach((line, index) => {
      const previous = lines[index - 1];
      const next = lines[index + 1];
      const from = previous ? (previous.bottom + line.top) / 2 : top;
      const to = next ? (line.bottom + next.top) / 2 : bottom;
      // A line starts just past the horizontal one above it, so the two only touch.
      const start = previous ? from + 1 : from;
      if (previous) separator("h", edge.left, from, edge.right - edge.left);
      const inside = cellLines(
        line.cells.map((cell: { box: Box }) => cell.box),
        edge,
      );
      for (const x of inside.vertical) separator("v", x, start, to - start);
      for (const { x, y, w } of inside.horizontal) separator("h", x, y, w);
    });
  };

  let frameRequest: number | undefined;
  const schedule = () => {
    if (frameRequest !== undefined) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = undefined;
      paint();
    });
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  if (observer) {
    observer.observe(host);
    for (const node of members) observer.observe(node);
  }
  // A viewport change can move `--cms-list-pad` through a media query without resizing any observed box.
  window.addEventListener("resize", schedule);
  record.paint = paint;
  record.schedule = schedule;
  paint();

  record.detach = () => {
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    for (const node of separators.splice(0)) node.remove();
    frame.remove();
    host.classList.remove("cms-group", "cms-group--locked");
    if (!hadClass && host.classList.length === 0) host.removeAttribute("class");
    record.detach = undefined;
    record.paint = () => undefined;
    record.schedule = () => undefined;
  };
}

export interface OutlineWatch {
  /** Checks on the next animation frame; any number of calls before then are one check. */
  schedule(): void;
  /** Checks now. */
  check(): void;
  destroy(): void;
}

/** What a dashed outline overhangs its field by: `--cms-space-1`. */
const FIELD_OFFSET = 4;
const EDGE = 0.5;

/**
 * Warns when two dashed outlines cross (G10): a plain field's outline with its offset, a group's frame, a list's frame.
 * One outline inside another is fine; so is one apart. Once per pair of elements, however often it is rechecked.
 * `active` is false while the editor isn't editing: nothing is drawn then.
 */
export function createOutlineWatch(root: HTMLElement, active: () => boolean): OutlineWatch {
  const ids = new WeakMap<Element, number>();
  let nextId = 1;
  const idOf = (node: Element): number => {
    let id = ids.get(node);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      ids.set(node, id);
    }
    return id;
  };
  // Bounded by the pairs of outlines on the page, and by the number of elements ever seen crossing.
  const reported = new Set<string>();

  let schedule: () => void = () => undefined;
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule());

  const outlines = (): { node: Element; box: Box }[] => {
    const found: { node: Element; box: Box }[] = [];
    const add = (node: Element, box: Box, grow: number) => {
      // Observed even when it has no size yet: showing it rechecks.
      observer?.observe(node);
      if (box.r - box.l <= 0 || box.b - box.t <= 0) return;
      found.push({ node, box: { l: box.l - grow, r: box.r + grow, t: box.t - grow, b: box.b + grow } });
    };
    const viewport = { left: 0, top: 0 };
    for (const node of root.querySelectorAll(".cms-field")) {
      if (node.closest(".cms-group, .cms-item")) continue;
      add(node, boxOf(node, viewport), FIELD_OFFSET);
    }
    for (const node of root.querySelectorAll(".cms-group")) {
      const frame = node.querySelector(":scope > .cms-group__frame");
      const pad = frame ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--cms-list-pad")) || 12 : 12;
      add(node, boxOf(node, viewport), pad);
    }
    for (const node of root.querySelectorAll(".cms-list__frame")) add(node, boxOf(node, viewport), 0);
    return found;
  };

  const inside = (outer: Box, inner: Box) =>
    outer.l <= inner.l + EDGE && outer.r >= inner.r - EDGE && outer.t <= inner.t + EDGE && outer.b >= inner.b - EDGE;
  const crosses = (a: Box, b: Box) =>
    Math.min(a.r, b.r) - Math.max(a.l, b.l) > EDGE &&
    Math.min(a.b, b.b) - Math.max(a.t, b.t) > EDGE &&
    !inside(a, b) &&
    !inside(b, a);

  const check = () => {
    if (!active()) return;
    const found = outlines();
    for (const [index, a] of found.entries()) {
      for (const b of found.slice(index + 1)) {
        if (!crosses(a.box, b.box)) continue;
        const ids2 = [idOf(a.node), idOf(b.node)].sort((x, y) => x - y);
        const pair = ids2.join(":");
        if (reported.has(pair)) continue;
        reported.add(pair);
        console.warn(
          `[yl-editor] The dashed outlines of ${describe(a.node)} and ${describe(b.node)} cross. Give the fields room, or wrap neighbouring fields in an element carrying editable(docKey).group() so they share one outline. See docs/chrome.md → Groups.`,
        );
      }
    }
  };

  let frameRequest: number | undefined;
  schedule = () => {
    if (frameRequest !== undefined) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = undefined;
      check();
    });
  };
  window.addEventListener("resize", schedule);
  return {
    schedule: () => schedule(),
    check,
    destroy() {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
      frameRequest = undefined;
    },
  };
}
