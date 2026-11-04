import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { contractRegistry } from "../contract.ts";
import { createSqliteContentStore } from "../sqlite-store.ts";
import { makeTestDb } from "../test-support.ts";
import type { Access, AccessVerdict, ContentStore, DocumentRef } from "../types.ts";
import { createContentHandlers, type ChangeEvent, type ContentHandlers } from "./handlers.ts";

const allowed: AccessVerdict = { allowed: true };

/** An Access whose verdicts each test sets, recording every call. */
function fakeAccess() {
  type Verdict = (ref: DocumentRef) => AccessVerdict;
  const verdicts: { edit: Verdict; publish: Verdict } = { edit: () => allowed, publish: () => allowed };
  const calls: { check: "canEdit" | "canPublish"; locals: unknown; ref: DocumentRef }[] = [];
  const access: Access = {
    canEdit: (locals, ref) => {
      calls.push({ check: "canEdit", locals, ref });
      return verdicts.edit(ref);
    },
    canPublish: async (locals, ref) => {
      calls.push({ check: "canPublish", locals, ref });
      return verdicts.publish(ref);
    },
  };
  return { access, verdicts, calls };
}

const baseHeaders = { "X-Requested-With": "yl-editor" };

const post = (route: string, body: unknown, headers: Record<string, string> = baseHeaders) =>
  new Request(`http://host/api/content/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (pathAndQuery: string, headers: Record<string, string> = baseHeaders) =>
  new Request(`http://host/api/content/${pathAndQuery}`, { headers });

const note = { title: "A", tags: [] as string[] };

let store: ContentStore;
let fake: ReturnType<typeof fakeAccess>;
let events: ChangeEvent[];
let handlers: ContentHandlers;

const session = { user: "ada" };

beforeEach(() => {
  store = createSqliteContentStore(makeTestDb(), contractRegistry);
  fake = fakeAccess();
  events = [];
  handlers = createContentHandlers({
    store,
    registry: contractRegistry,
    access: fake.access,
    locals: () => session,
    actor: (locals) => (locals as typeof session).user,
    onChange: (event) => {
      events.push(event);
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(request: Request) {
  const response = await handlers.handle(request);
  // Bodies are asserted structurally; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { response, status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("routes", () => {
  test("lists every route with its method", () => {
    expect(handlers.routes).toEqual([
      "GET documents",
      "GET revisions",
      "POST field",
      "POST array",
      "POST publish",
      "POST discard",
      "POST retire",
      "POST restore",
      "POST rename",
      "POST create",
    ]);
  });

  test("create returns 201 with the document and gates on the body's type and key", async () => {
    const { status, body } = await call(post("create", { type: "note", slug: "first", payload: note }));
    expect(status).toBe(201);
    expect(body.document).toMatchObject({ key: "notes/first", type: "note", isDraft: true, version: 1 });
    expect(fake.calls).toEqual([{ check: "canEdit", locals: session, ref: { type: "note", key: "notes/first" } }]);
  });

  test("documents summarises known keys with access and omits unknown ones", async () => {
    await store.create("note", "first", note);
    await store.create("note", "second", note);
    await store.retire("notes/second");
    const { status, body, response } = await call(get("documents?keys=notes/first,notes/second,notes/none"));
    expect(status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(Object.keys(body.documents)).toEqual(["notes/first", "notes/second"]);
    expect(body.documents["notes/first"]).toEqual({
      key: "notes/first",
      type: "note",
      version: 1,
      isDraft: true,
      draftUpdatedAt: expect.any(String),
      publishedAt: null,
      access: { edit: true, publish: true },
    });
  });

  test("documents lists a document the actor cannot edit, greyed", async () => {
    await store.create("note", "first", note);
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    fake.verdicts.publish = () => ({ allowed: false, reason: "Not yours" });
    const { status, body } = await call(get("documents?keys=notes/first"));
    expect(status).toBe(200);
    expect(body.documents["notes/first"].access).toEqual({ edit: false, publish: false });
  });

  test("field writes the draft and honours expectedVersion", async () => {
    await store.create("note", "first", note);
    const { status, body } = await call(
      post("field", { key: "notes/first", path: "title", value: "B", expectedVersion: 1 }),
    );
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ payload: { title: "B", tags: [] }, version: 2 });
  });

  test("array inserts, moves and removes", async () => {
    await store.create("note", "first", note);
    await call(post("array", { key: "notes/first", path: "tags", op: { kind: "insert", index: 0, value: "x" } }));
    await call(post("array", { key: "notes/first", path: "tags", op: { kind: "insert", index: 1, value: "y" } }));
    const moved = await call(post("array", { key: "notes/first", path: "tags", op: { kind: "move", from: 0, to: 1 } }));
    expect(moved.body.document.payload.tags).toEqual(["y", "x"]);
    const removed = await call(post("array", { key: "notes/first", path: "tags", op: { kind: "remove", index: 0 } }));
    expect(removed.status).toBe(200);
    expect(removed.body.document.payload.tags).toEqual(["x"]);
  });

  test("publish, retire, restore and rename go through canPublish", async () => {
    await store.create("note", "first", note);
    const published = await call(post("publish", { key: "notes/first" }));
    expect(published.body.document).toMatchObject({ isDraft: false, publishedAt: expect.any(String) });
    const retired = await call(post("retire", { key: "notes/first" }));
    expect(retired.body.document.retiredAt).toEqual(expect.any(String));
    const restored = await call(post("restore", { key: "notes/first" }));
    expect(restored.body.document.retiredAt).toBeNull();
    const renamed = await call(post("rename", { key: "notes/first", slug: "renamed" }));
    expect(renamed.status).toBe(200);
    expect(renamed.body.document).toMatchObject({ key: "notes/renamed", previousSlugs: ["first"] });
    expect(fake.calls.map((entry) => entry.check)).toEqual(["canPublish", "canPublish", "canPublish", "canPublish"]);
  });

  test("discard drops the draft of a published document, and returns null for a draft-only one", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "B");
    const discarded = await call(post("discard", { key: "notes/first" }));
    expect(discarded.status).toBe(200);
    expect(discarded.body.document).toMatchObject({ isDraft: false, payload: note });

    await store.create("note", "second", note);
    const dropped = await call(post("discard", { key: "notes/second" }));
    expect(dropped.status).toBe(200);
    expect(dropped.body).toEqual({ document: null });
    expect(fake.calls.every((entry) => entry.check === "canEdit")).toBe(true);
  });

  test("revisions lists the history with the actor from options.actor", async () => {
    await store.create("note", "first", note);
    await call(post("publish", { key: "notes/first" }));
    const { status, body } = await call(get("revisions?key=notes/first"));
    expect(status).toBe(200);
    expect(body.revisions).toEqual([
      {
        id: expect.any(Number),
        action: "publish",
        slug: "first",
        payload: note,
        actor: "ada",
        createdAt: expect.any(String),
      },
    ]);
  });
});

describe("guards", () => {
  test("refuses a request without X-Requested-With", async () => {
    const { status, body } = await call(post("field", { key: "notes/first", path: "title", value: "B" }, {}));
    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  test("refuses a cross-site Sec-Fetch-Site", async () => {
    const { status, body } = await call(
      get("documents?keys=notes/first", { ...baseHeaders, "Sec-Fetch-Site": "cross-site" }),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });

  test("refuses a foreign Origin and accepts the request's own", async () => {
    const foreign = await call(get("documents?keys=a/b", { ...baseHeaders, Origin: "http://evil.example" }));
    expect(foreign.status).toBe(403);
    const own = await call(
      get("documents?keys=a/b", { ...baseHeaders, Origin: "http://host", "Sec-Fetch-Site": "same-origin" }),
    );
    expect(own.status).toBe(200);
  });

  test("sameOrigin: false lets a cross-site caller through but still needs the header", async () => {
    const open = createContentHandlers({
      store,
      registry: contractRegistry,
      access: fake.access,
      locals: () => null,
      sameOrigin: false,
    });
    const crossSite = { ...baseHeaders, "Sec-Fetch-Site": "cross-site", Origin: "http://elsewhere" };
    expect((await open.handle(get("documents?keys=a/b", crossSite))).status).toBe(200);
    expect((await open.handle(get("documents?keys=a/b", {}))).status).toBe(403);
  });

  test("revisions of a document the actor cannot edit is forbidden", async () => {
    await store.create("note", "first", note);
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    const { status, body } = await call(get("revisions?key=notes/first"));
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "forbidden", message: "Not yours" });
  });

  test("field is forbidden when canEdit denies, with the reason, and nothing is written", async () => {
    await store.create("note", "first", note);
    fake.verdicts.edit = () => ({ allowed: false, reason: "Editors only" });
    const { status, body } = await call(post("field", { key: "notes/first", path: "title", value: "B" }));
    expect(status).toBe(403);
    expect(body.error.message).toBe("Editors only");
    expect((await store.get("notes/first", { draft: true }))?.payload).toEqual(note);
    expect(events).toEqual([]);
  });

  test("publish is forbidden when canPublish denies even though canEdit allows", async () => {
    await store.create("note", "first", note);
    fake.verdicts.publish = () => ({ allowed: false, reason: "Publishers only" });
    const { status, body } = await call(post("publish", { key: "notes/first" }));
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "forbidden", message: "Publishers only" });
  });

  test("create is forbidden when canEdit denies", async () => {
    fake.verdicts.edit = () => ({ allowed: false, reason: "No new notes" });
    const { status, body } = await call(post("create", { type: "note", slug: "first", payload: note }));
    expect(status).toBe(403);
    expect(body.error.message).toBe("No new notes");
    expect(await store.get("notes/first", { draft: true })).toBeNull();
  });
});

describe("errors", () => {
  test("an unknown key is 404 before any access check", async () => {
    const { status, body } = await call(post("field", { key: "notes/none", path: "title", value: "B" }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(fake.calls).toEqual([]);
  });

  test("a stale expectedVersion is 409 carrying the current document", async () => {
    await store.create("note", "first", note);
    await store.writeField("notes/first", "title", "Theirs");
    const { status, body } = await call(
      post("field", { key: "notes/first", path: "title", value: "Mine", expectedVersion: 1 }),
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
    expect(body.error.current).toMatchObject({
      key: "notes/first",
      version: 2,
      payload: { title: "Theirs", tags: [] },
    });
  });

  test("a payload that breaks the schema is 422 with issues", async () => {
    await store.create("note", "first", note);
    const { status, body } = await call(post("field", { key: "notes/first", path: "title", value: "" }));
    expect(status).toBe(422);
    expect(body.error.code).toBe("validation");
    expect(body.error.issues).toEqual([expect.objectContaining({ path: ["title"] })]);
  });

  test("create of an unknown type is 422", async () => {
    const { status, body } = await call(post("create", { type: "poem", slug: "first", payload: {} }));
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: "validation", message: "Unknown document type" });
    expect(fake.calls).toEqual([]);
  });

  test("a bad path is 400 path, an invalid slug is 400 slug, a retired write is 409 state", async () => {
    await store.create("note", "first", note);
    const badPath = await call(post("field", { key: "notes/first", path: "meta.title", value: "x" }));
    expect([badPath.status, badPath.body.error.code]).toEqual([400, "path"]);
    const badSlug = await call(post("rename", { key: "notes/first", slug: "Not A Slug" }));
    expect([badSlug.status, badSlug.body.error.code]).toEqual([400, "slug"]);
    await store.retire("notes/first");
    const retired = await call(post("retire", { key: "notes/first" }));
    expect([retired.status, retired.body.error.code]).toEqual([409, "state"]);
  });

  test("a body that is not JSON is 400 bad_request", async () => {
    const { status, body } = await call(post("field", "{not json"));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
  });

  test("a body that fails the request schema is 400 with issues", async () => {
    const { status, body } = await call(post("array", { key: "notes/first", path: "tags", op: { kind: "shuffle" } }));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["op", "kind"] })]));
  });

  test("a missing query parameter is 400", async () => {
    const { status, body } = await call(get("revisions"));
    expect(status).toBe(400);
    expect(body.error.issues).toBeDefined();
  });

  test("the wrong method is 405 with Allow", async () => {
    const { status, response } = await call(get("field"));
    expect(status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    const documents = await call(post("documents", {}));
    expect(documents.response.headers.get("Allow")).toBe("GET");
  });

  test("an unknown route, or a path outside base, is 404", async () => {
    expect((await call(post("explode", {}))).body.error.code).toBe("not_found");
    expect((await call(get("toString"))).status).toBe(404);
    expect((await handlers.handle(new Request("http://host/other/field", { method: "POST" }))).status).toBe(404);
  });

  test("an unexpected store error is 500 without leaking its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: ContentStore = {
      ...store,
      writeField: async () => {
        throw new Error("disk on fire at /var/secret.db");
      },
    };
    await store.create("note", "first", note);
    const handlersOverBroken = createContentHandlers({
      store: broken,
      registry: contractRegistry,
      access: fake.access,
      locals: () => null,
    });
    const response = await handlersOverBroken.handle(post("field", { key: "notes/first", path: "title", value: "B" }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(text).not.toContain("secret");
    expect(logged).toHaveBeenCalled();
  });
});

describe("custom base", () => {
  test("routes under the configured base, trailing slash tolerated", async () => {
    const mounted = createContentHandlers({
      store,
      registry: contractRegistry,
      access: fake.access,
      locals: () => null,
      base: "/cms/",
    });
    const request = new Request("http://host/cms/documents?keys=notes/none", { headers: baseHeaders });
    expect((await mounted.handle(request)).status).toBe(200);
    expect((await mounted.handle(get("documents?keys=notes/none"))).status).toBe(404);
  });
});

describe("onChange", () => {
  test("fires after each write with the action, key, document and actor", async () => {
    await call(post("create", { type: "note", slug: "first", payload: note }));
    await call(post("field", { key: "notes/first", path: "title", value: "B" }));
    await call(post("publish", { key: "notes/first" }));
    expect(events.map((event) => [event.action, event.key, event.actor])).toEqual([
      ["create", "notes/first", "ada"],
      ["field", "notes/first", "ada"],
      ["publish", "notes/first", "ada"],
    ]);
    expect(events[1]?.document).toMatchObject({ payload: { title: "B" } });
  });

  test("a failing onChange is logged and the write still succeeds", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const noisy = createContentHandlers({
      store,
      registry: contractRegistry,
      access: fake.access,
      locals: () => null,
      onChange: () => {
        throw new Error("log down");
      },
    });
    const response = await noisy.handle(post("create", { type: "note", slug: "first", payload: note }));
    expect(response.status).toBe(201);
    expect(logged).toHaveBeenCalled();
  });

  test("reads do not fire onChange", async () => {
    await store.create("note", "first", note);
    await call(get("documents?keys=notes/first"));
    await call(get("revisions?key=notes/first"));
    expect(events).toEqual([]);
  });
});
