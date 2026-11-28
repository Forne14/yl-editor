// Field groups: the plain fields inside a `[data-edit-group]` wrapper are drawn as one dashed outline with thin dashed
// lines between the fields, the way a list is (docs/specs/artefacts/2026-11-field-groups.html, rulings G1-G10 on #44).
// The host's wrapper is borrowed: the chrome adds a class and its own `.cms-root` children, positions them only through
// custom properties (CSP-safe), and `detach` takes every one of them back out.
//
// Invariants:
// - Membership (G12, option B of docs/specs/artefacts/2026-11-field-groups-live-layout.html) is decided only by
//   `attachGroup`, which runs at the mount's scan and dress, setEditing(true), a list swap's rescan, a refresh, and the
//   Discard of a never-published document. Members are the wrapper's `[data-edit-field]` elements the chrome dresses
//   now (`recordOf` knows them and they are attached), not inside a `[data-edit-list]` or `[data-edit-item]`; the mount's
//   `recordOf` leaves out fields whose document the editor doesn't have (a set the mount keeps beside their reason, never
//   a comparison with an overridable string), so a Discard-deleted field never rejoins. Fewer than two members at
//   attach: no group, no class, no node. Layout (boxes, display, host CSS keyed on `.cms-group`) never changes
//   membership: paint has no retire path, so it can't loop.
// - Members carry `data-cms-member` exactly while their group is drawn: attach sets it on this attach's members, retire
//   (every detach, and the re-attach's detach first) takes it off them. The chrome's CSS and the crossing check key on it,
//   never on being inside `.cms-group`, so a field in a drawn group that isn't a member keeps its own outline and is
//   checked. An attribute, not a class: a field's detach drops its class attribute from what it saw at its own attach,
//   which a class the group added before or after it would make wrong in one order or the other.
// - Paint only places the frame and lines from the members' boxes. A member with no box (hidden at this width) gets no
//   line beside it and isn't laid out; the frame still goes round the wrapper. The locked class is set at attach from
//   the members' editability (G3), which only changes through a path that re-attaches.
// - Display (G11) is read at scan only. A wrapper that turns inline or contents later (a breakpoint) is unsupported.
// - Measurement policy (shared with the list painter in lists.ts): never parse a CSS length in JS. An unregistered
//   custom property computes to its unresolved token (`1rem`, `calc()`), so `--cms-list-pad` and `--cms-space-1` are
//   never read. Geometry comes from rendered boxes: the wrapper's padding box (border box + clientLeft/clientTop,
//   clientWidth/clientHeight), where its absolutely positioned children sit; the pad is the frame's rect against that
//   padding box (the frame's inset is -pad); the frame's border is its computed `border-*-width`, and a plain field's
//   outline reach is its computed `outline-offset` + `outline-width` (real properties, so px). 0 is a value; only an
//   unreadable one (no box, an empty style: an engine without layout) takes the fallback.
// - Measure after styling: attach adds `cms-group` and the frame before the first paint measures anything, so host CSS
//   keyed on `.cms-group` is in every box a paint reads.
// - Nodes: the frame and separators are appended to the wrapper, never prepended, so host `:first-child` and
//   `> * + *` rules match the same elements in edit mode.
// - Never a group inside a group (the outermost wins), a group holding a list, a group inside a list (between the list
//   and its items, or inside an item), an inline wrapper (computed display `inline` or `contents`: it has no box of
//   its own to frame, G11), or a wrapper that is itself a `[data-edit-field]` (the field's classes and outline are the
//   field's): each is dropped at scan time and its fields keep their own outlines. So the wrapper's class attribute has
//   one chrome writer, and `hadClass` read at attach is the host's.
// - Warnings: scan-time ones (G5, G7, G8, G11, a field wrapper) and the clipping one (a wrapper whose overflow clips its
//   outline) are once per element and kind per mount: the mount owns the `Warnings` and passes it in. Bounded by
//   elements x 6 kinds.
// - `attachGroup` is the only writer of the group classes, the member attribute and the frame; `paint` the only writer
//   of separators and their positions; `schedule` coalesces any number of requests into one paint per animation frame.
//   `detach` cancels the frame, disconnects the observer (which watches the wrapper and the members, nothing else), and
//   removes every node, class and attribute added.
// - Crossing hand-off: an attach whose member set differs from the one it replaces (a group drawn, gone, or a member in
//   or out) calls `changed` once, which the mount wires to the crossing watch's `schedule`: one scheduled check per
//   change, coalesced with any other into one check per frame. A paint never calls it. `detach` doesn't either: every
//   caller of detach either stops editing (which runs one check that lets the watch go), rescans and attaches again
//   (which schedules), or destroys the mount.
// - The crossing check (`createOutlineWatch`) only reads boxes, and warns once per pair of elements per mount; it never
//   changes the page. Its outlines are each drawn group's frame, each list's frame, and every `.cms-field` that is
//   neither a member nor in a list item (those share a frame), the same fields the CSS leaves an outline on. On each check its observer watches exactly the current outlines: it is disconnected and
//   re-observed only when that set changed, so a removed node isn't held and a recheck triggers at most one more check
//   (the new observations' first report), which finds the same set and stops. A check while not editing watches
//   nothing; the mount runs one on Done, so the watch holds no node while the page is the host's. Once destroyed,
//   `schedule` and `check` are no-ops: no frame is requested and nothing is observed again.
import { element } from "./dom.ts";
import {
  FRAME_PAD,
  boxOf,
  cellLines,
  computedPixels,
  frameBorder,
  framePad,
  layOut,
  paddingBox,
  px,
  type Box,
} from "./lists.ts";

export interface GroupRecord {
  element: HTMLElement;
  /** The fields the last attach made members; empty while nothing is drawn. Only `attachGroup` and detach set it. */
  members?: readonly HTMLElement[];
  detach?: () => void;
  /** Draws the group now. Nothing until it is attached. */
  paint: () => void;
  /** Draws it on the next animation frame; any number of calls before then are one paint. */
  schedule: () => void;
}

/** Warns about `node` once per kind; one per mount, so a rescan doesn't repeat a warning but a new mount does. */
export type Warnings = (
  node: Element,
  kind: "item" | "list" | "nested" | "inline" | "field" | "clip",
  message: string,
) => void;

export function createWarnings(): Warnings {
  const told = new WeakMap<Element, Set<string>>();
  return (node, kind, message) => {
    const kinds = told.get(node) ?? new Set<string>();
    if (kinds.has(kind)) return;
    kinds.add(kind);
    told.set(node, kinds);
    console.warn(`[yl-editor] ${describe(node)} ${message} See docs/chrome.md → Groups.`);
  };
}

/** `<section id="hero" data-edit-group>`: enough for a developer to find the element. */
function describe(node: Element): string {
  const attributes = [...node.attributes]
    .filter((attribute) => attribute.name === "id" || attribute.name.startsWith("data-edit-"))
    .map((attribute) => (attribute.value === "" ? attribute.name : `${attribute.name}="${attribute.value}"`));
  return `<${[node.localName, ...attributes].join(" ")}>`;
}

/** Every `[data-edit-group]` under `root` the chrome will draw, in page order. */
export function scanGroups(root: HTMLElement, warn: Warnings): GroupRecord[] {
  const records: GroupRecord[] = [];
  const candidates = [
    ...(root.matches("[data-edit-group]") ? [root] : []),
    ...root.querySelectorAll<HTMLElement>("[data-edit-group]"),
  ];
  for (const target of candidates) {
    if (target.closest(".cms-root")) continue;
    // The field's own outline and classes are the field's: framing it too would put two outlines on one element.
    if (target.matches("[data-edit-field]")) {
      warn(
        target,
        "field",
        "is itself a data-edit-field, so it is ignored: its fields keep their own outlines. Put data-edit-group on an element around the fields.",
      );
      continue;
    }
    if (target.closest("[data-edit-item]")) {
      warn(
        target,
        "item",
        "is inside a list item, so it is ignored: the item's fields already share the list's outline.",
      );
      continue;
    }
    // Between a list and its items: the list's frame already goes round everything in it.
    const outer = target.parentElement?.closest("[data-edit-list]");
    if (outer) {
      warn(
        target,
        "item",
        `is inside the list ${describe(outer)}, so it is ignored: the list's fields already share the list's outline.`,
      );
      continue;
    }
    const list = target.matches("[data-edit-list]") ? target : target.querySelector("[data-edit-list]");
    if (list) {
      warn(target, "list", `holds the list ${describe(list)}, so it is ignored: its fields keep their own outlines.`);
      continue;
    }
    if (records.some((outer) => outer.element.contains(target))) {
      warn(
        target,
        "nested",
        "is inside another data-edit-group, so it is ignored: the outer group draws all its fields.",
      );
      continue;
    }
    // An inline wrapper's box is its line boxes (none at all for `contents`): there is no one rectangle to frame (G11).
    const display = getComputedStyle(target).display;
    if (display === "inline" || display === "contents") {
      warn(
        target,
        "inline",
        `is display: ${display}, so it is ignored: its fields keep their own outlines. Make the wrapper block-level or inline-block to give them one.`,
      );
      continue;
    }
    records.push({ element: target, paint: () => undefined, schedule: () => undefined });
  }
  return records;
}

/** On each member while its group is drawn: the chrome's CSS and the crossing check key on members, not on position. */
const MEMBER = "data-cms-member";

/** Overflow values that cut off what reaches past the padding box, as the frame does by the pad. */
const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);

function clips(node: Element): string | undefined {
  const style = getComputedStyle(node);
  // `overflow` too: an engine that keeps only the shorthand still says what it is.
  const values = `${style.overflowX} ${style.overflowY} ${style.overflow}`.split(/\s+/);
  return values.find((value) => CLIPS.has(value));
}

/**
 * Decides the group's members and draws it: a frame, and a line between its members from their boxes. `recordOf`
 * answers for a field element the chrome knows (`editable` false for a locked one, `detach` set while it is dressed);
 * an element it doesn't know, or one not dressed now, isn't a member. `changed` is called once when this attach's
 * members differ from the ones it replaces (a group drawn, gone, or a member in or out): the outlines on the page moved.
 */
export function attachGroup(
  record: GroupRecord,
  recordOf: (element: HTMLElement) => { editable: boolean; detach?: unknown } | undefined,
  warn: Warnings,
  changed: () => void,
): void {
  const before = record.members ?? [];
  record.detach?.();
  const host = record.element;
  const found = [...host.querySelectorAll<HTMLElement>("[data-edit-field]")].filter(
    (node) => !node.closest(".cms-root, [data-edit-list], [data-edit-item]") && recordOf(node)?.detach !== undefined,
  );
  const members = found.length < 2 ? [] : found;
  record.members = members;
  if (members.length !== before.length || members.some((node, index) => before[index] !== node)) changed();
  if (members.length === 0) return;

  const hadClass = host.hasAttribute("class");
  const childTag = host.tagName === "UL" || host.tagName === "OL" ? "li" : "div";
  const frame = element(childTag, { class: "cms-root cms-group__frame", "aria-hidden": "true" });
  const separators: HTMLElement[] = [];

  const separator = (axis: "v" | "h", x: number, y: number, length: number) => {
    const sep = element(childTag, { class: `cms-root cms-group__sep cms-group__sep--${axis}`, "aria-hidden": "true" });
    sep.style.setProperty("--cms-sep-x", px(x));
    sep.style.setProperty("--cms-sep-top", px(y));
    sep.style.setProperty("--cms-sep-length", px(length));
    host.append(sep);
    separators.push(sep);
  };

  /** Takes the frame, the separators and the classes back out: the fields look plain. */
  const retire = () => {
    for (const node of separators.splice(0)) node.remove();
    frame.remove();
    for (const node of members) node.removeAttribute(MEMBER);
    host.classList.remove("cms-group", "cms-group--locked");
    if (!hadClass && host.classList.length === 0) host.removeAttribute("class");
  };

  // Styled before any paint measures, so host CSS keyed on `.cms-group` is in the boxes it reads.
  host.classList.add("cms-group");
  host.classList.toggle(
    "cms-group--locked",
    members.every((node) => recordOf(node)?.editable !== true),
  );
  // An attribute, not a class: a field's own detach decides whether its class attribute goes, from what it found.
  for (const node of members) node.setAttribute(MEMBER, "");
  host.append(frame);
  const clipping = clips(host);
  if (clipping) {
    warn(
      host,
      "clip",
      `has overflow: ${clipping}, so it clips its group's outline, which sits --cms-list-pad outside it. Let it overflow, or give the group room inside an element that clips.`,
    );
  }

  const hasBox = (box: Box) => box.r - box.l > 0 && box.b - box.t > 0;
  /** Places the lines from the members' boxes now. It never changes who is a member or whether the group is drawn. */
  const paint = () => {
    for (const node of separators.splice(0)) node.remove();
    const origin = paddingBox(host);
    // A member hidden at this width has no box: no line beside it, and the frame still goes round the wrapper.
    const shown = members.map((node) => ({ node, box: boxOf(node, origin) })).filter(({ box }) => hasBox(box));
    const pad = framePad(frame, origin);
    const border = frameBorder(frame);
    // Inside the frame's border.
    const edge = { left: -pad + border.left, right: origin.width + pad - border.right };
    const top = -pad + border.top;
    const bottom = origin.height + pad - border.bottom;
    // A line is fields sharing a stretch of height; one on top of another are lines of their own (a column).
    const { lines } = layOut(
      shown.map((cell) => cell.box),
      shown,
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
  // The wrapper and the members: a member that moves, or is shown or hidden, moves the lines.
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
  if (observer) {
    observer.observe(host);
    for (const node of members) observer.observe(node);
  }
  // A viewport change can move the pad through a media query without resizing any observed box.
  window.addEventListener("resize", schedule);
  record.paint = paint;
  record.schedule = schedule;
  paint();

  record.detach = () => {
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    retire();
    record.members = [];
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

/** A plain field's outline when its style can't be read: `--cms-space-1`'s 4px offset and `--cms-outline`'s 2px. */
const FIELD_OFFSET = 4;
const FIELD_OUTLINE = 2;
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

  let destroyed = false;
  let schedule: () => void = () => undefined;
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule());
  /** What the observer watches: the outlines of the last check, whatever their size (showing one rechecks). */
  let watched = new Set<Element>();
  const watch = (nodes: readonly Element[]) => {
    if (nodes.length === watched.size && nodes.every((node) => watched.has(node))) return;
    observer?.disconnect();
    watched = new Set(nodes);
    for (const node of nodes) observer?.observe(node);
  };

  const outlines = (): { node: Element; box: Box }[] => {
    const seen: Element[] = [];
    const found: { node: Element; box: Box }[] = [];
    const add = (node: Element, box: Box, grow: number) => {
      seen.push(node);
      if (box.r - box.l <= 0 || box.b - box.t <= 0) return;
      found.push({ node, box: { l: box.l - grow, r: box.r + grow, t: box.t - grow, b: box.b + grow } });
    };
    const viewport = { left: 0, top: 0 };
    for (const node of root.querySelectorAll(".cms-field")) {
      // A member shares its group's frame; a field in a group that isn't a member keeps its own outline.
      if (node.hasAttribute(MEMBER) || node.closest(".cms-item")) continue;
      // The outline is drawn outline-offset outside the border box, and is outline-width thick.
      const style = getComputedStyle(node);
      const reach =
        computedPixels(style, "outline-offset", FIELD_OFFSET) + computedPixels(style, "outline-width", FIELD_OUTLINE);
      add(node, boxOf(node, viewport), reach);
    }
    for (const node of root.querySelectorAll<HTMLElement>(".cms-group")) {
      const frame = node.querySelector(":scope > .cms-group__frame");
      // The frame sits in the wrapper's padding box, reaching the pad past it.
      const inner = paddingBox(node);
      const pad = frame ? framePad(frame, inner) : FRAME_PAD;
      add(node, { l: inner.left, r: inner.left + inner.width, t: inner.top, b: inner.top + inner.height }, pad);
    }
    for (const node of root.querySelectorAll(".cms-list__frame")) add(node, boxOf(node, viewport), 0);
    watch(seen);
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
    if (destroyed) return;
    if (!active()) {
      // Nothing is drawn: hold nothing until editing starts again (which schedules a check).
      watch([]);
      return;
    }
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
    if (destroyed || frameRequest !== undefined) return;
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
      destroyed = true;
      observer?.disconnect();
      watched = new Set();
      window.removeEventListener("resize", schedule);
      if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
      frameRequest = undefined;
    },
  };
}
