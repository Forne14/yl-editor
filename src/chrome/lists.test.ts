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

  test("a list addressed by index stays unkeyed: Duplicate adds no _key", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    listAttrs = { ...listAttrs, duplicate: true };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    toolButton(0, "duplicate").click();
    await settle();
    const op = arrayCalls[0]?.op as Extract<ArrayOp, { kind: "insert" }>;
    expect(op).toEqual({ kind: "insert", index: 1, value: { name: "Mara" } });
    expect(items()[1]?.querySelector("h3")?.classList.contains("cms-field--editing")).toBe(true);
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
    expect(document.querySelectorAll(".cms-list__frame")).toHaveLength(2);
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

  test("in a list addressed by index, a failed value is dropped when a remove moves another item to its path", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }, { name: "Ines" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = page();
    await mount();
    failFields = true;
    const ines = items()[2]?.querySelector("h3") as HTMLElement;
    ines.click();
    ines.textContent = "Ann";
    ines.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    toolButton(1, "remove").click();
    await settle();
    // Ines is now at artists.1, and nothing claims artists.2: "Ann" is not painted onto anyone.
    expect(names()).toEqual(["Mara", "Ines"]);
    expect(document.querySelector(".cms-field--failed")).toBeNull();
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

  test("in a list addressed by index, Add keeps a failed value at an index it doesn't shift", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const mara = items()[0]?.querySelector("h3") as HTMLElement;
    mara.click();
    mara.textContent = "Mara Okoye";
    mara.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    addButton()?.click();
    await settle();
    const first = items()[0]?.querySelector("h3");
    expect(first?.textContent).toBe("Mara Okoye");
    expect(first?.classList.contains("cms-field--failed")).toBe(true);
  });

  test("a field in a list whose write is on its way doesn't open", async () => {
    let release: (() => void) | undefined;
    await mount();
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (!String(input).includes("/api/")) await gate;
      return realFetch(input, init);
    });
    toolButton(0, "down").click();
    await settle();
    const tobias = items()[1]?.querySelector("h3") as HTMLElement;
    tobias.click();
    expect(tobias.classList.contains("cms-field--editing")).toBe(false);
    release?.();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
  });

  test("a swap that throws doesn't stop the next one", async () => {
    await mount();
    let calls = 0;
    pageAnswer = () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return new Response(`<!doctype html><main id="page">${renderList()}</main>`);
    };
    toolButton(0, "down").click();
    await settle();
    expect(document.querySelector(".cms-toast")?.textContent).toContain("Reload to see it.");
    toolButton(1, "up").click();
    await settle();
    expect(names()).toEqual(["Mara", "Tobias"]);
  });
});

describe("fourth review round", () => {
  test("a nested list doesn't act while its outer list's document has a write on its way", async () => {
    artists[0] = { _key: "a", name: "Mara", links: [{ _key: "l1", name: "Site" }] };
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    const outerDown = items()[0]?.querySelector<HTMLButtonElement>(':scope > .cms-item__tools [data-action="down"]');
    const nested = document.querySelector<HTMLElement>(`[data-edit-list="${KEY}:artists[_key=a].links"]`);
    outerDown?.click();
    nested?.querySelector<HTMLButtonElement>('[data-action="remove"]')?.click();
    await settle();
    expect(arrayCalls.map((call) => call.op.kind)).toEqual(["move"]);
  });

  test("a Retry pressed while a remove is queued doesn't write into the item that moved to its index", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }, { name: "Ines" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const ines = items()[2]?.querySelector("h3") as HTMLElement;
    ines.click();
    ines.textContent = "Ann";
    ines.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    fieldCalls = [];
    toolButton(1, "remove").click();
    const retry = [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")].find(
      (node) => node.textContent === "Retry",
    );
    retry?.click();
    await settle();
    expect(fieldCalls).toEqual([]);
    expect(names()).toEqual(["Mara", "Ines"]);
  });

  test("a conflict on a list write drops failed values at index paths, which another editor may have moved", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }];
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const mara = items()[0]?.querySelector("h3") as HTMLElement;
    mara.click();
    mara.textContent = "Mine";
    mara.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    arrayAnswer = () => {
      artists = [{ name: "Tobias" }, { name: "Mara" }];
      version += 1;
      return json({ error: { code: "conflict", message: "Version mismatch", current: wireDocument() } }, 409);
    };
    toolButton(1, "remove").click();
    await settle();
    expect(names()).toEqual(["Tobias", "Mara"]);
    expect(document.querySelector(".cms-field--failed")).toBeNull();
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

  test("a Retry still on screen after a write dropped its value does nothing", async () => {
    artists = [{ name: "Mara" }, { name: "Tobias" }, { name: "Ines" }];
    listAttrs = { ...listAttrs, min: 0 };
    document.body.innerHTML = `<main id="page">${renderList()}</main>`;
    await mount();
    failFields = true;
    const ines = items()[2]?.querySelector("h3") as HTMLElement;
    ines.click();
    ines.textContent = "Ann";
    ines.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    failFields = false;
    const retry = [...document.querySelectorAll<HTMLButtonElement>(".cms-toast button")].find(
      (node) => node.textContent === "Retry",
    );
    toolButton(1, "remove").click();
    await settle();
    fieldCalls = [];
    retry?.click();
    await settle();
    expect(fieldCalls).toEqual([]);
  });

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
