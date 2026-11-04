import { beforeEach, describe, expect, test, vi } from "vitest";
import type Database from "better-sqlite3";
import { contractRegistry, runContentStoreContract } from "./contract.ts";
import { createSqliteContentStore } from "./sqlite-store.ts";
import { makeTestDb } from "./test-support.ts";
import {
  ContentValidationError,
  PathError,
  type ContentStore,
  type RegistryEntry,
  type SchemaRegistry,
} from "./types.ts";

let contractDb: Database.Database;
runContentStoreContract("sqlite", () => createSqliteContentStore((contractDb = makeTestDb()), contractRegistry), {
  reopen: (registry, hooks) => createSqliteContentStore(contractDb, registry, undefined, hooks),
});

let db: Database.Database;
let store: ContentStore;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++));

beforeEach(() => {
  db = makeTestDb();
  tick = 0;
  store = createSqliteContentStore(db, contractRegistry, clock);
});

describe("migrations", () => {
  test("every migration applies: documents carry version, revisions carry actor", () => {
    const documentColumns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
    const revisionColumns = db.prepare<[], { name: string }>("PRAGMA table_info(revisions)").all();
    expect(documentColumns.map((column) => column.name)).toContain("version");
    expect(revisionColumns.map((column) => column.name)).toContain("actor");
  });
  test("a row written before 0002 reads as version 0 and accepts expectedVersion 0", async () => {
    db.prepare(
      "INSERT INTO documents (key, type, slug, draft_payload, created_at) VALUES ('notes/legacy', 'note', 'legacy', ?, '2026-01-01T00:00:00.000Z')",
    ).run(JSON.stringify({ title: "Old", tags: [] }));
    expect((await store.get("notes/legacy", { draft: true }))?.version).toBe(0);
    expect((await store.publish("notes/legacy", { expectedVersion: 0 })).version).toBe(1);
  });
});

describe("migration 0004", () => {
  test("documents gain scheduled_at and the revisions CHECK accepts the new actions", () => {
    const columns = db.prepare<[], { name: string }>("PRAGMA table_info(documents)").all();
    expect(columns.map((column) => column.name)).toContain("scheduled_at");
    db.prepare(
      "INSERT INTO documents (key, type, slug, draft_payload, created_at) VALUES ('notes/x', 'note', 'x', '{}', 'now')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO revisions (document_id, action, slug, payload, created_at) VALUES (1, ?, 'x', '{}', 'now')",
    );
    expect(() => insert.run("unpublish")).not.toThrow();
    expect(() => insert.run("restore_revision")).not.toThrow();
    expect(() => insert.run("bogus")).toThrow(/CHECK/);
  });
  test("the revisions index survives the rebuild", () => {
    const indexes = db.prepare<[], { name: string }>("PRAGMA index_list(revisions)").all();
    expect(indexes.map((index) => index.name)).toContain("revisions_document_idx");
  });
});

describe("lifecycle timestamps", () => {
  test("publish with at does not stamp publishedAt; publishDue stamps it from the clock", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first", { at: "2026-10-14T12:30:00Z" });
    expect(db.prepare("SELECT scheduled_at FROM documents").pluck().get()).toBe("2026-10-14T12:30:00.000Z");
    const [doc] = await store.publishDue("2026-10-14T12:30:00.000Z");
    expect(doc?.publishedAt).toBe("2026-10-14T12:00:01.000Z");
  });
  test("publishDue defaults to the store clock", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first", { at: "2026-10-14T12:00:30.000Z" });
    expect(await store.publishDue()).toEqual([]);
    store = createSqliteContentStore(db, contractRegistry, () => new Date("2026-10-14T12:01:00Z"));
    expect(await store.publishDue()).toHaveLength(1);
  });
  test("an unparseable at is refused", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await expect(store.publish("notes/first", { at: "soon" })).rejects.toThrow(/ISO/);
  });
});

describe("timestamps come from the injected clock", () => {
  test("publish stamps publishedAt and the revision from the clock", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    const doc = await store.publish("notes/first");
    expect(doc.publishedAt).toBe("2026-10-14T12:00:01.000Z");
    expect((await store.revisions("notes/first"))[0]?.createdAt).toBe("2026-10-14T12:00:02.000Z");
  });
});

describe("reads validate (Review Focus 1)", () => {
  test("a stored payload that no longer matches the schema throws naming the key", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first");
    db.prepare("UPDATE documents SET published_payload = ? WHERE key = ?").run(
      JSON.stringify({ title: 1 }),
      "notes/first",
    );
    await expect(store.get("notes/first", { draft: true })).rejects.toThrow(/notes\/first/);
    await expect(store.list("note", { draft: true })).rejects.toThrow(ContentValidationError);
  });
  test("a public read serves the stored payload and reports through onReadIssue", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first");
    db.prepare("UPDATE documents SET published_payload = ? WHERE key = ?").run(
      JSON.stringify({ title: 1 }),
      "notes/first",
    );
    const reported: string[] = [];
    const lenient = createSqliteContentStore(db, contractRegistry, clock, { onReadIssue: (key) => reported.push(key) });
    expect((await lenient.get("notes/first"))?.payload).toEqual({ title: 1 });
    expect(reported).toEqual(["notes/first"]);
  });
  test("the default onReadIssue warns once per key", async () => {
    await store.create("note", "warned", { title: "A", tags: [] });
    await store.publish("notes/warned");
    db.prepare("UPDATE documents SET published_payload = ? WHERE key = ?").run(
      JSON.stringify({ title: 1 }),
      "notes/warned",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.get("notes/warned");
    await store.get("notes/warned");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("payload_version", () => {
  const versionOf = (key: string) =>
    db.prepare<[string], { payload_version: number }>("SELECT payload_version FROM documents WHERE key = ?").get(key)
      ?.payload_version;
  const v3: RegistryEntry = { ...(contractRegistry.entry("note") as RegistryEntry), version: 3 };
  const v3Registry: SchemaRegistry = {
    entry: () => v3,
    byCollection: () => v3,
    entries: () => [v3],
  };

  test("rows default to 1 and writes stamp the entry's version", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    expect(versionOf("notes/first")).toBe(1);
    const next = createSqliteContentStore(db, v3Registry, clock);
    await next.writeField("notes/first", "title", "B");
    expect(versionOf("notes/first")).toBe(3);
    await next.create("note", "second", { title: "S", tags: [] });
    expect(versionOf("notes/second")).toBe(3);
  });
  test("publish stamps the entry's version", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await createSqliteContentStore(db, v3Registry, clock).publish("notes/first");
    expect(versionOf("notes/first")).toBe(3);
  });
  test("reads never write back", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first");
    const before = db.prepare("SELECT * FROM documents WHERE key = 'notes/first'").get();
    await createSqliteContentStore(db, v3Registry, clock).get("notes/first");
    expect(db.prepare("SELECT * FROM documents WHERE key = 'notes/first'").get()).toEqual(before);
  });
});

describe("editor writes that miss leave the stored row byte-identical (Review Focus 2)", () => {
  beforeEach(async () => {
    await store.create("note", "first", { title: "A", tags: ["x"] });
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "B");
  });
  const draftRow = () =>
    db.prepare("SELECT draft_payload, draft_updated_at, version FROM documents WHERE key = ?").get("notes/first");
  test("writeField to a missing parent leaves the stored draft unchanged", async () => {
    const before = draftRow();
    await expect(store.writeField("notes/first", "meta.title", "y")).rejects.toThrow(PathError);
    await expect(store.writeField("notes/first", "tags.9", "y")).rejects.toThrow(PathError);
    expect(draftRow()).toEqual(before);
  });
  test("arrayOp out of range leaves the stored draft unchanged", async () => {
    const before = draftRow();
    await expect(store.arrayOp("notes/first", "tags", { kind: "remove", index: 5 })).rejects.toThrow(PathError);
    await expect(store.arrayOp("notes/first", "tags", { kind: "insert", index: 9, value: "z" })).rejects.toThrow(
      PathError,
    );
    expect(draftRow()).toEqual(before);
  });
});

describe("malformed JSON columns", () => {
  test("a bad previous_slugs column throws naming the key", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET previous_slugs = ? WHERE key = ?").run('{"a":1}', "notes/first");
    await expect(store.get("notes/first", { draft: true })).rejects.toThrow(/notes\/first.*previous_slugs/);
    await expect(store.get("notes/first", { draft: true })).rejects.toThrow(ContentValidationError);
  });
  test("a stored document of an unregistered type throws ContentValidationError naming the key", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET type = 'poster' WHERE key = ?").run("notes/first");
    await expect(store.get("notes/first", { draft: true })).rejects.toThrow(ContentValidationError);
    await expect(store.get("notes/first", { draft: true })).rejects.toThrow(/notes\/first/);
  });
  test("a rename whose previous_slugs column is malformed rolls back with no revision", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    await store.publish("notes/first");
    db.prepare("UPDATE documents SET previous_slugs = ? WHERE key = ?").run('"oops"', "notes/first");
    await expect(store.rename("notes/first", "second")).rejects.toThrow(ContentValidationError);
    const row = db.prepare<[], { key: string; version: number }>("SELECT key, version FROM documents").get();
    expect(row).toEqual({ key: "notes/first", version: 2 });
    expect(db.prepare("SELECT count(*) AS total FROM revisions").get()).toEqual({ total: 1 });
  });
});
