import { beforeEach, describe, expect, test } from "vitest";
import { contractRegistry } from "../contract.ts";
import { createSqliteContentStore } from "../sqlite-store.ts";
import { makeTestDb } from "../test-support.ts";
import type { Access, AccessVerdict, ContentStore } from "../types.ts";
import { ContentRequestError, createContentClient, type ContentClient } from "./client.ts";
import { createContentHandlers } from "./handlers.ts";

const note = { title: "A", tags: [] as string[] };

let store: ContentStore;
let client: ContentClient;
let publishVerdict: AccessVerdict;
let seenHeaders: Headers[];

beforeEach(() => {
  store = createSqliteContentStore(makeTestDb(), contractRegistry);
  publishVerdict = { allowed: true };
  seenHeaders = [];
  const access: Access = { canEdit: () => ({ allowed: true }), canPublish: () => publishVerdict };
  const handlers = createContentHandlers({
    store,
    registry: contractRegistry,
    access,
    locals: () => ({ user: "grace" }),
    actor: (locals) => (locals as { user: string }).user,
  });
  client = createContentClient({
    base: "http://host/api/content/",
    fetch: (input, init) => {
      const request = new Request(input, init);
      seenHeaders.push(request.headers);
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
