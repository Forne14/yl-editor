// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { groupByDocument, scanFields } from "./fields.ts";
import { mountEditor, type ContentClient } from "./index.ts";
import { Session } from "./session.ts";
import type { EditorHandle, EditorOptions, WidgetContext, WireDocument } from "./types.ts";

interface RecordedCall {
  method: string;
  route: string;
  body: Record<string, unknown> | undefined;
  init: RequestInit;
}

type Answer = { status?: number; json: unknown };
type Handler = (body: Record<string, unknown> | undefined, url: URL) => Answer | Promise<Answer>;

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
    const result = await handler(body, url);
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

afterEach(async () => {
  handle?.destroy();
  handle = undefined;
  // Destroying commits an open edit; let that write reach the stub rather than the real fetch.
  await settle();
  vi.unstubAllGlobals();
});

async function mount(extra: EditorOptions = {}): Promise<EditorHandle> {
  handle = mountEditor({ actorLabel: "Editing as Maya (Editor)", ...extra });
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
  expect(publishes.map((call) => call.body)).toEqual([{ key: "pages/home", expectedVersion: 4 }]);
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

test("bulk discard lists touched documents the user may edit, not only publish", async () => {
  handlers["POST /api/content/discard"] = (body) => ({ json: { document: wireDocument(String(body?.key), 10) } });
  await mount();
  await editText("pages/home:title", "One");
  await editText("artists/finn:name", "Finnegan");
  buttonNamed("Discard").click();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet");
  const listed = [...(sheet?.querySelectorAll("li[data-key]") ?? [])].map((item) => item.getAttribute("data-key"));
  expect(listed).toEqual(["pages/home", "artists/finn"]);
  expect(sheet?.textContent).not.toContain("publish access");
  buttonNamed("Discard", sheet ?? document).click();
  await settle();
  const discards = calls.filter((call) => call.route === "POST /api/content/discard");
  expect(discards.map((call) => call.body)).toEqual([
    { key: "pages/home", expectedVersion: 4 },
    { key: "artists/finn", expectedVersion: 4 },
  ]);
});

test("publishing waits for an in-flight field write of the same document", async () => {
  const { api } = await mount();
  const title = field("pages/home:title");
  title.click();
  title.textContent = "Late";
  press(title, "Enter");
  await api.publish("pages/home");
  const routes = calls.map((call) => call.route).filter((route) => route.startsWith("POST"));
  expect(routes).toEqual(["POST /api/content/field", "POST /api/content/publish"]);
});

test("a url popover edit is committed when another field is opened", async () => {
  document
    .getElementById("page")
    ?.insertAdjacentHTML("beforeend", `<a data-edit-field="pages/home:link" data-edit-type="url">x</a>`);
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  const { api } = await mount();
  await api.refresh();
  field("pages/home:link").click();
  await settle();
  const input = document.querySelector<HTMLInputElement>(".cms-popover input");
  if (!input) throw new Error("no input");
  input.value = "https://example.com";
  field("pages/home:title").click();
  await settle();
  const write = calls.find((call) => call.route === "POST /api/content/field");
  expect(write?.body).toMatchObject({ path: "link", value: "https://example.com" });
});

test("a tags popover edit is committed when the editor is destroyed", async () => {
  document
    .getElementById("page")
    ?.insertAdjacentHTML("beforeend", `<p data-edit-field="pages/home:tags" data-edit-type="tags">rendered</p>`);
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { tags: ["a"] }) },
  });
  const editor = await mount();
  field("pages/home:tags").click();
  await settle();
  const input = document.querySelector<HTMLInputElement>(".cms-popover input");
  if (!input) throw new Error("no input");
  input.value = "b";
  editor.destroy();
  await settle();
  const write = calls.find((call) => call.route === "POST /api/content/field");
  expect(write?.body).toMatchObject({ path: "tags", value: ["a", "b"] });
});

function addToggle(rendered: string): void {
  document
    .getElementById("page")
    ?.insertAdjacentHTML(
      "beforeend",
      `<span data-edit-field="pages/home:live" data-edit-type="toggle">${rendered}</span>`,
    );
}

function checkbox(): HTMLInputElement {
  const box = document.querySelector<HTMLInputElement>(".cms-popover input[type=checkbox]");
  if (!box) throw new Error("no checkbox");
  return box;
}

const documentFetches = () => calls.filter((call) => call.route.startsWith("GET /api/content/document?"));

test("a toggle opens on the fetched document's value, not on the text the page renders", async () => {
  addToggle("On");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { live: false }) },
  });
  await mount();
  expect(documentFetches()).toHaveLength(0);
  field("pages/home:live").click();
  await settle();
  expect(documentFetches()[0]?.route).toBe("GET /api/content/document?key=pages%2Fhome");
  expect(checkbox().checked).toBe(false);
});

test("the opposite way round too: a toggle rendered Off opens checked when the document says true", async () => {
  addToggle("Off");
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, { live: true }) } });
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
});

test("a keyed path reads the item by its _key, wherever the array has moved it", async () => {
  document
    .getElementById("page")
    ?.insertAdjacentHTML(
      "beforeend",
      `<span data-edit-field="pages/home:items[_key=b].live" data-edit-type="toggle">Off</span>`,
    );
  handlers["GET /api/content/document"] = () => ({
    json: {
      document: wireDocument("pages/home", 3, {
        items: [
          { _key: "a", live: false },
          { _key: "b", live: true },
        ],
      }),
    },
  });
  await mount();
  field("pages/home:items[_key=b].live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
});

test("one document fetch per key per session, and a write's result replaces the cached copy", async () => {
  addToggle("x");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { live: false }) },
  });
  handlers["POST /api/content/field"] = (body) => ({
    json: { document: wireDocument("pages/home", 4, { live: body?.value }) },
  });
  await mount();
  const live = field("pages/home:live");
  live.click();
  await settle();
  press(checkbox(), "Escape");
  live.click();
  await settle();
  expect(documentFetches()).toHaveLength(1);
  const box = checkbox();
  box.checked = true;
  box.dispatchEvent(new Event("change"));
  await settle();
  live.click();
  await settle();
  expect(checkbox().checked).toBe(true);
  expect(documentFetches()).toHaveLength(1);
});

test("a failed document fetch keeps the widget closed, says why, and the next open retries", async () => {
  addToggle("On");
  handlers["GET /api/content/document"] = [
    () => ({ status: 403, json: { error: { code: "forbidden", message: "Nope" } } }),
    () => ({ json: { document: wireDocument("pages/home", 3, { live: true }) } }),
  ];
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(document.querySelector(".cms-popover")).toBeNull();
  expect(visibleToast().textContent).toContain("Couldn’t load this field: Nope");
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
});

function addEditValueField(path: string, type: string, editValue?: string, options?: string[]): HTMLElement {
  const added = document.createElement("span");
  added.dataset.editField = `pages/home:${path}`;
  added.dataset.editType = type;
  added.textContent = "rendered";
  if (editValue !== undefined) added.dataset.editValue = editValue;
  if (options) added.dataset.editOptions = JSON.stringify(options);
  document.getElementById("page")?.append(added);
  return added;
}

const serverError = () => ({ status: 500, json: { error: { code: "internal", message: "Boom" } } });
const fieldWrites = () => calls.filter((call) => call.route === "POST /api/content/field");

function popoverControl<Control extends HTMLElement>(selector: string): Control {
  const control = document.querySelector<Control>(`.cms-popover ${selector}`);
  if (!control) throw new Error(`no control ${selector}`);
  return control;
}

test("the stored value beats data-edit-value", async () => {
  addEditValueField("live", "toggle", "true");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { live: false }) },
  });
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(false);
});

test("a stored null is a stored value: data-edit-value does not replace it", async () => {
  addEditValueField("spaces", "number", "12");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { spaces: null }) },
  });
  await mount();
  field("pages/home:spaces").click();
  await settle();
  expect(popoverControl<HTMLInputElement>("input").value).toBe("");
});

test("data-edit-value is used when the path is missing from the stored document", async () => {
  addEditValueField("live", "toggle", "true");
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
  expect(document.querySelector<HTMLElement>(".cms-toast")?.hidden).toBe(true);
});

test("with the path missing and no data-edit-value the rendered text is still not read", async () => {
  addToggle("On");
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(false);
});

test("data-edit-value is used when the fetch fails, says so, and the next open retries for the stored value", async () => {
  addEditValueField("live", "toggle", "true");
  handlers["GET /api/content/document"] = [
    serverError,
    () => ({ json: { document: wireDocument("pages/home", 3, { live: false }) } }),
  ];
  await mount();
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
  expect(visibleToast().textContent).toContain("starts from the page’s value: Boom");
  press(checkbox(), "Escape");
  field("pages/home:live").click();
  await settle();
  expect(documentFetches()).toHaveLength(2);
  expect(checkbox().checked).toBe(false);
});

test("an edit started from data-edit-value after a failed fetch still sends the known version", async () => {
  addEditValueField("live", "toggle", "true");
  handlers["GET /api/content/document"] = serverError;
  await mount();
  field("pages/home:live").click();
  await settle();
  const box = checkbox();
  box.checked = false;
  box.dispatchEvent(new Event("change"));
  await settle();
  expect(fieldWrites()[0]?.body).toMatchObject({ path: "live", value: false, expectedVersion: 3 });
});

test("a fetch failing after another field was opened neither opens the widget nor shows a toast", async () => {
  addEditValueField("live", "toggle", "true");
  handlers["GET /api/content/document"] = serverError;
  await mount();
  field("pages/home:live").click();
  field("pages/home:title").click();
  await settle();
  expect(document.querySelector(".cms-popover")).toBeNull();
  expect(document.querySelector<HTMLElement>(".cms-toast")?.hidden).toBe(true);
});

test("a data-edit-value that is not JSON is used as written", async () => {
  addEditValueField("style", "select", "plain", ["plain", "bold"]);
  addEditValueField("note", "url", "{not json");
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  await mount();
  field("pages/home:style").click();
  await settle();
  expect(popoverControl<HTMLSelectElement>("select").value).toBe("plain");
  press(popoverControl("select"), "Escape");
  field("pages/home:note").click();
  await settle();
  expect(popoverControl<HTMLInputElement>("input").value).toBe("{not json");
});

function richWidget() {
  const seen: { value: unknown; commit: (next: unknown) => Promise<void> }[] = [];
  const widget = {
    mount(ctx: WidgetContext) {
      seen.push({ value: ctx.value, commit: ctx.commit });
      return { destroy: () => undefined };
    },
  };
  return { seen, widget };
}

const markup = '<p class="lead">Hello <em>there</em></p>';

test("a host richtext widget starts from data-edit-value with its markup intact, at once", async () => {
  const { seen, widget } = richWidget();
  field("pages/home:lede").dataset.editValue = JSON.stringify(markup);
  handle = mountEditor({ widgets: { richtext: widget } });
  await handle.ready;
  field("pages/home:lede").click();
  // No settle: the widget opened without waiting for a fetch.
  expect(seen[0]?.value).toBe(markup);
  await settle();
  expect(documentFetches()).toHaveLength(0);
});

test("a richtext data-edit-value that is not JSON is used as written", async () => {
  const { seen, widget } = richWidget();
  field("pages/home:lede").dataset.editValue = markup;
  handle = mountEditor({ widgets: { richtext: widget } });
  await handle.ready;
  field("pages/home:lede").click();
  expect(seen[0]?.value).toBe(markup);
});

test("a host richtext widget committing its starting value from data-edit-value writes nothing", async () => {
  const { seen, widget } = richWidget();
  field("pages/home:lede").dataset.editValue = JSON.stringify(markup);
  handle = mountEditor({ widgets: { richtext: widget } });
  await handle.ready;
  field("pages/home:lede").click();
  await seen[0]?.commit(markup);
  await settle();
  expect(fieldWrites()).toEqual([]);
});

test("once known, the stored value beats data-edit-value for text and richtext", async () => {
  const { seen, widget } = richWidget();
  addToggle("On");
  field("pages/home:lede").dataset.editValue = JSON.stringify(markup);
  field("pages/home:title").dataset.editValue = JSON.stringify("Attribute title");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { live: true, lede: "<p>Stored</p>", title: "Hello" }) },
  });
  handle = mountEditor({ widgets: { richtext: widget, text: widget } });
  await handle.ready;
  // Opening a non-text field of the document is what fetches its payload.
  field("pages/home:live").click();
  await settle();
  press(checkbox(), "Escape");
  field("pages/home:lede").click();
  expect(seen[0]?.value).toBe("<p>Stored</p>");
  field("pages/home:title").click();
  expect(seen[1]?.value).toBe("Hello");
});

test("data-edit-value falls back to the element's text only when it is absent", async () => {
  const { seen, widget } = richWidget();
  handle = mountEditor({ widgets: { richtext: widget } });
  await handle.ready;
  field("pages/home:lede").click();
  expect(seen[0]?.value).toBe("Lede");
});

test.each(["blur", "Enter"])(
  "the text widget left untouched by %s writes nothing when data-edit-value differs from the text",
  async (exit) => {
    const title = field("pages/home:title");
    title.dataset.editValue = JSON.stringify("Stored title, shown differently");
    await mount();
    title.click();
    if (exit === "blur") title.dispatchEvent(new FocusEvent("blur"));
    else press(title, "Enter");
    await settle();
    expect(title.classList.contains("cms-field--editing")).toBe(false);
    expect(fieldWrites()).toEqual([]);
  },
);

test("the text widget left untouched writes nothing when the stored value differs from the text", async () => {
  addToggle("On");
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { live: true, title: "Stored title" }) },
  });
  await mount();
  field("pages/home:live").click();
  await settle();
  press(checkbox(), "Escape");
  const title = field("pages/home:title");
  title.click();
  title.dispatchEvent(new FocusEvent("blur"));
  await settle();
  expect(fieldWrites()).toEqual([]);
});

test("an edited text field with data-edit-value still saves", async () => {
  field("pages/home:title").dataset.editValue = JSON.stringify("Attribute title");
  await mount();
  await editText("pages/home:title", "Edited");
  expect(fieldWrites()[0]?.body).toMatchObject({ path: "title", value: "Edited" });
});

const untouchedCases: [string, string, string, string[]?][] = [
  ["toggle", "toggle", "true"],
  ["number", "number", "12"],
  ["an empty number", "number", ""],
  ["a number that is not JSON", "number", "abc"],
  ["url", "url", '"https://example.com"'],
  ["date", "date", '"2026-11-14"'],
  ["a date that is not JSON", "date", "14 Nov"],
  ["select", "select", "plain", ["plain", "bold"]],
  ["select with an empty value", "select", "", ["plain", "bold"]],
  ["tags", "tags", '["a","b"]'],
];

describe.each([
  ["the path is missing", () => ({ json: { document: wireDocument("pages/home", 3, {}) } })],
  ["the fetch failed", serverError],
])("a popover left untouched writes nothing when %s", (_name, documentHandler) => {
  test.each(untouchedCases)("%s", async (_label, type, editValue, options) => {
    addEditValueField("thing", type, editValue, options);
    handlers["GET /api/content/document"] = documentHandler;
    await mount();
    field("pages/home:thing").click();
    await settle();
    expect(document.querySelector(".cms-popover")).not.toBeNull();
    // Opening another field commits whatever the open popover holds.
    field("pages/home:title").click();
    await settle();
    expect(document.querySelector(".cms-popover")).toBeNull();
    expect(fieldWrites()).toEqual([]);
  });

  test("tags confirmed with Done", async () => {
    addEditValueField("thing", "tags", '["a","b"]');
    handlers["GET /api/content/document"] = documentHandler;
    await mount();
    field("pages/home:thing").click();
    await settle();
    buttonNamed("Done", popoverControl<HTMLElement>(".cms-tags")).click();
    await settle();
    expect(fieldWrites()).toEqual([]);
  });
});

test("a toggle whose fetch finishes after another field was opened does not open", async () => {
  addToggle("On");
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, { live: true }) } });
  await mount();
  field("pages/home:live").click();
  field("pages/home:title").click();
  await settle();
  expect(document.querySelector(".cms-popover")).toBeNull();
  expect(field("pages/home:title").getAttribute("contenteditable")).not.toBeNull();
});

function revision(id: number, action: string, payload: unknown) {
  return { id, action, slug: "home", payload, actor: "Maya", createdAt: "2026-01-01T00:00:00.000Z" };
}

async function openRevisions(): Promise<HTMLElement> {
  buttonNamed("Revisions").click();
  await settle();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet");
  if (!sheet) throw new Error("no sheet");
  return sheet;
}

function pick(sheet: HTMLElement, key: string): void {
  const picker = sheet.querySelector("select");
  if (!picker) throw new Error("no picker");
  picker.value = key;
  picker.dispatchEvent(new Event("change"));
}

test("Restore shows on each revision only with edit access", async () => {
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(1, "publish", {})] } });
  await mount();
  const sheet = await openRevisions();
  expect(buttonNamed("Restore", sheet).getAttribute("aria-label")).toBe("Restore revision 1 into the draft");
  pick(sheet, "locked/doc");
  await settle();
  expect(sheet.querySelector("li[data-revision]")).not.toBeNull();
  expect(() => buttonNamed("Restore", sheet)).toThrow();
});

test("Restore calls restoreRevision, repaints the fields from the draft and reloads the list", async () => {
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(7, "publish", {})] } });
  handlers["GET /api/content/document"] = () => ({
    json: { document: wireDocument("pages/home", 3, { title: "Hello", lede: "Lede" }) },
  });
  handlers["POST /api/content/restore-revision"] = (body) => ({
    json: { document: wireDocument(String(body?.key), 4, { title: "Old title", lede: "Lede" }) },
  });
  const { api } = await mount();
  const changed = vi.fn();
  field("pages/home:title").addEventListener("cms:change", changed);
  const sheet = await openRevisions();
  const listings = calls.filter((call) => call.route.startsWith("GET /api/content/revisions")).length;
  buttonNamed("Restore", sheet).click();
  buttonNamed("Confirm", sheet).click();
  await settle();
  const write = calls.find((call) => call.route === "POST /api/content/restore-revision");
  expect(write?.body).toEqual({ key: "pages/home", revisionId: 7, expectedVersion: 3 });
  expect(field("pages/home:title").textContent).toBe("Old title");
  expect(changed).toHaveBeenCalledOnce();
  const state = api.documents().get("pages/home");
  expect(state?.version).toBe(4);
  expect([...(state?.touchedPaths ?? [])]).toEqual(["title"]);
  expect(visibleToast().textContent).toContain("Restored a revision of pages/home");
  expect(calls.filter((call) => call.route.startsWith("GET /api/content/revisions")).length).toBe(listings + 1);
});

test("Restore asks first; cancelling writes nothing and leaves the page and the draft alone", async () => {
  handlers["GET /api/content/revisions"] = () => ({
    json: { revisions: [revision(6, "publish", {}), revision(7, "publish", {})] },
  });
  handlers["POST /api/content/restore-revision"] = () => ({
    json: { document: wireDocument("pages/home", 4, { title: "Old title" }) },
  });
  const { api } = await mount();
  await editText("pages/home:title", "Mine");
  const changed = vi.fn();
  field("pages/home:title").addEventListener("cms:change", changed);
  const before = calls.length;
  const sheet = await openRevisions();
  const listings = calls.length;
  const restore = buttonNamed("Restore", sheet);
  restore.click();
  await settle();

  expect(sheet.textContent).toContain("The current draft of pages/home will be replaced.");
  expect(sheet.textContent).toContain("publish revision from");
  expect(document.activeElement).toBe(buttonNamed("Cancel", sheet));
  expect(calls).toHaveLength(listings);
  expect(calls.filter((call) => call.method === "POST" && calls.indexOf(call) >= before)).toEqual([]);

  buttonNamed("Cancel", sheet).click();
  await settle();
  expect(sheet.textContent).not.toContain("will be replaced");
  expect(document.activeElement).toBe(restore);
  expect(calls).toHaveLength(listings);
  expect(calls.some((call) => call.route === "POST /api/content/restore-revision")).toBe(false);
  expect(field("pages/home:title").textContent).toBe("Mine");
  expect(changed).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLElement>(".cms-toast")?.textContent).not.toContain("Restored");
  expect(api.documents().get("pages/home")?.version).toBe(4);
});

test("Esc or another document abandons the Restore prompt without writing", async () => {
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(7, "publish", {})] } });
  await mount();
  const sheet = await openRevisions();
  buttonNamed("Restore", sheet).click();
  pick(sheet, "artists/finn");
  await settle();
  expect(sheet.textContent).not.toContain("will be replaced");
  buttonNamed("Restore", sheet).click();
  press(document.body, "Escape");
  await settle();
  expect(sheet.hidden).toBe(true);
  expect(calls.some((call) => call.route === "POST /api/content/restore-revision")).toBe(false);
});

test("a Restore that fails after Confirm drops the prompt and leaves the fields alone", async () => {
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(7, "publish", {})] } });
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  handlers["POST /api/content/restore-revision"] = () => ({
    status: 500,
    json: { error: { code: "internal", message: "Boom" } },
  });
  await mount();
  const sheet = await openRevisions();
  buttonNamed("Restore", sheet).click();
  buttonNamed("Confirm", sheet).click();
  await settle();
  expect(visibleToast().textContent).toContain("Restore failed for pages/home: Boom");
  expect(sheet.textContent).not.toContain("will be replaced");
  expect(field("pages/home:title").textContent).toBe("Hello");
  expect(buttonNamed("Restore", sheet).disabled).toBe(false);
});

test("Restore waits for an in-flight field write and its next write carries the returned version", async () => {
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  handlers["POST /api/content/restore-revision"] = () => ({
    json: { document: wireDocument("pages/home", 20, { title: "Old" }) },
  });
  const { api } = await mount();
  const title = field("pages/home:title");
  title.click();
  title.textContent = "Late";
  press(title, "Enter");
  await api.restoreRevision("pages/home", 7);
  const routes = calls.map((call) => call.route).filter((route) => route.startsWith("POST"));
  expect(routes).toEqual(["POST /api/content/field", "POST /api/content/restore-revision"]);
  await editText("pages/home:lede", "After");
  expect(calls.at(-1)?.body?.expectedVersion).toBe(20);
});

test("a failed restore shows a toast, leaves the fields alone and does not stall later saves", async () => {
  handlers["GET /api/content/document"] = () => ({ json: { document: wireDocument("pages/home", 3, {}) } });
  handlers["POST /api/content/restore-revision"] = () => ({
    status: 409,
    json: { error: { code: "conflict", message: "Stale", current: wireDocument("pages/home", 9, {}) } },
  });
  const { api } = await mount();
  await expect(api.restoreRevision("pages/home", 7)).rejects.toThrow("Stale");
  expect(visibleToast().textContent).toContain("Restore did nothing: pages/home has changed");
  expect(field("pages/home:title").textContent).toBe("Hello");
  await editText("pages/home:title", "Still saves");
  expect(calls.at(-1)?.route).toBe("POST /api/content/field");
  expect(calls.at(-1)?.body?.expectedVersion).toBe(9);
});

function published(key: string, version: number, payload: unknown) {
  return { ...wireDocument(key, version, payload), publishedAt: "2026-01-01T00:00:00.000Z" };
}

const documentResponse = (document: WireDocument, publishedPayload: unknown): Handler => {
  return () => ({ json: { document, publishedPayload } });
};

const diffLines = (scope: ParentNode = document) =>
  [...scope.querySelectorAll(".cms-diff li")].map((line) => line.textContent);

test("the publish sheet lists the changes against the published payload, without reading revisions", async () => {
  handlers["GET /api/content/document"] = documentResponse(
    published("pages/home", 4, { title: "New", extra: "x", lede: "Same" }),
    { title: "Old", lede: "Same", gone: 1 },
  );
  await mount();
  await editText("pages/home:title", "New");
  buttonNamed("Publish").click();
  await settle();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet");
  expect(diffLines()).toEqual(['title "Old" → "New"', 'extra added "x"', "gone removed 1"]);
  expect(calls.some((call) => call.route.startsWith("GET /api/content/revisions"))).toBe(false);
  expect(calls.some((call) => call.route === "POST /api/content/publish")).toBe(false);
  buttonNamed("Publish", sheet ?? document).click();
  await settle();
  expect(calls.filter((call) => call.route === "POST /api/content/publish").map((call) => call.body)).toEqual([
    { key: "pages/home", expectedVersion: 4 },
  ]);
});

test("the publish sheet says when nothing is live when nothing is live, without reading revisions", async () => {
  handlers["GET /api/content/document"] = documentResponse(wireDocument("pages/home", 4, { title: "One" }), null);
  await mount();
  await editText("pages/home:title", "One");
  buttonNamed("Publish").click();
  await settle();
  expect(document.querySelector(".cms-diff")?.textContent).toBe(
    "Nothing is live: publishing puts this version on the site.",
  );
  expect(calls.some((call) => call.route.startsWith("GET /api/content/revisions"))).toBe(false);
});

test("a failed fetch says so for that document only, and Publish stays usable", async () => {
  handlers["GET /api/content/documents"] = () => ({
    json: {
      documents: {
        "pages/home": summary("pages/home", true, true),
        "artists/finn": summary("artists/finn", true, true),
      },
    },
  });
  handlers["GET /api/content/document"] = [
    () => ({ status: 500, json: { error: { code: "internal", message: "Boom" } } }),
    documentResponse(published("artists/finn", 4, { name: "Finnegan" }), { name: "Finn" }),
  ];
  await mount();
  await editText("pages/home:title", "One");
  await editText("artists/finn:name", "Finnegan");
  buttonNamed("Publish").click();
  await settle();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet") as HTMLElement;
  expect(sheet.querySelector('li[data-key="pages/home"] .cms-diff')?.textContent).toBe(
    "Couldn’t load the changes: Boom",
  );
  expect(diffLines(sheet.querySelector('li[data-key="artists/finn"]') as HTMLElement)).toEqual([
    'name "Finn" → "Finnegan"',
  ]);
  const confirm = buttonNamed("Publish", sheet);
  expect(confirm.disabled).toBe(false);
  confirm.click();
  await settle();
  // The failed fetch reviewed nothing, so that document goes out on the session's version.
  expect(calls.filter((call) => call.route === "POST /api/content/publish").map((call) => call.body)).toEqual([
    { key: "pages/home", expectedVersion: 4 },
    { key: "artists/finn", expectedVersion: 4 },
  ]);
});

test("the sheet fetches afresh on each opening, so another editor's change appears", async () => {
  addToggle("Off");
  handlers["GET /api/content/document"] = [
    documentResponse(published("pages/home", 4, { title: "Mine", live: false }), { title: "Old", live: false }),
    documentResponse(published("pages/home", 6, { title: "Theirs", live: true }), { title: "Older", live: false }),
  ];
  const { api } = await mount();
  await editText("pages/home:title", "Mine");
  const opener = buttonNamed("Publish");
  opener.click();
  await settle();
  expect(documentFetches()).toHaveLength(1);
  expect(diffLines()).toEqual(['title "Old" → "Mine"']);
  press(document.body, "Escape");
  opener.click();
  await settle();
  expect(documentFetches()).toHaveLength(2);
  expect(diffLines()).toEqual(['title "Older" → "Theirs"', "live false → true"]);

  // The session's copy moved on, so the next widget opens on it with no further fetch...
  const state = api.documents().get("pages/home");
  expect(state?.payload).toEqual({ title: "Theirs", live: true });
  press(document.body, "Escape");
  field("pages/home:live").click();
  await settle();
  expect(checkbox().checked).toBe(true);
  expect(documentFetches()).toHaveLength(2);

  // ...but its version did not, so our next write still conflicts with the change we have not seen on the page.
  expect(state?.version).toBe(4);
  press(checkbox(), "Escape");
  await editText("pages/home:lede", "After");
  expect(calls.at(-1)?.body?.expectedVersion).toBe(4);
});

test("the sheet waits for the document's queued writes before it reads", async () => {
  handlers["GET /api/content/document"] = documentResponse(published("pages/home", 4, { title: "Late" }), {
    title: "Old",
  });
  await mount();
  await editText("pages/home:lede", "First");
  const title = field("pages/home:title");
  title.click();
  title.textContent = "Late";
  press(title, "Enter");
  buttonNamed("Publish").click();
  await settle();
  const routes = calls.map((call) => call.route).filter((route) => !route.startsWith("GET /api/content/documents"));
  expect(routes.at(-2)).toBe("POST /api/content/field");
  expect(routes.at(-1)).toBe("GET /api/content/document?key=pages%2Fhome");
});

function sessionWith(documentForPublish: ContentClient["documentForPublish"]): Session {
  const client = {
    documentForPublish,
    document: () => Promise.reject(new Error("no second read expected")),
    documents: () => Promise.resolve({ "pages/home": summary("pages/home", true, true) }),
  } as unknown as ContentClient;
  const events = { stateChanged() {}, saved() {}, failed() {}, conflicted() {} };
  return new Session(client, events, "/api/content");
}

test("a failed fetch for the sheet leaves the session's cached document as it was", async () => {
  const session = sessionWith(() => Promise.reject(new Error("Boom")));
  await session.load(["pages/home"]);
  session.adopt(wireDocument("pages/home", 8, { title: "Cached" }));
  await expect(session.documentForPublish("pages/home")).rejects.toThrow("Boom");
  expect((await session.document("pages/home")).payload).toEqual({ title: "Cached" });
  expect(session.documents.get("pages/home")?.version).toBe(8);
});

test("Publish at sends at with an offset, shows the schedule, and Publish now publishes without at", async () => {
  handlers["POST /api/content/publish"] = (body) => ({
    json: {
      document: {
        ...wireDocument("pages/home", 9),
        isDraft: body?.at !== undefined,
        scheduledAt: (body?.at as string | undefined) ?? null,
      },
    },
  });
  const { api } = await mount({ scheduling: true });
  await editText("pages/home:title", "One");
  buttonNamed("Publish").click();
  await settle();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet") as HTMLElement;
  const input = sheet.querySelector<HTMLInputElement>("input[type=datetime-local]") as HTMLInputElement;
  input.value = "2030-06-01T09:30";
  input.dispatchEvent(new Event("input"));
  buttonNamed("Schedule", sheet).click();
  await settle();
  const schedule = calls.find((call) => call.route === "POST /api/content/publish");
  expect(schedule?.body?.at).toMatch(/^2030-06-01T09:30:00[+-]\d{2}:\d{2}$/);
  expect(new Date(String(schedule?.body?.at)).getTime()).toBe(new Date("2030-06-01T09:30").getTime());
  const line = document.querySelector<HTMLElement>(".cms-bar__scheduled") as HTMLElement;
  expect(line.textContent).toContain("pages/home scheduled for");
  expect(line.textContent).toContain(new Date("2030-06-01T09:30").toLocaleString());
  expect(visibleToast().textContent).toContain("Scheduled pages/home for");
  expect(api.documents().get("pages/home")?.touched).toBe(true);

  buttonNamed("Publish now", line).click();
  await settle();
  const publishes = calls.filter((call) => call.route === "POST /api/content/publish");
  expect(publishes[1]?.body).toEqual({ key: "pages/home", expectedVersion: 9 });
  expect(document.querySelector<HTMLElement>(".cms-bar__schedule")?.hidden).toBe(true);
  expect(api.documents().get("pages/home")?.touched).toBe(false);
});

test("without Publish at the sheet publishes now and the button still reads Publish", async () => {
  await mount({ scheduling: true });
  await editText("pages/home:title", "One");
  buttonNamed("Publish").click();
  await settle();
  const sheet = document.querySelector<HTMLElement>(".cms-sheet") as HTMLElement;
  const input = sheet.querySelector<HTMLInputElement>("input[type=datetime-local]") as HTMLInputElement;
  input.value = "2030-06-01T09:30";
  input.dispatchEvent(new Event("input"));
  input.value = "";
  input.dispatchEvent(new Event("input"));
  buttonNamed("Publish", sheet).click();
  await settle();
  expect(calls.find((call) => call.route === "POST /api/content/publish")?.body).toEqual({
    key: "pages/home",
    expectedVersion: 4,
  });
});

function summariesWithLive(): void {
  handlers["GET /api/content/documents"] = () => ({
    json: {
      documents: {
        "pages/home": { ...summary("pages/home", true, true), publishedAt: "2026-01-01T00:00:00.000Z" },
        "artists/finn": { ...summary("artists/finn", true, false), publishedAt: "2026-01-01T00:00:00.000Z" },
        "locked/doc": summary("locked/doc", false, false),
      },
    },
  });
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [] } });
}

test("Unpublish asks first, calls the client and refreshes the state", async () => {
  summariesWithLive();
  handlers["POST /api/content/unpublish"] = (body) => ({ json: { document: wireDocument(String(body?.key), 8) } });
  const { api } = await mount();
  const sheet = await openRevisions();
  buttonNamed("Unpublish", sheet).click();
  expect(sheet.textContent).toContain("Take pages/home off the live site?");
  expect(calls.some((call) => call.route === "POST /api/content/unpublish")).toBe(false);
  buttonNamed("Cancel", sheet).click();
  expect(sheet.textContent).not.toContain("off the live site");
  expect(calls.some((call) => call.route === "POST /api/content/unpublish")).toBe(false);

  buttonNamed("Unpublish", sheet).click();
  buttonNamed("Confirm", sheet).click();
  await settle();
  expect(calls.filter((call) => call.route === "POST /api/content/unpublish").map((call) => call.body)).toEqual([
    { key: "pages/home", expectedVersion: 3 },
  ]);
  const state = api.documents().get("pages/home");
  expect(state?.publishedAt).toBeNull();
  expect(state?.isDraft).toBe(true);
  expect(state?.version).toBe(8);
  expect(visibleToast().textContent).toContain("Unpublished pages/home");
  expect(() => buttonNamed("Unpublish", sheet)).toThrow();
});

test("Unpublish needs publish access and something live", async () => {
  summariesWithLive();
  await mount();
  const sheet = await openRevisions();
  expect(() => buttonNamed("Unpublish", sheet)).not.toThrow();
  pick(sheet, "artists/finn");
  await settle();
  expect(() => buttonNamed("Unpublish", sheet)).toThrow();
  pick(sheet, "locked/doc");
  await settle();
  expect(() => buttonNamed("Unpublish", sheet)).toThrow();
});

test("new labels come through strings overrides", async () => {
  summariesWithLive();
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(1, "publish", {})] } });
  handle = mountEditor({ strings: { restore: "Bring back", unpublish: "Take down" } });
  await handle.ready;
  const sheet = await openRevisions();
  expect(() => buttonNamed("Bring back", sheet)).not.toThrow();
  expect(() => buttonNamed("Take down", sheet)).not.toThrow();
});

test("discarding a never-published document detaches its fields and says so", async () => {
  handlers["POST /api/content/discard"] = () => ({ json: { document: null } });
  const { api } = await mount();
  await editText("artists/finn:name", "Finnegan");
  await api.discard("artists/finn");
  expect(api.documents().has("artists/finn")).toBe(false);
  const name = field("artists/finn:name");
  expect(name.classList.contains("cms-field")).toBe(false);
  expect(visibleToast().textContent).toContain("Discarded artists/finn. Nothing was live, so the document is gone.");
  expect(visibleToast().textContent).not.toContain("Reload");
  name.click();
  expect(name.hasAttribute("contenteditable")).toBe(false);
});

test("malformed remembered touched entries are dropped instead of breaking load", async () => {
  sessionStorage.setItem(
    "yl-editor:touched:/api/content",
    JSON.stringify({ "pages/home": 5, "artists/finn": ["name", 3], "locked/doc": ["x"] }),
  );
  handlers["GET /api/content/documents"] = () => ({
    json: {
      documents: {
        "pages/home": { ...summary("pages/home", true, true), isDraft: true },
        "artists/finn": { ...summary("artists/finn", true, false), isDraft: true },
      },
    },
  });
  const { api } = await mount();
  expect(api.documents().get("pages/home")?.touchedPaths.size).toBe(0);
  expect(api.documents().get("artists/finn")?.touchedPaths.size).toBe(0);
});

// A small fake of the server for the concurrency tests: it keeps one version per document and answers a stale
// `expectedVersion` the way the handlers do, so a test sees a real 409 rather than a scripted one.
interface FakeDocument {
  version: number;
  payload: unknown;
  publishedPayload: unknown;
  scheduledAt: string | null;
}

function serve(initial: Record<string, Partial<FakeDocument>>) {
  const stored = new Map<string, FakeDocument>(
    Object.entries(initial).map(([key, partial]) => [
      key,
      { version: 3, payload: {}, publishedPayload: null, scheduledAt: null, ...partial },
    ]),
  );
  const wire = (key: string): WireDocument => {
    const entry = stored.get(key) as FakeDocument;
    return {
      ...wireDocument(key, entry.version, entry.payload),
      publishedAt: entry.publishedPayload === null ? null : "2026-01-01T00:00:00.000Z",
      scheduledAt: entry.scheduledAt,
    };
  };
  /** Runs `write` when the version matches, as the store does; otherwise answers the 409 that carries `current`. */
  const guarded =
    (write: (entry: FakeDocument, body: Record<string, unknown>) => void): Handler =>
    (body) => {
      const key = String(body?.key);
      const entry = stored.get(key);
      if (!entry) return { status: 404, json: { error: { code: "not_found", message: `No document ${key}` } } };
      if (body?.expectedVersion !== undefined && body.expectedVersion !== entry.version) {
        return { status: 409, json: { error: { code: "conflict", message: "Stale", current: wire(key) } } };
      }
      write(entry, body as Record<string, unknown>);
      entry.version += 1;
      return { json: { document: wire(key) } };
    };
  handlers["GET /api/content/documents"] = () => ({
    json: {
      documents: Object.fromEntries(
        [...stored].map(([key, entry]) => [
          key,
          {
            ...summary(key, true, true, entry.version),
            publishedAt: entry.publishedPayload === null ? null : "2026-01-01T00:00:00.000Z",
          },
        ]),
      ),
    },
  });
  handlers["GET /api/content/document"] = (_body, url) => {
    const key = url.searchParams.get("key") ?? "";
    return { json: { document: wire(key), publishedPayload: stored.get(key)?.publishedPayload ?? null } };
  };
  handlers["GET /api/content/revisions"] = () => ({ json: { revisions: [revision(7, "publish", {})] } });
  handlers["POST /api/content/field"] = guarded((entry, body) => {
    entry.payload = { ...(entry.payload as object), [String(body.path)]: body.value };
  });
  handlers["POST /api/content/publish"] = guarded((entry, body) => {
    if (typeof body.at === "string") entry.scheduledAt = body.at;
    else {
      entry.publishedPayload = entry.payload;
      entry.scheduledAt = null;
    }
  });
  handlers["POST /api/content/unpublish"] = guarded((entry) => {
    entry.publishedPayload = null;
  });
  handlers["POST /api/content/restore-revision"] = guarded((entry) => {
    entry.payload = { ...(entry.payload as object), title: "Restored" };
  });
  handlers["POST /api/content/discard"] = guarded((entry) => {
    entry.payload = entry.publishedPayload;
  });
  return {
    stored,
    /** Another editor's write: the version moves and nothing on this page knows. */
    theirWrite(key: string, change: Record<string, unknown>) {
      const entry = stored.get(key) as FakeDocument;
      entry.payload = { ...(entry.payload as object), ...change };
      entry.version += 1;
    },
  };
}

/** Holds a route's answers until released. */
function hold(route: string) {
  const entry = handlers[route];
  const inner = (Array.isArray(entry) ? entry[0] : entry) as Handler;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  handlers[route] = async (body, url) => {
    await gate;
    return inner(body, url);
  };
  return { release: () => release() };
}

const posts = (route: string) => calls.filter((call) => call.route === `POST /api/content/${route}`);
const toastText = () => document.querySelector<HTMLElement>(".cms-toast")?.textContent ?? "";
const theSheet = () => document.querySelector<HTMLElement>(".cms-sheet") as HTMLElement;
const changesLine = () => document.querySelector<HTMLElement>(".cms-bar__changes");

function commitText(address: string, next: string): void {
  const target = field(address);
  target.click();
  target.textContent = next;
  press(target, "Enter");
}

async function openPublishSheet(): Promise<HTMLElement> {
  buttonNamed("Publish").click();
  await settle();
  return theSheet();
}

type Api = EditorHandle["api"];

describe("a save queued behind a lifecycle write", () => {
  const live = { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } };
  const actions: [string, string, (api: Api) => Promise<unknown>][] = [
    ["publish", "publish", (api) => api.publish("pages/home")],
    ["schedule", "publish", (api) => api.publish("pages/home", { at: "2030-01-01T00:00:00+00:00" })],
    ["discard", "discard", (api) => api.discard("pages/home")],
    ["unpublish", "unpublish", (api) => api.unpublish("pages/home")],
    ["restore", "restore-revision", (api) => api.restoreRevision("pages/home", 7)],
  ];

  test.each(actions)("%s: sends the new version and gets no conflict", async (_name, route, act) => {
    serve({ "pages/home": live });
    const { release } = hold(`POST /api/content/${route}`);
    const { api } = await mount();
    const action = act(api);
    await settle();
    commitText("pages/home:lede", "Typed meanwhile");
    await settle();
    expect(fieldWrites()).toEqual([]);
    release();
    await action;
    await settle();
    expect(fieldWrites()[0]?.body?.expectedVersion).toBe(4);
    expect(toastText()).not.toContain("Keep mine");
    expect(field("pages/home:lede").dataset.cmsState).toBe("saved");
    expect(field("pages/home:lede").textContent).toBe("Typed meanwhile");
    expect(api.documents().get("pages/home")?.version).toBe(5);
    expect(api.documents().get("pages/home")?.touchedPaths.has("lede")).toBe(true);
  });

  test("a discard that deletes the document: its state is gone before the queued save runs", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    handlers["POST /api/content/discard"] = () => ({ json: { document: null } });
    handlers["POST /api/content/field"] = () => ({
      status: 404,
      json: { error: { code: "not_found", message: "No document" } },
    });
    const { release } = hold("POST /api/content/discard");
    const { api } = await mount();
    const action = api.discard("pages/home");
    await settle();
    commitText("pages/home:lede", "Typed meanwhile");
    await settle();
    release();
    await action;
    await settle();
    // With no version there is nothing stale to conflict with: the server answers not_found, and that is what shows.
    expect(fieldWrites()[0]?.body?.expectedVersion).toBeUndefined();
    expect(toastText()).not.toContain("Keep mine");
    expect(toastText()).toContain("Not saved: No document");
    expect(api.documents().has("pages/home")).toBe(false);
  });
});

describe("publish sends the version the editor reviewed", () => {
  const home = { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } };

  test("per document: another editor's change that the sheet showed publishes, with its version", async () => {
    const server = serve({ "pages/home": home, "artists/finn": { version: 11, publishedPayload: {} } });
    await mount();
    await editText("pages/home:title", "Mine");
    await editText("artists/finn:name", "Finnegan");
    server.theirWrite("pages/home", { lede: "Theirs" });
    const sheet = await openPublishSheet();
    expect(diffLines(sheet.querySelector('li[data-key="pages/home"]') as HTMLElement)).toContain('lede added "Theirs"');
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish").map((call) => call.body)).toEqual([
      { key: "pages/home", expectedVersion: 5 },
      { key: "artists/finn", expectedVersion: 12 },
    ]);
    expect(sheet.hidden).toBe(true);
  });

  test("an own save still running at Confirm moves the reviewed version with it, so no false conflict", async () => {
    serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const { release } = hold("POST /api/content/field");
    commitText("pages/home:lede", "Two");
    await settle();
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")).toEqual([]);
    release();
    await settle();
    expect(posts("publish").map((call) => call.body)).toEqual([{ key: "pages/home", expectedVersion: 5 }]);
    expect(sheet.hidden).toBe(true);
    expect(toastText()).toContain("Published pages/home");
  });

  test("several own saves after the review all count", async () => {
    serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    await editText("pages/home:title", "Two");
    await editText("pages/home:lede", "Three");
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(6);
    expect(sheet.hidden).toBe(true);
  });

  test("a save that lands while the sheet's read is in flight causes no false conflict", async () => {
    serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    const read = hold("GET /api/content/document");
    buttonNamed("Publish").click();
    await settle();
    await editText("pages/home:lede", "Two");
    read.release();
    await settle();
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(5);
    expect(theSheet().hidden).toBe(true);
  });

  test("another editor's write after the review conflicts", async () => {
    const server = serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    server.theirWrite("pages/home", { lede: "Theirs" });
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")).toHaveLength(1);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual(home.publishedPayload);
    expect(sheet.hidden).toBe(false);
  });

  test("Keep mine past a third editor's write does not count as reviewing that write", async () => {
    const server = serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One"); // ours: version 4
    server.theirWrite("pages/home", { lede: "Seen in the sheet" }); // version 5
    const sheet = await openPublishSheet();
    expect(diffLines(sheet)).toContain('lede added "Seen in the sheet"');
    server.theirWrite("pages/home", { extra: "Never seen" }); // version 6
    commitText("pages/home:title", "Two");
    await settle();
    buttonNamed("Keep mine (overwrite)", visibleToast()).click(); // writes 6 -> 7
    await settle();
    expect(server.stored.get("pages/home")?.version).toBe(7);
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(5);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual(home.publishedPayload);
    expect(diffLines(sheet)).toContain('extra added "Never seen"');
  });

  test("Confirm before the diff has shown sends the session's version, not the one arriving later", async () => {
    const server = serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    server.theirWrite("pages/home", { lede: "Unseen" });
    const read = hold("GET /api/content/document");
    buttonNamed("Publish").click();
    await settle();
    const write = hold("POST /api/content/publish");
    buttonNamed("Publish", theSheet()).click();
    await settle();
    read.release();
    await settle();
    write.release();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(4);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual(home.publishedPayload);
  });

  test("a conflict doesn't publish: the sheet stays, says so, shows the updated diff, offers no overwrite", async () => {
    const server = serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    expect(diffLines(sheet)).toEqual(['title "Hello" → "One"']);
    server.theirWrite("pages/home", { lede: "Theirs" });
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(sheet.hidden).toBe(false);
    const item = sheet.querySelector('li[data-key="pages/home"]') as HTMLElement;
    expect(item.querySelector(".cms-error")?.textContent).toContain("changed since you reviewed it");
    expect(toastText()).toContain("changed since you reviewed it");
    expect(diffLines(item)).toEqual(['title "Hello" → "One"', 'lede added "Theirs"']);
    expect(() => buttonNamed("Keep mine (overwrite)")).toThrow();
    expect(posts("publish")).toHaveLength(1);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual(home.publishedPayload);

    const confirm = buttonNamed("Publish", sheet);
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await settle();
    expect(posts("publish")[1]?.body).toEqual({ key: "pages/home", expectedVersion: 5 });
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "One", lede: "Theirs" });
    expect(sheet.hidden).toBe(true);
  });

  test("Publish now sends the known version; a conflict opens the sheet on the updated diff", async () => {
    addToggle("x");
    const server = serve({ "pages/home": { ...home, scheduledAt: "2030-01-01T00:00:00+00:00" } });
    await mount();
    field("pages/home:live").click();
    await settle();
    press(checkbox(), "Escape");
    server.theirWrite("pages/home", { lede: "Theirs" });
    buttonNamed("Publish now").click();
    await settle();
    expect(posts("publish")[0]?.body).toEqual({ key: "pages/home", expectedVersion: 3 });
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual(home.publishedPayload);
    const sheet = theSheet();
    expect(sheet.hidden).toBe(false);
    expect(sheet.querySelector(".cms-error")?.textContent).toContain("changed since you reviewed it");
    expect(diffLines(sheet)).toEqual(['lede added "Theirs"']);
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[1]?.body).toEqual({ key: "pages/home", expectedVersion: 4 });
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello", lede: "Theirs" });
  });

  test("Publish now succeeds without a sheet when nothing changed", async () => {
    addToggle("x");
    const server = serve({ "pages/home": { ...home, scheduledAt: "2030-01-01T00:00:00+00:00" } });
    await mount();
    field("pages/home:live").click();
    await settle();
    press(checkbox(), "Escape");
    buttonNamed("Publish now").click();
    await settle();
    expect(theSheet().hidden).toBe(true);
    expect(server.stored.get("pages/home")?.scheduledAt).toBeNull();
    expect(toastText()).toContain("Published pages/home");
  });

  test("api.publish rejects on a conflict and the toast offers the review, not an overwrite", async () => {
    const server = serve({ "pages/home": home });
    const { api } = await mount();
    server.theirWrite("pages/home", { lede: "Theirs" });
    await expect(api.publish("pages/home")).rejects.toThrow("Stale");
    expect(posts("publish")[0]?.body).toEqual({ key: "pages/home", expectedVersion: 3 });
    expect(theSheet().hidden).toBe(true);
    buttonNamed("Review changes", visibleToast()).click();
    await settle();
    expect(diffLines(theSheet())).toEqual(['lede added "Theirs"']);
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello", lede: "Theirs" });
  });

  test("publishing a change the sheet showed repaints the page, which hadn't seen it", async () => {
    const server = serve({ "pages/home": home });
    await mount();
    await editText("pages/home:title", "One");
    server.theirWrite("pages/home", { lede: "Theirs" });
    buttonNamed("Publish", await openPublishSheet()).click();
    await settle();
    expect(field("pages/home:lede").textContent).toBe("Theirs");
  });
});

describe("Unpublish, Restore and Discard send the known version", () => {
  const live = { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } };
  const actions: [string, string, (api: Api) => Promise<unknown>][] = [
    ["Unpublish", "unpublish", (api) => api.unpublish("pages/home")],
    ["Restore", "restore-revision", (api) => api.restoreRevision("pages/home", 7)],
    ["Discard", "discard", (api) => api.discard("pages/home")],
  ];

  test.each(actions)("%s sends it, and writes once", async (_name, route, act) => {
    serve({ "pages/home": live });
    const { api } = await mount();
    await editText("pages/home:lede", "Mine");
    await act(api);
    expect(posts(route)).toHaveLength(1);
    expect(posts(route)[0]?.body?.expectedVersion).toBe(4);
  });

  test.each(actions)(
    "%s on a conflict: says the document changed and refreshes its state",
    async (name, route, act) => {
      const server = serve({ "pages/home": live });
      const { api } = await mount();
      server.theirWrite("pages/home", { lede: "Theirs" });
      const before = server.stored.get("pages/home")?.payload;
      await expect(act(api)).rejects.toThrow("Stale");
      expect(visibleToast().textContent).toContain(`${name} did nothing: pages/home has changed`);
      expect(posts(route)).toHaveLength(1);
      expect(server.stored.get("pages/home")?.payload).toEqual(before);
      expect(server.stored.get("pages/home")?.version).toBe(4);
      const state = api.documents().get("pages/home");
      expect(state?.version).toBe(4);
      expect(state?.payload).toEqual({ title: "Hello", lede: "Theirs" });
      expect(state?.touched).toBe(false);
      expect(field("pages/home:lede").textContent).toBe("Theirs");
      // The retry now goes through, because the session has the version the page shows.
      await act(api);
      expect(posts(route)[1]?.body?.expectedVersion).toBe(4);
    },
  );

  test("a conflict refresh doesn't close a widget the editor is typing in", async () => {
    const server = serve({ "pages/home": live });
    const { api } = await mount();
    const lede = field("pages/home:lede");
    lede.click();
    lede.textContent = "Typing";
    server.theirWrite("pages/home", { lede: "Theirs" });
    await expect(api.unpublish("pages/home")).rejects.toThrow("Stale");
    expect(lede.getAttribute("contenteditable")).not.toBeNull();
    expect(lede.textContent).toBe("Typing");
  });
});

describe("a bulk publish with a failure", () => {
  const two = () =>
    serve({
      "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } },
      "artists/finn": { publishedPayload: { name: "Finn" }, payload: { name: "Finn" } },
    });
  async function bothEdited() {
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    return openPublishSheet();
  }

  test("a failing first document doesn't stop the second, and each is reported as what happened", async () => {
    const server = two();
    const real = handlers["POST /api/content/publish"] as Handler;
    handlers["POST /api/content/publish"] = (body, url) =>
      body?.key === "pages/home"
        ? { status: 422, json: { error: { code: "validation", message: "Title too long" } } }
        : real(body, url);
    await mount();
    const sheet = await bothEdited();
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(server.stored.get("artists/finn")?.publishedPayload).toEqual({ name: "Two" });
    expect(sheet.hidden).toBe(false);
    expect([...sheet.querySelectorAll("li[data-key]")].map((item) => item.getAttribute("data-key"))).toEqual([
      "pages/home",
    ]);
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-error')?.textContent).toContain("Title too long");
    expect(visibleToast().textContent).toContain("1 of 2");
    expect(visibleToast().textContent).toContain("pages/home");
    expect(visibleToast().dataset.kind).toBe("error");
    expect(buttonNamed("Publish", sheet).disabled).toBe(false);
  });

  test("a failing last document is not hidden by the earlier success, and retrying sends only it", async () => {
    const server = two();
    const real = handlers["POST /api/content/publish"] as Handler;
    handlers["POST /api/content/publish"] = [
      real,
      () => ({ status: 500, json: { error: { code: "internal", message: "Boom" } } }),
      real,
    ];
    await mount();
    const sheet = await bothEdited();
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(visibleToast().textContent).toContain("1 of 2");
    expect(handle?.api.documents().get("pages/home")?.touched).toBe(false);
    expect(handle?.api.documents().get("artists/finn")?.touched).toBe(true);
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish").map((call) => call.body?.key)).toEqual(["pages/home", "artists/finn", "artists/finn"]);
    expect(server.stored.get("artists/finn")?.publishedPayload).toEqual({ name: "Two" });
    expect(sheet.hidden).toBe(true);
  });

  test("a conflict on one refreshes only that document's diff; the other still publishes", async () => {
    const server = two();
    await mount();
    const sheet = await bothEdited();
    server.theirWrite("pages/home", { lede: "Theirs" });
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(server.stored.get("artists/finn")?.publishedPayload).toEqual({ name: "Two" });
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello" });
    expect(diffLines(sheet)).toEqual(['title "Hello" → "One"', 'lede added "Theirs"']);
    expect(visibleToast().textContent).toContain("1 of 2");
  });

  test("everything publishing says so for all of them, not just the last", async () => {
    two();
    await mount();
    const sheet = await bothEdited();
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(sheet.hidden).toBe(true);
    expect(visibleToast().textContent).toContain("2 documents");
    expect(visibleToast().dataset.kind).toBe("saved");
  });

  test("a bulk discard behaves the same way", async () => {
    const server = two();
    const real = handlers["POST /api/content/discard"] as Handler;
    handlers["POST /api/content/discard"] = (body, url) =>
      body?.key === "pages/home"
        ? { status: 500, json: { error: { code: "internal", message: "Boom" } } }
        : real(body, url);
    await mount();
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    buttonNamed("Discard").click();
    await settle();
    const sheet = theSheet();
    buttonNamed("Discard", sheet).click();
    await settle();
    expect(server.stored.get("artists/finn")?.payload).toEqual({ name: "Finn" });
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-error')?.textContent).toContain("Boom");
    expect(visibleToast().textContent).toContain("1 of 2");
  });
});

describe("reopening a field whose save failed", () => {
  const failOnce = () => {
    handlers["POST /api/content/field"] = [serverError, handlers["POST /api/content/field"] as Handler];
  };

  test.each(["blur", "Enter"])("text left by %s resends the failed value", async (exit) => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    failOnce();
    await mount();
    await editText("pages/home:title", "Again");
    const title = field("pages/home:title");
    expect(title.dataset.cmsState).toBe("failed");
    title.click();
    if (exit === "blur") title.dispatchEvent(new FocusEvent("blur"));
    else press(title, "Enter");
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual(["Again", "Again"]);
    expect(title.dataset.cmsState).toBe("saved");
  });

  test("text left with Esc doesn't resend", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    failOnce();
    await mount();
    await editText("pages/home:title", "Again");
    const title = field("pages/home:title");
    title.click();
    press(title, "Escape");
    await settle();
    expect(fieldWrites()).toHaveLength(1);
    expect(title.dataset.cmsState).toBe("failed");
  });

  test("text changed back to the stored value is sent, so the failed value doesn't linger", async () => {
    addToggle("x");
    serve({ "pages/home": { payload: { title: "Hello", live: true } } });
    failOnce();
    await mount();
    field("pages/home:live").click();
    await settle();
    press(checkbox(), "Escape");
    await editText("pages/home:title", "Again");
    await editText("pages/home:title", "Hello");
    expect(fieldWrites().at(-1)?.body?.value).toBe("Hello");
    expect(field("pages/home:title").dataset.cmsState).toBe("saved");
  });

  test("once it has saved, reopening and leaving writes nothing", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    failOnce();
    await mount();
    await editText("pages/home:title", "Again");
    const title = field("pages/home:title");
    title.click();
    press(title, "Enter");
    await settle();
    title.click();
    press(title, "Enter");
    await settle();
    expect(fieldWrites()).toHaveLength(2);
  });

  test("a popover starts from the failed value and leaving it resends", async () => {
    addEditValueField("spaces", "number");
    serve({ "pages/home": { payload: { spaces: 1 } } });
    await mount();
    const spaces = field("pages/home:spaces");
    spaces.click();
    await settle();
    failOnce();
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "2";
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(spaces.dataset.cmsState).toBe("failed");
    spaces.click();
    await settle();
    expect(popoverControl<HTMLInputElement>("input").value).toBe("2");
    field("pages/home:title").click();
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual([2, 2]);
    expect(spaces.dataset.cmsState).toBe("saved");
  });

  test("a popover left with Esc doesn't resend", async () => {
    addEditValueField("spaces", "number");
    serve({ "pages/home": { payload: { spaces: 1 } } });
    await mount();
    const spaces = field("pages/home:spaces");
    spaces.click();
    await settle();
    failOnce();
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "2";
    input.dispatchEvent(new Event("change"));
    await settle();
    spaces.click();
    await settle();
    press(popoverControl<HTMLInputElement>("input"), "Escape");
    await settle();
    expect(fieldWrites()).toHaveLength(1);
  });

  test("a host widget receives the failed value, and committing it unchanged resends", async () => {
    const { seen, widget } = richWidget();
    serve({ "pages/home": { payload: { lede: "Stored" } } });
    failOnce();
    handle = mountEditor({ widgets: { richtext: widget } });
    await handle.ready;
    field("pages/home:lede").click();
    await seen[0]?.commit("<p>Mine</p>");
    await settle();
    field("pages/home:lede").click();
    expect(seen[1]?.value).toBe("<p>Mine</p>");
    await seen[1]?.commit("<p>Mine</p>");
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual(["<p>Mine</p>", "<p>Mine</p>"]);
    // Saved now: the same commit from a truly untouched widget writes nothing.
    field("pages/home:lede").click();
    await seen[2]?.commit("<p>Mine</p>");
    await settle();
    expect(fieldWrites()).toHaveLength(2);
  });

  test.each([
    ["discard", (api: Api) => api.discard("pages/home")],
    ["restore", (api: Api) => api.restoreRevision("pages/home", 7)],
  ])("%s drops the failed value: it isn't resent on the next open", async (_name, act) => {
    serve({ "pages/home": { payload: { title: "Hello" }, publishedPayload: { title: "Hello" } } });
    failOnce();
    const { api } = await mount();
    await editText("pages/home:title", "Again");
    await act(api);
    const title = field("pages/home:title");
    expect(title.dataset.cmsState).toBe("idle");
    title.click();
    press(title, "Enter");
    await settle();
    expect(fieldWrites()).toHaveLength(1);
  });
});

describe("unpublish and restore leave something to publish", () => {
  const live = { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } };

  test("unpublish on an unedited page, then Publish from the sheet, goes live", async () => {
    const server = serve({ "pages/home": live });
    const { api } = await mount();
    expect(changesLine()?.textContent).toMatch(/^No changes yet/);
    await api.unpublish("pages/home");
    expect(server.stored.get("pages/home")?.publishedPayload).toBeNull();
    expect(changesLine()?.textContent).toMatch(/^1 change on this page/);
    const sheet = await openPublishSheet();
    const item = sheet.querySelector('li[data-key="pages/home"]') as HTMLElement;
    expect(item.textContent).not.toContain("· 0");
    expect(item.querySelector(".cms-diff")?.textContent).toBe(
      "Nothing is live: publishing puts this version on the site.",
    );
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello" });
    expect(api.documents().get("pages/home")?.touched).toBe(false);
    expect(changesLine()?.textContent).toMatch(/^No changes yet/);
  });

  test("a restore whose payload equals the draft stays in the publish sheet", async () => {
    serve({ "pages/home": { publishedPayload: { title: "Old" }, payload: { title: "Restored" } } });
    const { api } = await mount();
    await api.restoreRevision("pages/home", 7);
    expect(api.documents().get("pages/home")?.touched).toBe(true);
    expect(api.documents().get("pages/home")?.touchedPaths.size).toBe(0);
    expect(changesLine()?.textContent).toMatch(/^1 change on this page/);
    const sheet = await openPublishSheet();
    expect(sheet.querySelector('li[data-key="pages/home"]')).not.toBeNull();
    expect(diffLines(sheet)).toEqual(['title "Old" → "Restored"']);
  });

  test("a change with no paths survives a reload", async () => {
    const server = serve({ "pages/home": live });
    const editor = await mount();
    await editor.api.unpublish("pages/home");
    editor.destroy();
    handle = undefined;
    const documents = handlers["GET /api/content/documents"] as Handler;
    handlers["GET /api/content/documents"] = async (body, url) => {
      const answer = await documents(body, url);
      const summaries = (answer.json as { documents: Record<string, { isDraft: boolean }> }).documents;
      for (const entry of Object.values(summaries)) entry.isDraft = true;
      return answer;
    };
    expect(server.stored.get("pages/home")?.publishedPayload).toBeNull();
    const { api } = await mount();
    expect(api.documents().get("pages/home")?.touched).toBe(true);
    expect(changesLine()?.textContent).toMatch(/^1 change on this page/);
  });

  test("a change with no paths counts as one beside other documents' fields", async () => {
    serve({ "pages/home": live, "artists/finn": { publishedPayload: {} } });
    const { api } = await mount();
    await api.unpublish("pages/home");
    await editText("artists/finn:name", "Two");
    expect(changesLine()?.textContent).toMatch(/^2 changes across 2 documents/);
    expect(changesLine()?.dataset.fields).toBe("2");
  });
});

describe("a popover opened while a save is on its way", () => {
  function setValue(value: string): void {
    const input = popoverControl<HTMLInputElement>("input");
    input.value = value;
    input.dispatchEvent(new Event("change"));
  }

  async function opened(): Promise<HTMLElement> {
    addEditValueField("n", "number");
    serve({ "pages/home": { payload: { n: 1 } } });
    await mount();
    const target = field("pages/home:n");
    target.click();
    await settle();
    return target;
  }

  test("in flight: it shows the committed value, and a revert is saved after it", async () => {
    const target = await opened();
    const { release } = hold("POST /api/content/field");
    setValue("2");
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual([2]);
    target.click();
    await settle();
    expect(popoverControl<HTMLInputElement>("input").value).toBe("2");
    setValue("1");
    await settle();
    release();
    await settle();
    expect(fieldWrites().map((call) => [call.body?.value, call.body?.expectedVersion])).toEqual([
      [2, 3],
      [1, 4],
    ]);
    expect(toastText()).not.toContain("Keep mine");
  });

  test("queued: it shows the committed value, and a revert replaces it", async () => {
    const target = await opened();
    press(popoverControl("input"), "Escape");
    const { release } = hold("POST /api/content/field");
    commitText("pages/home:title", "Ahead");
    await settle();
    target.click();
    await settle();
    setValue("2");
    await settle();
    target.click();
    await settle();
    expect(popoverControl<HTMLInputElement>("input").value).toBe("2");
    setValue("1");
    await settle();
    release();
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual(["Ahead", 1]);
    expect(handle?.api.documents().get("pages/home")?.payload).toMatchObject({ n: 1 });
  });

  test.each(["in flight", "queued"])("%s: leaving it untouched lets the committed value land", async (when) => {
    const target = await opened();
    const { release } = hold("POST /api/content/field");
    if (when === "queued") {
      press(popoverControl("input"), "Escape");
      commitText("pages/home:title", "Ahead");
      await settle();
      target.click();
      await settle();
    }
    setValue("2");
    await settle();
    target.click();
    await settle();
    field("pages/home:lede").click();
    await settle();
    release();
    await settle();
    expect(fieldWrites().at(-1)?.body?.value).toBe(2);
    expect(fieldWrites().filter((call) => call.body?.path === "n")).toHaveLength(1);
  });

  test("a text field reverted while its save is in flight is saved too", async () => {
    addToggle("x");
    serve({ "pages/home": { payload: { title: "Hello", live: true } } });
    await mount();
    field("pages/home:live").click();
    await settle();
    press(checkbox(), "Escape");
    const { release } = hold("POST /api/content/field");
    commitText("pages/home:title", "Changed");
    await settle();
    commitText("pages/home:title", "Hello");
    await settle();
    release();
    await settle();
    expect(fieldWrites().map((call) => call.body?.value)).toEqual(["Changed", "Hello"]);
  });
});

describe("a popover waiting on its fetch", () => {
  async function waiting(extra: EditorOptions = {}) {
    addToggle("x");
    serve({ "pages/home": { payload: { live: true }, publishedPayload: { live: true } } });
    const { release } = hold("GET /api/content/document");
    const editor = await mount(extra);
    field("pages/home:live").click();
    await settle();
    return { editor, release };
  }

  async function expectNoPopover(release: () => void): Promise<void> {
    release();
    await settle();
    expect(document.querySelector(".cms-popover")).toBeNull();
    expect(field("pages/home:live").classList.contains("cms-field--editing")).toBe(false);
  }

  test("still opens when nothing else happens", async () => {
    const { release } = await waiting();
    release();
    await settle();
    expect(document.querySelector(".cms-popover")).not.toBeNull();
  });

  test.each(["Publish", "Discard", "Revisions"])("is cancelled by opening the %s sheet", async (label) => {
    const { release } = await waiting();
    buttonNamed(label).click();
    await expectNoPopover(release);
    expect(theSheet().hidden).toBe(false);
  });

  test("is cancelled by opening a host panel", async () => {
    const { release } = await waiting({
      panels: [{ id: "notes", label: "Notes", mount: () => ({ destroy() {} }) }],
    });
    buttonNamed("Notes").click();
    await expectNoPopover(release);
  });

  test.each([
    ["publish", (api: Api) => api.publish("pages/home")],
    ["discard", (api: Api) => api.discard("pages/home")],
    ["unpublish", (api: Api) => api.unpublish("pages/home")],
    ["restore", (api: Api) => api.restoreRevision("pages/home", 7)],
  ])("is cancelled by starting %s", async (_name, act) => {
    const { editor, release } = await waiting();
    const action = act(editor.api).catch(() => undefined);
    await expectNoPopover(release);
    await action;
    await settle();
    expect(document.querySelector(".cms-popover")).toBeNull();
  });

  test("doesn't mount on a document deleted during the wait", async () => {
    addToggle("x");
    serve({ "pages/home": { payload: { live: true } } });
    handlers["POST /api/content/discard"] = () => ({ json: { document: null } });
    const discard = hold("POST /api/content/discard");
    const read = hold("GET /api/content/document");
    const { api } = await mount();
    const discarding = api.discard("pages/home");
    await settle();
    field("pages/home:live").click();
    await settle();
    discard.release();
    await discarding;
    await settle();
    read.release();
    await settle();
    expect(document.querySelector(".cms-popover")).toBeNull();
    expect(field("pages/home:live").classList.contains("cms-field--editing")).toBe(false);
  });
});

test("opening a sheet commits an open popover first, so the sheet's diff includes it", async () => {
  addEditValueField("spaces", "number");
  serve({ "pages/home": { payload: { spaces: 1 }, publishedPayload: { spaces: 1 } } });
  await mount();
  await editText("pages/home:title", "One");
  field("pages/home:spaces").click();
  await settle();
  popoverControl<HTMLInputElement>("input").value = "2";
  buttonNamed("Publish").click();
  await settle();
  expect(document.querySelector(".cms-popover")).toBeNull();
  expect(fieldWrites().at(-1)?.body).toMatchObject({ path: "spaces", value: 2 });
  expect(diffLines(theSheet())).toContain("spaces 1 → 2");
});

describe("scheduling", () => {
  const dateInput = (sheet: HTMLElement) => sheet.querySelector<HTMLInputElement>("input[type=datetime-local]");
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  test("is off by default: no Publish at input, and Confirm publishes", async () => {
    await mount();
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    expect(dateInput(sheet)).toBeNull();
    expect(sheet.textContent).not.toContain("Publish at");
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.at).toBeUndefined();
  });

  test("off: a schedule already on the document still shows in the bar with Publish now", async () => {
    addToggle("x");
    serve({ "pages/home": { payload: { live: true }, scheduledAt: "2030-01-01T00:00:00+00:00" } });
    await mount();
    field("pages/home:live").click();
    await settle();
    const line = document.querySelector<HTMLElement>(".cms-bar__scheduled") as HTMLElement;
    expect(line.textContent).toContain("pages/home scheduled for");
    expect(() => buttonNamed("Publish now", line)).not.toThrow();
  });

  test("off: api.publish with at still schedules, for host panels", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    const { api } = await mount();
    await api.publish("pages/home", { at: "2030-01-01T00:00:00+00:00" });
    expect(posts("publish")[0]?.body).toEqual({
      key: "pages/home",
      at: "2030-01-01T00:00:00+00:00",
      expectedVersion: 3,
    });
    expect(document.querySelector(".cms-bar__scheduled")?.textContent).toContain("pages/home scheduled for");
  });

  test("on: the input has a min of now and a future time schedules", async () => {
    vi.useFakeTimers({ now: new Date(2030, 5, 1, 9, 30), toFake: ["Date"] });
    serve({ "pages/home": { payload: { title: "Hello" } } });
    await mount({ scheduling: true });
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const input = dateInput(sheet) as HTMLInputElement;
    expect(input.min).toBe("2030-06-01T09:30");
    type(input, "2030-06-01T09:31");
    const confirm = buttonNamed("Schedule", sheet);
    expect(confirm.disabled).toBe(false);
    expect(sheet.querySelector(".cms-error")).toBeNull();
    confirm.click();
    await settle();
    expect(String(posts("publish")[0]?.body?.at)).toMatch(/^2030-06-01T09:31:00/);
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(4);
  });

  test("on: a past time disables the button and says why, and clearing it recovers", async () => {
    vi.useFakeTimers({ now: new Date(2030, 5, 1, 9, 30), toFake: ["Date"] });
    serve({ "pages/home": { payload: { title: "Hello" } } });
    await mount({ scheduling: true });
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const input = dateInput(sheet) as HTMLInputElement;
    type(input, "2030-06-01T09:00");
    expect(buttonNamed("Schedule", sheet).disabled).toBe(true);
    const reason = sheet.querySelector(".cms-error");
    expect(reason?.textContent).toContain("in the past");
    expect(input.getAttribute("aria-describedby")).toBe(reason?.parentElement?.id);
    type(input, "");
    expect(buttonNamed("Publish", sheet).disabled).toBe(false);
    expect(sheet.querySelector(".cms-error")).toBeNull();
  });

  test("on: a time the clock passes while the sheet is open is refused at Confirm", async () => {
    vi.useFakeTimers({ now: new Date(2030, 5, 1, 9, 30), toFake: ["Date"] });
    serve({ "pages/home": { payload: { title: "Hello" } } });
    await mount({ scheduling: true });
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const input = dateInput(sheet) as HTMLInputElement;
    type(input, "2030-06-01T09:45");
    const confirm = buttonNamed("Schedule", sheet);
    expect(confirm.disabled).toBe(false);
    vi.setSystemTime(new Date(2030, 5, 1, 10, 0));
    confirm.click();
    await settle();
    expect(posts("publish")).toEqual([]);
    expect(sheet.hidden).toBe(false);
    expect(confirm.disabled).toBe(true);
    expect(sheet.querySelector(".cms-error")?.textContent).toContain("in the past");
  });
});

describe("a document whose draft fails its schema", () => {
  const invalid = () => ({
    status: 422,
    json: { error: { code: "validation", message: "Draft is invalid", issues: [{ path: "title" }] } },
  });

  function invalidHome() {
    const server = serve({ "pages/home": { payload: { title: 42 }, publishedPayload: { title: "Live" } } });
    handlers["GET /api/content/document"] = invalid;
    return server;
  }

  test("the page and the bar load, and the fields are editable", async () => {
    invalidHome();
    const { api } = await mount();
    expect(api.documents().get("pages/home")?.access.edit).toBe(true);
    expect(field("pages/home:title").classList.contains("cms-field--locked")).toBe(false);
    expect(changesLine()?.textContent).toMatch(/^No changes yet/);
  });

  test("the revisions drawer opens and lists", async () => {
    invalidHome();
    await mount();
    const sheet = await openRevisions();
    expect(sheet.querySelector("li[data-revision]")).not.toBeNull();
    expect(sheet.querySelector(".cms-error")).toBeNull();
  });

  test("Restore works from the drawer and repaints", async () => {
    invalidHome();
    const { api } = await mount();
    const sheet = await openRevisions();
    buttonNamed("Restore", sheet).click();
    buttonNamed("Confirm", sheet).click();
    await settle();
    expect(posts("restore-revision")[0]?.body?.expectedVersion).toBe(3);
    expect(field("pages/home:title").textContent).toBe("Restored");
    expect(api.documents().get("pages/home")?.version).toBe(4);
    expect(visibleToast().textContent).toContain("Restored a revision of pages/home");
    expect(buttonNamed("Publish").disabled).toBe(false);
    expect(api.documents().get("pages/home")?.touched).toBe(true);
  });

  test("Discard works and repaints from the document it returns", async () => {
    invalidHome();
    const { api } = await mount();
    await api.discard("pages/home");
    expect(field("pages/home:title").textContent).toBe("Live");
    expect(api.documents().get("pages/home")?.version).toBe(4);
  });

  test.each([
    ["a string", "not an object"],
    ["null", null],
    ["a number", 7],
    ["an array", [1, 2]],
    ["a wrong shape", { title: { nested: true }, lede: ["a"] }],
  ])("a lifecycle response carrying %s as its payload doesn't throw", async (_name, payload) => {
    serve({ "pages/home": { publishedPayload: { title: "Live" } } });
    for (const route of ["restore-revision", "unpublish", "discard", "publish"]) {
      handlers[`POST /api/content/${route}`] = (body) => ({
        json: { document: wireDocument(String(body?.key), Number(body?.expectedVersion) + 1, payload) },
      });
    }
    const { api } = await mount();
    await api.restoreRevision("pages/home", 7);
    expect(api.documents().get("pages/home")?.payload).toEqual(payload);
    await api.unpublish("pages/home");
    await api.publish("pages/home", { at: "2030-01-01T00:00:00+00:00" });
    await api.publish("pages/home");
    await api.discard("pages/home");
    expect(api.documents().get("pages/home")?.version).toBe(8);
    expect(() => field("pages/home:title").click()).not.toThrow();
    expect(field("pages/home:title").getAttribute("contenteditable")).not.toBeNull();
  });

  test("a conflict carrying an invalid payload refreshes without throwing", async () => {
    serve({ "pages/home": {} });
    handlers["POST /api/content/discard"] = () => ({
      status: 409,
      json: { error: { code: "conflict", message: "Stale", current: wireDocument("pages/home", 9, "garbage") } },
    });
    const { api } = await mount();
    await expect(api.discard("pages/home")).rejects.toThrow("Stale");
    expect(api.documents().get("pages/home")?.version).toBe(9);
    expect(visibleToast().textContent).toContain("Discard did nothing");
  });

  test("the publish sheet says could-not-load for that document only, and Publish answers the validation error", async () => {
    const server = serve({
      "pages/home": { payload: { title: 42 }, publishedPayload: { title: "Live" } },
      "artists/finn": { payload: { name: "Finn" }, publishedPayload: { name: "Finn" } },
    });
    const read = handlers["GET /api/content/document"] as Handler;
    handlers["GET /api/content/document"] = (body, url) =>
      url.searchParams.get("key") === "pages/home" ? invalid() : read(body, url);
    const write = handlers["POST /api/content/publish"] as Handler;
    handlers["POST /api/content/publish"] = (body, url) => (body?.key === "pages/home" ? invalid() : write(body, url));
    const { api } = await mount();
    await editText("pages/home:lede", "Still bad");
    await editText("artists/finn:name", "Finnegan");
    const sheet = await openPublishSheet();
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-diff')?.textContent).toBe(
      "Couldn’t load the changes: Draft is invalid",
    );
    expect(diffLines(sheet.querySelector('li[data-key="artists/finn"]') as HTMLElement)).toEqual([
      'name "Finn" → "Finnegan"',
    ]);
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish").map((call) => call.body?.key)).toEqual(["pages/home", "artists/finn"]);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Live" });
    expect(server.stored.get("artists/finn")?.publishedPayload).toEqual({ name: "Finnegan" });
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-error')?.textContent).toContain("Draft is invalid");
    expect(api.documents().get("pages/home")?.touched).toBe(true);
    expect(visibleToast().textContent).toContain("1 of 2");
  });

  test("Publish of it alone says the validation error, without a crash", async () => {
    invalidHome();
    handlers["POST /api/content/publish"] = invalid;
    const { api } = await mount();
    await expect(api.publish("pages/home")).rejects.toThrow("Draft is invalid");
    expect(visibleToast().textContent).toContain("Publish failed for pages/home: Draft is invalid");
  });

  test("a popover on it says it couldn't load, and opens once a restore has repaired the document", async () => {
    invalidHome();
    addEditValueField("thing", "number");
    const { api } = await mount();
    field("pages/home:thing").click();
    await settle();
    expect(visibleToast().textContent).toContain("Couldn’t load this field: Draft is invalid");
    await api.restoreRevision("pages/home", 7);
    field("pages/home:thing").click();
    await settle();
    expect(document.querySelector(".cms-popover")).not.toBeNull();
  });
});

/** Answers a route only when told to, one gate per request, with what the server held when the request arrived. */
function gateAnswers(route: string) {
  const inner = handlers[route] as Handler;
  const gates: (() => void)[] = [];
  handlers[route] = async (body, url) => {
    const answer = await inner(body, url);
    await new Promise<void>((resolve) => gates.push(resolve));
    return answer;
  };
  return gates;
}

describe("a bulk run in progress", () => {
  const dateInput = () => theSheet().querySelector<HTMLInputElement>("input[type=datetime-local]") as HTMLInputElement;

  test("the schedule input is disabled, and an input event can't re-enable Confirm or submit twice", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    await mount({ scheduling: true });
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const write = hold("POST /api/content/publish");
    const confirm = buttonNamed("Publish", sheet);
    confirm.click();
    await settle();
    expect(dateInput().disabled).toBe(true);
    expect(document.activeElement).toBe(buttonNamed("Cancel", sheet));
    dateInput().dispatchEvent(new Event("input"));
    dateInput().dispatchEvent(new Event("change"));
    expect(confirm.disabled).toBe(true);
    confirm.click();
    await settle();
    write.release();
    await settle();
    expect(posts("publish")).toHaveLength(1);
    expect(sheet.hidden).toBe(true);
  });

  test("a failed run gives the schedule input and Confirm back", async () => {
    serve({ "pages/home": { payload: { title: "Hello" } } });
    handlers["POST /api/content/publish"] = () => ({
      status: 500,
      json: { error: { code: "internal", message: "Boom" } },
    });
    await mount({ scheduling: true });
    await editText("pages/home:title", "One");
    const sheet = await openPublishSheet();
    const confirm = buttonNamed("Publish", sheet);
    confirm.click();
    await settle();
    expect(sheet.querySelector(".cms-error")?.textContent).toContain("Boom");
    expect(dateInput().disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
  });
});

describe("cancelling a bulk run", () => {
  const two = () =>
    serve({
      "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } },
      "artists/finn": { publishedPayload: { name: "Finn" }, payload: { name: "Finn" } },
    });
  const leave: [string, () => void][] = [
    ["Cancel", () => buttonNamed("Cancel", theSheet()).click()],
    ["Close", () => buttonNamed("Close", theSheet()).click()],
    ["Esc", () => press(document.body, "Escape")],
  ];

  test.each(leave)("%s lets the one in flight finish and starts no other", async (_name, stop) => {
    const server = two();
    await mount();
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    const sheet = await openPublishSheet();
    const write = hold("POST /api/content/publish");
    buttonNamed("Publish", sheet).click();
    await settle();
    stop();
    expect(sheet.hidden).toBe(true);
    write.release();
    await settle();
    expect(posts("publish").map((call) => call.body?.key)).toEqual(["pages/home"]);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "One" });
    expect(server.stored.get("artists/finn")?.publishedPayload).toEqual({ name: "Finn" });
    expect(handle?.api.documents().get("artists/finn")?.touched).toBe(true);
    const toast = visibleToast();
    expect(toast.textContent).toContain("1 of 2 done");
    expect(toast.textContent).toContain("artists/finn");
    expect(toast.dataset.kind).toBe("info");
    // It names what didn't go out, so it stays until dismissed.
    buttonNamed("Close", toast).click();
    expect(toast.hidden).toBe(true);
  });

  test("a bulk discard stops the same way", async () => {
    const server = two();
    await mount();
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    buttonNamed("Discard").click();
    await settle();
    const write = hold("POST /api/content/discard");
    buttonNamed("Discard", theSheet()).click();
    await settle();
    press(document.body, "Escape");
    write.release();
    await settle();
    expect(posts("discard").map((call) => call.body?.key)).toEqual(["pages/home"]);
    expect(server.stored.get("artists/finn")?.payload).toEqual({ name: "Two" });
    expect(visibleToast().textContent).toContain("1 of 2 done");
  });

  test("the one in flight failing after a cancel is reported as an error", async () => {
    two();
    handlers["POST /api/content/publish"] = () => ({
      status: 500,
      json: { error: { code: "internal", message: "Boom" } },
    });
    const write = hold("POST /api/content/publish");
    await mount();
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    buttonNamed("Publish", await openPublishSheet()).click();
    await settle();
    press(document.body, "Escape");
    write.release();
    await settle();
    expect(posts("publish")).toHaveLength(1);
    expect(visibleToast().textContent).toContain("0 of 2 done");
    expect(visibleToast().dataset.kind).toBe("error");
  });

  /**
   * The sheet showed version 5, a third editor wrote 6, and Keep mine moved the session to 7, so the session's version
   * covers a change nobody reviewed. A publish still waiting behind the held save has not read its version yet.
   */
  async function publishWaitingBehindASave() {
    const server = serve({ "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } } });
    await mount();
    await editText("pages/home:title", "One");
    server.theirWrite("pages/home", { lede: "Seen in the sheet" });
    const sheet = await openPublishSheet();
    server.theirWrite("pages/home", { extra: "Never seen" });
    commitText("pages/home:title", "Two");
    await settle();
    buttonNamed("Keep mine (overwrite)", visibleToast()).click();
    await settle();
    const save = hold("POST /api/content/field");
    commitText("pages/home:title", "Three");
    await settle();
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")).toEqual([]);
    return { server, save };
  }

  test("a document waiting to go when cancelled still sends its reviewed version, so it can't publish unseen", async () => {
    const { server, save } = await publishWaitingBehindASave();
    press(document.body, "Escape");
    save.release();
    await settle();
    expect(posts("publish").map((call) => call.body?.expectedVersion)).toEqual([5]);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello" });
    // The finished run left no review behind: a later publish is on the session's version.
    await handle?.api.publish("pages/home");
    expect(posts("publish")[1]?.body?.expectedVersion).toBe(8);
  });

  test("reopening the sheet doesn't hand the waiting publish the new, unloaded review", async () => {
    const { server, save } = await publishWaitingBehindASave();
    press(document.body, "Escape");
    buttonNamed("Publish").click();
    await settle();
    save.release();
    await settle();
    expect(posts("publish").map((call) => call.body?.expectedVersion)).toEqual([5]);
    expect(server.stored.get("pages/home")?.publishedPayload).toEqual({ title: "Hello" });
  });
});

describe("a slow GET documents", () => {
  function sessionWithSummaries(summaries: () => Promise<Record<string, unknown>>) {
    const client = { documents: summaries } as unknown as ContentClient;
    return new Session(client, { stateChanged() {}, saved() {}, failed() {}, conflicted() {} }, "/api/content");
  }

  test("an older summary doesn't lower the version or drop the newer document", async () => {
    let respond: (documents: Record<string, unknown>) => void = () => undefined;
    const answers: (() => Promise<Record<string, unknown>>)[] = [
      () => Promise.resolve({ "pages/home": summary("pages/home", true, false, 3) }),
      () => new Promise((resolve) => (respond = resolve)),
    ];
    const session = sessionWithSummaries(() => (answers.shift() as () => Promise<Record<string, unknown>>)());
    await session.load(["pages/home"]);
    const slow = session.load(["pages/home"]);
    await settle();
    const newer = {
      ...wireDocument("pages/home", 8, { title: "Newer" }),
      scheduledAt: "2030-01-01T00:00:00+00:00",
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    session.adopt(newer);
    session.touch("pages/home", ["title"]);
    respond({ "pages/home": { ...summary("pages/home", true, true, 3), publishedAt: null } });
    await slow;
    expect(session.documents.get("pages/home")).toMatchObject({
      version: 8,
      payload: { title: "Newer" },
      publishedAt: newer.publishedAt,
      scheduledAt: newer.scheduledAt,
      touched: true,
      access: { edit: true, publish: true },
    });
    expect((await session.document("pages/home")).version).toBe(8);
  });

  test("a newer summary is still taken: another editor's write shows and the cache is dropped", async () => {
    const answers = [3, 5].map((version) => ({ "pages/home": summary("pages/home", true, true, version) }));
    const session = sessionWithSummaries(() => Promise.resolve(answers.shift() as Record<string, unknown>));
    await session.load(["pages/home"]);
    session.adopt(wireDocument("pages/home", 4, { title: "Ours" }));
    await session.load(["pages/home"]);
    expect(session.documents.get("pages/home")).toMatchObject({ version: 5, payload: undefined });
  });

  test("api.refresh waits for queued writes, so the next write doesn't conflict with this session's own", async () => {
    const server = serve({ "pages/home": { payload: { title: "Hello" } } });
    const { api } = await mount();
    const save = hold("POST /api/content/field");
    commitText("pages/home:title", "One");
    await settle();
    const before = calls.filter((call) => call.route.startsWith("GET /api/content/documents")).length;
    const refreshed = api.refresh();
    await settle();
    expect(calls.filter((call) => call.route.startsWith("GET /api/content/documents"))).toHaveLength(before);
    save.release();
    await refreshed;
    expect(api.documents().get("pages/home")?.version).toBe(4);
    await editText("pages/home:title", "Two");
    expect(server.stored.get("pages/home")?.version).toBe(5);
    expect(field("pages/home:title").dataset.cmsState).toBe("saved");
  });
});

describe("two reads of one row's diff", () => {
  async function conflictWhileTheFirstReadIsSlow() {
    const server = serve({ "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } } });
    const reads = gateAnswers("GET /api/content/document");
    await mount();
    await editText("pages/home:title", "One");
    buttonNamed("Publish").click();
    await settle();
    const live = server.stored.get("pages/home") as FakeDocument;
    live.publishedPayload = { title: "Theirs live" };
    live.version += 1;
    // Nothing reviewed yet, so this goes on the session's version and conflicts, which starts the second read.
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(reads).toHaveLength(2);
    return { server, reads };
  }

  test("the slow first read resolving last renders nothing and the publish sends the second's version", async () => {
    const { reads } = await conflictWhileTheFirstReadIsSlow();
    reads[1]?.();
    await settle();
    const second = ['title "Theirs live" → "One"'];
    expect(diffLines(theSheet())).toEqual(second);
    reads[0]?.();
    await settle();
    expect(diffLines(theSheet())).toEqual(second);
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(posts("publish").at(-1)?.body?.expectedVersion).toBe(5);
    expect(theSheet().hidden).toBe(true);
  });

  test("the first read resolving first is ignored, and doesn't make the second look stale", async () => {
    const { reads } = await conflictWhileTheFirstReadIsSlow();
    reads[0]?.();
    await settle();
    expect(diffLines(theSheet())).toEqual([]);
    reads[1]?.();
    await settle();
    expect(diffLines(theSheet())).toEqual(['title "Theirs live" → "One"']);
    expect(reads).toHaveLength(2);
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(posts("publish").at(-1)?.body?.expectedVersion).toBe(5);
  });
});

describe("a write landing during the sheet's read", () => {
  test("the pair is read again, so the document and the published payload come from one response", async () => {
    const responses: ((response: { document: WireDocument; publishedPayload: unknown }) => void)[] = [];
    const session = sessionWith(() => new Promise((resolve) => responses.push(resolve)));
    await session.load(["pages/home"]);
    const review = session.startReview("pages/home");
    const read = session.documentForPublish("pages/home");
    await settle();
    session.adopt(wireDocument("pages/home", 8, { title: "Newer" }));
    responses[0]?.({ document: wireDocument("pages/home", 7, { title: "Older" }), publishedPayload: { title: "Old" } });
    await settle();
    expect(review.version).toBeUndefined();
    responses[1]?.({ document: wireDocument("pages/home", 8, { title: "Newer" }), publishedPayload: { title: "New" } });
    expect(await read).toMatchObject({ document: { version: 8 }, publishedPayload: { title: "New" } });
    expect(review.version).toBe(8);
    expect(session.documents.get("pages/home")?.payload).toEqual({ title: "Newer" });
  });

  test("a read that never settles gives up after a few tries: never reviewed, and the cache is kept", async () => {
    let reads = 0;
    const session: Session = sessionWith(() => {
      reads += 1;
      session.adopt(wireDocument("pages/home", 100 + reads, { title: `Write ${reads}` }));
      return Promise.resolve({ document: wireDocument("pages/home", reads), publishedPayload: {} });
    });
    await session.load(["pages/home"]);
    const review = session.startReview("pages/home");
    await expect(session.documentForPublish("pages/home")).rejects.toThrow();
    expect(reads).toBe(3);
    expect(review.version).toBeUndefined();
    expect((await session.document("pages/home")).version).toBe(103);
  });

  test("an own save during the read shows in the diff and sends its version", async () => {
    serve({ "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } } });
    await mount();
    await editText("pages/home:title", "One");
    const reads = gateAnswers("GET /api/content/document");
    buttonNamed("Publish").click();
    await settle();
    await editText("pages/home:lede", "Two");
    reads[0]?.();
    await settle();
    expect(reads).toHaveLength(2);
    reads[1]?.();
    await settle();
    expect(diffLines(theSheet())).toEqual(['title "Hello" → "One"', 'lede added "Two"']);
    buttonNamed("Publish", theSheet()).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(5);
  });

  test("the sheet shows could-not-load when own saves keep landing, and Publish goes on the session's version", async () => {
    serve({ "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } } });
    const read = handlers["GET /api/content/document"] as Handler;
    await mount();
    await editText("pages/home:title", "One");
    let count = 0;
    handlers["GET /api/content/document"] = async (body, url) => {
      const answer = await read(body, url);
      count += 1;
      await editText("pages/home:lede", `Write ${count}`);
      return answer;
    };
    const sheet = await openPublishSheet();
    await vi.waitFor(() => expect(sheet.querySelector(".cms-error")).not.toBeNull());
    expect(count).toBe(3);
    expect(diffLines(sheet)).toEqual([]);
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-error')?.textContent).toBe(
      "Couldn’t load the changes: it kept changing while loading. Close this and open it again.",
    );
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(7);
  });
});

describe("a published document whose published payload can't be read", () => {
  test("the sheet says could-not-load, never first publish, and nothing counts as reviewed", async () => {
    await mount();
    await editText("pages/home:title", "One");
    handlers["GET /api/content/document"] = () => ({
      json: {
        document: { ...wireDocument("pages/home", 9, { title: "One" }), publishedAt: "2026-01-01T00:00:00.000Z" },
        publishedPayload: null,
      },
    });
    const sheet = await openPublishSheet();
    const item = sheet.querySelector('li[data-key="pages/home"]') as HTMLElement;
    expect(item.querySelector(".cms-error")?.textContent).toBe(
      "Couldn’t load the changes: the published version couldn’t be read",
    );
    expect(item.textContent).not.toContain("Nothing is live");
    expect(handle?.api.documents().get("pages/home")?.payload).not.toEqual({ title: "One" });
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(4);
  });

  test("a string published payload is raw stored text: could-not-load, no diff, not a first publish", async () => {
    await mount();
    await editText("pages/home:title", "One");
    handlers["GET /api/content/document"] = () => ({
      json: {
        document: { ...wireDocument("pages/home", 9, { title: "One" }), publishedAt: "2026-01-01T00:00:00.000Z" },
        publishedPayload: '{"title": broken',
      },
    });
    const sheet = await openPublishSheet();
    const item = sheet.querySelector('li[data-key="pages/home"]') as HTMLElement;
    expect(item.querySelector(".cms-error")?.textContent).toBe(
      "Couldn’t load the changes: the published version couldn’t be read",
    );
    expect(diffLines(item)).toEqual([]);
    expect(item.textContent).not.toContain("Nothing is live");
    buttonNamed("Publish", sheet).click();
    await settle();
    expect(posts("publish")[0]?.body?.expectedVersion).toBe(4);
  });

  test("nothing published and no published payload is still a first publish", async () => {
    await mount();
    await editText("pages/home:title", "One");
    handlers["GET /api/content/document"] = () => ({
      json: { document: wireDocument("pages/home", 4, { title: "One" }), publishedPayload: null },
    });
    const sheet = await openPublishSheet();
    expect(sheet.querySelector('li[data-key="pages/home"] .cms-diff')?.textContent).toContain("Nothing is live");
    expect(sheet.querySelector(".cms-error")).toBeNull();
  });
});

describe("the Discard sheet on a document with nothing published", () => {
  const deleting = (key: string) =>
    theSheet().querySelector(`li[data-key="${key}"] .cms-diff .cms-error`)?.textContent ?? null;
  const expected = (key: string) =>
    `Nothing is published, so discarding deletes ${key} and all its revision history. This can’t be undone.`;
  const mixed = () =>
    serve({
      "pages/home": { publishedPayload: { title: "Hello" }, payload: { title: "Hello" } },
      "artists/finn": { publishedPayload: null, payload: { name: "Finn" } },
    });
  async function openDiscardSheet() {
    await editText("pages/home:title", "One");
    await editText("artists/finn:name", "Two");
    buttonNamed("Discard").click();
    await settle();
    return theSheet();
  }

  test("warns on those documents only, and they stay listed and discardable", async () => {
    mixed();
    await mount();
    const sheet = await openDiscardSheet();
    expect(deleting("artists/finn")).toBe(expected("artists/finn"));
    expect(deleting("pages/home")).toBeNull();
    buttonNamed("Discard", sheet).click();
    await settle();
    expect(posts("discard").map((call) => call.body?.key)).toEqual(["pages/home", "artists/finn"]);
  });

  test("the Publish sheet has no such warning", async () => {
    mixed();
    await mount();
    await editText("artists/finn:name", "Two");
    const sheet = await openPublishSheet();
    expect(sheet.textContent).not.toContain("deletes");
  });

  test("a conflict that reveals nothing is published any more adds the warning before the retry", async () => {
    const server = mixed();
    await mount();
    await openDiscardSheet();
    const live = server.stored.get("pages/home") as FakeDocument;
    live.publishedPayload = null;
    live.version += 1;
    buttonNamed("Discard", theSheet()).click();
    await settle();
    expect(theSheet().querySelector('li[data-key="pages/home"]')?.textContent).toContain(expected("pages/home"));
    expect(theSheet().querySelector('li[data-key="pages/home"]')?.textContent).toContain("Discard did nothing");
  });

  test("a warning that became due while the sheet was open stops Confirm once, so it can be read", async () => {
    mixed();
    const { api } = await mount();
    await openDiscardSheet();
    await api.unpublish("pages/home");
    const confirm = buttonNamed("Discard", theSheet());
    confirm.click();
    await settle();
    expect(posts("discard")).toEqual([]);
    expect(deleting("pages/home")).toBe(expected("pages/home"));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await settle();
    expect(posts("discard").map((call) => call.body?.key)).toEqual(["pages/home", "artists/finn"]);
  });
});
