// Keyed lists: finding `[data-edit-list]` elements and their items, and dressing them while editing. One dashed
// outline per list; a single dashed line between items and between the fields inside an item, so nothing nests or
// crosses (docs/specs/artefacts/2026-11-list-editing.html). The host's elements are borrowed: the chrome adds
// classes and its own `.cms-root` children, positions them only through custom properties (CSP-safe), and `detach`
// takes every one of them back out.
import { KEY_ID, element, isItemKey, uniqueId } from "./dom.ts";
import { splitAddress } from "./fields.ts";
import { format, type Strings } from "./strings.ts";

export interface ListInfo {
  key: string;
  path: string;
  label: string;
  noun: string;
  plural: string;
  min: number;
  max: number | undefined;
  order: "manual" | "data";
  duplicate: boolean;
  /** Field name, relative to an item, whose text names the item. */
  itemLabel: string | undefined;
}

export interface ItemRecord {
  element: HTMLElement;
  /** The item's payload path, `artists[_key=a1]` or `artists.3`. */
  path: string;
  /** The `_key` the path names, if keyed. */
  itemKey: string | undefined;
}

export type ItemAction = "grip" | "up" | "down" | "duplicate" | "remove";

export interface ListHandlers {
  /**
   * False for a list whose items can't be tied to a key: the outline and grid, with no toolbar, Add or Undo. Its fields
   * still edit in place.
   */
  actions: boolean;
  /** Whether Add is offered: the host gave the list a `newItem`. */
  canAdd: boolean;
  add(): void;
  /** Whether a removal from this list can still be undone: the Add row then offers Undo too. */
  canUndo: boolean;
  undo(): void;
  /** `focusOn`: the button focus returns to after a move, when it isn't the one pressed (the handle, for an arrow key). */
  act(item: ItemRecord, action: ItemAction, button: HTMLButtonElement, focusOn?: ItemAction): void;
  /**
   * A drag is about to start: false (and said) while the list waits for the page. A drag runs only while its pointer
   * is down, so the host learns it is over from that pointer's up or cancel.
   */
  dragStart(): boolean;
  /**
   * The item was dropped next to `place`'s item, by `_key`: after it, or before it when the item is now first. The
   * page can show fewer items than are stored, so only a neighbour's key, not a page index, names a stored place.
   * `putBack` returns the element to where the drag took it from, and says whether it could; the write calls it before
   * the items are arranged in the stored order, so a drop leaves the host's markup between items where Move up and
   * down leave it. Resolves false when nothing was written; the host then shows the stored order itself if `putBack`
   * can't.
   */
  drop(item: ItemRecord, place: DropPlace, putBack: () => boolean): Promise<boolean>;
}

/** Where a drop left an item: after the item with this `_key`, or before it when the dropped item is now first. */
export type DropPlace = { after: string } | { before: string };

export interface ListRecord {
  element: HTMLElement;
  info: ListInfo;
  /** `<key>:<path>`, as written in `data-edit-list`. */
  id: string;
  items: ItemRecord[];
  detach?: () => void;
  /** Inside an item of another list, as scanned. Whether that keeps it from list chrome depends on the outer list. */
  insideItem: boolean;
  /** Inside an item of a list the chrome dresses: no list chrome of its own; its fields are cells of that row. */
  nested: boolean;
  /** Redraws the lines; a no-op until attached. */
  paint: () => void;
  /** The chrome's Add button, while attached and offered. */
  addButton?: HTMLButtonElement;
  /** Undo in the Add row, right after the items, so Tab from the list reaches it. Hidden when nothing is undoable. */
  undoButton?: HTMLButtonElement;
}

/** What follows the list's path in an item's path: a key, or an index (which leaves the list without list chrome). */
const ITEM_REST = new RegExp(`^(\\[_key=${KEY_ID}\\]|\\.\\d+)$`);
const KEYED_ITEM = new RegExp(`\\[_key=(${KEY_ID})\\]$`);

function count(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseList(target: HTMLElement): ListInfo | null {
  const address = splitAddress(target.dataset.editList ?? "");
  if (!address) return null;
  const set = target.dataset;
  const last = address.path.split(".").at(-1) ?? address.path;
  const noun = set.editListNoun ?? "item";
  const max = count(set.editListMax, -1);
  return {
    ...address,
    label: set.editListLabel ?? last,
    noun,
    plural: set.editListPlural ?? `${noun}s`,
    min: count(set.editListMin, 0),
    max: max < 0 ? undefined : max,
    order: set.editListOrder === "data" ? "data" : "manual",
    duplicate: set.editListDuplicate !== undefined,
    itemLabel: set.editListItemLabel,
  };
}

/** The list's items: elements whose `data-edit-item` names an element of this list, in page order. */
function scanItems(list: HTMLElement, info: ListInfo): ItemRecord[] {
  const items: ItemRecord[] = [];
  for (const target of list.querySelectorAll<HTMLElement>("[data-edit-item]")) {
    if (target.closest(".cms-root") || target.parentElement?.closest("[data-edit-list]") !== list) continue;
    const address = splitAddress(target.dataset.editItem ?? "");
    if (!address || address.key !== info.key) continue;
    const rest = address.path.slice(info.path.length);
    if (!address.path.startsWith(info.path) || !ITEM_REST.test(rest)) continue;
    // A forbidden id is no key at all: the item counts as unkeyed, so the list gets no list actions.
    const itemKey = KEYED_ITEM.exec(address.path)?.[1];
    items.push({ element: target, path: address.path, itemKey: isItemKey(itemKey) ? itemKey : undefined });
  }
  return items;
}

/** Every `[data-edit-list]` under `root`, outside the chrome's own surfaces. */
export function scanLists(root: HTMLElement): ListRecord[] {
  const records: ListRecord[] = [];
  const candidates = [
    ...(root.matches("[data-edit-list]") ? [root] : []),
    ...root.querySelectorAll<HTMLElement>("[data-edit-list]"),
  ];
  for (const target of candidates) {
    if (target.closest(".cms-root")) continue;
    const info = parseList(target);
    if (!info) continue;
    records.push({
      element: target,
      info,
      id: `${info.key}:${info.path}`,
      items: scanItems(target, info),
      insideItem: target.parentElement?.closest("[data-edit-item]")?.closest("[data-edit-list]") != null,
      // Decided when the list is dressed, from the outer list's access.
      nested: false,
      paint: () => undefined,
    });
  }
  return records;
}

/** The item's name in messages: its label field's text, else "{noun} {position}". */
export function itemName(list: ListRecord, item: ItemRecord, strings: Strings): string {
  const position = list.items.indexOf(item) + 1;
  const name = list.info.itemLabel;
  if (name !== undefined) {
    const suffix = `${item.path}.${name}`;
    for (const node of item.element.querySelectorAll<HTMLElement>("[data-edit-field]")) {
      const address = splitAddress(node.dataset.editField ?? "");
      if (address?.key === list.info.key && address.path === suffix) {
        const text = (node.textContent ?? "").trim();
        if (text) return text;
      }
    }
  }
  return format(strings.itemFallback, { noun: list.info.noun, position });
}

/** A fresh `_key` for an item the chrome creates: 10 characters from the `_key` alphabet. */
export function newItemKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** A stored item's `_key`, when it has one the paths accept. */
export function itemKeyOf(entry: unknown): string | undefined {
  const value = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["_key"] : undefined;
  return isItemKey(value) ? value : undefined;
}

/** The item's index in the stored array, by its `_key` (only keyed lists get list chrome). -1 when gone. */
export function storedIndex(items: readonly unknown[], item: ItemRecord): number {
  if (item.itemKey === undefined) return -1;
  return items.findIndex((entry) => itemKeyOf(entry) === item.itemKey);
}

const SVG = "http://www.w3.org/2000/svg";
const ICONS: Record<ItemAction | "add", string[]> = {
  grip: ["M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"],
  up: ["m6 15 6-6 6 6"],
  down: ["m6 9 6 6 6-6"],
  duplicate: ["M9 9h11v11H9z", "M5 15V6a2 2 0 0 1 2-2h9"],
  remove: ["M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"],
  add: ["M12 5v14M5 12h14"],
};

function icon(name: ItemAction | "add"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [attribute, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "20",
    height: "20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(attribute, value);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const px = (value: number) => `${Math.round(value * 100) / 100}px`;

export interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** The viewport as an origin: boxes in client coordinates, as a pointer event's are. */
const VIEWPORT = { left: 0, top: 0 } as const;

export function boxOf(node: Element, origin: { left: number; top: number }): Box {
  const rect = node.getBoundingClientRect();
  return {
    l: rect.left - origin.left,
    r: rect.right - origin.left,
    t: rect.top - origin.top,
    b: rect.bottom - origin.top,
  };
}

/**
 * The box an absolutely positioned child is placed in: the padding box, in client coordinates. A host border moves it
 * in from the border box `getBoundingClientRect` gives.
 */
export function paddingBox(node: HTMLElement): { left: number; top: number; width: number; height: number } {
  const rect = node.getBoundingClientRect();
  return {
    left: rect.left + node.clientLeft,
    top: rect.top + node.clientTop,
    width: node.clientWidth,
    height: node.clientHeight,
  };
}

/** A computed length in pixels (`--cms-list-pad`, `border-left-width`). 0 is a value: only an unreadable one falls back. */
export function cssPixels(node: Element, property: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(node).getPropertyValue(property));
  return Number.isNaN(value) ? fallback : value;
}

/**
 * Lines between an item's fields, from the fields' boxes. A vertical line goes midway between two fields side by side
 * and runs the item's band, from the line above to the line below. A horizontal one goes midway between two stacked
 * fields and runs to the nearest vertical line, or the outline, on each side. Neighbours only: a pair with another
 * field between them gets no line.
 */
export function cellLines(fields: readonly Box[], edge: { left: number; right: number }) {
  const overlapY = (a: Box, b: Box) => Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
  const overlapX = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1;
  const xs: number[] = [];
  const rows: { y: number; l: number; r: number }[] = [];
  for (const a of fields) {
    for (const b of fields) {
      if (a === b) continue;
      if (a.r <= b.l && overlapY(a, b)) {
        const between = fields.some((c) => c !== a && c !== b && c.l >= a.r && c.r <= b.l && overlapY(c, a));
        const x = (a.r + b.l) / 2;
        if (!between && !xs.some((other) => Math.abs(other - x) < 2)) xs.push(x);
      }
      if (a.b <= b.t && overlapX(a, b)) {
        const between = fields.some((c) => c !== a && c !== b && c.t >= a.b && c.b <= b.t && overlapX(c, a));
        if (!between) rows.push({ y: (a.b + b.t) / 2, l: Math.min(a.l, b.l), r: Math.max(a.r, b.r) });
      }
    }
  }
  const horizontal: { x: number; y: number; w: number }[] = [];
  for (const row of rows) {
    const left = Math.max(edge.left, ...xs.filter((x) => x <= row.l + 1));
    const right = Math.min(edge.right, ...xs.filter((x) => x >= row.r - 1));
    if (horizontal.some((line) => Math.abs(line.y - row.y) < 2 && Math.abs(line.x - left) < 2)) continue;
    // A line that starts on a vertical line starts just past it, so the two only touch.
    const start = xs.some((x) => Math.abs(x - left) < 2) ? left + 1 : left;
    horizontal.push({ x: start, y: row.y, w: right - start });
  }
  return { vertical: xs, horizontal };
}

export type Axis = "column" | "row" | "grid";

interface Cell {
  row: HTMLElement;
  band: HTMLElement;
  tools: HTMLElement | undefined;
  /** An item, not the Add row. */
  item: boolean;
  box: Box;
}

export interface Line<T = Cell> {
  top: number;
  bottom: number;
  /** Left to right. */
  cells: T[];
}

/**
 * Cells grouped into lines, and the list's axis from its items' boxes (ruling D10 on #28). A cell joins a line when
 * it shares more than a pixel of height with it; lines run top to bottom, cells left to right, whatever the order of
 * the DOM (a drag moves an item's element before anything is written). A column has one item per line, a row has
 * every item on one line, a grid wraps. Fewer than two items is a column.
 */
function group<T extends { box: Box }>(all: readonly T[]): { top: number; bottom: number; cells: T[] }[] {
  const lines: { top: number; bottom: number; cells: T[] }[] = [];
  for (const cell of [...all].sort((a, b) => a.box.t - b.box.t || a.box.l - b.box.l)) {
    const last = lines.at(-1);
    if (last && cell.box.t < last.bottom - 1) {
      last.cells.push(cell);
      last.bottom = Math.max(last.bottom, cell.box.b);
    } else {
      lines.push({ top: cell.box.t, bottom: cell.box.b, cells: [cell] });
    }
  }
  for (const line of lines) line.cells.sort((a, b) => a.box.l - b.box.l);
  return lines;
}

export function layOut<T extends { box: Box }>(
  itemBoxes: readonly Box[],
  cells: readonly T[],
): { lines: Line<T>[]; axis: Axis } {
  const across = group(itemBoxes.map((box) => ({ box })));
  const crowded = across.some((line) => line.cells.length > 1);
  const axis: Axis = !crowded ? "column" : across.length === 1 ? "row" : "grid";
  return { lines: group(cells), axis };
}

/** One of the chrome's own nodes: they come and go with each dressing. */
function isChrome(node: Node | null): node is Element {
  return node instanceof Element && node.classList.contains("cms-root");
}

/** The first sibling after `node` that is the host's (an item or the host's own markup), or null at the end. */
function hostSibling(node: Node): Node | null {
  let next = node.nextSibling;
  while (isChrome(next)) next = next.nextSibling;
  return next;
}

/** The host's element next to `node` on that side, chrome `.cms-root` nodes and text skipped, or null. */
function hostElementBeside(node: Element, side: "previous" | "next"): Element | null {
  const step = (from: Element) => (side === "next" ? from.nextElementSibling : from.previousElementSibling);
  let beside = step(node);
  while (isChrome(beside)) beside = step(beside);
  return beside;
}

/** Adds the outline, the tag, each item's toolbar and band, and the Add row. */
export function attachList(record: ListRecord, strings: Strings, handlers: ListHandlers): void {
  record.detach?.();
  const host = record.element;
  const { info, items } = record;
  const childTag = host.tagName === "UL" || host.tagName === "OL" ? "li" : "div";
  const hadClass = host.hasAttribute("class");
  const added: Element[] = [];
  const itemClasses: { node: HTMLElement; hadClass: boolean }[] = [];
  const total = items.length;
  const full = info.max !== undefined && total >= info.max;
  const atMin = total <= info.min;
  const fullReason = format(strings.listFull, { max: info.max ?? 0, plural: info.plural });
  const minReason = format(strings.listAtMin, { min: info.min, noun: info.noun });

  host.classList.add("cms-list");
  const tag = element("span", { class: "cms-list__tag" }, [
    info.max === undefined
      ? format(strings.listTagNoMax, { label: info.label, count: total })
      : format(strings.listTag, { label: info.label, count: total, max: info.max }),
  ]);
  const frame = element(childTag, { class: "cms-root cms-list__frame", "aria-hidden": "true" }, [tag]);
  host.prepend(frame);
  added.push(frame);

  const toolbars: (HTMLElement | undefined)[] = [];
  const bands: HTMLElement[] = [];
  // The drag. Invariants:
  // - Claim: at most one drag per list at a time. `endDrag` is set exactly while one runs; a pointerdown while it is
  //   set, or one `dragStart` refuses (the list waits for the page), starts nothing.
  // - One pointer: the drag belongs to the pointerdown's `pointerId`. Moves, ups, cancels and lost capture of any
  //   other pointer are ignored.
  // - Page only: until the drop nothing is written. A drag moves only the dragged item's own element, next to another
  //   item (which can sit in another wrapper of the host's); every other node (host markup between items, the
  //   chrome's rows) stays where it is. A move inserts the element only when its host element neighbour on that side
  //   (text and chrome `.cms-root` nodes skipped) isn't already it, so a pointer held over one place inserts nothing.
  // - Release: `endDrag` runs at most once (it clears itself first), from the drag's pointerup or pointercancel
  //   anywhere in the document, the list losing its capture (`lostpointercapture` whose target is the list), Escape,
  //   or detach. It removes every listener it added (on the list and on the document) and releases the capture,
  //   whatever the outcome.
  // - Put back: a cancel, a drop where it started, or a drop that wrote nothing (resolved false, or rejected) returns
  //   the element to the place it had at pointerdown, from wherever the drag left it, another wrapper of the host's
  //   included. The place is `parent` and `next`, the first following sibling that is the host's (chrome `.cms-root`
  //   nodes skipped: a re-dress replaces them, the Add row after the last item among them), or null for the end,
  //   which means after the host's last node and before the chrome's rows closing `parent`. It does so only while
  //   `parent` is still in the list and `next` still in `parent` (or was the end), and says whether it did;
  //   otherwise the markup there has been replaced. A drop that writes puts it back on the write chain before the
  //   items are arranged in the stored order (`ListHandlers.drop`), so a drop and a move leave the same markup; if
  //   the guard refuses, that arrangement still ends in the stored order. A drop that wrote nothing and could not be
  //   put back is arranged in the stored order by the host (`dropItem` in mount.ts).
  // - Detached: a drop that wrote nothing (resolved false, or rejected) puts the element back whenever the host is
  //   still on the page, attached or not: nothing was stored, so the stored order is what the page shows. The guards
  //   of `putBack` above still apply. Only the repaint is the dressing's: `record.paint`, a no-op once detached, the
  //   new dressing's own paint once the list was dressed again. The `putBack` handed to the write is the write's own
  //   step and keeps the same guards: it runs before the write arranges the items, whatever dresses them by then.
  // - Bound: a drop sends at most one move, placed by the neighbour's `_key`, never by a page index.
  // Pointer capture sits on the list, which never moves (capture on the handle would be lost when the item is
  // re-inserted). A touch or pen starts captured to the handle implicitly; the list's capture takes it over, and the
  // `lostpointercapture` that fires at the handle and bubbles to the list is that hand-over, not an end.
  let endDrag: ((outcome: "drop" | "cancel") => void) | undefined;
  const startDrag = (event: PointerEvent, item: ItemRecord) => {
    if (event.button !== 0 || endDrag || !handlers.dragStart()) return;
    event.preventDefault();
    const pointer = event.pointerId;
    const node = item.element;
    const parent = node.parentNode;
    // The host's node it sat before: the chrome's rows (the Add row after the last item) are replaced by a re-dress.
    const next = hostSibling(node);
    const from = items.indexOf(item);
    node.classList.add("cms-item--dragging");
    try {
      host.setPointerCapture(pointer);
    } catch {
      // No capture (a synthetic pointer): moves arrive while the pointer is over the list, and the up from anywhere.
    }
    const ours = (other: PointerEvent) => other.pointerId === pointer;
    const onMove = (move: PointerEvent) => {
      if (!ours(move)) return;
      const others = items.filter((other) => other !== item).map((other) => other.element);
      let before: HTMLElement | undefined;
      if (axis === "column") {
        before = others.find((other) => {
          const box = other.getBoundingClientRect();
          return move.clientY < box.top + box.height / 2;
        });
      } else {
        // Along a line: above it, or within it and left of an item's middle. The line's top and bottom, not the item's
        // own box: an item shorter than its line still holds the pointer anywhere within the line.
        const lines = group(others.map((other) => ({ element: other, box: boxOf(other, VIEWPORT) })));
        for (const line of lines) {
          const cell = line.cells.find(
            ({ box }) => move.clientY < line.top || (move.clientY < line.bottom && move.clientX < (box.l + box.r) / 2),
          );
          if (cell) {
            before = cell.element;
            break;
          }
        }
      }
      // Already there, whatever text or chrome sits between: no insert (server HTML has whitespace between items).
      if (before) {
        if (hostElementBeside(before, "previous") !== node) before.before(node);
      } else {
        const last = others.at(-1);
        if (last && hostElementBeside(last, "next") !== node) last.after(node);
      }
      record.paint();
    };
    const onUp = (up: PointerEvent) => {
      if (ours(up)) endDrag?.("drop");
    };
    const onCancel = (cancel: PointerEvent) => {
      if (ours(cancel)) endDrag?.("cancel");
    };
    // Only the list's own capture going ends the drag. A touch or pen is captured to the handle implicitly; taking it
    // for the list fires `lostpointercapture` at the handle, which bubbles here and is the hand-over, not an end.
    const onLost = (lost: PointerEvent) => {
      if (lost.target === host) onCancel(lost);
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.stopPropagation();
      endDrag?.("cancel");
    };
    /** True when the element is back where it was at pointerdown; false when the markup there has been replaced. */
    const putBack = (): boolean => {
      if (!parent || !parent.isConnected || !host.contains(parent)) return false;
      if (next !== null && next.parentNode !== parent) return false;
      if (node.parentNode === parent && hostSibling(node) === next) return true;
      // At the end: after the host's last node, before the chrome's rows that close the parent.
      let anchor = next;
      if (anchor === null) for (let last = parent.lastChild; isChrome(last); last = last.previousSibling) anchor = last;
      parent.insertBefore(node, anchor);
      return true;
    };
    /** What the drag comes to once its listeners are gone: a put-back, or one drop write. */
    const settleDrop = (outcome: "drop" | "cancel") => {
      const order = [...items].sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      const to = order.indexOf(item);
      // The page can show fewer items than are stored: the drop names its neighbour, which the write finds by key.
      const neighbour = to > 0 ? order[to - 1] : order[1];
      const place: DropPlace | undefined =
        neighbour?.itemKey === undefined
          ? undefined
          : to > 0
            ? { after: neighbour.itemKey }
            : { before: neighbour.itemKey };
      if (outcome === "cancel" || to === from || !place || !host.isConnected) {
        putBack();
        record.paint();
        return;
      }
      // Nothing written (offline, a refusal, a write that threw): the page shows the stored order again.
      const restore = () => {
        if (!host.isConnected) return;
        putBack();
        record.paint();
      };
      void handlers.drop(item, place, putBack).then((written) => {
        if (!written) restore();
      }, restore);
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("lostpointercapture", onLost);
    // On the document, so an up or cancel outside the list ends the drag when capture failed. A captured one reaches
    // the document too, by way of the list.
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    document.addEventListener("keydown", onKey, true);
    endDrag = (outcome) => {
      endDrag = undefined;
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("lostpointercapture", onLost);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onCancel, true);
      document.removeEventListener("keydown", onKey, true);
      try {
        host.releasePointerCapture(pointer);
      } catch {
        // Already released.
      }
      node.classList.remove("cms-item--dragging");
      settleDrop(outcome);
    };
  };
  items.forEach((item, index) => {
    if (!handlers.actions) {
      // Still a row of the grid: a band for its line and the tint, but nothing to act with.
      const band = element("span", { class: "cms-root cms-item__band", "aria-hidden": "true" });
      itemClasses.push({ node: item.element, hadClass: item.element.hasAttribute("class") });
      item.element.classList.add("cms-item");
      item.element.append(band);
      added.push(band);
      bands.push(band);
      toolbars.push(undefined);
      return;
    }
    const name = itemName(record, item, strings);
    const position = index + 1;
    const placement = { item: name, position, count: total };
    const toolButton = (action: ItemAction, label: string, inert: boolean, reason?: string) => {
      const node = element("button", {
        type: "button",
        class: `cms-btn cms-btn--ghost cms-item__${action}`,
        "aria-label": label,
        "aria-disabled": inert ? "true" : undefined,
        "data-action": action,
        "data-reason": inert ? reason : undefined,
        tabindex: "-1",
      });
      node.append(icon(action));
      if (action !== "grip") node.addEventListener("click", () => handlers.act(item, action, node));
      return node;
    };
    const buttons: HTMLButtonElement[] = [];
    if (info.order === "manual") {
      const grip = toolButton("grip", format(strings.itemDrag, placement), false);
      grip.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
      grip.addEventListener("pointerdown", (event) => startDrag(event, item));
      buttons.push(
        grip,
        toolButton("up", format(strings.itemMoveUp, placement), index === 0, format(strings.itemIsFirst, placement)),
        toolButton(
          "down",
          format(strings.itemMoveDown, placement),
          index === total - 1,
          format(strings.itemIsLast, placement),
        ),
      );
    }
    if (info.duplicate)
      buttons.push(toolButton("duplicate", format(strings.itemDuplicate, placement), full, fullReason));
    buttons.push(toolButton("remove", format(strings.itemRemove, placement), atMin, minReason));
    // The handle acts only on a pointer or the arrow keys: Tab lands on the first button that does something on Enter.
    const first = buttons.find((button) => button.dataset.action !== "grip") ?? buttons[0];
    if (first) first.tabIndex = 0;
    // Touch: the only way in without hover. Hidden on devices that hover (chrome.css).
    const chip = element(
      "button",
      {
        type: "button",
        class: "cms-btn cms-item__chip",
        "aria-expanded": "false",
        "aria-label": format(strings.itemActions, placement),
      },
      [
        element("span", { class: "cms-item__chip-closed", "aria-hidden": "true" }, [
          format(strings.itemChip, placement),
        ]),
        element("span", { class: "cms-item__chip-open", "aria-hidden": "true" }, [strings.itemChipOpen]),
      ],
    );
    chip.addEventListener("click", () => {
      const opening = !item.element.hasAttribute("data-cms-open");
      for (const other of items) other.element.removeAttribute("data-cms-open");
      for (const other of toolbars) other?.querySelector(".cms-item__chip")?.setAttribute("aria-expanded", "false");
      if (opening) item.element.setAttribute("data-cms-open", "");
      chip.setAttribute("aria-expanded", String(opening));
    });
    const tools = element(
      "div",
      { class: "cms-root cms-item__tools", role: "toolbar", "aria-label": format(strings.itemToolbar, placement) },
      [chip, ...buttons],
    );
    tools.addEventListener("keydown", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement) || target === chip) {
        if (event.key === "Escape" && item.element.hasAttribute("data-cms-open")) chip.click();
        return;
      }
      const at = buttons.indexOf(target);
      if (target.dataset.action === "grip" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        // The same as Move up / Move down, with focus staying on the handle.
        event.preventDefault();
        const step = event.key === "ArrowUp" ? "up" : "down";
        const mover = buttons.find((node) => node.dataset.action === step);
        if (mover) handlers.act(item, step, mover, "grip");
        return;
      }
      const to =
        event.key === "ArrowRight"
          ? (at + 1) % buttons.length
          : event.key === "ArrowLeft"
            ? (at - 1 + buttons.length) % buttons.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : -1;
      if (to >= 0) {
        event.preventDefault();
        buttons[to]?.focus();
      } else if (event.key === "Escape" && item.element.hasAttribute("data-cms-open")) {
        chip.click();
        chip.focus();
      }
    });
    tools.addEventListener("focusin", (event) => {
      if (!(event.target instanceof HTMLButtonElement) || !buttons.includes(event.target)) return;
      for (const node of buttons) node.tabIndex = node === event.target ? 0 : -1;
    });
    const band = element("span", { class: "cms-root cms-item__band", "aria-hidden": "true" });
    itemClasses.push({ node: item.element, hadClass: item.element.hasAttribute("class") });
    item.element.classList.add("cms-item");
    item.element.prepend(tools);
    item.element.append(band);
    added.push(tools, band);
    toolbars.push(tools);
    bands.push(band);
  });

  // The tag is drawn on the outline, which is aria-hidden; Add carries the same words as its description.
  const tagCopy = element("span", { class: "cms-visually-hidden", id: uniqueId("cms-list-tag") }, [
    tag.textContent ?? "",
  ]);
  const reasonId = uniqueId("cms-list-reason");
  const reason = element("span", { class: "cms-list__reason", id: reasonId }, [
    full && handlers.canAdd ? fullReason : "",
  ]);
  record.addButton = undefined;
  record.undoButton = undefined;
  const addChildren: (Node | null)[] = [];
  if (total === 0)
    addChildren.push(element("p", { class: "cms-list__empty" }, [format(strings.listEmpty, { plural: info.plural })]));
  if (handlers.actions && handlers.canAdd) {
    const add = element("button", {
      type: "button",
      class: "cms-btn cms-list__add-button",
      "aria-disabled": full ? "true" : undefined,
      "aria-describedby": full ? `${tagCopy.id} ${reasonId}` : tagCopy.id,
      "data-reason": full ? fullReason : undefined,
    });
    add.append(icon("add"), format(strings.listAdd, { noun: info.noun }));
    add.addEventListener("click", () => handlers.add());
    record.addButton = add;
    addChildren.push(element("div", { class: "cms-list__add-line" }, [add, reason, tagCopy]));
  }
  if (handlers.actions) {
    const undo = element("button", { type: "button", class: "cms-btn cms-list__undo", hidden: !handlers.canUndo }, [
      strings.undo,
    ]);
    undo.addEventListener("click", () => handlers.undo());
    record.undoButton = undo;
    addChildren.push(undo);
  }
  const addBand = element("span", { class: "cms-item__band", "aria-hidden": "true" });
  const addRow = handlers.actions
    ? element(childTag, { class: "cms-root cms-list__add" }, [...addChildren, addBand])
    : undefined;
  if (addRow) {
    host.append(addRow);
    added.push(addRow);
  }

  // The painter. Invariants:
  // - Measurement policy (as in groups.ts): never parse a CSS length in JS; `--cms-list-pad` is never read. Boxes are
  //   measured in the host's padding box (`paddingBox`), where the frame, bands and tools are positioned. The pad is the
  //   frame's rect against that padding box (its `left` is -pad); the frame's border is its computed
  //   `border-left-width` / `border-right-width` (real properties, so px). Only an unreadable value (a frame with no
  //   box, an empty style: an engine without layout) takes the fallback.
  // - Measure after styling: `cms-list` and the frame are on the host before the first paint, so host CSS keyed on
  //   `.cms-list` is in every box a paint reads. The axis classes are set from the boxes a paint read; no chrome rule
  //   keyed on them moves a box.
  // - Nodes: the frame is appended to the host (after its items, before the Add row), so host `:first-child` rules
  //   match the same item in edit mode. Each item's toolbar stays its first child: Tab reaches it before the item's
  //   fields (#28).
  // - `paint` is the only writer of separators, bands' and tools' positions and the axis classes; `schedule` coalesces
  //   any number of requests into one paint per animation frame.
  const separators: HTMLElement[] = [];
  let axis: Axis = "column";
  const paint = () => {
    for (const node of separators.splice(0)) node.remove();
    const origin = host.getBoundingClientRect();
    const pad = cssPixels(frame, "--cms-list-pad", 12);
    const cells: Cell[] = [
      ...items.map((item, index) => ({ row: item.element, band: bands[index], tools: toolbars[index], item: true })),
      ...(addRow ? [{ row: addRow, band: addBand, tools: undefined, item: false }] : []),
    ].flatMap((cell) => (cell.band ? [{ ...cell, band: cell.band, box: boxOf(cell.row, origin) }] : []));
    const { lines, axis: found } = layOut(
      cells.filter((cell) => cell.item).map((cell) => cell.box),
      cells,
    );
    axis = found;
    host.classList.toggle("cms-list--row", axis === "row");
    host.classList.toggle("cms-list--grid", axis === "grid");
    // Halfway to the next line, or the outline's padding at the ends.
    const halves = lines.map((line, index) => {
      const next = lines[index + 1];
      return next ? Math.max((next.top - line.bottom) / 2, 0) : pad;
    });
    const lead = Math.max(halves[0] ?? pad, pad);
    const firstTop = (lines[0]?.top ?? 0) - lead;
    frame.style.setProperty("--cms-frame-top", px(firstTop));
    frame.style.setProperty("--cms-frame-height", px((lines.at(-1)?.bottom ?? 0) + pad - firstTop));
    // Inside the outline's 2px border on each side.
    const innerLeft = -pad + 2;
    const innerRight = origin.width + pad - 2;
    lines.forEach((line, lineIndex) => {
      const above = lineIndex === 0 ? lead : (halves[lineIndex - 1] ?? 0);
      const below = halves[lineIndex] ?? pad;
      const top = line.top - above;
      const bottom = line.bottom + below;
      line.cells.forEach((cell, at) => {
        const { box, band, row, tools } = cell;
        const previous = line.cells[at - 1];
        const next = line.cells[at + 1];
        const left = previous ? (previous.box.r + box.l) / 2 : innerLeft;
        const right = next ? (box.r + next.box.l) / 2 : innerRight;
        const hasTop = lineIndex > 0;
        const hasLeft = at > 0;
        band.classList.toggle("cms-item__band--top", hasTop);
        band.classList.toggle("cms-item__band--left", hasLeft);
        band.style.setProperty("--cms-band-top", px(top - box.t));
        band.style.setProperty("--cms-band-bottom", px(box.b - bottom));
        band.style.setProperty("--cms-band-left", px(left - box.l));
        band.style.setProperty("--cms-band-width", px(right - left));
        if (tools) {
          // On the item's leading line: the top left in a row or grid, the top right of the outline in a column.
          tools.style.setProperty("--cms-tools-above", px(box.t - top));
          tools.style.setProperty("--cms-tools-right", axis === "column" ? px(origin.width - box.r) : "auto");
          tools.style.setProperty("--cms-tools-left", axis === "column" ? "auto" : px(left + pad - box.l));
        }
        if (!cell.item) return;
        const itemOrigin = row.getBoundingClientRect();
        const fields = [...row.querySelectorAll("[data-edit-field]")]
          .filter((node) => node.closest(".cms-item") === row)
          .map((node) => boxOf(node, itemOrigin));
        // The cell's own top and left borders take a pixel; field lines start past them.
        const lineTop = top - box.t + (hasTop ? 1 : 0);
        const cellLeft = left - box.l + (hasLeft ? 1 : 0);
        const cellRight = right - box.l;
        const inside = cellLines(fields, { left: cellLeft, right: cellRight });
        for (const x of inside.vertical) {
          const sep = element("span", { class: "cms-root cms-item__sep cms-item__sep--v", "aria-hidden": "true" });
          sep.style.setProperty("--cms-sep-x", px(x));
          sep.style.setProperty("--cms-sep-top", px(lineTop));
          sep.style.setProperty("--cms-sep-length", px(bottom - top - (hasTop ? 1 : 0)));
          row.append(sep);
          separators.push(sep);
        }
        for (const { x, y, w } of inside.horizontal) {
          const sep = element("span", { class: "cms-root cms-item__sep cms-item__sep--h", "aria-hidden": "true" });
          sep.style.setProperty("--cms-sep-x", px(x));
          sep.style.setProperty("--cms-sep-top", px(y));
          sep.style.setProperty("--cms-sep-length", px(w));
          row.append(sep);
          separators.push(sep);
        }
      });
    });
  };
  let frameRequest: number | undefined;
  // Coalesced into one paint per frame. The observer's first report still counts: boxes can change between the paint
  // below and its delivery (a nested list dressed after this one, a web font arriving).
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
    for (const item of items) {
      observer.observe(item.element);
      for (const node of item.element.querySelectorAll("[data-edit-field]")) observer.observe(node);
    }
  }
  // A viewport change can move `--cms-list-pad` through a media query without resizing any observed box.
  window.addEventListener("resize", schedule);
  record.paint = paint;
  paint();

  record.detach = () => {
    endDrag?.("cancel");
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    for (const node of separators.splice(0)) node.remove();
    for (const node of added) node.remove();
    for (const { node, hadClass: had } of itemClasses) {
      node.classList.remove("cms-item", "cms-item--dragging");
      node.removeAttribute("data-cms-open");
      if (!had && node.classList.length === 0) node.removeAttribute("class");
    }
    host.classList.remove("cms-list", "cms-list--row", "cms-list--grid");
    if (!hadClass && host.classList.length === 0) host.removeAttribute("class");
    record.detach = undefined;
    record.addButton = undefined;
    record.undoButton = undefined;
    record.paint = () => undefined;
  };
}
