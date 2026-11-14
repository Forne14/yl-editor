// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editable, type EditableListAttrs } from "../editable.ts";
import { applyArrayOp, parsePath } from "../path.ts";
import type { ArrayOp } from "../types.ts";
import { mountEditor } from "./index.ts";
import type { EditorHandle, EditorOptions } from "./types.ts";

interface Artist {
  _key: string;
  name: string;
}

const KEY = "artist/list";
const LIST = `${KEY}:artists`;
let artists: Artist[];
let version: number;
let canEdit: boolean;
let listAttrs: EditableListAttrs;
let arrayCalls: { op: ArrayOp; expectedVersion: unknown }[];
let arrayAnswer: (() => Response) | undefined;
let pageAnswer: (() => Response) | undefined;
let handle: EditorHandle | undefined;

function renderList(): string {
  const edit = editable(KEY);
  const attrs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
  const items = artists
    .map(
      (artist, index) =>
        `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`artists[_key=${artist._key}].name`, "text"))}>${artist.name}</h3></li>`,
    )
    .join("");
  return `<ul${attrs(edit.list("artists", listAttrs))}>${items}</ul>`;
}

function wireDocument() {
  return {
    id: 1,
    key: KEY,
    type: "page",
    slug: "list",
    payload: { artists },
    isDraft: true,
    publishedAt: null,
    draftUpdatedAt: null,
    previousSlugs: [],
    retiredAt: null,
    version,
    scheduledAt: null,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, location.href);
      const route = `${init.method ?? "GET"} ${url.pathname}`;
      if (route === "GET /api/content/documents") {
        return json({
          documents: {
            [KEY]: {
              key: KEY,
              type: "page",
              version,
              isDraft: true,
              draftUpdatedAt: null,
              publishedAt: null,
              access: { edit: canEdit, publish: canEdit },
            },
          },
        });
      }
      if (route === "GET /api/content/document") return json({ document: wireDocument(), publishedPayload: null });
      if (route === "POST /api/content/array") {
        const body = JSON.parse(String(init.body)) as { op: ArrayOp; expectedVersion: unknown };
        arrayCalls.push({ op: body.op, expectedVersion: body.expectedVersion });
        if (arrayAnswer) return arrayAnswer();
        artists = applyArrayOp({ artists }, parsePath("artists"), body.op).artists;
        version += 1;
        return json({ document: wireDocument() });
      }
      if (route.startsWith("GET ") && !url.pathname.startsWith("/api/")) {
        if (pageAnswer) return pageAnswer();
        return new Response(`<!doctype html><html><body><main id="page">${renderList()}</main></body></html>`);
      }
      return json({ error: { code: "not_found", message: "none" } }, 404);
    }),
  );
}

async function settle(): Promise<void> {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(extra: EditorOptions = {}): Promise<void> {
  handle = mountEditor({
    lists: { [LIST]: { newItem: () => ({ name: "New artist" }) } },
    ...extra,
  });
  await handle.ready;
}

const list = () => document.querySelector<HTMLElement>(`[data-edit-list="${LIST}"]`) as HTMLElement;
const items = () => [...list().querySelectorAll<HTMLElement>("[data-edit-item]")];
const toolButton = (index: number, action: string) =>
  items()[index]?.querySelector<HTMLButtonElement>(`.cms-item__tools [data-action="${action}"]`) as HTMLButtonElement;
const addButton = () => list().querySelector<HTMLButtonElement>(".cms-list__add-button");
const liveText = () => document.querySelector(".cms-live")?.textContent ?? "";
const names = () => items().map((item) => item.querySelector("h3")?.textContent);

beforeEach(() => {
  artists = [
    { _key: "a", name: "Mara" },
    { _key: "b", name: "Tobias" },
  ];
  version = 4;
  canEdit = true;
  listAttrs = { label: "Artists", noun: "artist", plural: "artists", min: 1, max: 3, itemLabel: "name" };
  arrayCalls = [];
  arrayAnswer = undefined;
  pageAnswer = undefined;
  sessionStorage.clear();
  document.body.innerHTML = `<main id="page">${renderList()}</main>`;
  installFetch();
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  vi.unstubAllGlobals();
});

describe("a list while editing", () => {
  test("gets one outline with its tag, a named toolbar per item and an Add button", async () => {
    await mount();
    expect(list().classList.contains("cms-list")).toBe(true);
    expect(list().querySelectorAll(".cms-list__frame")).toHaveLength(1);
    expect(list().querySelector(".cms-list__tag")?.textContent).toBe("Artists · 2 of 3");
    const toolbar = items()[1]?.querySelector('[role="toolbar"]');
    expect(toolbar?.getAttribute("aria-label")).toBe("Tobias, 2 of 2: actions");
    expect(toolButton(1, "down").getAttribute("aria-label")).toBe("Move Tobias down");
    expect(toolButton(0, "up").getAttribute("aria-disabled")).toBe("true");
    expect(toolButton(1, "down").getAttribute("aria-disabled")).toBe("true");
    expect(toolButton(0, "duplicate")).toBeNull();
    expect(addButton()?.textContent).toBe("Add artist");
  });

  test("its toolbar is one tab stop, with arrow keys between the buttons", async () => {
    await mount();
    const up = toolButton(1, "up");
    const remove = toolButton(1, "remove");
    expect([up.tabIndex, toolButton(1, "down").tabIndex, remove.tabIndex]).toEqual([0, -1, -1]);
    up.focus();
    up.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(remove);
    expect([up.tabIndex, remove.tabIndex]).toEqual([-1, 0]);
  });

  test("Done, and destroy, give the host its markup back", async () => {
    const before = document.body.querySelector("main")?.innerHTML;
    await mount();
    handle?.destroy();
    handle = undefined;
    expect(document.body.querySelector("main")?.innerHTML).toBe(before);
  });

  test("a list whose document can't be edited gets no list chrome", async () => {
    canEdit = false;
    await mount();
    expect(list().querySelector(".cms-root")).toBeNull();
  });

  test("a list without newItem offers no Add", async () => {
    await mount({ lists: {} });
    expect(addButton()).toBeNull();
    expect(toolButton(0, "remove")).not.toBeNull();
  });

  test("order data has no move buttons; duplicate on has Duplicate", async () => {
    listAttrs = { ...listAttrs, order: "data", duplicate: true };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    expect(toolButton(0, "up")).toBeNull();
    expect(toolButton(0, "duplicate").getAttribute("aria-label")).toBe("Duplicate Mara");
  });
});

describe("list operations", () => {
  test("Move down sends a move on the stored indices, swaps in the page's new list and keeps focus on the item", async () => {
    await mount();
    toolButton(0, "down").click();
    await settle();
    expect(arrayCalls).toEqual([{ op: { kind: "move", from: 0, to: 1 }, expectedVersion: 4 }]);
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(liveText()).toBe("Mara moved to position 2 of 2.");
    // Move down is inert now that Mara is last, so focus takes the move that still works.
    expect(document.activeElement).toBe(toolButton(1, "up"));
  });

  test("Remove removes at once, offers Undo, and Undo puts the same item back where it was", async () => {
    await mount();
    toolButton(0, "remove").click();
    await settle();
    expect(arrayCalls[0]?.op).toEqual({ kind: "remove", index: 0 });
    expect(names()).toEqual(["Tobias"]);
    expect(liveText()).toContain("Mara removed. 1 left.");
    const undo = [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")].find(
      (node) => node.textContent === "Undo",
    );
    // The same Undo sits right after the items, so Tab from the list reaches it.
    const inList = list().querySelector<HTMLButtonElement>(".cms-list__undo");
    expect(inList?.hidden).toBe(false);
    undo?.click();
    await settle();
    expect(arrayCalls[1]?.op).toEqual({ kind: "insert", index: 0, value: { _key: "a", name: "Mara" } });
    expect(names()).toEqual(["Mara", "Tobias"]);
    expect(liveText()).toBe("Mara restored at position 1 of 2.");
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
  });

  test("Ctrl+Z in the list undoes the last removal", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(1, "remove").click();
    await settle();
    const focused = document.activeElement as HTMLElement;
    expect(focused.closest(".cms-list")).not.toBeNull();
    focused.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
  });

  test("Add inserts newItem with a fresh _key at the end and opens its first field", async () => {
    await mount();
    addButton()?.click();
    await settle();
    const op = arrayCalls[0]?.op as Extract<ArrayOp, { kind: "insert" }>;
    expect(op.kind).toBe("insert");
    expect(op.index).toBe(2);
    expect(op.value).toMatchObject({ name: "New artist", _key: expect.stringMatching(/^[a-z0-9]{10}$/) });
    expect(names()).toEqual(["Mara", "Tobias", "New artist"]);
    expect(items()[2]?.querySelector("h3")?.classList.contains("cms-field--editing")).toBe(true);
    // Selected, so typing replaces the default instead of adding to it.
    expect(document.getSelection()?.toString()).toBe("New artist");
    expect(liveText()).toBe("New artist added at position 3 of 3.");
  });

  test("at the maximum Add is inert, says why on screen, and writes nothing", async () => {
    artists.push({ _key: "c", name: "Ines" });
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const add = addButton() as HTMLButtonElement;
    expect(add.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(add.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Maximum of 3 artists. Remove one to add another.");
    add.click();
    await settle();
    expect(arrayCalls).toEqual([]);
    expect(liveText()).toBe("Maximum of 3 artists. Remove one to add another.");
  });

  test("at the minimum Remove is inert and says why", async () => {
    artists = [{ _key: "a", name: "Mara" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    expect(arrayCalls).toEqual([]);
    expect(liveText()).toBe("At least 1 artist needed.");
  });

  test("an empty list says so and still offers Add", async () => {
    artists = [];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    expect(list().querySelector(".cms-list__empty")?.textContent).toBe("No artists yet.");
    expect(addButton()).not.toBeNull();
  });

  test("Duplicate inserts a copy with a new _key right after the original", async () => {
    listAttrs = { ...listAttrs, duplicate: true };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "duplicate").click();
    await settle();
    const op = arrayCalls[0]?.op as Extract<ArrayOp, { kind: "insert" }>;
    expect(op.index).toBe(1);
    expect(op.value).toMatchObject({ name: "Mara" });
    expect((op.value as Artist)._key).not.toBe("a");
    expect(names()).toEqual(["Mara", "Mara", "Tobias"]);
  });

  test("a page that doesn't show the list after the write asks for a reload", async () => {
    await mount();
    pageAnswer = () => new Response("<!doctype html><p>elsewhere</p>");
    toolButton(0, "down").click();
    await settle();
    expect(arrayCalls).toHaveLength(1);
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Reload to see it.");
  });

  test("a conflict writes nothing, says so and shows the latest list", async () => {
    await mount();
    arrayAnswer = () => {
      artists = [{ _key: "z", name: "Someone else" }, ...artists];
      version += 1;
      return json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409);
    };
    toolButton(0, "down").click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("has changed since this page loaded");
    expect(names()).toEqual(["Someone else", "Mara", "Tobias"]);
  });
});
