// @vitest-environment happy-dom
// Field groups (#44). happy-dom has no layout, so boxes are stubbed by element id: this proves the chrome's logic, not
// how a browser lays the page out (e2e/groups.spec.ts does that).
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { attachGroup, createOutlineWatch, createWarnings, scanGroups } from "./groups.ts";
import { mountEditor } from "./index.ts";
import type { EditorHandle } from "./types.ts";

const KEY = "page/home";
/** Another document the editor can edit, and one it can only read. */
const OTHER = "page/other";
const LOCKED = "page/locked";
let canEdit: boolean;
let handle: EditorHandle | undefined;
/** `id -> [left, top, width, height]`. An element with no entry has no box, like one that isn't rendered. */
let boxes: Record<string, [number, number, number, number]>;
/**
 * Boxes that replace `boxes` while a `.cms-group` is on the page: host CSS keyed on the class moves them. `null`: the
 * class hides that element (no box).
 */
let groupedBoxes: Record<string, [number, number, number, number] | null>;
/**
 * Where a frame is drawn: its parent's padding box grown by this much on each side, as the chrome's CSS lays it out
 * (`inset` / `left` / `right` of `calc(-1 * --cms-list-pad)`). Undefined: frames have no box, as in happy-dom.
 */
let framePad: number | undefined;
let boxCalls: Record<string, number>;
let warn: MockInstance<typeof console.warn>;
const realRect = Element.prototype.getBoundingClientRect;
const realObserver = globalThis.ResizeObserver;
let observed: (() => void)[];
/** What each ResizeObserver watches now, in creation order. */
let watching: Set<Element>[];
/** `id -> [clientLeft, clientTop]`: a host border. Without one, the padding box is the border box. */
let borders: Record<string, [number, number]>;
const clientProperties = ["clientLeft", "clientTop", "clientWidth", "clientHeight"] as const;
const realClient = clientProperties.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function field(id: string, name: string): string {
  return `<p id="${id}" data-edit-field="${KEY}:${name}" data-edit-type="text">${name}</p>`;
}

function page(html: string): void {
  document.body.innerHTML = `<main id="page">${html}</main>`;
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, location.href);
      if (url.pathname === "/api/content/documents") {
        const summary = (key: string, edit: boolean) => ({
          key,
          type: "page",
          version: 1,
          isDraft: true,
          draftUpdatedAt: null,
          publishedAt: null,
          access: { edit, publish: edit },
        });
        return json({
          documents: { [KEY]: summary(KEY, canEdit), [OTHER]: summary(OTHER, true), [LOCKED]: summary(LOCKED, false) },
        });
      }
      if (url.pathname === "/api/content/discard") return json({ document: null });
      if (url.pathname === "/api/content/document") {
        return json({
          document: {
            id: 1,
            key: KEY,
            type: "page",
            slug: "home",
            payload: { a: "A", b: "B", c: "C" },
            isDraft: true,
            publishedAt: null,
            draftUpdatedAt: null,
            previousSlugs: [],
            retiredAt: null,
            version: 1,
            scheduledAt: null,
          },
          publishedPayload: null,
        });
      }
      return json({ error: { code: "not_found", message: "none" } }, 404);
    }),
  );
}

async function settle(): Promise<void> {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(): Promise<void> {
  handle = mountEditor();
  await handle.ready;
  await settle();
}

const frames = () => [...document.querySelectorAll<HTMLElement>(".cms-group__frame")];
const seps = (kind?: "v" | "h") => [
  ...document.querySelectorAll<HTMLElement>(kind ? `.cms-group__sep--${kind}` : ".cms-group__sep"),
];
const frame = (at: number) => frames()[at] as HTMLElement;

/** A column of three fields, one under the other, in a 400 by 200 wrapper. */
function column(): void {
  page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}${field("c", "c")}</section>`);
  boxes = { g: [100, 100, 400, 200], a: [100, 100, 400, 40], b: [100, 160, 400, 40], c: [100, 220, 400, 40] };
}

beforeEach(() => {
  canEdit = true;
  boxes = {};
  groupedBoxes = {};
  framePad = undefined;
  boxCalls = {};
  observed = [];
  watching = [];
  borders = {};
  document.head.innerHTML = "";
  sessionStorage.clear();
  const layout = (id: string) =>
    document.querySelector(".cms-group") && id in groupedBoxes ? (groupedBoxes[id] ?? undefined) : boxes[id];
  Element.prototype.getBoundingClientRect = function (this: Element) {
    boxCalls[this.id] = (boxCalls[this.id] ?? 0) + 1;
    const parent = this.parentElement;
    if (framePad !== undefined && parent && this.matches(".cms-group__frame, .cms-list__frame")) {
      const [left, top, width, height] = layout(parent.id) ?? [0, 0, 0, 0];
      const [sideX, sideY] = borders[parent.id] ?? [0, 0];
      return new DOMRect(
        left + sideX - framePad,
        top + sideY - framePad,
        width - 2 * sideX + 2 * framePad,
        height - 2 * sideY + 2 * framePad,
      );
    }
    const box = layout(this.id);
    return box ? new DOMRect(...box) : new DOMRect(0, 0, 0, 0);
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: () => void) {
        observed.push(callback);
        watching.push(this.targets);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      disconnect() {
        this.targets.clear();
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
    },
  );
  // The padding box: the border box less the host border (stubbed by id).
  const sides = (node: Element) => borders[node.id] ?? [0, 0];
  const size = (node: Element) => layout(node.id) ?? [0, 0, 0, 0];
  const values = {
    clientLeft: (node: Element) => sides(node)[0],
    clientTop: (node: Element) => sides(node)[1],
    clientWidth: (node: Element) => size(node)[2] - 2 * sides(node)[0],
    clientHeight: (node: Element) => size(node)[3] - 2 * sides(node)[1],
  };
  for (const name of clientProperties) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: Element) {
        return values[name](this);
      },
    });
  }
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  installFetch();
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  Element.prototype.getBoundingClientRect = realRect;
  clientProperties.forEach((name, index) => {
    const real = realClient[index];
    if (real) Object.defineProperty(HTMLElement.prototype, name, real);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  });
  document.head.innerHTML = "";
  globalThis.ResizeObserver = realObserver;
  warn.mockRestore();
  vi.unstubAllGlobals();
});

describe("a group of plain fields", () => {
  test("gets one frame, and a separator halfway between each pair of stacked fields", async () => {
    column();
    await mount();
    const group = document.getElementById("g") as HTMLElement;
    expect(group.classList.contains("cms-group")).toBe(true);
    expect(frames()).toHaveLength(1);
    expect(seps("v")).toHaveLength(0);
    expect(seps("h")).toHaveLength(2);
    // Fields end at y 140 and 200, the next start at 160 and 220: halfway is 150 and 210, from the wrapper's top (100).
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["50px", "110px"]);
  });

  test("lays separators out by the fields' boxes: a row gets vertical ones", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}${field("c", "c")}</section>`);
    boxes = { g: [0, 0, 600, 40], a: [0, 0, 180, 40], b: [210, 0, 180, 40], c: [420, 0, 180, 40] };
    await mount();
    expect(seps("v")).toHaveLength(2);
    expect(seps("h")).toHaveLength(0);
    expect(seps("v").map((sep) => sep.style.getPropertyValue("--cms-sep-x"))).toEqual(["195px", "405px"]);
  });

  test("a grid gets both kinds", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}${field("c", "c")}</section>`);
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 180, 40], b: [220, 0, 180, 40], c: [0, 60, 180, 40] };
    await mount();
    expect(seps("v").length).toBeGreaterThan(0);
    expect(seps("h").length).toBeGreaterThan(0);
  });

  test("has no tag, no Tab stop and no tint: the frame is aria-hidden and nothing in it is focusable", async () => {
    column();
    await mount();
    expect(frame(0).getAttribute("aria-hidden")).toBe("true");
    const added = document.querySelectorAll("#g .cms-root");
    for (const node of added) {
      expect(node.hasAttribute("tabindex")).toBe(false);
      expect(node.textContent).toBe("");
    }
    expect(document.querySelector(".cms-group__tag, .cms-group__band")).toBeNull();
  });

  test("sets positions only through custom properties", async () => {
    column();
    await mount();
    for (const node of document.querySelectorAll<HTMLElement>("#g .cms-root")) {
      const style = node.getAttribute("style") ?? "";
      expect(style.split(";").every((part) => part.trim() === "" || part.trim().startsWith("--"))).toBe(true);
    }
    expect(seps().length).toBeGreaterThan(0);
  });

  test("is muted only when every field in it is locked", async () => {
    canEdit = false;
    column();
    await mount();
    expect(document.getElementById("g")?.classList.contains("cms-group--locked")).toBe(true);
    expect(document.querySelectorAll("#g .cms-field--locked")).toHaveLength(3);
    expect(frames()).toHaveLength(1);
  });

  test("is not muted when a field in it can be edited", async () => {
    column();
    document.getElementById("c")?.setAttribute("data-edit-field", `${LOCKED}:c`);
    await mount();
    expect(document.getElementById("g")?.classList.contains("cms-group--locked")).toBe(false);
    // The locked field stays in the group: it keeps its separator.
    expect(seps("h")).toHaveLength(2);
  });

  test("with fewer than two fields draws nothing", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}<p>text</p></section>`);
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 400, 40] };
    await mount();
    expect(frames()).toHaveLength(0);
    expect(document.getElementById("g")?.hasAttribute("class")).toBe(false);
    expect(document.getElementById("a")?.classList.contains("cms-field")).toBe(true);
  });

  test("destroy gives the host its markup back", async () => {
    column();
    const before = document.body.innerHTML;
    await mount();
    expect(document.body.innerHTML).not.toBe(before);
    handle?.destroy();
    handle = undefined;
    expect(document.body.querySelector("main")?.innerHTML).toBe(before.replace(/^<main id="page">|<\/main>$/g, ""));
  });
});

describe("a group the chrome ignores", () => {
  test("one holding a list is dropped, its fields stay plain, and the console names it (G5)", async () => {
    page(
      `<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}<ul id="l" data-edit-list="${KEY}:items"></ul></section>`,
    );
    await mount();
    expect(frames()).toHaveLength(0);
    expect(document.getElementById("g")?.classList.contains("cms-group")).toBe(false);
    expect(document.getElementById("a")?.classList.contains("cms-field")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('id="g"');
    expect(String(warn.mock.calls[0]?.[0])).toContain("data-edit-list");
  });

  test("nested groups: the outermost wins and the console names the inner (G7)", async () => {
    page(
      `<section id="outer" data-edit-group>${field("a", "a")}<div id="inner" data-edit-group>${field("b", "b")}${field("c", "c")}</div></section>`,
    );
    boxes = {
      outer: [0, 0, 400, 200],
      a: [0, 0, 400, 40],
      inner: [0, 60, 400, 100],
      b: [0, 60, 400, 40],
      c: [0, 120, 400, 40],
    };
    await mount();
    expect(frames()).toHaveLength(1);
    expect(document.getElementById("inner")?.classList.contains("cms-group")).toBe(false);
    expect(document.querySelector("#outer > .cms-group__frame")).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('id="inner"');
  });

  test("one inside a list, between the list and its items, is ignored and the console names it", async () => {
    page(
      `<div id="l" data-edit-list="${KEY}:items"><div id="g" data-edit-group><div data-edit-item="${KEY}:items[_key=i1]">${field("a", "items[_key=i1].a")}</div><div data-edit-item="${KEY}:items[_key=i2]">${field("b", "items[_key=i2].b")}</div></div></div>`,
    );
    boxes = { l: [0, 0, 400, 100], g: [0, 0, 400, 100], a: [0, 0, 400, 40], b: [0, 60, 400, 40] };
    await mount();
    expect(frames()).toHaveLength(0);
    expect(document.getElementById("g")?.classList.contains("cms-group")).toBe(false);
    const named = warn.mock.calls.filter((call) => String(call[0]).includes('id="g"'));
    expect(named).toHaveLength(1);
    await handle?.api.refresh();
    await settle();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('id="g"'))).toHaveLength(1);
  });

  test("one inside a list item is ignored and the console names it (G8)", async () => {
    page(
      `<ul id="l" data-edit-list="${KEY}:items"><li data-edit-item="${KEY}:items[_key=i1]"><div id="g" data-edit-group>${field("a", "items[_key=i1].a")}${field("b", "items[_key=i1].b")}</div></li></ul>`,
    );
    await mount();
    expect(frames()).toHaveLength(0);
    expect(document.getElementById("g")?.classList.contains("cms-group")).toBe(false);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('id="g"'))).toBe(true);
  });
});

describe("two dashed outlines that cross (G10)", () => {
  const crossings = () => warn.mock.calls.filter((call) => String(call[0]).includes("cross"));

  test("warn once, naming both, and not again on a recheck", async () => {
    page(`${field("a", "a")}${field("b", "b")}`);
    // Outlines sit 4px outside the fields: these two overlap by 4 pixels each way without one holding the other.
    boxes = { a: [0, 0, 100, 40], b: [90, 30, 100, 40] };
    await mount();
    expect(crossings()).toHaveLength(1);
    const message = String(crossings()[0]?.[0]);
    expect(message).toContain('id="a"');
    expect(message).toContain('id="b"');
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(crossings()).toHaveLength(1);
  });

  test("a group frame and a plain field count, and so does a pair that only starts to cross after a resize", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>${field("c", "c")}`);
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 400, 40], b: [0, 60, 400, 40], c: [0, 200, 400, 40] };
    await mount();
    expect(crossings()).toHaveLength(0);
    // The group's frame reaches 12px past its wrapper: c now starts inside it and ends outside.
    boxes.c = [0, 105, 400, 40];
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(crossings()).toHaveLength(1);
    expect(String(crossings()[0]?.[0])).toContain('id="g"');
    expect(String(crossings()[0]?.[0])).toContain('id="c"');
  });

  test("an outline inside another does not cross it", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>`);
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 400, 40], b: [0, 60, 400, 40] };
    await mount();
    expect(crossings()).toHaveLength(0);
  });

  test("skips an element with no size", async () => {
    page(`${field("a", "a")}${field("b", "b")}`);
    boxes = { a: [0, 0, 100, 40] };
    await mount();
    expect(crossings()).toHaveLength(0);
  });
});

describe("repainting", () => {
  test("a burst of resize reports repaints once per frame, as one report does", async () => {
    column();
    await mount();
    const reportOnce = async (times: number) => {
      const before = boxCalls["g"] ?? 0;
      for (const report of observed) for (let count = 0; count < times; count += 1) report();
      await settle();
      return (boxCalls["g"] ?? 0) - before;
    };
    const one = await reportOnce(1);
    expect(one).toBeGreaterThan(0);
    expect(await reportOnce(5)).toBe(one);
  });

  test("follows the fields when they move", async () => {
    column();
    await mount();
    boxes.b = [100, 170, 400, 40];
    for (const report of observed) report();
    await settle();
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["55px", "115px"]);
  });
});

/** A host or chrome stylesheet rule, as a page would carry it. */
function css(rules: string): void {
  const style = document.createElement("style");
  style.textContent = rules;
  document.head.append(style);
}

const reportAll = async () => {
  for (const report of observed) report();
  await settle();
};

describe("membership: the fields the chrome dresses now", () => {
  test("discarding a never-published document retires the group holding its fields", async () => {
    column();
    await mount();
    expect(frames()).toHaveLength(1);
    await handle?.api.discard(KEY);
    await settle();
    const group = document.getElementById("g") as HTMLElement;
    expect(frames()).toHaveLength(0);
    expect(seps()).toHaveLength(0);
    expect(group.classList.contains("cms-group")).toBe(false);
    expect(group.hasAttribute("class")).toBe(false);
  });

  test("a member hidden at this width keeps the group: the frame goes round the wrapper, no line beside it (G12)", async () => {
    column();
    boxes = { g: [100, 100, 400, 200], a: [100, 100, 400, 40] };
    await mount();
    const group = document.getElementById("g") as HTMLElement;
    expect(frames()).toHaveLength(1);
    expect(group.classList.contains("cms-group")).toBe(true);
    expect(seps()).toHaveLength(0);
    boxes.b = [100, 160, 400, 40];
    await reportAll();
    expect(frames()).toHaveLength(1);
    expect(seps("h")).toHaveLength(1);
    delete boxes.b;
    await reportAll();
    expect(frames()).toHaveLength(1);
    expect(seps()).toHaveLength(0);
    expect(group.classList.contains("cms-group")).toBe(true);
  });

  test("host CSS on .cms-group that hides members doesn't make the group draw and retire (G12)", async () => {
    column();
    groupedBoxes = { b: null, c: null };
    await mount();
    const group = document.getElementById("g") as HTMLElement;
    for (let round = 0; round < 3; round += 1) {
      await reportAll();
      expect(frames()).toHaveLength(1);
      expect(group.classList.contains("cms-group")).toBe(true);
      expect(seps()).toHaveLength(0);
    }
  });

  test("a field of a document Discard deleted leaves its group for good: Done then Edit doesn't bring it back", async () => {
    page(
      `<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}<p id="c" data-edit-field="${OTHER}:c" data-edit-type="text">c</p><p id="d" data-edit-field="${OTHER}:d" data-edit-type="text">d</p></section>`,
    );
    boxes = {
      g: [0, 0, 400, 240],
      a: [0, 0, 400, 40],
      b: [0, 60, 400, 40],
      c: [0, 120, 400, 40],
      d: [0, 180, 400, 40],
    };
    await mount();
    expect(seps("h")).toHaveLength(3);
    await handle?.api.discard(KEY);
    await settle();
    expect(frames()).toHaveLength(1);
    expect(seps("h")).toHaveLength(1);
    const done = [...document.querySelectorAll<HTMLButtonElement>(".cms-bar button")].find(
      (button) => button.textContent === "Done",
    );
    done?.click();
    document.querySelector<HTMLButtonElement>(".cms-enter")?.click();
    await settle();
    expect(frames()).toHaveLength(1);
    expect(seps("h")).toHaveLength(1);
  });

  test("a field inside a list item in the wrapper is not a member", async () => {
    page(
      `<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}<div id="i" data-edit-item="${KEY}:items[_key=i1]">${field("x", "items[_key=i1].x")}</div></section>`,
    );
    boxes = {
      g: [0, 0, 400, 180],
      a: [0, 0, 400, 40],
      b: [0, 60, 400, 40],
      i: [0, 120, 400, 40],
      x: [0, 120, 400, 40],
    };
    await mount();
    expect(frames()).toHaveLength(1);
    expect(seps("h")).toHaveLength(1);
  });

  test("`changed` is called when membership is decided at attach, never by a paint", () => {
    column();
    const group = scanGroups(document.getElementById("page") as HTMLElement, createWarnings())[0];
    if (!group) throw new Error("no group");
    const known = new Map(
      ["a", "b", "c"].map((id) => [
        document.getElementById(id) as HTMLElement,
        { editable: true, detach: () => undefined },
      ]),
    );
    const changed = vi.fn();
    attachGroup(group, (node) => known.get(node), createWarnings(), changed);
    expect(changed).toHaveBeenCalledTimes(1);
    delete boxes.b;
    group.paint();
    delete boxes.c;
    group.paint();
    boxes.b = [100, 160, 400, 40];
    group.paint();
    expect(changed).toHaveBeenCalledTimes(1);
    group.detach?.();
  });

  test("a wrapper that turns display: contents after the scan keeps its frame: display is checked at scan only", async () => {
    column();
    await mount();
    css("#g { display: contents; }");
    await reportAll();
    expect(frames()).toHaveLength(1);
  });
});

describe("geometry: measured in the wrapper's padding box", () => {
  test("a host border does not shift the lines", async () => {
    column();
    // A 5px border: the border box is 410 by 210 at 95,95; the padding box is the 400 by 200 at 100,100 of `column`.
    boxes.g = [95, 95, 410, 210];
    borders = { g: [5, 5] };
    await mount();
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["50px", "110px"]);
    // Edge to edge inside the frame's border: 400 + 2 * (12 - 2).
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-length"))).toEqual(["420px", "420px"]);
  });

  test("the right edge reads the frame's right border, not its left one", async () => {
    css(".cms-group__frame { border-right-width: 5px; }");
    column();
    await mount();
    // From -12 + 2 (left border) to 400 + 12 - 5 (right border).
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-x"))).toEqual(["-10px", "-10px"]);
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-length"))).toEqual(["417px", "417px"]);
  });

  test("a pad of 0 is a pad of 0, not the 12px fallback", async () => {
    css(".cms-group__frame { --cms-list-pad: 0px; }");
    framePad = 0;
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>`);
    boxes = { g: [0, 0, 400, 40], a: [0, 0, 180, 40], b: [220, 0, 180, 40] };
    await mount();
    // From just inside the 2px border at the top to just inside it at the bottom.
    expect(seps("v").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["2px"]);
    expect(seps("v").map((sep) => sep.style.getPropertyValue("--cms-sep-length"))).toEqual(["36px"]);
  });

  test("the frame's border width is read from its style, not assumed to be 2px", async () => {
    // The vertical lines run from the top border to the bottom one.
    css(".cms-group__frame { border-top-width: 5px; border-bottom-width: 5px; }");
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>`);
    boxes = { g: [0, 0, 400, 40], a: [0, 0, 180, 40], b: [220, 0, 180, 40] };
    await mount();
    expect(seps("v").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["-7px"]);
    expect(seps("v").map((sep) => sep.style.getPropertyValue("--cms-sep-length"))).toEqual(["54px"]);
  });

  test("a list's pad of 0 is a pad of 0 too", async () => {
    css(".cms-list__frame { --cms-list-pad: 0px; }");
    framePad = 0;
    page(
      `<ul id="l" data-edit-list="${KEY}:items"><li id="i1" data-edit-item="${KEY}:items[_key=i1]">${field("x", "items[_key=i1].a")}</li></ul>`,
    );
    boxes = { l: [0, 0, 400, 40], i1: [0, 0, 400, 40], x: [0, 0, 400, 40] };
    await mount();
    const listFrame = document.querySelector<HTMLElement>(".cms-list__frame");
    expect(listFrame?.style.getPropertyValue("--cms-frame-top")).toBe("0px");
  });
});

describe("geometry: read from rendered boxes, never parsed from a custom property", () => {
  test("the pad is where the frame is drawn: a 1rem pad is 16px, not 1", async () => {
    // An unregistered custom property computes to its token: `1rem`, which parses as 1.
    css(".cms-group__frame { --cms-list-pad: 1rem; }");
    framePad = 16;
    column();
    await mount();
    // Edge to edge inside the frame's 2px border: 400 + 2 * (16 - 2).
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-length"))).toEqual(["428px", "428px"]);
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-x"))).toEqual(["-14px", "-14px"]);
  });

  test("lines are measured once .cms-group is on: host padding keyed on the class counts", async () => {
    column();
    // `.hero.cms-group { padding-top: 20px }` in the host's CSS: with the class on, the fields sit 20px lower.
    groupedBoxes = {
      g: [100, 100, 400, 220],
      a: [100, 120, 400, 40],
      b: [100, 180, 400, 40],
      c: [100, 240, 400, 40],
    };
    await mount();
    expect(seps("h").map((sep) => sep.style.getPropertyValue("--cms-sep-top"))).toEqual(["70px", "130px"]);
  });

  test("a group frame's reach in the crossing check is where it is drawn", async () => {
    framePad = 16;
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>${field("c", "c")}`);
    // c's outline starts at 114 (6px above it); the frame ends at 116 with a 16px pad, at 112 with the 12px fallback.
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 400, 40], b: [0, 60, 400, 40], c: [0, 120, 400, 40] };
    await mount();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("cross"))).toHaveLength(1);
  });
});

describe("an inline wrapper (G11)", () => {
  test.each(["inline", "contents"])(
    "with display: %s is dropped: its fields keep their own outlines, and the console says so once per mount",
    async (display) => {
      css(`#g { display: ${display}; }`);
      column();
      await mount();
      const group = document.getElementById("g") as HTMLElement;
      expect(frames()).toHaveLength(0);
      expect(seps()).toHaveLength(0);
      expect(group.hasAttribute("class")).toBe(false);
      expect(document.getElementById("a")?.classList.contains("cms-field")).toBe(true);
      const told = () => warn.mock.calls.filter((call) => String(call[0]).includes("inline-block"));
      expect(told()).toHaveLength(1);
      expect(String(told()[0]?.[0])).toContain('id="g"');
      await handle?.api.refresh();
      await settle();
      expect(told()).toHaveLength(1);
    },
  );

  test("an inline-block wrapper is drawn", async () => {
    css("#g { display: inline-block; }");
    column();
    await mount();
    expect(frames()).toHaveLength(1);
  });
});

describe("nodes: appended, so the host's own child rules hold", () => {
  test("the frame and separators come after the host's children", async () => {
    column();
    await mount();
    const group = document.getElementById("g") as HTMLElement;
    expect(group.firstElementChild?.id).toBe("a");
    const children = [...group.children];
    const firstChrome = children.findIndex((node) => node.classList.contains("cms-root"));
    expect(children.slice(firstChrome).every((node) => node.classList.contains("cms-root"))).toBe(true);
    expect(children.slice(0, firstChrome).map((node) => node.id)).toEqual(["a", "b", "c"]);
  });
});

describe("warnings: once per element per mount", () => {
  test("a dropped group warns again in a new mount", async () => {
    page(
      `<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}<ul id="l" data-edit-list="${KEY}:items"></ul></section>`,
    );
    await mount();
    await handle?.api.refresh();
    await settle();
    expect(warn).toHaveBeenCalledTimes(1);
    handle?.destroy();
    await mount();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("a wrapper that clips its overflow is named once: its outline is clipped", async () => {
    css("#g { overflow: hidden; }");
    column();
    await mount();
    const clipped = () => warn.mock.calls.filter((call) => String(call[0]).includes("clip"));
    expect(clipped()).toHaveLength(1);
    expect(String(clipped()[0]?.[0])).toContain('id="g"');
    await handle?.api.refresh();
    await settle();
    expect(clipped()).toHaveLength(1);
  });

  test("a wrapper that lets its overflow show is not named", async () => {
    column();
    await mount();
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("clip"))).toHaveLength(0);
  });
});

describe("crossing watch", () => {
  const crossings = () => warn.mock.calls.filter((call) => String(call[0]).includes("cross"));

  test("a plain field's outline reaches outline-offset + outline-width: with both 0, touching fields don't cross", async () => {
    css(".cms-field { outline-offset: 0px; outline-width: 0px; }");
    page(`${field("a", "a")}${field("b", "b")}`);
    boxes = { a: [0, 0, 100, 40], b: [100, 10, 100, 40] };
    await mount();
    expect(crossings()).toHaveLength(0);
  });

  test("fields 10px apart cross: each outline reaches 4px offset + 2px width", async () => {
    css(".cms-field { outline-offset: 4px; outline-width: 2px; }");
    page(`${field("a", "a")}${field("b", "b")}`);
    boxes = { a: [0, 0, 100, 40], b: [110, 10, 100, 40] };
    await mount();
    expect(crossings()).toHaveLength(1);
  });

  test("a group with a hidden member still draws its frame, and the crossing check counts it (G12)", async () => {
    page(`<section id="g" data-edit-group>${field("a", "a")}${field("b", "b")}</section>${field("c", "c")}`);
    // b has no box. c sits clear of a's own outline (6px past it) but inside the frame's reach (12px past the wrapper).
    boxes = { g: [0, 0, 400, 100], a: [0, 0, 400, 40], c: [0, 106, 400, 40] };
    await mount();
    expect(frames()).toHaveLength(1);
    expect(crossings()).toHaveLength(1);
    expect(String(crossings()[0]?.[0])).toContain('id="g"');
  });

  test("Done lets the watch go of every outline it held", async () => {
    page(`${field("a", "a")}${field("b", "b")}`);
    boxes = { a: [0, 0, 100, 40], b: [0, 100, 100, 40] };
    await mount();
    const a = document.getElementById("a") as HTMLElement;
    expect(watching.some((targets) => targets.has(a))).toBe(true);
    const done = [...document.querySelectorAll<HTMLButtonElement>(".cms-bar button")].find(
      (button) => button.textContent === "Done",
    );
    done?.click();
    expect(watching.every((targets) => targets.size === 0)).toBe(true);
  });

  test("a destroyed watch neither checks nor schedules", async () => {
    page(`<p id="a" class="cms-field"></p><p id="b" class="cms-field"></p>`);
    boxes = { a: [0, 0, 100, 40], b: [90, 30, 100, 40] };
    const frame = vi.spyOn(window, "requestAnimationFrame");
    const watch = createOutlineWatch(document.getElementById("page") as HTMLElement, () => true);
    watch.destroy();
    watch.check();
    watch.schedule();
    await settle();
    expect(crossings()).toHaveLength(0);
    expect(frame).not.toHaveBeenCalled();
    expect(watching.every((targets) => targets.size === 0)).toBe(true);
    frame.mockRestore();
  });

  test("watches exactly the outlines of the last check: a removed field is let go", async () => {
    page(`${field("a", "a")}${field("b", "b")}`);
    boxes = { a: [0, 0, 100, 40], b: [0, 100, 100, 40] };
    await mount();
    const b = document.getElementById("b") as HTMLElement;
    expect(watching.some((targets) => targets.has(b))).toBe(true);
    b.remove();
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(watching.some((targets) => targets.has(b))).toBe(false);
    expect(watching.some((targets) => targets.has(document.getElementById("a") as HTMLElement))).toBe(true);
  });
});
