// @vitest-environment happy-dom
// Field groups (#44). happy-dom has no layout, so boxes are stubbed by element id: this proves the chrome's logic, not
// how a browser lays the page out (e2e/groups.spec.ts does that).
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { mountEditor } from "./index.ts";
import type { EditorHandle } from "./types.ts";

const KEY = "page/home";
let canEdit: boolean;
let handle: EditorHandle | undefined;
/** `id -> [left, top, width, height]`. An element with no entry has no box, like one that isn't rendered. */
let boxes: Record<string, [number, number, number, number]>;
let boxCalls: Record<string, number>;
let warn: MockInstance<typeof console.warn>;
const realRect = Element.prototype.getBoundingClientRect;
const realObserver = globalThis.ResizeObserver;
let observed: (() => void)[];

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
        return json({
          documents: {
            [KEY]: {
              key: KEY,
              type: "page",
              version: 1,
              isDraft: true,
              draftUpdatedAt: null,
              publishedAt: null,
              access: { edit: canEdit, publish: canEdit },
            },
          },
        });
      }
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
  boxCalls = {};
  observed = [];
  sessionStorage.clear();
  Element.prototype.getBoundingClientRect = function (this: Element) {
    boxCalls[this.id] = (boxCalls[this.id] ?? 0) + 1;
    const box = boxes[this.id];
    return box ? new DOMRect(...box) : new DOMRect(0, 0, 0, 0);
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  installFetch();
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  Element.prototype.getBoundingClientRect = realRect;
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
    document.getElementById("c")?.setAttribute("data-edit-field", "other/doc:c");
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
