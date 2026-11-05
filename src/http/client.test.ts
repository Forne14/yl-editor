import type Database from "better-sqlite3";
import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { contractRegistry } from "../contract.ts";
import { createSqliteContentStore } from "../sqlite-store.ts";
import { makeTestDb } from "../test-support.ts";
import type { Access, AccessVerdict, ContentStore } from "../types.ts";
import { ContentRequestError, createContentClient, type ContentClient } from "./client.ts";
import { createContentHandlers } from "./handlers.ts";
import type { DocumentForPublishResponse, DocumentResponse, WireDocument } from "./wire-types.ts";

const note = { title: "A", tags: [] as string[] };

let db: Database.Database;
let store: ContentStore;
let client: ContentClient;
let publishVerdict: AccessVerdict;
let editVerdict: AccessVerdict;
let dueVerdict: AccessVerdict;
let seenHeaders: Headers[];
let seenRequests: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  db = makeTestDb();
  store = createSqliteContentStore(db, contractRegistry);
  publishVerdict = { allowed: true };
  editVerdict = { allowed: true };
  dueVerdict = { allowed: true };
  seenHeaders = [];
  seenRequests = [];
  const access: Access = { canEdit: () => editVerdict, canPublish: () => publishVerdict };
  const handlers = createContentHandlers({
    store,
    registry: contractRegistry,
    access,
    locals: () => ({ user: "grace" }),
    actor: (locals) => (locals as { user: string }).user,
    publishDue: { authorize: () => dueVerdict },
  });
  client = createContentClient({
    base: "http://host/api/content/",
    fetch: (input, init) => {
      const request = new Request(input, init);
      seenHeaders.push(request.headers);
      seenRequests.push({
        method: request.method,
        url: request.url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return handlers.handle(request);
    },
  });
});

describe("content client round trip", () => {
  test("create, edit, publish, rename and read back", async () => {
    const created = await client.create("note", "first", note);
    expect(created).toMatchObject({ key: "notes/first", version: 1 });
    const titled = await client.field("notes/first", "title", "B", created.version);
    expect(titled.payload).toEqual({ title: "B", tags: [] });
    const tagged = await client.array("notes/first", "tags", { kind: "insert", index: 0, value: "x" });
    expect(tagged.payload).toEqual({ title: "B", tags: ["x"] });
    const published = await client.publish("notes/first");
    expect(published.isDraft).toBe(false);
    const renamed = await client.rename("notes/first", "second");
    expect(renamed.key).toBe("notes/second");

    const documents = await client.documents(["notes/second", "notes/none"]);
    expect(Object.keys(documents)).toEqual(["notes/second"]);
    expect(documents["notes/second"]?.access).toEqual({ edit: true, publish: true });

    const revisions = await client.revisions("notes/second");
    expect(revisions.map((revision) => [revision.action, revision.actor])).toEqual([
      ["publish", "grace"],
      ["rename", "grace"],
    ]);
  });

  test("retire, restore and discard", async () => {
    await client.create("note", "first", note);
    await client.publish("notes/first");
    expect((await client.retire("notes/first")).retiredAt).not.toBeNull();
    expect((await client.restore("notes/first")).retiredAt).toBeNull();
    await client.field("notes/first", "title", "Draft");
    expect((await client.discard("notes/first"))?.payload).toEqual(note);
    await client.create("note", "draft-only", note);
    expect(await client.discard("notes/draft-only")).toBeNull();
  });

  test("an empty key list asks nothing of the server", async () => {
    expect(await client.documents([])).toEqual({});
    expect(seenHeaders).toEqual([]);
  });

  test("every request carries the CSRF header", async () => {
    await client.documents(["notes/none"]);
    await client.create("note", "first", note);
    expect(seenHeaders.map((headers) => headers.get("X-Requested-With"))).toEqual(["yl-editor", "yl-editor"]);
  });

  test("a conflict throws ContentRequestError carrying the current document", async () => {
    await client.create("note", "first", note);
    await client.field("notes/first", "title", "Theirs");
    const failure = await client.field("notes/first", "title", "Mine", 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentRequestError);
    const requestError = failure as ContentRequestError;
    expect(requestError.status).toBe(409);
    expect(requestError.code).toBe("conflict");
    expect(requestError.current).toMatchObject({ version: 2, payload: { title: "Theirs", tags: [] } });
  });

  test("a denial throws forbidden with the reason, validation carries issues", async () => {
    await client.create("note", "first", note);
    publishVerdict = { allowed: false, reason: "Publishers only" };
    await expect(client.publish("notes/first")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "Publishers only",
    });
    const invalid = await client.field("notes/first", "title", "").catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 422, code: "validation" });
    expect((invalid as ContentRequestError).issues).toBeInstanceOf(Array);
  });

  test("a response without an envelope still throws a ContentRequestError", async () => {
    const bare = createContentClient({ fetch: async () => new Response("Bad gateway", { status: 502 }) });
    await expect(bare.publish("notes/first")).rejects.toMatchObject({ status: 502, code: "internal" });
  });
});

describe("content client lifecycle verbs", () => {
  test("document reads one document, draft view, and 404s on an unknown key", async () => {
    await client.create("note", "first", note);
    await client.field("notes/first", "title", "B");
    expect(await client.document("notes/first")).toMatchObject({ key: "notes/first", payload: { title: "B" } });
    expect(seenRequests.at(-1)).toMatchObject({
      method: "GET",
      url: "http://host/api/content/document?key=notes%2Ffirst",
    });
    await expect(client.document("notes/none")).rejects.toMatchObject({ status: 404, code: "not_found" });
    editVerdict = { allowed: false, reason: "Not yours" };
    await expect(client.document("notes/first")).rejects.toMatchObject({ status: 403, message: "Not yours" });
  });

  test("documentForPublish hits the document route and returns the draft beside the published payload", async () => {
    await client.create("note", "first", note);
    expect(await client.documentForPublish("notes/first")).toMatchObject({
      document: { key: "notes/first", payload: note },
      publishedPayload: null,
    });
    await client.publish("notes/first");
    await client.field("notes/first", "title", "B");
    const read = await client.documentForPublish("notes/first");
    expect(seenRequests.at(-1)).toMatchObject({
      method: "GET",
      url: "http://host/api/content/document?key=notes%2Ffirst",
    });
    expect(read.document.payload).toEqual({ title: "B", tags: [] });
    expect(read.publishedPayload).toEqual(note);
    expect(await client.document("notes/first")).toEqual(read.document);
    await expect(client.documentForPublish("notes/none")).rejects.toMatchObject({ status: 404, code: "not_found" });
    editVerdict = { allowed: false, reason: "Not yours" };
    await expect(client.documentForPublish("notes/first")).rejects.toMatchObject({ status: 403, message: "Not yours" });
  });

  test("publish with at schedules; without at the body stays { key }", async () => {
    await client.create("note", "first", note);
    const scheduled = await client.publish("notes/first", { at: "2030-01-01T00:00:00Z" });
    expect(scheduled).toMatchObject({ isDraft: true, scheduledAt: "2030-01-01T00:00:00.000Z" });
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", at: "2030-01-01T00:00:00Z" });
    const invalid = await client.publish("notes/first", { at: "soon" }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 400, code: "bad_request" });
    expect((await client.publish("notes/first", {})).isDraft).toBe(false);
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first" });
  });

  test("unpublish returns the draft-only document and surfaces state and forbidden errors", async () => {
    await client.create("note", "first", note);
    await expect(client.unpublish("notes/first")).rejects.toMatchObject({ status: 409, code: "state" });
    await client.publish("notes/first");
    publishVerdict = { allowed: false, reason: "Publishers only" };
    await expect(client.unpublish("notes/first")).rejects.toMatchObject({ status: 403, code: "forbidden" });
    publishVerdict = { allowed: true };
    expect(await client.unpublish("notes/first")).toMatchObject({ isDraft: true, publishedAt: null });
  });

  test("restoreRevision copies a revision into the draft and 404s on an unknown revision", async () => {
    await client.create("note", "first", note);
    await client.publish("notes/first");
    await client.field("notes/first", "title", "Later");
    const [revision] = await client.revisions("notes/first");
    const restored = await client.restoreRevision("notes/first", revision?.id ?? -1);
    expect(restored).toMatchObject({ isDraft: true, payload: note });
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", revisionId: revision?.id });
    await expect(client.restoreRevision("notes/first", 9999)).rejects.toMatchObject({ status: 404 });
    expect((await client.revisions("notes/first")).map((entry) => [entry.action, entry.actor])).toEqual([
      ["publish", "grace"],
      ["restore_revision", "grace"],
    ]);
  });

  test("publishDue returns the published documents and honours the authorize verdict", async () => {
    await client.create("note", "first", note);
    await client.publish("notes/first", { at: "2030-01-01T00:00:00Z" });
    dueVerdict = { allowed: false, reason: "Cron only" };
    await expect(client.publishDue("2031-01-01T00:00:00Z")).rejects.toMatchObject({
      status: 403,
      message: "Cron only",
    });
    dueVerdict = { allowed: true };
    expect(await client.publishDue("2029-01-01T00:00:00Z")).toEqual({ documents: [], failed: [] });
    const { documents, failed } = await client.publishDue("2031-01-01T00:00:00Z");
    expect(documents.map((document) => [document.key, document.isDraft])).toEqual([["notes/first", false]]);
    expect(failed).toEqual([]);
    expect(seenRequests.at(-1)?.body).toEqual({ now: "2031-01-01T00:00:00Z" });
    expect(await client.publishDue()).toEqual({ documents: [], failed: [] });
    expect(seenRequests.at(-1)).toMatchObject({ method: "POST", body: {} });
  });

  test("publishDue returns the documents that failed beside the ones that published", async () => {
    await client.create("note", "bad", note);
    await client.create("note", "good", note);
    await client.publish("notes/bad", { at: "2030-01-01T00:00:00Z" });
    await client.publish("notes/good", { at: "2030-01-02T00:00:00Z" });
    db.prepare("UPDATE documents SET draft_payload = ? WHERE key = 'notes/bad'").run(JSON.stringify({ title: "" }));
    const { documents, failed } = await client.publishDue("2031-01-01T00:00:00Z");
    expect(documents.map((document) => document.key)).toEqual(["notes/good"]);
    expect(failed).toEqual([{ key: "notes/bad", code: "validation", message: expect.any(String) }]);
  });
});

describe("content client expectedVersion", () => {
  const conflict = { status: 409, code: "conflict" };
  let stale: number;
  let current: number;

  beforeEach(async () => {
    const created = await client.create("note", "first", note);
    stale = created.version;
    await client.publish("notes/first");
    current = (await client.field("notes/first", "title", "Draft")).version;
  });

  test("publish sends it, alone or with at, and a stale one is a conflict", async () => {
    const failure = await client.publish("notes/first", { expectedVersion: stale }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentRequestError);
    expect(failure).toMatchObject({ ...conflict, current: { version: current } });
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", expectedVersion: stale });
    await expect(
      client.publish("notes/first", { at: "2030-01-01T00:00:00Z", expectedVersion: stale }),
    ).rejects.toMatchObject(conflict);
    expect(seenRequests.at(-1)?.body).toEqual({
      key: "notes/first",
      at: "2030-01-01T00:00:00Z",
      expectedVersion: stale,
    });
    expect((await client.publish("notes/first", { expectedVersion: current })).isDraft).toBe(false);
  });

  test("unpublish sends it, and a stale one is a conflict", async () => {
    await expect(client.unpublish("notes/first", { expectedVersion: stale })).rejects.toMatchObject(conflict);
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", expectedVersion: stale });
    expect((await client.unpublish("notes/first", { expectedVersion: current })).publishedAt).toBeNull();
  });

  test("restoreRevision sends it, and a stale one is a conflict", async () => {
    const [revision] = await client.revisions("notes/first");
    const revisionId = revision?.id ?? -1;
    await expect(client.restoreRevision("notes/first", revisionId, { expectedVersion: stale })).rejects.toMatchObject(
      conflict,
    );
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", revisionId, expectedVersion: stale });
    const restored = await client.restoreRevision("notes/first", revisionId, { expectedVersion: current });
    expect(restored.payload).toEqual(note);
  });

  test("discard sends it, and a stale one is a conflict", async () => {
    await expect(client.discard("notes/first", { expectedVersion: stale })).rejects.toMatchObject(conflict);
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first", expectedVersion: stale });
    expect(await client.discard("notes/first", { expectedVersion: current })).toMatchObject({ isDraft: false });
  });

  test("without options the body carries only what it did before", async () => {
    await client.unpublish("notes/first");
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first" });
    await client.discard("notes/first");
    expect(seenRequests.at(-1)?.body).toEqual({ key: "notes/first" });
  });
});

describe("response types", () => {
  test("DocumentResponse is the POST shape; documentForPublish returns its own type", () => {
    expectTypeOf<DocumentResponse>().toEqualTypeOf<{ document: WireDocument }>();
    expectTypeOf<DocumentForPublishResponse>().toEqualTypeOf<{
      document: WireDocument;
      publishedPayload: unknown | null;
    }>();
    expectTypeOf<ContentClient["documentForPublish"]>().returns.resolves.toEqualTypeOf<DocumentForPublishResponse>();
  });
});
