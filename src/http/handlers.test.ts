import type Database from "better-sqlite3";
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

let db: Database.Database;
let store: ContentStore;
let fake: ReturnType<typeof fakeAccess>;
let events: ChangeEvent[];
let handlers: ContentHandlers;

const session = { user: "ada" };

beforeEach(() => {
  db = makeTestDb();
  store = createSqliteContentStore(db, contractRegistry);
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
      "GET document",
      "GET revisions",
      "POST field",
      "POST array",
      "POST publish",
      "POST unpublish",
      "POST restore-revision",
      "POST publish-due",
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

  test("documents rejects more than 100 keys and dedupes before counting", async () => {
    const many = Array.from({ length: 101 }, (_, index) => `notes/k${index}`).join(",");
    const over = await call(get(`documents?keys=${many}`));
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("100");
    const dupes = Array.from({ length: 150 }, () => "notes/none").join(",");
    expect((await call(get(`documents?keys=${dupes}`))).status).toBe(200);
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
  test("a slow onChange does not delay the write response", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const called = vi.fn();
    const slow = createContentHandlers({
      store,
      registry: contractRegistry,
      access: fake.access,
      locals: () => null,
      onChange: async (event) => {
        called(event.action);
        await gate;
      },
    });
    const response = await slow.handle(post("create", { type: "note", slug: "first", payload: note }));
    expect(response.status).toBe(201);
    await Promise.resolve();
    expect(called).toHaveBeenCalledWith("create");
    release();
  });

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

describe("document", () => {
  test("returns the draft view, retired included, gated by canEdit", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    await store.retire("notes/first");
    const { status, body } = await call(get("document?key=notes/first"));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({
      key: "notes/first",
      isDraft: true,
      payload: { title: "Draft", tags: [] },
      retiredAt: expect.any(String),
    });
    expect(fake.calls).toEqual([{ check: "canEdit", locals: session, ref: { type: "note", key: "notes/first" } }]);
    expect(events).toEqual([]);
  });

  test("an unknown key is 404 before any verdict, a denial is 403, a missing key is 400", async () => {
    const missing = await call(get("document?key=notes/none"));
    expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
    expect(fake.calls).toEqual([]);

    await store.create("note", "first", note);
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    const denied = await call(get("document?key=notes/first"));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toEqual({ code: "forbidden", message: "Not yours" });

    const malformed = await call(get("document"));
    expect([malformed.status, malformed.body.error.code]).toEqual([400, "bad_request"]);
    expect((await call(post("document", {}))).status).toBe(405);
  });
});

describe("document publishedPayload", () => {
  const read = async () => {
    const { status, body } = await call(get("document?key=notes/first"));
    expect(status).toBe(200);
    return body;
  };
  /** Fails `note`'s schema: `title` must be non-empty. */
  const stale = { title: "", tags: [] as string[] };
  const corrupt = (column: "published_payload" | "draft_payload") =>
    db.prepare(`UPDATE documents SET ${column} = ? WHERE key = 'notes/first'`).run(JSON.stringify(stale));

  beforeEach(() => {
    // The store reports a stale payload this way; the route must not depend on it.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("published with a draft: the draft is the document and the live payload sits beside it", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    const body = await read();
    expect(body.document).toMatchObject({ isDraft: true, payload: { title: "Draft", tags: [] } });
    expect(body.publishedPayload).toEqual(note);
  });

  test("published with no draft: both sides are the live payload", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const body = await read();
    expect(body.document).toMatchObject({ isDraft: false, payload: note });
    expect(body.publishedPayload).toEqual(note);
  });

  test("never published: null", async () => {
    await store.create("note", "first", note);
    const body = await read();
    expect(body.document).toMatchObject({ isDraft: true, publishedAt: null, payload: note });
    expect(body.publishedPayload).toBeNull();
  });

  test("unpublished: null, and the content stays as the draft", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.unpublish("notes/first");
    const body = await read();
    expect(body.document).toMatchObject({ isDraft: true, publishedAt: null, payload: note });
    expect(body.publishedPayload).toBeNull();
  });

  test("retired: the published payload it still holds, with or without a draft", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.retire("notes/first");
    expect((await read()).publishedPayload).toEqual(note);
    await store.writeField("notes/first", "title", "Draft");
    const body = await read();
    expect(body.document).toMatchObject({ retiredAt: expect.any(String), payload: { title: "Draft", tags: [] } });
    expect(body.publishedPayload).toEqual(note);
  });

  test("retired and never published: null", async () => {
    await store.create("note", "first", note);
    await store.retire("notes/first");
    expect((await read()).publishedPayload).toBeNull();
  });

  test("a published payload failing the schema is served beside a valid draft", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    corrupt("published_payload");
    const body = await read();
    expect(body.document).toMatchObject({ isDraft: true, payload: { title: "Draft", tags: [] } });
    expect(body.publishedPayload).toEqual(stale);
  });

  test.each([false, true])(
    "a published payload failing the schema with no draft does not fail the route (retired: %s)",
    async (retired) => {
      await store.create("note", "first", note);
      await store.publish("notes/first");
      if (retired) await store.retire("notes/first");
      corrupt("published_payload");
      const body = await read();
      expect(body.document).toMatchObject({ isDraft: false, payload: stale, publishedAt: expect.any(String) });
      expect(body.publishedPayload).toEqual(stale);
    },
  );

  test("a draft failing the schema is still reported, not hidden behind the published view", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    corrupt("draft_payload");
    const { status, body } = await call(get("document?key=notes/first"));
    expect([status, body.error.code]).toEqual([422, "validation"]);
  });

  test("the verdict gates every path, and is asked about the stored row once", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    corrupt("published_payload");
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    const { status, body } = await call(get("document?key=notes/first"));
    expect(status).toBe(403);
    expect(body).toEqual({ error: { code: "forbidden", message: "Not yours" } });
    expect(fake.calls).toEqual([{ check: "canEdit", locals: session, ref: { type: "note", key: "notes/first" } }]);
  });
});

describe("documents with a payload failing its schema", () => {
  /** Fails `note`'s schema: `title` must be non-empty. */
  const stale = JSON.stringify({ title: "", tags: [] as string[] });
  const corrupt = (key: string, column: "published_payload" | "draft_payload") =>
    db.prepare(`UPDATE documents SET ${column} = ? WHERE key = ?`).run(stale, key);

  beforeEach(async () => {
    // The store reports a stale payload this way; the route must not depend on it.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.create("note", "first", note);
    await store.publish("notes/first");
    await store.create("note", "second", note);
  });

  test.each([false, true])(
    "a stale published payload with no draft is summarised, beside the healthy documents (retired: %s)",
    async (retired) => {
      if (retired) await store.retire("notes/first");
      corrupt("notes/first", "published_payload");
      const { status, body } = await call(get("documents?keys=notes/first,notes/second,notes/none"));
      expect(status).toBe(200);
      expect(Object.keys(body.documents).sort()).toEqual(["notes/first", "notes/second"]);
      expect(body.documents["notes/first"]).toEqual({
        key: "notes/first",
        type: "note",
        version: expect.any(Number),
        isDraft: false,
        draftUpdatedAt: null,
        publishedAt: expect.any(String),
        access: { edit: true, publish: true },
      });
      expect(body.documents["notes/second"]).toMatchObject({ isDraft: true });
    },
  );

  test("verdicts are still asked for each document, the stale one included", async () => {
    corrupt("notes/first", "published_payload");
    fake.verdicts.edit = (ref) => (ref.key === "notes/first" ? { allowed: false, reason: "Not yours" } : allowed);
    const { status, body } = await call(get("documents?keys=notes/first,notes/second"));
    expect(status).toBe(200);
    expect(body.documents["notes/first"].access).toEqual({ edit: false, publish: true });
    expect(body.documents["notes/second"].access).toEqual({ edit: true, publish: true });
    for (const key of ["notes/first", "notes/second"])
      for (const check of ["canEdit", "canPublish"])
        expect(fake.calls).toContainEqual({ check, locals: session, ref: { type: "note", key } });
  });

  test("a draft failing its schema is summarised beside the healthy documents", async () => {
    await store.writeField("notes/first", "title", "Draft");
    corrupt("notes/first", "draft_payload");
    corrupt("notes/second", "draft_payload");
    await store.create("note", "third", note);
    const { status, body } = await call(get("documents?keys=notes/first,notes/second,notes/third"));
    expect(status).toBe(200);
    expect(body.documents["notes/first"]).toMatchObject({ isDraft: true, publishedAt: expect.any(String) });
    expect(body.documents["notes/second"]).toMatchObject({ isDraft: true, publishedAt: null });
    expect(body.documents["notes/third"]).toMatchObject({ isDraft: true, access: { edit: true, publish: true } });
  });
});

describe.each([
  { state: "stale published with no draft", published: true, draft: false },
  { state: "invalid draft over a published payload", published: true, draft: true },
  { state: "invalid draft, unpublished", published: false, draft: true },
] as const)("repairing a document: $state", ({ published, draft }) => {
  /** Fails `note`'s schema through `tags`, so `tags` is what a repair writes. */
  const invalid = { title: "A", tags: [1] };
  const key = "notes/first";
  const corruptColumn = draft ? "draft_payload" : "published_payload";
  const strictRead = () => store.get(key, { draft: true, includeRetired: true });
  const storedRow = () => db.prepare("SELECT * FROM documents WHERE key = ?").get(key);
  let revisionId: number;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.create("note", "first", note);
    await store.publish(key);
    revisionId = (await store.revisions(key))[0]?.id ?? -1;
    if (!published) await store.unpublish(key);
    else if (draft) await store.writeField(key, "title", "Draft");
    db.prepare(`UPDATE documents SET ${corruptColumn} = ? WHERE key = ?`).run(JSON.stringify(invalid), key);
    fake.calls.length = 0;
  });

  test("the strict read really does fail", async () => {
    await expect(strictRead()).rejects.toThrow();
  });

  test("GET documents summarises it", async () => {
    const { status, body } = await call(get(`documents?keys=${key}`));
    expect(status).toBe(200);
    expect(body.documents[key]).toMatchObject({ key, type: "note", isDraft: draft });
  });

  test("GET revisions lists its history", async () => {
    const { status, body } = await call(get(`revisions?key=${key}`));
    expect(status).toBe(200);
    expect(body.revisions[0]).toMatchObject({ id: revisionId, action: "publish" });
  });

  test("restore-revision with a valid revision leaves a valid draft", async () => {
    const { status, body } = await call(post("restore-revision", { key, revisionId }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, payload: note });
    expect((await strictRead())?.payload).toEqual(note);
  });

  test("discard succeeds", async () => {
    const { status, body } = await call(post("discard", { key }));
    expect(status).toBe(200);
    if (!published) {
      expect(body.document).toBeNull();
      expect(await store.get(key, { draft: true, includeRetired: true })).toBeNull();
    } else if (draft) {
      expect(body.document).toMatchObject({ isDraft: false, payload: note });
      expect((await strictRead())?.payload).toEqual(note);
    } else {
      // Nothing to drop: the stale published payload stays, still served as stored.
      expect(body.document).toMatchObject({ isDraft: false, payload: invalid });
    }
  });

  test("unpublish moves the stored payloads, or is a state error with nothing published", async () => {
    const { status, body } = await call(post("unpublish", { key }));
    if (!published) {
      expect([status, body.error.code]).toEqual([409, "state"]);
      return;
    }
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, publishedAt: null, payload: invalid });
    expect(await store.get(key, { includeRetired: true })).toBeNull();
  });

  test("retire, restore and rename need no validation", async () => {
    const retired = await call(post("retire", { key }));
    expect(retired.status).toBe(200);
    expect(retired.body.document).toMatchObject({ retiredAt: expect.any(String), payload: invalid });
    const restored = await call(post("restore", { key }));
    expect(restored.status).toBe(200);
    expect(restored.body.document).toMatchObject({ retiredAt: null, payload: invalid });
    const renamed = await call(post("rename", { key, slug: "second" }));
    expect(renamed.status).toBe(200);
    expect(renamed.body.document).toMatchObject({ key: "notes/second", payload: invalid });
  });

  test("a field write that leaves it invalid is 422 with issues and changes nothing", async () => {
    const before = storedRow();
    const { status, body } = await call(post("field", { key, path: "title", value: "B" }));
    expect([status, body.error.code]).toEqual([422, "validation"]);
    expect(body.error.issues).toEqual([expect.objectContaining({ path: ["tags", 0] })]);
    expect(storedRow()).toEqual(before);
  });

  test("a field write that makes it valid succeeds", async () => {
    const { status, body } = await call(post("field", { key, path: "tags", value: [] }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, payload: { title: "A", tags: [] } });
    expect(await strictRead()).toMatchObject({ payload: { title: "A", tags: [] } });
  });

  test("an array write that leaves it invalid is 422 with issues", async () => {
    const op = { kind: "insert", index: 0, value: "x" };
    const { status, body } = await call(post("array", { key, path: "tags", op }));
    expect([status, body.error.code]).toEqual([422, "validation"]);
    expect(body.error.issues).toEqual([expect.objectContaining({ path: ["tags", 1] })]);
  });

  test("an array write that makes it valid succeeds", async () => {
    const { status, body } = await call(post("array", { key, path: "tags", op: { kind: "remove", index: 0 } }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ payload: { title: "A", tags: [] } });
  });

  test("publish never lets invalid content go live", async () => {
    const live = () => db.prepare("SELECT published_payload FROM documents WHERE key = ?").get(key);
    const before = live();
    const { status, body } = await call(post("publish", { key }));
    if (draft) expect([status, body.error.code]).toEqual([422, "validation"]);
    else expect([status, body.error.code]).toEqual([409, "state"]);
    expect(live()).toEqual(before);
  });

  test("scheduling an invalid draft is refused too", async () => {
    const { status } = await call(post("publish", { key, at: "2030-01-01T00:00:00Z" }));
    expect(status).toBe(draft ? 422 : 409);
  });

  test("GET document: an invalid draft is 422, a stale published payload is served", async () => {
    const { status, body } = await call(get(`document?key=${key}`));
    if (draft) expect([status, body.error.code]).toEqual([422, "validation"]);
    else {
      expect(status).toBe(200);
      expect(body.document).toMatchObject({ isDraft: false, payload: invalid });
    }
  });

  test("a stale expectedVersion is 409 and still carries the document as stored", async () => {
    const { status, body } = await call(post("field", { key, path: "tags", value: [], expectedVersion: 999 }));
    expect([status, body.error.code]).toEqual([409, "conflict"]);
    expect(body.error.current).toMatchObject({ key, payload: invalid });
  });

  test.each([
    ["document", () => get(`document?key=${key}`)],
    ["revisions", () => get(`revisions?key=${key}`)],
    ["field", () => post("field", { key, path: "tags", value: [] })],
    ["array", () => post("array", { key, path: "tags", op: { kind: "remove", index: 0 } })],
    ["discard", () => post("discard", { key })],
    ["restore-revision", () => post("restore-revision", { key, revisionId: 1 })],
  ])("%s asks canEdit about the stored row; a denial is 403 with no payload", async (_route, request) => {
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    const before = storedRow();
    const { status, body } = await call(request());
    expect(status).toBe(403);
    expect(body).toEqual({ error: { code: "forbidden", message: "Not yours" } });
    expect(fake.calls).toEqual([{ check: "canEdit", locals: session, ref: { type: "note", key } }]);
    expect(storedRow()).toEqual(before);
  });

  test.each([
    ["publish", () => post("publish", { key })],
    ["unpublish", () => post("unpublish", { key })],
    ["retire", () => post("retire", { key })],
    ["restore", () => post("restore", { key })],
    ["rename", () => post("rename", { key, slug: "second" })],
  ])("%s asks canPublish about the stored row; a denial is 403 with no payload", async (_route, request) => {
    fake.verdicts.publish = () => ({ allowed: false, reason: "Publishers only" });
    const before = storedRow();
    const { status, body } = await call(request());
    expect(status).toBe(403);
    expect(body).toEqual({ error: { code: "forbidden", message: "Publishers only" } });
    expect(fake.calls).toEqual([{ check: "canPublish", locals: session, ref: { type: "note", key } }]);
    expect(storedRow()).toEqual(before);
  });

  test("GET documents reports each verdict and no payload", async () => {
    fake.verdicts.edit = () => ({ allowed: false, reason: "Not yours" });
    const { status, body } = await call(get(`documents?keys=${key}`));
    expect(status).toBe(200);
    expect(body.documents[key].access).toEqual({ edit: false, publish: true });
    expect(body.documents[key].payload).toBeUndefined();
  });
});

describe("a never-published invalid draft", () => {
  const key = "notes/first";
  const invalid = { title: "", tags: [] as string[] };

  beforeEach(async () => {
    await store.create("note", "first", note);
    db.prepare("UPDATE documents SET draft_payload = ? WHERE key = ?").run(JSON.stringify(invalid), key);
  });

  test("is summarised, has an empty history, and unpublish is a state error", async () => {
    const { status, body } = await call(get(`documents?keys=${key}`));
    expect(status).toBe(200);
    expect(body.documents[key]).toMatchObject({ isDraft: true, publishedAt: null });
    expect((await call(get(`revisions?key=${key}`))).body).toEqual({ revisions: [] });
    expect((await call(post("unpublish", { key }))).status).toBe(409);
  });

  test("retire and restore work, and discard removes it", async () => {
    expect((await call(post("retire", { key }))).status).toBe(200);
    expect((await call(post("restore", { key }))).status).toBe(200);
    expect((await call(post("discard", { key }))).body).toEqual({ document: null });
  });

  test("publish is 422 until a field write repairs it", async () => {
    expect((await call(post("publish", { key }))).status).toBe(422);
    expect((await call(post("field", { key, path: "tags", value: ["x"] }))).status).toBe(422);
    expect((await call(post("field", { key, path: "title", value: "Fixed" }))).status).toBe(200);
    expect((await call(post("publish", { key }))).status).toBe(200);
  });
});

describe("discard expectedVersion", () => {
  test("a stale version is 409 with the current document, and nothing is discarded", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const draft = await store.writeField("notes/first", "title", "Draft");
    const { status, body } = await call(post("discard", { key: "notes/first", expectedVersion: draft.version - 1 }));
    expect([status, body.error.code]).toEqual([409, "conflict"]);
    expect(body.error.current).toMatchObject({ version: draft.version, payload: { title: "Draft" } });
    expect((await store.get("notes/first", { draft: true }))?.isDraft).toBe(true);
  });
  test("the current version discards", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const draft = await store.writeField("notes/first", "title", "Draft");
    const { status, body } = await call(post("discard", { key: "notes/first", expectedVersion: draft.version }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: false, payload: note });
  });
});

describe("publish with at", () => {
  test("schedules the draft instead of publishing, and fires a publish change", async () => {
    await store.create("note", "first", note);
    const { status, body } = await call(post("publish", { key: "notes/first", at: "2030-01-01T09:00:00+02:00" }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, publishedAt: null, scheduledAt: "2030-01-01T07:00:00.000Z" });
    expect(fake.calls.map((entry) => entry.check)).toEqual(["canPublish"]);
    expect(events.map((event) => [event.action, event.key, event.actor])).toEqual([["publish", "notes/first", "ada"]]);
  });

  test("an at that is not an ISO datetime is 400 and nothing is scheduled", async () => {
    await store.create("note", "first", note);
    for (const at of ["tomorrow", "2030-01-01", 42]) {
      const { status, body } = await call(post("publish", { key: "notes/first", at }));
      expect([status, body.error.code]).toEqual([400, "bad_request"]);
      expect(body.error.issues).toEqual([expect.objectContaining({ path: ["at"] })]);
    }
    expect((await store.get("notes/first", { draft: true }))?.scheduledAt).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("scheduling is forbidden when canPublish denies", async () => {
    await store.create("note", "first", note);
    fake.verdicts.publish = () => ({ allowed: false, reason: "Publishers only" });
    const { status, body } = await call(post("publish", { key: "notes/first", at: "2030-01-01T00:00:00Z" }));
    expect(status).toBe(403);
    expect(body.error.message).toBe("Publishers only");
    expect((await store.get("notes/first", { draft: true }))?.scheduledAt).toBeNull();
  });

  test("a stale expectedVersion is 409 with the current document", async () => {
    await store.create("note", "first", note);
    await store.writeField("notes/first", "title", "Theirs");
    const { status, body } = await call(post("publish", { key: "notes/first", expectedVersion: 1 }));
    expect([status, body.error.code]).toEqual([409, "conflict"]);
    expect(body.error.current).toMatchObject({ version: 2, payload: { title: "Theirs" } });
  });
});

describe("unpublish", () => {
  test("takes a published document back to draft-only, gated by canPublish", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const { status, body } = await call(post("unpublish", { key: "notes/first" }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, publishedAt: null, retiredAt: null, payload: note });
    expect(fake.calls.map((entry) => entry.check)).toEqual(["canPublish"]);
    expect(events.map((event) => [event.action, event.key, event.actor])).toEqual([
      ["unpublish", "notes/first", "ada"],
    ]);
    expect((await store.revisions("notes/first")).map((revision) => revision.action)).toEqual(["publish", "unpublish"]);
  });

  test("is forbidden when canPublish denies even though canEdit allows", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    fake.verdicts.publish = () => ({ allowed: false, reason: "Publishers only" });
    const { status, body } = await call(post("unpublish", { key: "notes/first" }));
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "forbidden", message: "Publishers only" });
    expect((await store.get("notes/first"))?.isDraft).toBe(false);
    expect(events).toEqual([]);
  });

  test("a never-published document is 409 state, an unknown key 404, a bad body 400", async () => {
    await store.create("note", "first", note);
    const never = await call(post("unpublish", { key: "notes/first" }));
    expect([never.status, never.body.error.code]).toEqual([409, "state"]);
    const unknown = await call(post("unpublish", { key: "notes/none" }));
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "not_found"]);
    const malformed = await call(post("unpublish", { slug: "first" }));
    expect([malformed.status, malformed.body.error.code]).toEqual([400, "bad_request"]);
  });

  test("a stale expectedVersion is 409 conflict", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const { status, body } = await call(post("unpublish", { key: "notes/first", expectedVersion: 1 }));
    expect([status, body.error.code]).toEqual([409, "conflict"]);
    expect(body.error.current).toMatchObject({ version: 2 });
  });
});

describe("restore-revision", () => {
  test("copies a revision's payload into the draft, gated by canEdit", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const [revision] = await store.revisions("notes/first");
    await store.writeField("notes/first", "title", "Later");
    const { status, body } = await call(post("restore-revision", { key: "notes/first", revisionId: revision?.id }));
    expect(status).toBe(200);
    expect(body.document).toMatchObject({ isDraft: true, payload: note });
    expect(fake.calls.map((entry) => entry.check)).toEqual(["canEdit"]);
    expect(events.map((event) => [event.action, event.key, event.actor])).toEqual([
      ["restore_revision", "notes/first", "ada"],
    ]);
  });

  test("is forbidden when canEdit denies, and nothing is written", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const [revision] = await store.revisions("notes/first");
    await store.writeField("notes/first", "title", "Later");
    fake.verdicts.edit = () => ({ allowed: false, reason: "Editors only" });
    const { status, body } = await call(post("restore-revision", { key: "notes/first", revisionId: revision?.id }));
    expect(status).toBe(403);
    expect(body.error.message).toBe("Editors only");
    expect((await store.get("notes/first", { draft: true }))?.payload).toMatchObject({ title: "Later" });
    expect(events).toEqual([]);
  });

  test("a revision of another document, or none at all, is 404", async () => {
    await store.create("note", "first", note);
    await store.create("note", "second", note);
    await store.publish("notes/second");
    const [foreign] = await store.revisions("notes/second");
    const other = await call(post("restore-revision", { key: "notes/first", revisionId: foreign?.id }));
    expect([other.status, other.body.error.code]).toEqual([404, "not_found"]);
    const none = await call(post("restore-revision", { key: "notes/first", revisionId: 9999 }));
    expect([none.status, none.body.error.code]).toEqual([404, "not_found"]);
  });

  test("a revisionId that is not a non-negative integer is 400", async () => {
    await store.create("note", "first", note);
    for (const revisionId of ["1", 1.5, -1, undefined]) {
      const { status, body } = await call(post("restore-revision", { key: "notes/first", revisionId }));
      expect([status, body.error.code]).toEqual([400, "bad_request"]);
    }
    expect(fake.calls).toEqual([]);
  });

  test("a stale expectedVersion is 409 conflict", async () => {
    await store.create("note", "first", note);
    await store.publish("notes/first");
    const [revision] = await store.revisions("notes/first");
    const { status, body } = await call(
      post("restore-revision", { key: "notes/first", revisionId: revision?.id, expectedVersion: 1 }),
    );
    expect([status, body.error.code]).toEqual([409, "conflict"]);
  });
});

describe("publish-due", () => {
  const withPublishDue = (authorize: (locals: unknown) => AccessVerdict | Promise<AccessVerdict>) =>
    createContentHandlers({
      store,
      registry: contractRegistry,
      access: fake.access,
      locals: () => session,
      actor: (locals) => (locals as typeof session).user,
      onChange: (event) => {
        events.push(event);
      },
      publishDue: { authorize },
    });

  const schedule = async (slug: string, at: string) => {
    await store.create("note", slug, note);
    await store.publish(`notes/${slug}`, { at });
  };

  test("without the option the route is forbidden and publishes nothing", async () => {
    await schedule("first", "2030-01-01T00:00:00Z");
    const { status, body } = await call(post("publish-due", { now: "2031-01-01T00:00:00Z" }));
    expect([status, body.error.code]).toEqual([403, "forbidden"]);
    expect(await store.get("notes/first")).toBeNull();
  });

  test("publishes what is due at now, firing one publish change per document", async () => {
    await schedule("first", "2030-01-01T00:00:00Z");
    await schedule("second", "2030-06-01T00:00:00Z");
    await schedule("later", "2032-01-01T00:00:00Z");
    const seen: unknown[] = [];
    const due = withPublishDue(async (locals) => {
      seen.push(locals);
      return allowed;
    });
    const response = await due.handle(post("publish-due", { now: "2031-01-01T00:00:00Z" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: { key: string; isDraft: boolean }[] };
    expect(body.documents.map((document) => [document.key, document.isDraft])).toEqual([
      ["notes/first", false],
      ["notes/second", false],
    ]);
    expect(seen).toEqual([session]);
    expect(fake.calls).toEqual([]);
    expect(events.map((event) => [event.action, event.key, event.actor])).toEqual([
      ["publish", "notes/first", "ada"],
      ["publish", "notes/second", "ada"],
    ]);
    expect((await store.revisions("notes/first"))[0]?.actor).toBe("ada");
    expect((await store.get("notes/later", { draft: true }))?.isDraft).toBe(true);
  });

  test("an empty body uses the store clock and may publish nothing", async () => {
    await schedule("first", "2999-01-01T00:00:00Z");
    const due = withPublishDue(() => allowed);
    const response = await due.handle(post("publish-due", {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [], failed: [] });
    expect(events).toEqual([]);
  });

  test("a due document that fails is reported, the others publish, and it stays scheduled", async () => {
    await schedule("bad", "2030-01-01T00:00:00Z");
    await schedule("good", "2030-06-01T00:00:00Z");
    db.prepare("UPDATE documents SET draft_payload = ? WHERE key = 'notes/bad'").run(JSON.stringify({ title: "" }));
    const due = withPublishDue(() => allowed);
    const response = await due.handle(post("publish-due", { now: "2031-01-01T00:00:00Z" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      documents: { key: string }[];
      failed: { key: string; code: string; message: string }[];
    };
    expect(body.documents.map((document) => document.key)).toEqual(["notes/good"]);
    expect(body.failed).toEqual([
      { key: "notes/bad", code: "validation", message: expect.stringContaining("notes/bad") },
    ]);
    expect(events.map((event) => [event.action, event.key])).toEqual([["publish", "notes/good"]]);
    const row = db.prepare("SELECT scheduled_at FROM documents WHERE key = 'notes/bad'").get();
    expect(row).toEqual({ scheduled_at: "2030-01-01T00:00:00.000Z" });
  });

  test("an unexpected failure is logged and never leaks its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: ContentStore = {
      ...store,
      publishDue: async (_now, context) => {
        context?.onFailure?.("notes/first", new Error("disk on fire at /var/secret.db"));
        return [];
      },
    };
    const due = createContentHandlers({
      store: broken,
      registry: contractRegistry,
      access: fake.access,
      locals: () => session,
      publishDue: { authorize: () => allowed },
    });
    const response = await due.handle(post("publish-due", {}));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      documents: [],
      failed: [{ key: "notes/first", code: "internal", message: "Internal error" }],
    });
    expect(text).not.toContain("secret");
    expect(logged).toHaveBeenCalled();
  });

  test("a store that throws outright is still 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: ContentStore = {
      ...store,
      publishDue: async () => {
        throw new Error("disk on fire at /var/secret.db");
      },
    };
    const due = createContentHandlers({
      store: broken,
      registry: contractRegistry,
      access: fake.access,
      locals: () => session,
      publishDue: { authorize: () => allowed },
    });
    const response = await due.handle(post("publish-due", {}));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "internal", message: "Internal error" } });
  });

  test("a denying authorize is 403 with its reason", async () => {
    await schedule("first", "2030-01-01T00:00:00Z");
    const due = withPublishDue(() => ({ allowed: false, reason: "Cron only" }));
    const response = await due.handle(post("publish-due", { now: "2031-01-01T00:00:00Z" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Cron only" } });
    expect(await store.get("notes/first")).toBeNull();
  });

  test("a now that is not an ISO datetime is 400", async () => {
    const due = withPublishDue(() => allowed);
    const response = await due.handle(post("publish-due", { now: "soon" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; issues: unknown } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.issues).toEqual([expect.objectContaining({ path: ["now"] })]);
  });
});
