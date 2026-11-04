// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { groupByDocument, scanFields } from "./fields.ts";
import { mountEditor } from "./index.ts";
import type { EditorHandle, WireDocument } from "./types.ts";

interface RecordedCall {
  method: string;
  route: string;
  body: Record<string, unknown> | undefined;
  init: RequestInit;
}

type Handler = (body: Record<string, unknown> | undefined) => { status?: number; json: unknown };

let calls: RecordedCall[] = [];
let handlers: Record<string, Handler[] | Handler> = {};
let handle: EditorHandle | undefined;

function wireDocument(key: string, version: number, payload: unknown = {}): WireDocument {
  return {
    id: 1,
    key,
    type: "page",
    slug: key.split("/")[1] ?? key,
    payload,
    isDraft: true,
    publishedAt: null,
    draftUpdatedAt: null,
    previousSlugs: [],
    retiredAt: null,
    version,
    scheduledAt: null,
  };
}

function summary(key: string, edit: boolean, publish: boolean, version = 3) {
  return {
    key,
    type: "page",
    version,
    isDraft: false,
    draftUpdatedAt: null,
    publishedAt: null,
    access: { edit, publish },
  };
}

const echoField: Handler = (body) => ({
  json: { document: wireDocument(String(body?.key), Number(body?.expectedVersion ?? 0) + 1) },
});

function installFetch(): void {
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://localhost");
    const method = init.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, route: `${route}${url.search}`, body, init });
    const entry = handlers[route];
    const handler = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!handler)
      return new Response(JSON.stringify({ error: { code: "not_found", message: "none" } }), { status: 404 });
    const result = handler(body);
    return new Response(JSON.stringify(result.json), { status: result.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function field(address: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-edit-field="${address}"]`);
  if (!found) throw new Error(`no field ${address}`);
  return found;
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function buttonNamed(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label && !candidate.closest("[hidden]"),
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function visibleToast(): HTMLElement {
  const toast = document.querySelector<HTMLElement>(".cms-toast");
  if (!toast || toast.hidden) throw new Error("no toast");
  return toast;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function editText(address: string, next: string): Promise<void> {
  const target = field(address);
  target.click();
  target.textContent = next;
  press(target, "Enter");
  await settle();
}

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  document.body.innerHTML = `
    <main id="page">
      <a href="/elsewhere"><h1 data-edit-field="pages/home:title" data-edit-type="text" data-edit-label="Title">Hello</h1></a>
      <p data-edit-field="pages/home:lede" data-edit-type="richtext">Lede</p>
      <span data-edit-field="artists/finn:name" data-edit-type="text">Finn</span>
      <span data-edit-field="locked/doc:name" data-edit-type="text">Locked</span>
      <span data-edit-field="pages/home:clip" data-edit-type="video">Clip</span>
    </main>`;
  handlers = {
    "GET /api/content/documents": () => ({
      json: {
        documents: {
          "pages/home": summary("pages/home", true, true),
          "artists/finn": summary("artists/finn", true, false),
          "locked/doc": summary("locked/doc", false, false),
        },
      },
    }),
    "POST /api/content/field": echoField,
    "POST /api/content/publish": (body) => ({
      json: { document: { ...wireDocument(String(body?.key), 9), isDraft: false } },
    }),
  };
  installFetch();
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  vi.unstubAllGlobals();
});

async function mount(): Promise<EditorHandle> {
  handle = mountEditor({ actorLabel: "Editing as Maya (Editor)" });
  await handle.ready;
  return handle;
}

test("scans fields and groups them by document key", () => {
  const records = scanFields(document.body);
  expect(records.map((record) => record.id)).toEqual([
    "pages/home:title",
    "pages/home:lede",
    "artists/finn:name",
    "locked/doc:name",
    "pages/home:clip",
  ]);
  const groups = groupByDocument(records);
  expect([...groups.keys()]).toEqual(["pages/home", "artists/finn", "locked/doc"]);
  expect(groups.get("pages/home")?.map((record) => record.info.path)).toEqual(["title", "lede", "clip"]);
  expect(records[0]?.info.label).toBe("Title");
});

test("loads the page's documents once on mount, by the wire contract", async () => {
  await mount();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.route.startsWith("GET /api/content/documents?")).toBe(true);
  const query = new URLSearchParams(calls[0]?.route.split("?")[1]);
  expect(query.get("keys")).toBe("pages/home,artists/finn,locked/doc");
  expect(calls[0]?.init.credentials).toBe("same-origin");
  expect((calls[0]?.init.headers as Record<string, string>)["X-Requested-With"]).toBe("yl-editor");
  expect(handle?.api.documents().get("pages/home")?.version).toBe(3);
});

test("attaches a highlight with a badge to each editable field", async () => {
  await mount();
  const title = field("pages/home:title");
  expect(title.classList.contains("cms-field")).toBe(true);
  expect(title.tabIndex).toBe(0);
  const description = document.getElementById(title.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toContain("Title · text");
  title.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const badge = document.querySelector<HTMLElement>(".cms-badge");
  expect(badge?.hidden).toBe(false);
  expect(badge?.textContent).toBe("Title · text");
});

test("a field without edit access is shown but not editable, with the reason", async () => {
  await mount();
  const locked = field("locked/doc:name");
  expect(locked.classList.contains("cms-field--locked")).toBe(true);
  const description = document.getElementById(locked.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toContain("you don’t have edit access");
  locked.click();
  expect(locked.hasAttribute("contenteditable")).toBe(false);
  expect(visibleToast().textContent).toContain("you don’t have edit access");
});

test("the text widget commits with expectedVersion and stores the returned version", async () => {
  const { api } = await mount();
  const title = field("pages/home:title");
  const navigation = new MouseEvent("click", { bubbles: true, cancelable: true });
  title.dispatchEvent(navigation);
  expect(navigation.defaultPrevented).toBe(true);
  expect(title.getAttribute("contenteditable")).not.toBeNull();
  title.textContent = "Hi there";
  press(title, "Enter");
  await settle();
  const write = calls.find((call) => call.route === "POST /api/content/field");
  expect(write?.body).toEqual({ key: "pages/home", path: "title", value: "Hi there", expectedVersion: 3 });
  expect(api.documents().get("pages/home")?.version).toBe(4);
  expect(title.hasAttribute("contenteditable")).toBe(false);
  expect(title.dataset.cmsState).toBe("saved");
  expect(document.activeElement).toBe(title);

  await editText("pages/home:lede", "New lede");
  expect(calls.at(-1)?.body?.expectedVersion).toBe(4);
  expect(document.querySelector(".cms-bar__changes")?.textContent).toMatch(/^2 changes on this page/);
});

test("Esc cancels, restores the text and sends nothing", async () => {
  await mount();
  const title = field("pages/home:title");
  title.click();
  title.textContent = "Scribble";
  press(title, "Escape");
  await settle();
  expect(title.textContent).toBe("Hello");
  expect(title.hasAttribute("contenteditable")).toBe(false);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  expect(document.activeElement).toBe(title);
});

test("a failed save shows Retry, and Retry resends the value", async () => {
  handlers["POST /api/content/field"] = [
    () => ({ status: 400, json: { error: { code: "bad_request", message: "Boom" } } }),
    echoField,
  ];
  await mount();
  await editText("pages/home:title", "Again");
  const title = field("pages/home:title");
  expect(title.dataset.cmsState).toBe("failed");
  expect(visibleToast().textContent).toContain("Not saved: Boom");
  buttonNamed("Retry", visibleToast()).click();
  await settle();
  const writes = calls.filter((call) => call.route === "POST /api/content/field");
  expect(writes).toHaveLength(2);
  expect(writes[1]?.body?.value).toBe("Again");
  expect(title.dataset.cmsState).toBe("saved");
});

test("a conflict offers keep mine or take theirs, and take theirs reloads the field", async () => {
  handlers["POST /api/content/field"] = () => ({
    status: 409,
    json: {
      error: { code: "conflict", message: "Stale", current: wireDocument("pages/home", 9, { title: "Theirs" }) },
    },
  });
  const { api } = await mount();
  await editText("pages/home:title", "Mine");
  const toast = visibleToast();
  expect(toast.textContent).toContain("Keep mine (overwrite)");
  buttonNamed("Take theirs (reload field)", toast).click();
  expect(field("pages/home:title").textContent).toBe("Theirs");
  expect(api.documents().get("pages/home")?.version).toBe(9);
  expect(document.querySelector<HTMLElement>(".cms-toast")?.hidden).toBe(true);
});

test("publish lists only the touched documents the user may publish, then publishes each", async () => {
  await mount();
  await editText("pages/home:title", "One");
  await editText("artists/finn:name", "Finnegan");
  buttonNamed("Publish").click();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet");
  expect(sheet?.hidden).toBe(false);
  const listed = [...(sheet?.querySelectorAll("li[data-key]") ?? [])].map((item) => item.getAttribute("data-key"));
  expect(listed).toEqual(["pages/home"]);
  expect(sheet?.textContent).toContain("1 other changed documents need someone with publish access.");
  expect(calls.some((call) => call.route.startsWith("POST /api/content/publish"))).toBe(false);
  buttonNamed("Publish", sheet ?? document).click();
  await settle();
  const publishes = calls.filter((call) => call.route === "POST /api/content/publish");
  expect(publishes.map((call) => call.body)).toEqual([{ key: "pages/home" }]);
  expect(sheet?.hidden).toBe(true);
});

test("Esc closes an open panel and returns focus to its opener", async () => {
  await mount();
  const opener = buttonNamed("Discard");
  opener.focus();
  opener.click();
  press(document.body, "Escape");
  expect(document.querySelector<HTMLElement>(".cms-sheet")?.hidden).toBe(true);
  expect(document.activeElement).toBe(opener);
});

test("only one toast shows at a time", async () => {
  const { api } = await mount();
  api.status("First");
  api.status("Second", "error");
  expect(document.querySelectorAll(".cms-toast")).toHaveLength(1);
  expect(visibleToast().textContent).toContain("Second");
  expect(visibleToast().textContent).not.toContain("First");
  expect(document.querySelector(".cms-live")?.textContent).toBe("Second");
});

test("a field type with no widget says so and never throws", async () => {
  await mount();
  const clip = field("pages/home:clip");
  expect(() => clip.click()).not.toThrow();
  expect(document.querySelector(".cms-popover")?.textContent).toContain("No editor registered for video");
  press(buttonNamed("Close", document.querySelector(".cms-popover") ?? document), "Escape");
  expect(document.querySelector(".cms-popover")).toBeNull();
});

test("host widgets and panels plug in", async () => {
  const mounted = vi.fn();
  handle = mountEditor({
    widgets: {
      text: {
        mount(ctx) {
          mounted(ctx.field);
          void ctx.commit("from widget");
          return { destroy() {} };
        },
      },
    },
    panels: [
      {
        id: "notes",
        label: "Notes",
        mount(root) {
          root.append("Panel body");
          return { destroy: () => root.replaceChildren() };
        },
      },
    ],
  });
  await handle.ready;
  field("pages/home:title").click();
  await settle();
  expect(mounted).toHaveBeenCalledWith(expect.objectContaining({ key: "pages/home", path: "title", label: "Title" }));
  expect(calls.at(-1)?.body?.value).toBe("from widget");
  buttonNamed("Notes").click();
  expect(document.querySelector(".cms-sheet")?.textContent).toContain("Panel body");
});

test("destroy removes every node, attribute and listener it added", async () => {
  const targets = [document, window, document.body, field("pages/home:title")];
  const spies = targets.map((target) => ({
    added: vi.spyOn(target, "addEventListener"),
    removed: vi.spyOn(target, "removeEventListener"),
  }));
  const before = document.getElementById("page")?.outerHTML;
  const editor = mountEditor();
  await editor.ready;
  field("pages/home:title").click();
  editor.destroy();
  const balance = spies.map((spy) => spy.added.mock.calls.length - spy.removed.mock.calls.length);
  expect(spies[0]?.added.mock.calls.length).toBeGreaterThan(0);
  vi.restoreAllMocks();
  expect(document.querySelector(".cms-root")).toBeNull();
  expect(document.querySelector(".cms-popover")).toBeNull();
  expect(document.getElementById("page")?.outerHTML).toBe(before);
  expect(balance).toEqual([0, 0, 0, 0]);
  field("pages/home:title").click();
  expect(field("pages/home:title").hasAttribute("contenteditable")).toBe(false);
});

test("writes to one document are serialised, so the second carries the first's new version", async () => {
  await mount();
  for (const [address, next] of [
    ["pages/home:title", "A"],
    ["pages/home:lede", "B"],
  ] as const) {
    const target = field(address);
    target.click();
    target.textContent = next;
    press(target, "Enter");
  }
  await settle();
  const writes = calls.filter((call) => call.route === "POST /api/content/field");
  expect(writes.map((call) => call.body?.expectedVersion)).toEqual([3, 4]);
});
