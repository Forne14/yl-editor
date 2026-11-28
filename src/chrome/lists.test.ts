// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editable, itemPath, type EditableListAttrs } from "../editable.ts";
import { applyArrayOp, parsePath } from "../path.ts";
import type { ArrayOp } from "../types.ts";
import { addHostClass, element, removeHostClass } from "./dom.ts";
import { mountEditor } from "./index.ts";
import { attachList, scanLists, type ListHandlers } from "./lists.ts";
import { defaultStrings } from "./strings.ts";
import type { EditorHandle, EditorOptions } from "./types.ts";

interface Artist {
  _key?: string;
  name: string;
  /** Rendered as a list nested in the item when present. */
  links?: Artist[];
}

const KEY = "artist/list";
const LIST = `${KEY}:artists`;
let artists: Artist[];
/** A second list in the same document, rendered when set. */
let crew: Artist[] | undefined;
/** What Discard leaves; the stub answers a field save with 500 while `failFields` is set. */
let published: Artist[];
let failFields: boolean;
/** A second document, `other/list`, with one list, rendered when set. */
const OTHER = "other/list";
let guests: Artist[] | undefined;
let otherVersion: number;
let fieldCalls: string[];
let version: number;
let canEdit: boolean;
let listAttrs: EditableListAttrs;
let arrayCalls: { op: ArrayOp; expectedVersion: unknown }[];
let arrayAnswer: (() => Response) | undefined;
let pageAnswer: (() => Response) | undefined;
let handle: EditorHandle | undefined;

function renderOne(path: string, entries: Artist[], docKey = KEY): string {
  const edit = editable(docKey);
  const attrs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
  const items = entries
    .map(
      (artist, index) =>
        `<li${attrs(edit.item(path, artist, index))}><h3${attrs(edit(`${itemPath(path, artist, index)}.name`, "text"))}>${artist.name}</h3>${artist.links ? renderOne(`${itemPath(path, artist, index)}.links`, artist.links, docKey) : ""}</li>`,
    )
    .join("");
  return `<ul${attrs(edit.list(path, listAttrs))}>${items}</ul>`;
}

function renderList(): string {
  return (
    renderOne("artists", artists) +
    (crew ? renderOne("crew", crew) : "") +
    (guests ? renderOne("guests", guests, OTHER) : "")
  );
}

function otherDocument() {
  return { ...wireDocument(), id: 2, key: OTHER, payload: { guests }, version: otherVersion };
}

function wireDocument() {
  return {
    id: 1,
    key: KEY,
    type: "page",
    slug: "list",
    payload: { artists, ...(crew ? { crew } : {}) },
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
            ...(guests
              ? {
                  [OTHER]: {
                    key: OTHER,
                    type: "page",
                    version: otherVersion,
                    isDraft: true,
                    draftUpdatedAt: null,
                    publishedAt: null,
                    access: { edit: true, publish: true },
                  },
                }
              : {}),
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
      if (route === "GET /api/content/document") {
        const doc = url.searchParams.get("key") === OTHER ? otherDocument() : wireDocument();
        return json({ document: doc, publishedPayload: null });
      }
      if (route === "POST /api/content/array") {
        const body = JSON.parse(String(init.body)) as { op: ArrayOp; expectedVersion: unknown };
        arrayCalls.push({ op: body.op, expectedVersion: body.expectedVersion });
        if (arrayAnswer) return arrayAnswer();
        const body2 = JSON.parse(String(init.body)) as { path: string; key: string };
        if (body2.key === OTHER) {
          guests = applyArrayOp({ guests }, parsePath(body2.path), body.op).guests;
          otherVersion += 1;
          return json({ document: otherDocument() });
        }
        const next = applyArrayOp({ artists, crew }, parsePath(body2.path), body.op);
        artists = next.artists;
        crew = next.crew;
        version += 1;
        return json({ document: wireDocument() });
      }
      if (route === "POST /api/content/field") {
        fieldCalls.push((JSON.parse(String(init.body)) as { path: string }).path);
        if (failFields) return json({ error: { code: "internal", message: "down" } }, 500);
        const written = JSON.parse(String(init.body)) as { path: string; value: unknown };
        // A whole-list write (the chrome keying an unkeyed list) is stored, as the store would.
        if (written.path === "artists" && Array.isArray(written.value)) artists = written.value as Artist[];
        version += 1;
        return json({ document: wireDocument() });
      }
      if (route === "POST /api/content/discard") {
        if ((JSON.parse(String(init.body)) as { key: string }).key === OTHER) {
          guests = [{ _key: "g1", name: "Gus" }];
          otherVersion += 1;
          return json({ document: otherDocument() });
        }
        artists = published.map((artist) => ({ ...artist }));
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
  crew = undefined;
  guests = undefined;
  otherVersion = 2;
  fieldCalls = [];
  published = artists.map((artist) => ({ ...artist }));
  failFields = false;
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

  test("its toolbar is one tab stop, on its first button other than the handle, with arrow keys between the buttons", async () => {
    await mount();
    const up = toolButton(1, "up");
    const remove = toolButton(1, "remove");
    expect([toolButton(1, "grip").tabIndex, up.tabIndex, toolButton(1, "down").tabIndex, remove.tabIndex]).toEqual([
      -1, 0, -1, -1,
    ]);
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
    const described = (add.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    // The tag, which the outline hides from assistive technology, then the reason.
    expect(described[0]).toBe("Artists · 3 of 3");
    const reason = { textContent: described[1] };
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

describe("after review", () => {
  test("Undo in a list, and Ctrl+Z there, put back that list's removal, not the newest anywhere", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    crew = [
      { _key: "c1", name: "Cleo" },
      { _key: "c2", name: "Dev" },
    ];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    const crewList = () => document.querySelector<HTMLElement>(`[data-edit-list="${KEY}:crew"]`) as HTMLElement;
    crewList().querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    expect(crew?.map((member) => member.name)).toEqual(["Dev"]);
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
    expect(crew?.map((member) => member.name)).toEqual(["Dev"]);
  });

  test("Discard brings the list's markup back to what is stored", async () => {
    await mount();
    addButton()?.click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias", "New artist"]);
    (document.activeElement as HTMLElement | null)?.blur();
    await settle();
    await handle?.api.discard(KEY);
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
    expect(items()[0]?.querySelector(".cms-item__tools")).not.toBeNull();
  });

  test("a value that failed to save survives the list's new markup, with its failed state", async () => {
    await mount();
    failFields = true;
    const tobias = items()[1]?.querySelector("h3") as HTMLElement;
    tobias.click();
    tobias.textContent = "Tobi";
    tobias.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    toolButton(0, "down").click();
    await settle();
    const moved = items()[0]?.querySelector("h3");
    expect(moved?.textContent).toBe("Tobi");
    expect(moved?.classList.contains("cms-field--failed")).toBe(true);
  });
});

describe("swapping a list's markup touches nothing else", () => {
  const footer = () => document.querySelector<HTMLElement>("#footer") as HTMLElement;
  const page = () =>
    `<main id="page">${renderList()}<p id="footer" data-edit-field="${KEY}:title" data-edit-type="text">Title</p></main>`;

  test("lists of two documents changed back to back both show their change, with no reload toast", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    guests = [
      { _key: "g1", name: "Gus" },
      { _key: "g2", name: "Hal" },
    ];
    document.body.innerHTML = page();
    await mount();
    toolButton(0, "remove").click();
    const guestList = document.querySelector<HTMLElement>(`[data-edit-list="${OTHER}:guests"]`) as HTMLElement;
    guestList.querySelector<HTMLButtonElement>('[data-action="down"]')?.click();
    await settle();
    await settle();
    expect(names()).toEqual(["Tobias"]);
    const guestNames = [...document.querySelectorAll(`[data-edit-list="${OTHER}:guests"] [data-edit-item] h3`)].map(
      (node) => node.textContent,
    );
    expect(guestNames).toEqual(["Hal", "Gus"]);
    expect(document.querySelector(".cms-toast")?.textContent ?? "").not.toContain("Reload");
  });

  test("a list nested in an item swaps with its parent, with no reload toast", async () => {
    artists[0] = { _key: "a", name: "Mara", links: [{ _key: "l1", name: "Site" }] };
    document.body.innerHTML = page();
    await mount();
    const tobias = items().find((item) => item.querySelector("h3")?.textContent === "Tobias") as HTMLElement;
    tobias.querySelector<HTMLButtonElement>(':scope > .cms-item__tools [data-action="up"]')?.click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara", "Site"]);
    expect(document.querySelector(".cms-toast")?.textContent ?? "").not.toContain("Reload");
    // Top-level lists only (ruled 2026-11-18): the nested list's fields are cells of the outer row.
    expect(document.querySelectorAll(".cms-list__frame")).toHaveLength(1);
  });

  test("a failed field outside the list keeps its failed state and its text", async () => {
    document.body.innerHTML = page();
    await mount();
    failFields = true;
    footer().click();
    footer().textContent = "Unsaved";
    footer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(footer().classList.contains("cms-field--failed")).toBe(true);
    failFields = false;
    toolButton(0, "down").click();
    await settle();
    expect(footer().classList.contains("cms-field--failed")).toBe(true);
    expect(footer().textContent).toBe("Unsaved");
  });

  test("a field being edited elsewhere stays open while the list swaps", async () => {
    document.body.innerHTML = page();
    await mount();
    toolButton(0, "down").click();
    footer().click();
    expect(footer().classList.contains("cms-field--editing")).toBe(true);
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(footer().classList.contains("cms-field--editing")).toBe(true);
  });

  test("Discard within the Undo window takes the Undo away", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = page();
    await mount();
    toolButton(0, "remove").click();
    await settle();
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(false);
    await handle?.api.discard(KEY);
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent ?? "").not.toContain("Undo");
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
  });
});

describe("third review round", () => {
  test("discarding one document keeps the other's Undo, and it restores the other's item", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    guests = [{ _key: "g1", name: "Gus" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const guestList = () => document.querySelector<HTMLElement>(`[data-edit-list="${OTHER}:guests"]`) as HTMLElement;
    guestList().querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    toolButton(0, "remove").click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Removed Mara.");
    await handle?.api.discard(KEY);
    await settle();
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
    const undo = guestList().querySelector<HTMLButtonElement>(".cms-list__undo");
    expect(undo?.hidden).toBe(false);
    undo?.click();
    await settle();
    expect(guests?.map((guest) => guest.name)).toEqual(["Gus"]);
    expect(names()).toEqual(["Mara", "Tobias"]);
  });
});

describe("fifth review round", () => {
  /** Holds every page fetch until `release` is called. */
  function gatePage(): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (!String(input).includes("/api/")) await gate;
      return realFetch(input, init);
    });
    return () => release();
  }

  test("after a conflict the list stays locked until the page shows the other editor's change", async () => {
    await mount();
    const release = gatePage();
    arrayAnswer = () => {
      arrayAnswer = undefined;
      artists = [{ _key: "z", name: "Zed" }, ...artists];
      version += 1;
      return json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409);
    };
    toolButton(0, "down").click();
    await settle();
    toolButton(0, "down").click();
    await settle();
    expect(arrayCalls).toHaveLength(1);
    release();
    await settle();
    expect(names()).toEqual(["Zed", "Mara", "Tobias"]);
  });

  test("while Discard's swap is on its way the list doesn't act", async () => {
    await mount();
    const release = gatePage();
    await handle?.api.discard(KEY);
    toolButton(0, "down").click();
    await settle();
    expect(arrayCalls).toEqual([]);
    release();
    await settle();
  });

  test("focus moved to another list meanwhile stays there", async () => {
    guests = [
      { _key: "g1", name: "Gus" },
      { _key: "g2", name: "Hal" },
    ];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const release = gatePage();
    toolButton(0, "down").click();
    await settle();
    const guestButton = document.querySelector<HTMLButtonElement>(
      `[data-edit-list="${OTHER}:guests"] [data-action="remove"]`,
    ) as HTMLButtonElement;
    guestButton.focus();
    release();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(document.activeElement).toBe(guestButton);
  });
});

describe("the ruling of 2026-11-15", () => {
  /** Holds every page fetch until `release` is called; counts them. */
  function gatePage(): { release: () => void; requests: () => number } {
    let release: () => void = () => undefined;
    let requests = 0;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (!String(input).includes("/api/")) {
        requests += 1;
        await gate;
      }
      return realFetch(input, init);
    });
    return { release: () => release(), requests: () => requests };
  }

  test("Move and Remove change the page's own markup, with no page request", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const page = gatePage();
    const maraElement = items()[0];
    toolButton(0, "down").click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(items()[1]).toBe(maraElement);
    toolButton(0, "remove").click();
    await settle();
    expect(names()).toEqual(["Mara"]);
    expect(page.requests()).toBe(0);
    page.release();
  });

  test("Undo puts the removed item's own element back where it was", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const maraElement = items()[0];
    toolButton(0, "remove").click();
    await settle();
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(items()[0]).toBe(maraElement);
    expect(names()).toEqual(["Mara", "Tobias"]);
    expect(toolButton(0, "down")).not.toBeNull();
  });

  test("removing an item whose save failed drops that value and says so", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const tobias = items()[1]?.querySelector("h3") as HTMLElement;
    tobias.click();
    tobias.textContent = "Tobi";
    tobias.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    toolButton(1, "remove").click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain(
      "Removed Tobi. Its unsaved change was dropped.",
    );
    fieldCalls = [];
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(fieldCalls).toEqual([]);
  });

  test("while Add waits for the page, a press in the list says the list is updating", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    await mount();
    const page = gatePage();
    addButton()?.click();
    await settle();
    toolButton(1, "up").click();
    await settle();
    expect(liveText()).toBe("Updating the list…");
    expect(arrayCalls.map((call) => call.op.kind)).toEqual(["insert"]);
    page.release();
    await settle();
  });

  test("a page that doesn't show the list after Add asks for a reload, and the next Add still works", async () => {
    listAttrs = { ...listAttrs, max: 5 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    pageAnswer = () => {
      pageAnswer = undefined;
      return new Response("<!doctype html><p>elsewhere</p>");
    };
    addButton()?.click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Reload to see it.");
    addButton()?.click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias", "New artist", "New artist"]);
  });
});

describe("rearranging the page's own markup", () => {
  const attrs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
  /** The list element wraps a heading and a <ul>, with a separator between the items. */
  function wrapped(): string {
    const edit = editable(KEY);
    const item = (artist: Artist, index: number) =>
      `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`${itemPath("artists", artist, index)}.name`, "text"))}>${artist.name}</h3></li>`;
    const lis = artists.map(item);
    return `<main id="page"><section${attrs(edit.list("artists", listAttrs))}><h2>Team</h2><ul id="team-ul">${lis.join('<li class="sep">·</li>')}</ul></section></main>`;
  }

  test("a separator between items stays between them after a move", async () => {
    document.body.innerHTML = wrapped();
    await mount();
    toolButton(0, "down").click();
    await settle();
    const children = [...(document.querySelector("#team-ul")?.children ?? [])].map(
      (node) => node.querySelector("h3")?.textContent ?? node.textContent,
    );
    expect(children).toEqual(["Tobias", "·", "Mara"]);
  });

  test("Undo of the only item puts it back inside its own parent", async () => {
    artists = [{ _key: "a", name: "Mara" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = wrapped();
    await mount();
    toolButton(0, "remove").click();
    await settle();
    expect(document.querySelectorAll("#team-ul [data-edit-item]")).toHaveLength(0);
    document.querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(document.querySelectorAll("#team-ul [data-edit-item]")).toHaveLength(1);
  });

  test("Undo leaves another document's field inside the item as it was", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    const foreign = document.createElement("p");
    foreign.dataset.editField = `${OTHER}:note`;
    foreign.textContent = "Theirs";
    items()[0]?.append(foreign);
    await mount();
    toolButton(0, "remove").click();
    await settle();
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(foreign.isConnected).toBe(true);
    expect(foreign.textContent).toBe("Theirs");
  });

  test("an Undo that fails to write can be tried again", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    arrayAnswer = () => {
      arrayAnswer = undefined;
      return json({ error: { code: "internal", message: "down" } }, 500);
    };
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(names()).toEqual(["Tobias"]);
    const undo = list().querySelector<HTMLButtonElement>(".cms-list__undo");
    expect(undo?.hidden).toBe(false);
    undo?.click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
  });

  test("a stored item the page has no element for makes the chrome ask the page", async () => {
    await mount();
    artists.push({ _key: "c", name: "Ines" });
    toolButton(0, "down").click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara", "Ines"]);
  });
});

describe("eighth review round", () => {
  test("a write answer with no array at the list's path asks the page instead of emptying the list", async () => {
    await mount();
    arrayAnswer = () => {
      arrayAnswer = undefined;
      artists = [artists[1] as Artist, artists[0] as Artist];
      version += 1;
      return json({ document: { ...wireDocument(), payload: {} } });
    };
    toolButton(0, "down").click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
  });

  test("a failed value on the removed item's own path is dropped too", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    const whole = document.createElement("span");
    whole.dataset.editField = `${KEY}:artists[_key=b]`;
    whole.dataset.editType = "text";
    whole.textContent = "whole";
    items()[1]?.append(whole);
    await mount();
    failFields = true;
    whole.click();
    whole.textContent = "changed";
    whole.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    toolButton(1, "remove").click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Its unsaved change was dropped.");
  });
});

describe("ninth review round", () => {
  const attrs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
  /** Each item wrapped in an <li class="card"> of the host's. */
  function wrappedItems(): string {
    const edit = editable(KEY);
    const cards = artists
      .map(
        (artist, index) =>
          `<li class="card"><div${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`${itemPath("artists", artist, index)}.name`, "text"))}>${artist.name}</h3></div></li>`,
      )
      .join("");
    return `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${cards}</ul></main>`;
  }

  test("items wrapped in markup of the host's are redrawn by the page, leaving no empty wrapper", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = wrappedItems();
    pageAnswer = () => new Response(`<!doctype html>${wrappedItems()}`);
    await mount();
    toolButton(0, "remove").click();
    await settle();
    expect(document.querySelectorAll("li.card")).toHaveLength(1);
    expect(names()).toEqual(["Tobias"]);
  });

  test("Undo moves past a removal whose list has left the page", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    guests = [{ _key: "g1", name: "Gus" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    const guestList = () => document.querySelector<HTMLElement>(`[data-edit-list="${OTHER}:guests"]`);
    guestList()?.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    guestList()?.remove();
    const undo = () =>
      [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")].find(
        (node) => node.textContent === "Undo",
      );
    undo()?.click();
    await settle();
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
  });
});

describe("the rulings of 2026-11-18", () => {
  test("a nested list gets no list chrome; its fields are still fields", async () => {
    artists[0] = { _key: "a", name: "Mara", links: [{ _key: "l1", name: "Site" }] };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const nested = document.querySelector<HTMLElement>(`[data-edit-list="${KEY}:artists[_key=a].links"]`);
    expect(nested?.querySelector(".cms-root")).toBeNull();
    expect(nested?.querySelector("h3")?.classList.contains("cms-field")).toBe(true);
  });

  test("every copy of a list gets list chrome, and a removal shows in both", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    const both = () => `<main id="page">${renderList()}<section id="again">${renderList()}</section></main>`;
    document.body.innerHTML = both();
    pageAnswer = () => new Response(`<!doctype html>${both()}`);
    await mount();
    const copies = () => [...document.querySelectorAll<HTMLElement>(`[data-edit-list="${LIST}"]`)];
    expect(copies().map((copy) => copy.querySelectorAll(".cms-list__frame").length)).toEqual([1, 1]);
    copies()[1]?.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    const namesIn = (copy: HTMLElement | undefined) =>
      [...(copy?.querySelectorAll("[data-edit-item] h3") ?? [])].map((node) => node.textContent);
    expect(namesIn(copies()[0])).toEqual(["Tobias"]);
    expect(namesIn(copies()[1])).toEqual(["Tobias"]);
    expect(copies().map((copy) => copy.querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden)).toEqual([
      false,
      false,
    ]);
  });

  test("Undo that hits a conflict drops the removal and says it can't be put back", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    arrayAnswer = () => {
      arrayAnswer = undefined;
      artists = [{ _key: "z", name: "Zed" }, ...artists];
      version += 1;
      return json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409);
    };
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Mara can no longer be put back");
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
  });

  test("each removal has its own 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      listAttrs = { ...listAttrs, min: 0 };
      guests = [{ _key: "g1", name: "Gus" }];
      document.body.innerHTML = `<main id="page">${renderList()}</main>`;
      await mount();
      toolButton(0, "remove").click();
      await settle();
      vi.advanceTimersByTime(10000);
      const guestList = () => document.querySelector<HTMLElement>(`[data-edit-list="${OTHER}:guests"]`);
      guestList()?.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
      await settle();
      vi.advanceTimersByTime(6000);
      expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
      expect(guestList()?.querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("eleventh review round", () => {
  test("an Undo that fails after its window has closed doesn't bring the removal back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      listAttrs = { ...listAttrs, min: 0 };
      document.body.innerHTML = `<main id="page">${renderList()}</main>`;
      await mount();
      toolButton(0, "remove").click();
      await settle();
      arrayAnswer = () => {
        arrayAnswer = undefined;
        vi.advanceTimersByTime(16000);
        return json({ error: { code: "internal", message: "down" } }, 500);
      };
      list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
      await settle();
      expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("twelfth review round", () => {
  test("Undo puts an item back after its old neighbour, even after another change", async () => {
    artists.push({ _key: "c", name: "Ines" });
    listAttrs = { ...listAttrs, min: 0, max: 5 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(1, "remove").click();
    await settle();
    toolButton(1, "up").click();
    await settle();
    expect(names()).toEqual(["Ines", "Mara"]);
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(names()).toEqual(["Ines", "Mara", "Tobias"]);
  });

  test("Undo pressed in the second copy keeps focus in that copy", async () => {
    listAttrs = { ...listAttrs, min: 0 };
    const both = () => `<main id="page">${renderList()}<section id="again">${renderList()}</section></main>`;
    document.body.innerHTML = both();
    await mount();
    const copies = () => [...document.querySelectorAll<HTMLElement>(`[data-edit-list="${LIST}"]`)];
    copies()[1]?.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    copies()[1]?.querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(copies()[1]?.contains(document.activeElement)).toBe(true);
  });
});

describe("fourteenth review round", () => {
  test("after Add, each copy of a list keeps its own markup", async () => {
    listAttrs = { ...listAttrs, max: 5 };
    const page = () =>
      `<main id="page">${renderList()}<aside id="compact">${renderList().replaceAll("<h3", '<h3 class="compact"')}</aside></main>`;
    document.body.innerHTML = page();
    pageAnswer = () => new Response(`<!doctype html>${page()}`);
    await mount();
    addButton()?.click();
    await settle();
    const copies = [...document.querySelectorAll<HTMLElement>(`[data-edit-list="${LIST}"]`)];
    expect(copies[0]?.querySelector("h3.compact")).toBeNull();
    expect(copies[1]?.querySelector("h3.compact")).not.toBeNull();
    expect(copies[1]?.closest("#compact")).not.toBeNull();
  });

  test("an Undo that hits a conflict drops every removal of that document", async () => {
    artists.push({ _key: "c", name: "Ines" });
    listAttrs = { ...listAttrs, min: 0, max: 5 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "remove").click();
    await settle();
    toolButton(0, "remove").click();
    await settle();
    arrayAnswer = () => {
      arrayAnswer = undefined;
      version += 1;
      return json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409);
    };
    list().querySelector<HTMLButtonElement>(".cms-list__undo")?.click();
    await settle();
    expect(list().querySelector<HTMLButtonElement>(".cms-list__undo")?.hidden).toBe(true);
  });
});

describe("keys are the content's (ruled 2026-11-18)", () => {
  test("a list whose items have no _key keeps one outline with no list actions, writes nothing, and the console says why", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    expect(list().querySelectorAll(".cms-list__frame")).toHaveLength(1);
    expect(list().querySelector(".cms-item__tools")).toBeNull();
    expect(list().querySelector(".cms-list__add")).toBeNull();
    expect(items()[0]?.querySelector("h3")?.classList.contains("cms-field")).toBe(true);
    expect(warn.mock.calls[0]?.[0]).toContain("has no Add, Remove or Move: its items have no _key");
    expect(fieldCalls).toEqual([]);
    expect(arrayCalls).toEqual([]);
    warn.mockRestore();
  });
});

describe("fields by key are the site's (ruled 2026-11-18)", () => {
  test("a keyed item's field addressed by position leaves the list with one outline, no list actions, and a console note", async () => {
    const edit = editable(KEY);
    const attrs = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");
    document.body.innerHTML = `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists
      .map(
        (artist, index) =>
          `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`artists.${index}.name`, "text"))}>${artist.name}</h3></li>`,
      )
      .join("")}</ul></main>`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    expect(list().querySelectorAll(".cms-list__frame")).toHaveLength(1);
    expect(list().querySelector(".cms-item__tools")).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain("its field artists.0.name is addressed by position inside a keyed item");
    warn.mockRestore();
  });

  test("fields rendered with itemFields keep the full list chrome", async () => {
    const edit = editable(KEY);
    const attrs = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");
    document.body.innerHTML = `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists
      .map(
        (artist, index) =>
          `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit.itemFields("artists", artist, index)("name", "text"))}>${artist.name}</h3></li>`,
      )
      .join("")}</ul></main>`;
    await mount();
    expect(toolButton(0, "down")).not.toBeNull();
  });
});

describe("seventeenth review round", () => {
  test("removing the last item of a list with no Add leaves focus on the list's Undo", async () => {
    artists = [{ _key: "a", name: "Mara" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount({ lists: {} });
    toolButton(0, "remove").click();
    await settle();
    expect(document.activeElement).toBe(list().querySelector(".cms-list__undo"));
  });

  test("a newItem that returns a _key already in the list gets a fresh one", async () => {
    listAttrs = { ...listAttrs, max: 5 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount({ lists: { [LIST]: { newItem: () => ({ _key: "a", name: "New artist" }) } } });
    addButton()?.click();
    await settle();
    const op = arrayCalls[0]?.op as Extract<ArrayOp, { kind: "insert" }>;
    expect((op.value as Artist)._key).not.toBe("a");
  });
});

describe("a field open in a list when a conflict swaps it (#48)", () => {
  const typeInto = (index: number, text: string) => {
    const name = items()[index]?.querySelector("h3") as HTMLElement;
    name.click();
    name.textContent = text;
    return name;
  };
  const toastText = () => document.querySelector(".cms-toast")?.textContent ?? "";

  test("the swap holds it as a conflict instead of saving it over the other editor's change", async () => {
    await mount();
    typeInto(0, "Mine");
    // Another editor renames the same item; this page's Unpublish then conflicts and catches up.
    artists = [{ _key: "a", name: "Theirs" }, ...artists.slice(1)];
    version += 1;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      String(input).includes("/api/content/unpublish")
        ? Promise.resolve(
            json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409),
          )
        : realFetch(input, init),
    );
    await expect(handle?.api.unpublish(KEY)).rejects.toThrow("Version mismatch");
    await settle();
    expect(fieldCalls).toEqual([]);
    const fresh = items()[0]?.querySelector("h3");
    expect(fresh?.textContent).toBe("Mine");
    expect(fresh?.classList.contains("cms-field--failed")).toBe(true);
    expect(toastText()).toContain("Someone else changed this field");
    const keepMine = [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")].find(
      (button) => button.textContent === "Keep mine (overwrite)",
    );
    keepMine?.click();
    await settle();
    expect(fieldCalls).toEqual(["artists[_key=a].name"]);
  });

  test("Add still commits a field left open, with no conflict", async () => {
    await mount();
    typeInto(0, "Mine");
    addButton()?.click();
    await settle();
    expect(fieldCalls).toEqual(["artists[_key=a].name"]);
    expect(toastText()).not.toContain("Someone else changed this field");
    expect(names()).toEqual(["Mara", "Tobias", "New artist"]);
  });
});

describe("drag to reorder and date order (#43)", () => {
  const grip = (index: number) => toolButton(index, "grip");
  // A button is down from the press until the release, as a browser reports it.
  const pointer = (type: string, target: Element, init: { clientY?: number; button?: number } = {}) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
        ...init,
      }),
    );
  /** Each item is 100px tall; its midpoint is what a drag compares the pointer with. */
  const lay = () =>
    items().forEach((item, index) => {
      item.getBoundingClientRect = () => new DOMRect(0, index * 100, 300, 100);
    });
  const three = () => {
    artists = [
      { _key: "a", name: "Mara" },
      { _key: "b", name: "Tobias" },
      { _key: "c", name: "Ines" },
    ];
    published = artists.map((artist) => ({ ...artist }));
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
  };

  test("the handle is the first toolbar button, named for the item", async () => {
    await mount();
    const buttons = [...(items()[0]?.querySelectorAll<HTMLElement>(".cms-item__tools [data-action]") ?? [])];
    expect(buttons.map((node) => node.dataset.action)).toEqual(["grip", "up", "down", "remove"]);
    expect(grip(0).getAttribute("aria-label")).toBe("Drag to reorder Mara, or use the move buttons");
    expect(grip(0).className).toContain("cms-item__grip");
  });

  test("a drop makes one move write from the old index to the new, then focuses the handle and announces", async () => {
    three();
    await mount();
    lay();
    pointer("pointerdown", grip(0));
    expect(items()[0]?.classList.contains("cms-item--dragging")).toBe(true);
    pointer("pointermove", list(), { clientY: 160 });
    expect(names()).toEqual(["Tobias", "Mara", "Ines"]);
    expect(arrayCalls).toEqual([]);
    pointer("pointerup", list());
    await settle();
    expect(arrayCalls).toEqual([{ op: { kind: "move", from: 0, to: 1 }, expectedVersion: 4 }]);
    expect(names()).toEqual(["Tobias", "Mara", "Ines"]);
    expect(items()[1]?.classList.contains("cms-item--dragging")).toBe(false);
    expect(liveText()).toBe("Mara moved to position 2 of 3.");
    expect(document.activeElement).toBe(grip(1));
  });

  test("a drop at the same place writes nothing", async () => {
    three();
    await mount();
    lay();
    pointer("pointerdown", grip(1));
    pointer("pointermove", list(), { clientY: 260 });
    pointer("pointermove", list(), { clientY: 120 });
    pointer("pointerup", list());
    await settle();
    expect(arrayCalls).toEqual([]);
    expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
    expect(items()[1]?.classList.contains("cms-item--dragging")).toBe(false);
  });

  test("pointercancel puts the item back and writes nothing", async () => {
    three();
    await mount();
    lay();
    pointer("pointerdown", grip(0));
    pointer("pointermove", list(), { clientY: 260 });
    expect(names()).toEqual(["Tobias", "Ines", "Mara"]);
    pointer("pointercancel", list());
    await settle();
    expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
    expect(arrayCalls).toEqual([]);
    expect(items()[0]?.classList.contains("cms-item--dragging")).toBe(false);
  });

  test("Escape puts the item back, and a later pointerup does nothing", async () => {
    three();
    await mount();
    lay();
    pointer("pointerdown", grip(0));
    pointer("pointermove", list(), { clientY: 260 });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    pointer("pointerup", list());
    await settle();
    expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
    expect(arrayCalls).toEqual([]);
  });

  test("a failed write puts the item back where the page showed it", async () => {
    three();
    await mount();
    lay();
    arrayAnswer = () => json({ error: { code: "internal", message: "down" } }, 500);
    pointer("pointerdown", grip(0));
    pointer("pointermove", list(), { clientY: 260 });
    pointer("pointerup", list());
    await settle();
    expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
  });

  test("a drag is refused with listBusy while the list waits for the page", async () => {
    await mount();
    const realFetch = globalThis.fetch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (!String(input).includes("/api/")) await gate;
      return realFetch(input, init);
    });
    addButton()?.click();
    await settle();
    pointer("pointerdown", grip(0));
    expect(liveText()).toBe("Updating the list…");
    expect(items()[0]?.classList.contains("cms-item--dragging")).toBe(false);
    release();
    await settle();
  });

  test("Arrow Up and Down on the handle move the item one step and focus stays on the handle", async () => {
    await mount();
    grip(1).focus();
    grip(1).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await settle();
    expect(arrayCalls).toEqual([{ op: { kind: "move", from: 1, to: 0 }, expectedVersion: 4 }]);
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(liveText()).toBe("Tobias moved to position 1 of 2.");
    expect(document.activeElement).toBe(grip(0));
    grip(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await settle();
    expect(arrayCalls[1]?.op).toEqual({ kind: "move", from: 0, to: 1 });
    expect(document.activeElement).toBe(grip(1));
  });

  test("Arrow Up on the first item's handle says it is first and writes nothing", async () => {
    await mount();
    grip(0).focus();
    grip(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await settle();
    expect(arrayCalls).toEqual([]);
    expect(liveText()).toBe("Mara is already first.");
    expect(document.activeElement).toBe(grip(0));
  });

  test("Left and Right still rove between the handle and the buttons", async () => {
    await mount();
    grip(0).focus();
    grip(0).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(toolButton(0, "up"));
  });

  describe("order data", () => {
    const sorted = (rows: Artist[]) => {
      pageAnswer = () =>
        new Response(`<!doctype html><html><body><main id="page">${renderOne("artists", rows)}</main></body></html>`);
    };
    const zedFirst = [
      { _key: "b", name: "Tobias" },
      { _key: "c", name: "Ines" },
      { _key: "a", name: "Zed" },
    ];
    const rename = (index: number, text: string) => {
      const field = items()[index]?.querySelector("h3") as HTMLElement;
      field.click();
      field.textContent = text;
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    };
    beforeEach(() => {
      listAttrs = { ...listAttrs, order: "data" };
      artists = [
        { _key: "a", name: "Mara" },
        { _key: "b", name: "Tobias" },
        { _key: "c", name: "Ines" },
      ];
      document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    });

    test("has no handle", async () => {
      await mount();
      expect(grip(0)).toBeNull();
      expect(list().querySelector(".cms-item__grip")).toBeNull();
    });

    test("an item that moved is announced, and its field gets focus in the new place", async () => {
      await mount();
      sorted(zedFirst);
      rename(0, "Zed");
      await settle();
      expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
      expect(liveText()).toBe("Zed is now at position 3 of 3.");
      expect(document.activeElement).toBe(items()[2]?.querySelector("h3"));
    });

    test("an item that stayed is not announced", async () => {
      await mount();
      sorted(artists.map((artist) => (artist._key === "b" ? { ...artist, name: "Tom" } : artist)));
      rename(1, "Tom");
      await settle();
      expect(fieldCalls).toEqual(["artists[_key=b].name"]);
      expect(names()).toEqual(["Mara", "Tom", "Ines"]);
      expect(liveText()).not.toContain("is now at position");
    });

    test("focus is left alone when the editor has moved it elsewhere meanwhile", async () => {
      await mount();
      sorted(zedFirst);
      rename(0, "Zed");
      const other = document.createElement("button");
      document.body.append(other);
      other.focus();
      await settle();
      expect(liveText()).toBe("Zed is now at position 3 of 3.");
      expect(document.activeElement).toBe(other);
    });

    describe("refreshing in the background (ruled on #43)", () => {
      const field = (index: number, within: () => HTMLElement[] = items) =>
        within()[index]?.querySelector("h3") as HTMLElement;
      const crewList = () => document.querySelector<HTMLElement>(`[data-edit-list="${KEY}:crew"]`) as HTMLElement;
      const crewItems = () => [...crewList().querySelectorAll<HTMLElement>("[data-edit-item]")];
      const escape = (target: HTMLElement) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      const toastText = () => document.querySelector(".cms-toast")?.textContent ?? "";
      /** Moves focus out of every list, to a button of the page's. */
      const leaveLists = () => {
        const node = document.createElement("button");
        document.body.append(node);
        node.focus();
        return node;
      };
      /** Counts the page fetches; while `held`, each waits until `release()`. */
      let pageFetches: number;
      let held: boolean;
      let releases: (() => void)[];
      const release = () => {
        held = false;
        for (const go of releases.splice(0)) go();
      };
      beforeEach(() => {
        pageFetches = 0;
        held = false;
        releases = [];
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
          if (!String(input).includes("/api/")) {
            pageFetches += 1;
            if (held) await new Promise<void>((resolve) => releases.push(resolve));
          }
          return realFetch(input, init);
        });
      });

      test("an item that didn't move keeps focus on the saved field", async () => {
        await mount();
        sorted(artists.map((artist) => (artist._key === "b" ? { ...artist, name: "Tom" } : artist)));
        rename(1, "Tom");
        await settle();
        expect(pageFetches).toBe(1);
        expect(names()).toEqual(["Mara", "Tom", "Ines"]);
        expect(document.activeElement).toBe(field(1));
        expect(liveText()).not.toContain("is now at position");
      });

      test("a field open in another list of the same document stays open, and the refresh runs once focus leaves the lists", async () => {
        crew = [{ _key: "x", name: "Cy" }];
        document.body.innerHTML = `<main id="page">${renderList()}</main>`;
        await mount();
        pageAnswer = () =>
          new Response(
            `<!doctype html><html><body><main id="page">${renderOne("artists", zedFirst)}${renderOne("crew", crew ?? [])}</main></body></html>`,
          );
        rename(0, "Zed");
        // Opened before the save has settled.
        const open = field(0, crewItems);
        open.click();
        await settle();
        expect(open.isConnected).toBe(true);
        expect(open.classList.contains("cms-field--editing")).toBe(true);
        expect(pageFetches).toBe(0);
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
        escape(open);
        await settle();
        // Esc puts focus back on the crew field, inside the lists: still waiting.
        expect(pageFetches).toBe(0);
        leaveLists();
        await settle();
        expect(pageFetches).toBe(1);
        expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
        expect(liveText()).toBe("Zed is now at position 3 of 3.");
      });

      test("a field opened in the list while the page is on its way opens, with no listBusy", async () => {
        await mount();
        sorted(zedFirst);
        held = true;
        rename(0, "Zed");
        await settle();
        expect(pageFetches).toBe(1);
        field(1).click();
        await settle();
        expect(field(1).classList.contains("cms-field--editing")).toBe(true);
        expect(liveText()).not.toBe("Updating the list…");
        release();
        await settle();
      });

      test("a field opened while the page is on its way drops that page, and the refresh runs once focus leaves the list", async () => {
        await mount();
        sorted(zedFirst);
        held = true;
        rename(0, "Zed");
        await settle();
        const open = field(1);
        open.click();
        release();
        await settle();
        expect(open.isConnected).toBe(true);
        expect(open.classList.contains("cms-field--editing")).toBe(true);
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
        expect(liveText()).not.toContain("is now at position");
        escape(open);
        await settle();
        expect(pageFetches).toBe(1);
        leaveLists();
        await settle();
        expect(pageFetches).toBe(2);
        expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
        expect(liveText()).toBe("Zed is now at position 3 of 3.");
      });

      test("a failed page fetch shows no toast and leaves the list as it is", async () => {
        await mount();
        pageAnswer = () => new Response("down", { status: 500 });
        rename(0, "Zed");
        await settle();
        expect(pageFetches).toBe(1);
        expect(toastText()).not.toContain("Reload");
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
        expect(document.activeElement).toBe(field(0));
      });

      test("a page without the list shows no toast", async () => {
        await mount();
        pageAnswer = () => new Response(`<!doctype html><html><body><main id="page"></main></body></html>`);
        rename(0, "Zed");
        await settle();
        expect(toastText()).not.toContain("Reload");
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
      });

      test("several saves in a row give one page fetch", async () => {
        await mount();
        sorted([
          { _key: "c", name: "Ines" },
          { _key: "b", name: "Tom" },
          { _key: "a", name: "Zed" },
        ]);
        rename(0, "Zed");
        rename(1, "Tom");
        await settle();
        expect(fieldCalls).toEqual(["artists[_key=a].name", "artists[_key=b].name"]);
        expect(pageFetches).toBe(1);
        expect(names()).toEqual(["Ines", "Tom", "Zed"]);
        // The last saved field: Tom went from 2 to 2, so nothing moved for it.
        expect(liveText()).not.toContain("is now at position");
        expect(document.activeElement).toBe(field(1));
      });

      test("destroy while the page is on its way leaves the host's markup alone", async () => {
        await mount();
        sorted(zedFirst);
        held = true;
        rename(0, "Zed");
        await settle();
        handle?.destroy();
        handle = undefined;
        const before = list().outerHTML;
        release();
        await settle();
        expect(list().outerHTML).toBe(before);
      });

      test("Done while the page is on its way drops it, and nothing is pending on return", async () => {
        await mount();
        sorted(zedFirst);
        held = true;
        rename(0, "Zed");
        await settle();
        const done = [...document.querySelectorAll<HTMLButtonElement>(".cms-bar button")].find(
          (button) => button.textContent === "Done",
        );
        done?.click();
        release();
        await settle();
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
        document.querySelector<HTMLButtonElement>(".cms-enter")?.click();
        await settle();
        expect(pageFetches).toBe(1);
        expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
      });

      describe("code review round 2 (#52)", () => {
        /** The crew list in manual order, beside the artists list in data order. */
        const manualCrew = () => {
          const kept = listAttrs;
          listAttrs = { ...kept, order: "manual" };
          try {
            return renderOne("crew", crew ?? []);
          } finally {
            listAttrs = kept;
          }
        };
        const crewGrip = (index: number) =>
          crewItems()[index]?.querySelector<HTMLButtonElement>(`.cms-item__tools [data-action="grip"]`) as HTMLElement;

        test("a drag in another list of the same document holds the refresh until it ends", async () => {
          crew = [
            { _key: "x", name: "Cy" },
            { _key: "y", name: "Dee" },
          ];
          document.body.innerHTML = `<main id="page">${renderOne("artists", artists)}${manualCrew()}</main>`;
          await mount();
          const page = `<!doctype html><html><body><main id="page">${renderOne("artists", zedFirst)}${manualCrew()}</main></body></html>`;
          pageAnswer = () => new Response(page);
          rename(0, "Zed");
          pointer("pointerdown", crewGrip(0));
          await settle();
          expect(pageFetches).toBe(0);
          expect(crewItems()[0]?.classList.contains("cms-item--dragging")).toBe(true);
          pointer("pointerup", crewList());
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(liveText()).toBe("Zed is now at position 3 of 3.");
        });

        test("a popover field still reading its value holds the refresh, which runs once focus leaves the list", async () => {
          guests = [];
          document.body.innerHTML = `<main id="page">${renderList()}</main>`;
          const note = document.createElement("span");
          for (const [name, value] of Object.entries(editable(OTHER)("note", "number"))) note.setAttribute(name, value);
          items()[1]?.append(note);
          await mount();
          sorted(zedFirst);
          const realFetch = globalThis.fetch;
          let readOther: () => void = () => undefined;
          const otherRead = new Promise<void>((resolve) => {
            readOther = resolve;
          });
          vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
            if (String(input).includes("/api/content/document?") && String(input).includes("other")) await otherRead;
            return realFetch(input, init);
          });
          rename(0, "Zed");
          note.click();
          await settle();
          expect(pageFetches).toBe(0);
          readOther();
          await settle();
          expect(note.isConnected).toBe(true);
          expect(note.classList.contains("cms-field--editing")).toBe(true);
          expect(pageFetches).toBe(0);
          escape(document.activeElement as HTMLElement);
          await settle();
          expect(pageFetches).toBe(0);
          leaveLists();
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
        });

        test("a failed page fetch keeps a refresh asked for during its flight, which then runs", async () => {
          await mount();
          const answers = [
            () => new Response("down", { status: 500 }),
            () =>
              new Response(
                `<!doctype html><html><body><main id="page">${renderOne("artists", [
                  { _key: "c", name: "Ines" },
                  { _key: "b", name: "Tom" },
                  { _key: "a", name: "Zed" },
                ])}</main></body></html>`,
              ),
          ];
          pageAnswer = () => (answers.shift() ?? (answers[0] as () => Response))();
          held = true;
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(1);
          rename(1, "Tom");
          await settle();
          release();
          await settle();
          expect(pageFetches).toBe(2);
          expect(names()).toEqual(["Ines", "Tom", "Zed"]);
        });
      });

      describe("code review round 3 (#52)", () => {
        test("a refresh whose lists have left the page is dropped, and doesn't run when they come back", async () => {
          crew = [{ _key: "x", name: "Cy" }];
          document.body.innerHTML = `<main id="page">${renderList()}</main>`;
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          const open = field(0, crewItems);
          open.click();
          await settle();
          expect(pageFetches).toBe(0);
          // The host takes the document's lists off the page, then the field closes: nothing to refresh.
          const main = document.querySelector("#page") as HTMLElement;
          main.remove();
          escape(open);
          await settle();
          expect(pageFetches).toBe(0);
          document.body.prepend(main);
          field(0, crewItems).click();
          escape(field(0, crewItems));
          await settle();
          expect(pageFetches).toBe(0);
        });

        test("an item that another swap moved before the refresh ran is not announced as sorted", async () => {
          listAttrs = { ...listAttrs, duplicate: true, max: undefined };
          crew = [{ _key: "x", name: "Cy" }];
          document.body.innerHTML = `<main id="page">${renderList()}</main>`;
          await mount();
          rename(2, "Ivy");
          // The open field holds the refresh until Duplicate, whose swap puts Ines one place down, has run.
          field(0, crewItems).click();
          await settle();
          expect(pageFetches).toBe(0);
          toolButton(0, "duplicate").click();
          await settle();
          expect(items().at(-1)?.dataset.editItem).toBe(`${KEY}:artists[_key=c]`);
          // Duplicate opened the copy's first field, which holds the refresh too, and so does its focus after Esc.
          escape(document.activeElement as HTMLElement);
          leaveLists();
          await settle();
          expect(pageFetches).toBe(3);
          expect(liveText()).not.toContain("is now at position");
        });
      });

      describe("rule A: the swap never replaces what holds focus or a pointer, but the saved field (#43)", () => {
        const outside = () => {
          const node = document.createElement("button");
          document.body.append(node);
          return node;
        };

        test("Enter on the saved field swaps at once, focus follows the field, and the new place is announced", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(field(2));
          expect(liveText()).toBe("Zed is now at position 3 of 3.");
        });

        test("focus on Add holds the refresh; once focus leaves the list it swaps, leaves focus outside, and announces", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          addButton()?.focus();
          await settle();
          expect(pageFetches).toBe(0);
          expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
          expect(document.activeElement).toBe(addButton());
          const away = outside();
          away.focus();
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(away);
          expect(liveText()).toBe("Zed is now at position 3 of 3.");
        });

        test("an open chip menu, with focus on its chip, holds the refresh and stays open", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          const chip = items()[1]?.querySelector<HTMLButtonElement>(".cms-item__chip") as HTMLButtonElement;
          chip.focus();
          chip.click();
          await settle();
          expect(pageFetches).toBe(0);
          expect(chip.isConnected).toBe(true);
          expect(chip.getAttribute("aria-expanded")).toBe("true");
          expect(items()[1]?.hasAttribute("data-cms-open")).toBe(true);
          expect(document.activeElement).toBe(chip);
        });

        test("a pointer held down on a toolbar button holds the refresh until it comes up", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          const remove = toolButton(1, "remove");
          pointer("pointerdown", remove);
          await settle();
          expect(pageFetches).toBe(0);
          expect(remove.isConnected).toBe(true);
          pointer("pointerup", remove);
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(field(2));
        });

        test("focus in another list of the same document holds the refresh", async () => {
          crew = [{ _key: "x", name: "Cy" }];
          document.body.innerHTML = `<main id="page">${renderList()}</main>`;
          await mount();
          pageAnswer = () =>
            new Response(
              `<!doctype html><html><body><main id="page">${renderOne("artists", zedFirst)}${renderOne("crew", crew ?? [])}</main></body></html>`,
            );
          rename(0, "Zed");
          const crewField = field(0, crewItems);
          crewField.focus();
          await settle();
          expect(pageFetches).toBe(0);
          expect(crewField.isConnected).toBe(true);
          expect(document.activeElement).toBe(crewField);
        });

        test("focus elsewhere on the page lets it swap at once, and focus is left alone", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          const away = outside();
          away.focus();
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(away);
          expect(liveText()).toBe("Zed is now at position 3 of 3.");
        });

        test("a page that arrives once focus has moved into the list is dropped, and runs once focus leaves", async () => {
          await mount();
          sorted(zedFirst);
          held = true;
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(1);
          addButton()?.focus();
          release();
          await settle();
          expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
          outside().focus();
          await settle();
          expect(pageFetches).toBe(2);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
        });

        test("Tab between two fields of the list while a refresh waits starts no fetch (code review round 5, #52)", async () => {
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          field(1).focus();
          await settle();
          expect(pageFetches).toBe(0);
          // A browser's Tab: focusout first, with focus on body until focusin, and microtasks run in between.
          Object.defineProperty(document, "activeElement", { configurable: true, get: () => document.body });
          try {
            field(1).dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: field(2) }));
            await Promise.resolve();
            await Promise.resolve();
          } finally {
            delete (document as { activeElement?: unknown }).activeElement;
          }
          field(2).focus();
          await settle();
          expect(pageFetches).toBe(0);
          expect(names()).toEqual(["Zed", "Tobias", "Ines"]);
          expect(document.activeElement).toBe(field(2));
        });
      });

      describe("code review round 4 (#52)", () => {
        const copies = () => [...document.querySelectorAll<HTMLElement>(`[data-edit-list="${LIST}"]`)];
        const secondItems = () => [...(copies()[1]?.querySelectorAll<HTMLElement>("[data-edit-item]") ?? [])];
        const contact = (type: string, target: EventTarget, init: PointerEventInit) =>
          target.dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true, ...init }),
          );

        test("a field also shown outside the list, earlier on the page, still refreshes the list it was edited in", async () => {
          const outsideCopy = document.createElement("h3");
          for (const [name, value] of Object.entries(editable(KEY)("artists[_key=a].name", "text")))
            outsideCopy.setAttribute(name, value);
          outsideCopy.textContent = "Mara";
          document.querySelector("#page")?.prepend(outsideCopy);
          await mount();
          sorted(zedFirst);
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(field(2));
        });

        test("an edit in the second copy of the list swaps at once, and focus follows the field in that copy", async () => {
          document.body.innerHTML = `<main id="page">${renderOne("artists", artists)}${renderOne("artists", artists)}</main>`;
          await mount();
          pageAnswer = () =>
            new Response(
              `<!doctype html><html><body><main id="page">${renderOne("artists", zedFirst)}${renderOne("artists", zedFirst)}</main></body></html>`,
            );
          const edited = field(0, secondItems);
          edited.click();
          edited.textContent = "Zed";
          edited.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          await settle();
          expect(pageFetches).toBe(1);
          expect(secondItems().map((item) => item.querySelector("h3")?.textContent)).toEqual(["Tobias", "Ines", "Zed"]);
          expect(document.activeElement).toBe(field(2, secondItems));
          expect(liveText()).toBe("Zed is now at position 3 of 3.");
        });

        test("a touch whose release never reached the page stops holding the refresh when the window loses focus", async () => {
          await mount();
          sorted(zedFirst);
          contact("pointerdown", toolButton(1, "remove"), { pointerId: 7, pointerType: "touch", buttons: 1 });
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(0);
          window.dispatchEvent(new Event("blur"));
          await settle();
          expect(pageFetches).toBe(1);
          expect(names()).toEqual(["Tobias", "Ines", "Zed"]);
        });

        test("a lost touch release stops holding the refresh when the page is hidden", async () => {
          await mount();
          sorted(zedFirst);
          contact("pointerdown", toolButton(1, "remove"), { pointerId: 7, pointerType: "touch", buttons: 1 });
          rename(0, "Zed");
          await settle();
          expect(pageFetches).toBe(0);
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          try {
            document.dispatchEvent(new Event("visibilitychange"));
          } finally {
            delete (document as { visibilityState?: unknown }).visibilityState;
          }
          await settle();
          expect(pageFetches).toBe(1);
        });

        test("a lost touch release is dropped by the next first touch, which holds the refresh only while it is down", async () => {
          await mount();
          sorted(zedFirst);
          contact("pointerdown", toolButton(1, "remove"), { pointerId: 7, pointerType: "touch", buttons: 1 });
          rename(0, "Zed");
          await settle();
          contact("pointerdown", toolButton(2, "remove"), { pointerId: 8, pointerType: "touch", buttons: 1 });
          await settle();
          expect(pageFetches).toBe(0);
          contact("pointerup", toolButton(2, "remove"), { pointerId: 8, pointerType: "touch", buttons: 0 });
          await settle();
          expect(pageFetches).toBe(1);
        });

        test("a pen whose release was lost stops holding the refresh once it moves with no button down", async () => {
          await mount();
          sorted(zedFirst);
          contact("pointerdown", toolButton(1, "remove"), { pointerId: 3, pointerType: "pen", buttons: 1 });
          rename(0, "Zed");
          await settle();
          contact("pointermove", toolButton(1, "remove"), { pointerId: 3, pointerType: "pen", buttons: 1 });
          await settle();
          expect(pageFetches).toBe(0);
          contact("pointermove", document.body, { pointerId: 3, pointerType: "pen", buttons: 0 });
          await settle();
          expect(pageFetches).toBe(1);
        });
      });
    });
  });

  describe("code review round 4 (#52)", () => {
    const attrs = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");

    test("a drop of the last item that writes nothing once the list was dressed again goes back last, before the new Add row", async () => {
      three();
      const dress = (drop: ListHandlers["drop"]) => {
        const [record] = scanLists(document.body);
        if (!record) throw new Error("no list");
        attachList(record, defaultStrings, {
          actions: true,
          canAdd: false,
          add() {},
          canUndo: false,
          undo() {},
          act() {},
          dragStart: () => true,
          drop,
        });
        lay();
        return record;
      };
      let answer: (written: boolean) => void = () => undefined;
      const held = dress(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      pointer("pointerdown", grip(2));
      pointer("pointermove", list(), { clientY: 10 });
      pointer("pointerup", list());
      expect(names()).toEqual(["Ines", "Mara", "Tobias"]);
      held.detach?.();
      const fresh = dress(async () => false);
      answer(false);
      await settle();
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
      expect(list().lastElementChild?.classList.contains("cms-list__add")).toBe(true);
      fresh.detach?.();
    });

    test("a drop that writes nothing, whose put-back is refused, shows the stored order again", async () => {
      const edit = editable(KEY);
      const item = (artist: Artist, index: number) =>
        `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`${itemPath("artists", artist, index)}.name`, "text"))}>${artist.name}</h3></li>`;
      document.body.innerHTML = `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists.map(item).join('<li class="sep">·</li>')}</ul></main>`;
      await mount();
      lay();
      const realFetch = globalThis.fetch;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (String(input).includes("/api/content/array")) await gate;
        return realFetch(input, init);
      });
      arrayAnswer = () => json({ error: { code: "internal", message: "down" } }, 500);
      pointer("pointerdown", grip(0));
      pointer("pointermove", list(), { clientY: 160 });
      pointer("pointerup", list());
      await settle();
      expect(names()).toEqual(["Tobias", "Mara"]);
      // The host takes out the markup Mara sat before: the drag has nowhere left to put it back.
      list().querySelector(".sep")?.remove();
      release();
      await settle();
      expect(arrayCalls).toHaveLength(1);
      expect(names()).toEqual(["Mara", "Tobias"]);
    });

    test("after Remove, focus goes to the next item's first enabled button that isn't the handle", async () => {
      three();
      await mount();
      toolButton(1, "remove").click();
      await settle();
      expect(names()).toEqual(["Mara", "Ines"]);
      // Ines is last now: Move down is inert, Move up is the first button that does something on Enter.
      expect(document.activeElement).toBe(toolButton(1, "up"));
    });

    test("after Remove leaves one item with nothing else enabled, focus goes to its handle", async () => {
      await mount();
      toolButton(0, "remove").click();
      await settle();
      expect(names()).toEqual(["Tobias"]);
      expect(document.activeElement).toBe(grip(0));
    });
  });

  describe("code review round 1 (#52)", () => {
    const press = (type: string, target: EventTarget, init: PointerEventInit = {}) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init }),
      );
    const attrs = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");

    test("a drop is placed by its neighbour's key when the page doesn't show every stored item", async () => {
      artists = [
        { _key: "a", name: "Mara" },
        { _key: "b", name: "Tobias" },
        { _key: "x", name: "Hidden" },
        { _key: "c", name: "Ines" },
      ];
      listAttrs = { ...listAttrs, max: undefined };
      const shown = artists.filter((artist) => artist._key !== "x");
      document.body.innerHTML = `<main id="page">${renderOne("artists", shown)}</main>`;
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      press("pointerup", list());
      await settle();
      // After Ines, which is stored last: [Tobias, Hidden, Ines, Mara], not [Tobias, Hidden, Mara, Ines].
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 3 }]);
      expect(artists.map((artist) => artist._key)).toEqual(["b", "x", "c", "a"]);
    });

    test("a drop placed first resolves before its new neighbour", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(2));
      press("pointermove", list(), { clientY: 10 });
      press("pointerup", list());
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 2, to: 0 }]);
      expect(names()).toEqual(["Ines", "Mara", "Tobias"]);
    });

    test("a drop leaves host markup between items where Move down leaves it", async () => {
      const edit = editable(KEY);
      const item = (artist: Artist, index: number) =>
        `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`${itemPath("artists", artist, index)}.name`, "text"))}>${artist.name}</h3></li>`;
      document.body.innerHTML = `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists.map(item).join('<li class="sep">·</li>')}</ul></main>`;
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 160 });
      press("pointerup", list());
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 1 }]);
      const children = [...list().children]
        .filter((node) => !node.classList.contains("cms-root"))
        .map((node) => node.querySelector("h3")?.textContent ?? node.textContent);
      expect(children).toEqual(["Tobias", "·", "Mara"]);
    });

    test("another pointer's moves and pointerup are ignored", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      press("pointermove", list(), { clientY: 10, pointerId: 2 });
      expect(names()).toEqual(["Tobias", "Ines", "Mara"]);
      press("pointerup", list(), { pointerId: 2 });
      press("pointercancel", list(), { pointerId: 2 });
      press("lostpointercapture", list(), { pointerId: 2 });
      await settle();
      expect(arrayCalls).toEqual([]);
      expect(items()[2]?.classList.contains("cms-item--dragging")).toBe(true);
      press("pointerup", list());
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 2 }]);
    });

    test("a pointerup outside the list still drops the item", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      press("pointerup", document.body);
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 2 }]);
    });

    test("a pointercancel outside the list puts the item back", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      press("pointercancel", document.body);
      await settle();
      expect(arrayCalls).toEqual([]);
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
    });

    test("after Done mid-drag, a pointerup anywhere writes nothing", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      handle?.destroy();
      handle = undefined;
      press("pointerup", document.body);
      press("pointerup", list());
      await settle();
      expect(arrayCalls).toEqual([]);
    });

    test("a failed drop is named for its direction", async () => {
      three();
      await mount();
      lay();
      arrayAnswer = () => json({ error: { code: "internal", message: "down" } }, 500);
      press("pointerdown", grip(0));
      press("pointermove", list(), { clientY: 260 });
      press("pointerup", list());
      await settle();
      const toast = document.querySelector<HTMLElement>(".cms-toast");
      expect(toast?.textContent).toContain(`Move Mara down failed for ${KEY}`);
      press("pointerdown", grip(2));
      press("pointermove", list(), { clientY: 10 });
      press("pointerup", list());
      await settle();
      expect(toast?.textContent).toContain(`Move Ines up failed for ${KEY}`);
    });
  });

  describe("code review round 2 (#52)", () => {
    const attrs = (record: Record<string, string>) =>
      Object.entries(record)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");
    /** Each item in a wrapper of the host's: `<div class="col"><article item/></div>`. */
    const wrapped = () => {
      const edit = editable(KEY);
      const cells = artists
        .map(
          (artist, index) =>
            `<div class="col"><article${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`${itemPath("artists", artist, index)}.name`, "text"))}>${artist.name}</h3></article></div>`,
        )
        .join("");
      document.body.innerHTML = `<main id="page"><div${attrs(edit.list("artists", listAttrs))}>${cells}</div></main>`;
    };
    const columns = () => [...list().querySelectorAll<HTMLElement>(":scope > .col")];
    const wrapperNames = () => columns().map((column) => [...column.querySelectorAll("h3")].map((h) => h.textContent));

    test("Escape puts an item dragged into another wrapper back in its own", async () => {
      wrapped();
      await mount();
      lay();
      pointer("pointerdown", grip(0));
      pointer("pointermove", list(), { clientY: 160 });
      expect(wrapperNames()).toEqual([[], ["Tobias", "Mara"]]);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle();
      expect(wrapperNames()).toEqual([["Mara"], ["Tobias"]]);
      expect(arrayCalls).toEqual([]);
    });

    test("a drop into another wrapper that writes nothing puts the item back in its own", async () => {
      wrapped();
      await mount();
      lay();
      arrayAnswer = () => json({ error: { code: "internal", message: "down" } }, 500);
      pointer("pointerdown", grip(0));
      pointer("pointermove", list(), { clientY: 160 });
      pointer("pointerup", list());
      await settle();
      expect(arrayCalls).toHaveLength(1);
      expect(wrapperNames()).toEqual([["Mara"], ["Tobias"]]);
    });

    test("the handle names its Arrow Up and Down shortcut", async () => {
      await mount();
      expect(grip(0).getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown");
    });

    test("a drop whose write rejects puts the item back", async () => {
      three();
      const [record] = scanLists(document.body);
      if (!record) throw new Error("no list");
      attachList(record, defaultStrings, {
        actions: true,
        canAdd: false,
        add() {},
        canUndo: false,
        undo() {},
        act() {},
        dragStart: () => true,
        drop: () => Promise.reject(new Error("boom")),
      });
      lay();
      pointer("pointerdown", grip(0));
      pointer("pointermove", list(), { clientY: 260 });
      expect(names()).toEqual(["Tobias", "Ines", "Mara"]);
      pointer("pointerup", list());
      await settle();
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
      record.detach?.();
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
    });
  });

  describe("code review round 3 (#52)", () => {
    /** The list attached on its own, laid out as a row, whose drop answers only when the test says so. */
    const attachHeld = () => {
      const [record] = scanLists(document.body);
      if (!record) throw new Error("no list");
      let answer: (written: boolean) => void = () => undefined;
      let fail: () => void = () => undefined;
      attachList(record, defaultStrings, {
        actions: true,
        canAdd: false,
        add() {},
        canUndo: false,
        undo() {},
        act() {},
        dragStart: () => true,
        drop: () =>
          new Promise<boolean>((resolve, reject) => {
            answer = resolve;
            fail = () => reject(new Error("boom"));
          }),
      });
      list().getBoundingClientRect = () => new DOMRect(0, 0, 600, 100);
      items().forEach((item, index) => {
        item.getBoundingClientRect = () => new DOMRect(index * 200, 0, 180, 100);
        item.querySelectorAll<HTMLElement>("[data-edit-field]").forEach((field, at) => {
          field.getBoundingClientRect = () => new DOMRect(index * 200, at * 40, 180, 20);
        });
      });
      return { record, answer: (written: boolean) => answer(written), fail: () => fail() };
    };
    /** Two fields per item, so a paint draws a line between them. */
    const twoFields = () => {
      three();
      for (const item of items()) {
        const name = item.querySelector("h3") as HTMLElement;
        const role = name.cloneNode(true) as HTMLElement;
        role.setAttribute("data-edit-field", (name.getAttribute("data-edit-field") ?? "").replace(/name$/, "role"));
        item.append(role);
      }
    };
    const dragFirstToEnd = () => {
      grip(0).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      list().dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 590, clientY: 50 }));
      list().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    };

    for (const [how, end] of [
      ["writes nothing", (held: ReturnType<typeof attachHeld>) => held.answer(false)],
      ["rejects", (held: ReturnType<typeof attachHeld>) => held.fail()],
    ] as const) {
      test(`a drop that ${how} once the list was detached puts the item back, and draws nothing`, async () => {
        twoFields();
        const held = attachHeld();
        dragFirstToEnd();
        expect(names()).toEqual(["Tobias", "Ines", "Mara"]);
        held.record.detach?.();
        end(held);
        await settle();
        // Nothing was stored: the host's markup goes back to the stored order, with no chrome drawn on it.
        expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
        expect(list().querySelector(".cms-root, .cms-item__sep")).toBeNull();
        expect(list().hasAttribute("class")).toBe(false);
      });
    }

    test("a drop that writes nothing once the list was dressed again puts the item back inside the new dressing", async () => {
      twoFields();
      const held = attachHeld();
      dragFirstToEnd();
      held.record.detach?.();
      const fresh = attachHeld();
      const toolbars = list().querySelectorAll(".cms-item__tools").length;
      held.answer(false);
      await settle();
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
      expect(list().querySelectorAll(".cms-item__tools").length).toBe(toolbars);
      fresh.record.detach?.();
      expect(list().querySelector(".cms-root, .cms-item__sep")).toBeNull();
      expect(list().hasAttribute("class")).toBe(false);
    });
  });

  describe("code review round 5 (#52)", () => {
    const press = (type: string, target: EventTarget, init: PointerEventInit = {}) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init }),
      );

    test("the handle losing a touch's implicit capture to the list doesn't end the drag", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0), { pointerType: "touch", buttons: 1 });
      // The browser had captured the touch to the handle; the list's capture takes it, and the handle hears so.
      press("lostpointercapture", grip(0), { pointerType: "touch" });
      press("pointermove", list(), { clientY: 260, pointerType: "touch", buttons: 1 });
      expect(names()).toEqual(["Tobias", "Ines", "Mara"]);
      expect(items()[2]?.classList.contains("cms-item--dragging")).toBe(true);
      press("pointerup", list(), { pointerType: "touch" });
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 2 }]);
    });

    test("the list losing the capture still ends the drag and puts the item back", async () => {
      three();
      await mount();
      lay();
      press("pointerdown", grip(0), { pointerType: "touch", buttons: 1 });
      press("pointermove", list(), { clientY: 260, pointerType: "touch", buttons: 1 });
      press("lostpointercapture", list(), { pointerType: "touch" });
      await settle();
      expect(names()).toEqual(["Mara", "Tobias", "Ines"]);
      expect(items()[0]?.classList.contains("cms-item--dragging")).toBe(false);
      press("pointerup", list(), { pointerType: "touch" });
      await settle();
      expect(arrayCalls).toEqual([]);
    });

    test("with whitespace between items, a move inserts the item only when its place changes", async () => {
      const edit = editable(KEY);
      artists = [
        { _key: "a", name: "Mara" },
        { _key: "b", name: "Tobias" },
        { _key: "c", name: "Ines" },
      ];
      const item = (artist: Artist, index: number) =>
        `<li${Object.entries(edit.item("artists", artist, index))
          .map(([name, value]) => ` ${name}="${value}"`)
          .join("")}><h3${Object.entries(edit(`${itemPath("artists", artist, index)}.name`, "text"))
          .map(([name, value]) => ` ${name}="${value}"`)
          .join("")}>${artist.name}</h3></li>`;
      const listAttributes = Object.entries(edit.list("artists", listAttrs))
        .map(([name, value]) => ` ${name}="${value}"`)
        .join("");
      // As a server renders it: a newline and indent between every item.
      document.body.innerHTML = `<main id="page"><ul${listAttributes}>\n  ${artists.map(item).join("\n  ")}\n</ul></main>`;
      await mount();
      lay();
      const dragged = items()[0] as HTMLElement;
      // A drag inserts the item with `before` or `after` on another item.
      const spies = items().flatMap((node) => [vi.spyOn(node, "before"), vi.spyOn(node, "after")]);
      const insertsOfDragged = () => {
        const count = spies.reduce(
          (sum, spy) => sum + spy.mock.calls.filter((args) => (args as unknown[]).includes(dragged)).length,
          0,
        );
        for (const spy of spies) spy.mockClear();
        return count;
      };
      press("pointerdown", grip(0));
      // Still over Mara's own place, before Tobias, with text between them: nothing to insert.
      for (const clientY of [10, 20, 30]) press("pointermove", list(), { clientY });
      expect(insertsOfDragged()).toBe(0);
      // Between Tobias's middle and Ines's: one insert, before Ines, then none while it stays there.
      for (const clientY of [160, 170, 180]) press("pointermove", list(), { clientY });
      expect(names()).toEqual(["Tobias", "Mara", "Ines"]);
      expect(insertsOfDragged()).toBe(1);
      press("pointerup", list());
      await settle();
      expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 1 }]);
      // The last item held over its own place, after Ines with text between them: nothing to insert either.
      const last = items()[2] as HTMLElement;
      expect(last.querySelector("h3")?.textContent).toBe("Ines");
      lay();
      spies.push(...items().flatMap((node) => [vi.spyOn(node, "before"), vi.spyOn(node, "after")]));
      press("pointerdown", grip(2));
      for (const clientY of [260, 270, 280]) press("pointermove", list(), { clientY });
      const lastInserts = spies.reduce(
        (sum, spy) => sum + spy.mock.calls.filter((args) => (args as unknown[]).includes(last)).length,
        0,
      );
      expect(lastInserts).toBe(0);
      press("pointercancel", list());
      for (const spy of spies) spy.mockRestore();
    });
  });
});

describe("row and grid lists draw lines on their own axis (#43, ruling D10 on #28)", () => {
  const HOST_WIDTH = 600;
  const three = () => {
    artists = [
      { _key: "a", name: "Mara" },
      { _key: "b", name: "Tobias" },
      { _key: "c", name: "Ines" },
    ];
    published = artists.map((artist) => ({ ...artist }));
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
  };
  type Place = [x: number, y: number, width: number, height: number];
  const box = (place: Place) => () => new DOMRect(...place);
  /**
   * Gives the host, each item and the Add row a box; the next paint reads them. The host's padding box is at 0,0 and
   * HOST_WIDTH wide; a `border` puts its border box that much outside it.
   */
  const lay = (places: Place[], add: Place, border = 0) => {
    const bottom = Math.max(...places.map(([, y, , height]) => y + height), add[1] + add[3]);
    list().getBoundingClientRect = box([-border, -border, HOST_WIDTH + 2 * border, bottom + 2 * border]);
    for (const [name, value] of [
      ["clientLeft", border],
      ["clientTop", border],
      ["clientWidth", HOST_WIDTH],
      ["clientHeight", bottom],
    ] as const) {
      Object.defineProperty(list(), name, { configurable: true, get: () => value });
    }
    items().forEach((item, index) => {
      const place = places[index];
      if (!place) return;
      item.getBoundingClientRect = box(place);
      // No item border: its padding box is its border box (`itemBorder` gives it one).
      for (const [name, value] of [
        ["clientLeft", 0],
        ["clientTop", 0],
        ["clientWidth", place[2]],
        ["clientHeight", place[3]],
      ] as const) {
        Object.defineProperty(item, name, { configurable: true, get: () => value });
      }
    });
    const addRow = list().querySelector<HTMLElement>(".cms-list__add");
    if (addRow) addRow.getBoundingClientRect = box(add);
  };
  const repaint = async () => {
    window.dispatchEvent(new Event("resize"));
    await settle();
  };
  /** A stylesheet rule, as a page would carry it; gone after the test. */
  const css = (rules: string) => {
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = rules;
    document.head.append(style);
  };
  afterEach(() => {
    for (const style of document.head.querySelectorAll("style[data-test]")) style.remove();
  });
  const band = (index: number) => items()[index]?.querySelector<HTMLElement>(".cms-item__band") as HTMLElement;
  const addBand = () => list().querySelector<HTMLElement>(".cms-list__add .cms-item__band") as HTMLElement;
  const tools = (index: number) => items()[index]?.querySelector<HTMLElement>(".cms-item__tools") as HTMLElement;
  const prop = (node: HTMLElement, name: string) => node.style.getPropertyValue(name);
  const column: Place[] = [
    [0, 0, 300, 100],
    [0, 150, 300, 100],
    [0, 300, 300, 100],
  ];
  const row: Place[] = [
    [0, 0, 180, 100],
    [200, 0, 180, 100],
    [400, 0, 180, 100],
  ];
  const grid: Place[] = [
    [0, 0, 280, 100],
    [300, 0, 280, 100],
    [0, 140, 280, 100],
  ];
  const lines = (node: HTMLElement) => ({
    top: node.classList.contains("cms-item__band--top"),
    left: node.classList.contains("cms-item__band--left"),
  });
  const axis = () => ({
    row: list().classList.contains("cms-list--row"),
    grid: list().classList.contains("cms-list--grid"),
  });

  test("items stacked one under another are a column: a line above every item but the first", async () => {
    three();
    await mount();
    lay(column, [0, 420, 300, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: false });
    expect([0, 1, 2].map((index) => lines(band(index)))).toEqual([
      { top: false, left: false },
      { top: true, left: false },
      { top: true, left: false },
    ]);
    expect(lines(addBand())).toEqual({ top: true, left: false });
  });

  test("items side by side on one line are a row: a line left of every item but the first", async () => {
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    await repaint();
    expect(axis()).toEqual({ row: true, grid: false });
    expect([0, 1, 2].map((index) => lines(band(index)))).toEqual([
      { top: false, left: false },
      { top: false, left: true },
      { top: false, left: true },
    ]);
    // Cells tile the outline: each starts midway between two items; the last reaches the outline's inner edge.
    expect(prop(band(0), "--cms-band-left")).toBe("-10px");
    expect(prop(band(1), "--cms-band-left")).toBe("-10px");
    expect(prop(band(1), "--cms-band-width")).toBe("200px");
    expect(prop(band(2), "--cms-band-width")).toBe("220px");
  });

  test("a wrapped row is a grid: lines between items on a line and between lines, none doubled", async () => {
    three();
    await mount();
    lay(grid, [0, 260, 580, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: true });
    expect([0, 1, 2].map((index) => lines(band(index)))).toEqual([
      { top: false, left: false },
      { top: false, left: true },
      { top: true, left: false },
    ]);
    // The first line's cells end halfway to the second line; the second line's cell starts there.
    expect(prop(band(0), "--cms-band-bottom")).toBe("-20px");
    expect(prop(band(2), "--cms-band-top")).toBe("-20px");
  });

  test("the toolbar sits at the top left of an item in a row, at the right in a column", async () => {
    three();
    await mount();
    lay(column, [0, 420, 300, 40]);
    await repaint();
    expect(prop(tools(1), "--cms-tools-left")).toBe("auto");
    // Its right edge on the host's: past the 300px item's right edge by the rest of the host's width.
    expect(prop(tools(1), "--cms-tools-right")).toBe(`${300 - HOST_WIDTH}px`);
    lay(row, [0, 140, 580, 40]);
    await repaint();
    expect(prop(tools(1), "--cms-tools-right")).toBe("auto");
    // The cell starts at x = 190 and the item at 200; the toolbar is one outline padding in from the line.
    expect(prop(tools(1), "--cms-tools-left")).toBe("2px");
  });

  test("it repaints when the layout changes axis, and back", async () => {
    three();
    await mount();
    lay(column, [0, 420, 300, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: false });
    lay(row, [0, 140, 580, 40]);
    await repaint();
    expect(axis()).toEqual({ row: true, grid: false });
    lay(grid, [0, 260, 580, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: true });
    lay(column, [0, 420, 300, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: false });
    expect(lines(band(1))).toEqual({ top: true, left: false });
  });

  test("a list with one item is a column", async () => {
    artists = [{ _key: "a", name: "Mara" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    lay([[0, 0, 300, 100]], [0, 120, 300, 40]);
    await repaint();
    expect(axis()).toEqual({ row: false, grid: false });
  });

  test("detaching takes the axis class back off the host", async () => {
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    await repaint();
    handle?.destroy();
    handle = undefined;
    expect(list().hasAttribute("class")).toBe(false);
  });

  test("a field line inside a row item starts one past the cell's own left line", async () => {
    const h3 = items()[1]?.querySelector<HTMLElement>("h3") as HTMLElement;
    const second = h3.cloneNode(true) as HTMLElement;
    second.setAttribute("data-edit-field", (h3.getAttribute("data-edit-field") ?? "").replace(/name$/, "role"));
    items()[1]?.append(second);
    await mount();
    lay(
      [
        [0, 0, 180, 100],
        [200, 0, 180, 100],
      ],
      [0, 140, 580, 40],
    );
    h3.getBoundingClientRect = box([200, 10, 180, 20]);
    second.getBoundingClientRect = box([200, 50, 180, 20]);
    await repaint();
    const horizontal = items()[1]?.querySelector<HTMLElement>(".cms-item__sep--h") as HTMLElement;
    // Item 1's cell spans x = 190..610, so relative to the item it starts at -10; the line starts at -9.
    expect(prop(horizontal, "--cms-sep-x")).toBe("-9px");
    expect(prop(horizontal, "--cms-sep-length")).toBe("419px");
  });

  test("a host border doesn't move the cells: they are measured in the host's padding box", async () => {
    three();
    await mount();
    lay(row, [0, 140, 580, 40], 5);
    await repaint();
    expect(prop(band(0), "--cms-band-left")).toBe("-10px");
    expect(prop(band(2), "--cms-band-width")).toBe("220px");
    lay(column, [0, 420, 300, 40], 5);
    await repaint();
    expect(prop(tools(1), "--cms-tools-right")).toBe(`${300 - HOST_WIDTH}px`);
  });

  /** Gives item `index` a border of `width` on every side: its padding box is that much inside its border box. */
  const itemBorder = (index: number, width: number) => {
    const item = items()[index] as HTMLElement;
    const { width: w, height: h } = item.getBoundingClientRect();
    for (const [name, value] of [
      ["clientLeft", width],
      ["clientTop", width],
      ["clientWidth", w - 2 * width],
      ["clientHeight", h - 2 * width],
    ] as const) {
      Object.defineProperty(item, name, { configurable: true, get: () => value });
    }
  };

  test("an item's border doesn't move its band or toolbar: they are placed in the item's padding box", async () => {
    three();
    await mount();
    lay(column, [0, 420, 300, 40]);
    itemBorder(1, 4);
    await repaint();
    // Item 1's cell runs y = 125..275 and x = -10..610; its padding box starts at 4,154 and ends at 296,246.
    expect(prop(band(1), "--cms-band-top")).toBe("-29px");
    expect(prop(band(1), "--cms-band-bottom")).toBe("-29px");
    expect(prop(band(1), "--cms-band-left")).toBe("-14px");
    expect(prop(band(1), "--cms-band-width")).toBe("620px");
    expect(prop(tools(1), "--cms-tools-above")).toBe("29px");
    // The toolbar's right edge on the host's right edge, 304px past the item's padding box.
    expect(prop(tools(1), "--cms-tools-right")).toBe("-304px");
  });

  test("an item's border doesn't move the lines between its fields: they are measured in its padding box", async () => {
    const h3 = items()[1]?.querySelector<HTMLElement>("h3") as HTMLElement;
    const second = h3.cloneNode(true) as HTMLElement;
    second.setAttribute("data-edit-field", (h3.getAttribute("data-edit-field") ?? "").replace(/name$/, "role"));
    items()[1]?.append(second);
    await mount();
    lay(
      [
        [0, 0, 180, 100],
        [200, 0, 180, 100],
      ],
      [0, 140, 580, 40],
    );
    itemBorder(1, 4);
    h3.getBoundingClientRect = box([204, 10, 172, 20]);
    second.getBoundingClientRect = box([204, 50, 172, 20]);
    await repaint();
    const horizontal = items()[1]?.querySelector<HTMLElement>(".cms-item__sep--h") as HTMLElement;
    // The padding box starts at 204,4: the cell's left line at 190 is -14 in it, and the line starts one past that;
    // halfway between the fields (y = 30 and 50) is 36 in it.
    expect(prop(horizontal, "--cms-sep-x")).toBe("-13px");
    expect(prop(horizontal, "--cms-sep-top")).toBe("36px");
    expect(prop(horizontal, "--cms-sep-length")).toBe("419px");
  });

  test("the pad is where the frame is drawn: a 1rem pad is 16px, not 1", async () => {
    // An unregistered custom property computes to its token: `1rem`, which parses as 1.
    css(".cms-list__frame { --cms-list-pad: 1rem; }");
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    const frame = list().querySelector<HTMLElement>(".cms-list__frame") as HTMLElement;
    // The chrome's CSS puts the frame `--cms-list-pad` outside the padding box on the left and right.
    frame.getBoundingClientRect = box([-16, -16, HOST_WIDTH + 32, 132]);
    await repaint();
    // Inside the frame's 2px border: -16 + 2 on the left, 600 + 16 - 2 on the right.
    expect(prop(band(0), "--cms-band-left")).toBe("-14px");
    expect(prop(band(2), "--cms-band-width")).toBe("224px");
    // The Add row's line ends at 180, the pad below it; the frame starts 20 above the first line (half the gap).
    expect(prop(frame, "--cms-frame-height")).toBe("216px");
  });

  test("the frame's border is its real width, not assumed to be 2px", async () => {
    css(".cms-list__frame { border-left-width: 5px; border-right-width: 5px; }");
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    await repaint();
    expect(prop(band(0), "--cms-band-left")).toBe("-7px");
    expect(prop(band(2), "--cms-band-width")).toBe("217px");
  });

  test("the right edge reads the frame's right border, not its left one", async () => {
    css(".cms-list__frame { border-right-width: 5px; }");
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    await repaint();
    // The left border is the 2px default; the right one ends the last band at 600 + 12 - 5.
    expect(prop(band(0), "--cms-band-left")).toBe("-10px");
    expect(prop(band(2), "--cms-band-width")).toBe("217px");
  });

  test("the frame is appended: the host's first child is still its first item, and the toolbar leads each item", async () => {
    three();
    await mount();
    expect(list().firstElementChild).toBe(items()[0]);
    expect(list().querySelector(":scope > .cms-list__frame")).not.toBeNull();
    expect(items()[0]?.firstElementChild?.classList.contains("cms-item__tools")).toBe(true);
  });

  test("dragging in a row follows the pointer along the line", async () => {
    three();
    await mount();
    lay(row, [0, 140, 580, 40]);
    await repaint();
    toolButton(0, "grip").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    list().dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 420, clientY: 50 }));
    expect(names()).toEqual(["Tobias", "Mara", "Ines"]);
    list().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await settle();
    expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 0, to: 1 }]);
  });

  test("dragging in a row with uneven heights tests the pointer against the line, not each item's box", async () => {
    three();
    await mount();
    // Tobias is shorter than the line: the pointer below him but within the line is still on the line.
    lay(
      [
        [0, 0, 180, 100],
        [200, 0, 180, 40],
        [400, 0, 180, 100],
      ],
      [0, 140, 580, 40],
    );
    await repaint();
    toolButton(2, "grip").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    list().dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 70 }));
    expect(names()).toEqual(["Mara", "Ines", "Tobias"]);
    list().dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await settle();
    expect(arrayCalls.map((call) => call.op)).toEqual([{ kind: "move", from: 2, to: 1 }]);
  });
});

describe("the chrome's stylesheet and a host list", () => {
  const sheet = () => {
    const style = document.createElement("style");
    style.dataset.test = "";
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chrome.css"), "utf8");
    document.head.append(style);
  };
  afterEach(() => {
    for (const style of document.head.querySelectorAll("style[data-test]")) style.remove();
  });
  const look = (node: Element) => {
    const style = getComputedStyle(node);
    return {
      display: style.display,
      padding: style.paddingLeft,
      margin: style.marginTop,
      bullets: style.listStyleType,
    };
  };

  test("a host list dressed for editing keeps its own display, padding and bullets", async () => {
    sheet();
    const before = look(list());
    await mount();
    expect(list().classList.contains("cms-list")).toBe(true);
    expect(look(list())).toEqual(before);
  });

  test("a list in the chrome's own surfaces is still laid out as the chrome's grid", () => {
    sheet();
    const own = element("ul", { class: "cms-list" });
    const surface = element("div", { class: "cms-root" }, [own]);
    document.body.append(surface);
    expect(look(own)).toMatchObject({ display: "grid", padding: "0px", margin: "0px" });
    surface.remove();
  });
});

describe("a host element two chrome parts dress gives its class attribute back as it was", () => {
  test.each([
    ["no class attribute", null],
    ["an empty one", ""],
    ["its own classes", "card wide"],
  ])("with %s, whichever part lets go first", (_name, original) => {
    for (const order of [
      ["cms-field", "cms-item"],
      ["cms-item", "cms-field"],
    ]) {
      const node = document.createElement("li");
      if (original !== null) node.setAttribute("class", original);
      addHostClass(node, "cms-field");
      addHostClass(node, "cms-item");
      for (const name of order) removeHostClass(node, name);
      expect(node.getAttribute("class")).toBe(original);
    }
  });

  /** Each item is a field too: its name is edited on the `<li>` itself. */
  const itemsAreFields = () => {
    for (const item of items()) {
      const h3 = item.querySelector("h3") as HTMLElement;
      for (const name of ["data-edit-field", "data-edit-type"]) {
        item.setAttribute(name, h3.getAttribute(name) ?? "");
        h3.removeAttribute(name);
      }
    }
  };

  test("a list item that is also a field: Done gives back identical markup", async () => {
    itemsAreFields();
    const before = list().outerHTML;
    await mount();
    expect(items()[0]?.classList.contains("cms-item")).toBe(true);
    expect(items()[0]?.classList.contains("cms-field")).toBe(true);
    [...document.querySelectorAll<HTMLButtonElement>(".cms-bar button")]
      .find((button) => button.textContent === "Done")
      ?.click();
    expect(list().outerHTML).toBe(before);
  });

  test("a list item that is also a field: destroy gives back identical markup", async () => {
    itemsAreFields();
    const before = list().outerHTML;
    await mount();
    handle?.destroy();
    handle = undefined;
    expect(list().outerHTML).toBe(before);
  });
});
