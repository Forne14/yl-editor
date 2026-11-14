// Keyed lists: finding `[data-edit-list]` elements and their items, and dressing them while editing. One dashed
// outline per list; a single dashed line between items and between the fields inside an item, so nothing nests or
// crosses (docs/specs/artefacts/2026-11-list-editing.html). The host's elements are borrowed: the chrome adds
// classes and its own `.cms-root` children, positions them only through custom properties (CSP-safe), and `detach`
// takes every one of them back out.
import { KEY_ID, element, uniqueId } from "./dom.ts";
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

export type ItemAction = "up" | "down" | "duplicate" | "remove";

export interface ListHandlers {
  /** Whether Add is offered: the host gave the list a `newItem`. */
  canAdd: boolean;
  add(): void;
  /** Whether a removal from this list can still be undone: the Add row then offers Undo too. */
  canUndo: boolean;
  undo(): void;
  act(item: ItemRecord, action: ItemAction, button: HTMLButtonElement): void;
}

export interface ListRecord {
  element: HTMLElement;
  info: ListInfo;
  /** `<key>:<path>`, as written in `data-edit-list`. */
  id: string;
  items: ItemRecord[];
  detach?: () => void;
  /** Redraws the lines; a no-op until attached. */
  paint: () => void;
  /** The chrome's Add button, while attached and offered. */
  addButton?: HTMLButtonElement;
  /** Undo in the Add row, right after the items, so Tab from the list reaches it. Hidden when nothing is undoable. */
  undoButton?: HTMLButtonElement;
}

const KEYED_ITEM = new RegExp(`\\[_key=(${KEY_ID})\\]$`);
const LEADING_KEY = new RegExp(`^\\[_key=(${KEY_ID})\\]`);

/** The `_key` an item path's first part after the list names (`[_key=a1].name` → `a1`). */
export function leadingItemKey(rest: string): string | undefined {
  return LEADING_KEY.exec(rest)?.[1];
}

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
    if (!address.path.startsWith(info.path) || !/^(\[_key=[A-Za-z0-9_-]+\]|\.\d+)$/.test(rest)) continue;
    items.push({ element: target, path: address.path, itemKey: KEYED_ITEM.exec(address.path)?.[1] });
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

/** The item's index in the stored array: by `_key` when keyed, else the index its path names. -1 when gone. */
export function storedIndex(items: readonly unknown[], item: ItemRecord): number {
  if (item.itemKey !== undefined) {
    return items.findIndex(
      (entry) =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["_key"] === item.itemKey,
    );
  }
  const index = Number(/\.(\d+)$/.exec(item.path)?.[1] ?? Number.NaN);
  return Number.isInteger(index) && index < items.length ? index : -1;
}

const SVG = "http://www.w3.org/2000/svg";
const ICONS: Record<ItemAction | "add", string[]> = {
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

const px = (value: number) => `${Math.round(value * 100) / 100}px`;

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

function boxOf(node: Element, origin: DOMRect): Box {
  const rect = node.getBoundingClientRect();
  return {
    l: rect.left - origin.left,
    r: rect.right - origin.left,
    t: rect.top - origin.top,
    b: rect.bottom - origin.top,
  };
}

/**
 * Lines between an item's fields, from the fields' boxes. A vertical line goes midway between two fields side by side
 * and runs the item's band, from the line above to the line below. A horizontal one goes midway between two stacked
 * fields and runs to the nearest vertical line, or the outline, on each side. Neighbours only: a pair with another
 * field between them gets no line.
 */
function cellLines(fields: readonly Box[], edge: { left: number; right: number }) {
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

  const toolbars: HTMLElement[] = [];
  const bands: HTMLElement[] = [];
  items.forEach((item, index) => {
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
      node.addEventListener("click", () => handlers.act(item, action, node));
      return node;
    };
    const buttons: HTMLButtonElement[] = [];
    if (info.order === "manual") {
      buttons.push(
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
    const first = buttons[0];
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
      for (const other of toolbars) other.querySelector(".cms-item__chip")?.setAttribute("aria-expanded", "false");
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
  const addChildren: (Node | null)[] = [];
  if (total === 0)
    addChildren.push(element("p", { class: "cms-list__empty" }, [format(strings.listEmpty, { plural: info.plural })]));
  if (handlers.canAdd) {
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
  const undo = element("button", { type: "button", class: "cms-btn cms-list__undo", hidden: !handlers.canUndo }, [
    strings.undo,
  ]);
  undo.addEventListener("click", () => handlers.undo());
  record.undoButton = undo;
  addChildren.push(undo);
  const addBand = element("span", { class: "cms-item__band", "aria-hidden": "true" });
  const addRow = element(childTag, { class: "cms-root cms-list__add" }, [...addChildren, addBand]);
  host.append(addRow);
  added.push(addRow);

  const separators: HTMLElement[] = [];
  const paint = () => {
    for (const node of separators.splice(0)) node.remove();
    const origin = host.getBoundingClientRect();
    const pad = Number.parseFloat(getComputedStyle(frame).getPropertyValue("--cms-list-pad")) || 12;
    const rows = [...items.map((item) => item.element), addRow];
    const boxes = rows.map((row) => boxOf(row, origin));
    const halves = boxes.slice(0, -1).map((box, index) => Math.max(((boxes[index + 1]?.t ?? box.b) - box.b) / 2, 0));
    const lead = Math.max(halves[0] ?? pad, pad);
    const firstTop = (boxes[0]?.t ?? 0) - lead;
    frame.style.setProperty("--cms-frame-top", px(firstTop));
    frame.style.setProperty("--cms-frame-height", px((boxes.at(-1)?.b ?? 0) + pad - firstTop));
    rows.forEach((row, index) => {
      const box = boxes[index] as Box;
      const above = index === 0 ? lead : (halves[index - 1] ?? 0);
      const below = halves[index] ?? pad;
      const band = index < bands.length ? bands[index] : addBand;
      if (!band) return;
      // Inside the outline's 2px border on each side.
      const left = -pad + 2 - box.l;
      const width = origin.width + 2 * pad - 4;
      band.style.setProperty("--cms-band-top", px(-above));
      band.style.setProperty("--cms-band-bottom", px(-below));
      band.style.setProperty("--cms-band-left", px(left));
      band.style.setProperty("--cms-band-width", px(width));
      const tools = toolbars[index];
      if (tools) {
        tools.style.setProperty("--cms-tools-above", px(above));
        tools.style.setProperty("--cms-tools-right", px(origin.width - box.r));
      }
      if (index >= items.length) return;
      const itemOrigin = row.getBoundingClientRect();
      const fields = [...row.querySelectorAll("[data-edit-field]")]
        .filter((node) => node.closest("[data-edit-item]") === row)
        .map((node) => boxOf(node, itemOrigin));
      const lines = cellLines(fields, { left, right: left + width });
      for (const x of lines.vertical) {
        const line = element("span", { class: "cms-root cms-item__sep cms-item__sep--v", "aria-hidden": "true" });
        line.style.setProperty("--cms-sep-x", px(x));
        line.style.setProperty("--cms-sep-top", px(-above + 1));
        line.style.setProperty("--cms-sep-length", px(box.b - box.t + above + below - 1));
        row.append(line);
        separators.push(line);
      }
      for (const { x, y, w } of lines.horizontal) {
        const line = element("span", { class: "cms-root cms-item__sep cms-item__sep--h", "aria-hidden": "true" });
        line.style.setProperty("--cms-sep-x", px(x));
        line.style.setProperty("--cms-sep-top", px(y));
        line.style.setProperty("--cms-sep-length", px(w));
        row.append(line);
        separators.push(line);
      }
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
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    for (const node of separators.splice(0)) node.remove();
    for (const node of added) node.remove();
    for (const { node, hadClass: had } of itemClasses) {
      node.classList.remove("cms-item");
      node.removeAttribute("data-cms-open");
      if (!had && node.classList.length === 0) node.removeAttribute("class");
    }
    host.classList.remove("cms-list");
    if (!hadClass && host.classList.length === 0) host.removeAttribute("class");
    record.detach = undefined;
    record.addButton = undefined;
    record.undoButton = undefined;
    record.paint = () => undefined;
  };
}
