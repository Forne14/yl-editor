// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { editable, itemPath, type EditableListAttrs } from "../editable.ts";
import { applyArrayOp, parsePath } from "../path.ts";
import type { ArrayOp } from "../types.ts";
import { mountEditor } from "./index.ts";
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
/** The store refuses a whole-list write that adds `_key` (a schema without it). */
let refuseKeys: boolean;
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
        if (refuseKeys && written.path === "artists") {
          return json({ error: { code: "validation", message: "Unrecognized key: _key" } }, 422);
        }
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
  refuseKeys = false;
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

  test("a keyed item's field rendered by position is saved by key", async () => {
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
    await mount();
    expect(toolButton(0, "down")).not.toBeNull();
    const tobias = items()[1]?.querySelector("h3") as HTMLElement;
    tobias.click();
    tobias.textContent = "Tobi";
    tobias.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(fieldCalls).toEqual(["artists[_key=b].name"]);
  });

  test("an unkeyed list keys every item on its first change, then makes it", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    expect(toolButton(0, "down")).not.toBeNull();
    toolButton(0, "remove").click();
    await settle();
    expect(fieldCalls).toEqual(["artists"]);
    expect(arrayCalls.map((call) => call.op.kind)).toEqual(["remove"]);
    expect(names()).toEqual(["Tobias"]);
    expect(artists[0]?._key).toMatch(/^[a-z0-9]{10}$/);
  });

  test("when the keys are refused, the list keeps one outline and no list actions, and the console says why", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    refuseKeys = true;
    toolButton(0, "down").click();
    await settle();
    expect(arrayCalls).toEqual([]);
    expect(list().querySelectorAll(".cms-list__frame")).toHaveLength(1);
    expect(list().querySelector(".cms-item__tools")).toBeNull();
    expect(list().querySelector(".cms-list__add")).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain("has no Add, Remove or Move: its items have no _key");
    warn.mockRestore();
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
  test("a network failure while keying keeps the list's actions; the next press tries again", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    toolButton(0, "down").click();
    await settle();
    expect(list().querySelector(".cms-item__tools")).not.toBeNull();
    failFields = false;
    toolButton(0, "down").click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
  });

  test("a schema that refuses _key leaves the list with one outline and no actions", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    refuseKeys = true;
    toolButton(0, "down").click();
    await settle();
    expect(list().querySelector(".cms-item__tools")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

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
  const attrs = (record: Record<string, string>) =>
    Object.entries(record)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
  /** Items and fields rendered by position, whatever the data holds. */
  function byIndex(): string {
    const edit = editable(KEY);
    return `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists
      .map(
        (artist, index) =>
          `<li data-edit-item="${KEY}:artists.${index}"><h3${attrs(edit(`artists.${index}.name`, "text"))}>${artist.name}</h3></li>`,
      )
      .join("")}</ul></main>`;
  }

  test("keying a list moves a failed value to its item's key, so Retry writes into the same item", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const tobias = items()[1]?.querySelector("h3") as HTMLElement;
    tobias.click();
    tobias.textContent = "Tobi";
    tobias.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    toolButton(1, "up").click();
    await settle();
    expect(names()).toEqual(["Tobi", "Mara"]);
    fieldCalls = [];
    [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")]
      .find((node) => node.textContent === "Retry")
      ?.click();
    const moved = items()[0]?.querySelector("h3") as HTMLElement;
    expect(moved.classList.contains("cms-field--failed")).toBe(true);
    moved.click();
    moved.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    // Tobias moved to the top: the value goes to his key, wherever he is now.
    const tobiasKey = artists.find((artist) => artist.name === "Tobias")?._key;
    expect(fieldCalls).toEqual([`artists[_key=${tobiasKey}].name`]);
  });

  test("a page that still renders items by position after keying drops to one outline and says why", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = byIndex();
    pageAnswer = () => new Response(`<!doctype html>${byIndex()}`);
    await mount();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    toolButton(0, "down").click();
    await settle();
    expect(list().querySelector(".cms-item__tools")).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain("the page renders them by position");
    warn.mockRestore();
  });

  test("a field inside an item that names another entry keeps its own path", async () => {
    const edit = editable(KEY);
    document.body.innerHTML = `<main id="page"><ul${attrs(edit.list("artists", listAttrs))}>${artists
      .map(
        (artist, index) =>
          `<li${attrs(edit.item("artists", artist, index))}><h3${attrs(edit(`artists.${index}.name`, "text"))}>${artist.name}</h3><small${attrs(edit(`artists.${(index + 1) % 2}.name`, "text"))}>next</small></li>`,
      )
      .join("")}</ul></main>`;
    await mount();
    const teaser = items()[0]?.querySelector("small") as HTMLElement;
    teaser.click();
    teaser.textContent = "Tobi";
    teaser.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(fieldCalls).toEqual(["artists.1.name"]);
  });

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
