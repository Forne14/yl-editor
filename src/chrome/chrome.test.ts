// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { groupByDocument, scanFields } from "./fields.ts";
import { mountEditor, type ContentClient } from "./index.ts";
import { Session } from "./session.ts";
import type { EditorHandle, WidgetContext, WireDocument } from "./types.ts";

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
  expect(discards.map((call) => call.body)).toEqual([{ key: "pages/home" }, { key: "artists/finn" }]);
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
  expect(write?.body).toEqual({ key: "pages/home", revisionId: 7 });
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
  expect(visibleToast().textContent).toContain("Restore failed for pages/home: Stale");
  expect(field("pages/home:title").textContent).toBe("Hello");
  await editText("pages/home:title", "Still saves");
  expect(calls.at(-1)?.route).toBe("POST /api/content/field");
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
    { key: "pages/home" },
  ]);
});

test("the publish sheet says first publish when nothing is live, without reading revisions", async () => {
  handlers["GET /api/content/document"] = documentResponse(wireDocument("pages/home", 4, { title: "One" }), null);
  await mount();
  await editText("pages/home:title", "One");
  buttonNamed("Publish").click();
  await settle();
  expect(document.querySelector(".cms-diff")?.textContent).toBe("First publish: nothing is live yet.");
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
  expect(calls.filter((call) => call.route === "POST /api/content/publish").map((call) => call.body)).toEqual([
    { key: "pages/home" },
    { key: "artists/finn" },
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

test("a write landing during the sheet's fetch wins over the older response", async () => {
  let respond: (response: { document: WireDocument; publishedPayload: unknown }) => void = () => undefined;
  const session = sessionWith(() => new Promise((resolve) => (respond = resolve)));
  await session.load(["pages/home"]);
  const read = session.documentForPublish("pages/home");
  await settle();
  session.adopt(wireDocument("pages/home", 8, { title: "Newer" }));
  respond({ document: wireDocument("pages/home", 7, { title: "Older" }), publishedPayload: { title: "Live" } });
  const { document: draft, publishedPayload } = await read;
  expect(draft.payload).toEqual({ title: "Newer" });
  expect(publishedPayload).toEqual({ title: "Live" });
  expect(session.documents.get("pages/home")?.payload).toEqual({ title: "Newer" });
  expect((await session.document("pages/home")).version).toBe(8);
});

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
  const { api } = await mount();
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
  expect(publishes[1]?.body).toEqual({ key: "pages/home" });
  expect(document.querySelector<HTMLElement>(".cms-bar__schedule")?.hidden).toBe(true);
  expect(api.documents().get("pages/home")?.touched).toBe(false);
});

test("without Publish at the sheet publishes now and the button still reads Publish", async () => {
  await mount();
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
  expect(calls.find((call) => call.route === "POST /api/content/publish")?.body).toEqual({ key: "pages/home" });
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
    { key: "pages/home" },
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
  expect(visibleToast().textContent).toContain("Discarded artists/finn; it had never been published.");
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
