import { beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
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

describe("publishDue failures", () => {
  const past = "2000-01-01T00:00:00.000Z";
  const later = "2000-01-02T00:00:00.000Z";
  const latest = "2000-01-03T00:00:00.000Z";

  const schedule = async (slug: string, at: string) => {
    await store.create("note", slug, { title: slug, tags: [] });
    await store.publish(`notes/${slug}`, { at });
  };
  const corruptDraft = (key: string) =>
    db.prepare("UPDATE documents SET draft_payload = ? WHERE key = ?").run(JSON.stringify({ title: "" }), key);
  const row = (key: string) =>
    db
      .prepare<[string], { draft_payload: string | null; scheduled_at: string | null; version: number }>(
        "SELECT draft_payload, scheduled_at, version FROM documents WHERE key = ?",
      )
      .get(key);

  test("a document that fails rolls back on its own: its row is untouched and no revision is written", async () => {
    await schedule("bad", past);
    await schedule("good", later);
    corruptDraft("notes/bad");
    const before = row("notes/bad");
    const published = await store.publishDue(undefined, { onFailure: () => undefined });
    expect(published.map((doc) => doc.key)).toEqual(["notes/good"]);
    expect(row("notes/bad")).toEqual(before);
    expect(await store.revisions("notes/bad")).toEqual([]);
  });

  test("without onFailure the failure is logged with console.warn, naming the document", async () => {
    await schedule("bad", past);
    corruptDraft("notes/bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await store.publishDue()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("notes/bad");
    warn.mockRestore();
  });

  test("a migrate that throws fails only that document", async () => {
    await schedule("bad", past);
    await schedule("good", later);
    const boom = new Error("migrate blew up");
    const entry: RegistryEntry = {
      ...(contractRegistry.entry("note") as RegistryEntry),
      version: 2,
      migrate: (_from, payload) => {
        if ((payload as { title: string }).title === "bad") throw boom;
        return payload;
      },
    };
    const next = createSqliteContentStore(db, { entry: () => entry, byCollection: () => entry }, clock);
    const failures: [string, unknown][] = [];
    const published = await next.publishDue(undefined, { onFailure: (key, error) => failures.push([key, error]) });
    expect(published.map((doc) => doc.key)).toEqual(["notes/good"]);
    expect(failures).toEqual([["notes/bad", boom]]);
  });

  /** A store at version 2 whose `migrate` runs `act` when it reaches the document titled "broken". */
  const onBroken = (act: () => void) => {
    const entry: RegistryEntry = {
      ...(contractRegistry.entry("note") as RegistryEntry),
      version: 2,
      migrate: (_from, payload) => {
        if ((payload as { title: string }).title === "broken") act();
        return payload;
      },
    };
    return createSqliteContentStore(db, { entry: () => entry, byCollection: () => entry }, clock);
  };

  test("a real database failure stops the run: the rest are reported and stay scheduled, earlier publishes are kept", async () => {
    await schedule("first", past);
    await schedule("broken", later);
    await schedule("after", latest);
    await schedule("last", "2000-01-04T00:00:00.000Z");
    // Writes then fail with a genuine SQLITE_READONLY.
    const next = onBroken(() => db.pragma("query_only = ON"));
    const failures: [string, unknown][] = [];
    const published = await next.publishDue(undefined, { onFailure: (key, error) => failures.push([key, error]) });
    db.pragma("query_only = OFF");

    expect(published.map((doc) => doc.key)).toEqual(["notes/first"]);
    expect(failures.map(([key]) => key)).toEqual(["notes/broken", "notes/after", "notes/last"]);
    expect(failures[0]?.[1]).toMatchObject({ name: "SqliteError", code: "SQLITE_READONLY" });
    expect(failures[1]?.[1]).toBe(failures[0]?.[1]);
    expect(failures[2]?.[1]).toBe(failures[0]?.[1]);
    expect(row("notes/broken")?.scheduled_at).toBe(later);
    expect(row("notes/after")?.scheduled_at).toBe(latest);

    const retried = await store.publishDue();
    expect(retried.map((doc) => doc.key)).toEqual(["notes/broken", "notes/after", "notes/last"]);
  });

  test.each([
    "SQLITE_BUSY",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED",
    "SQLITE_LOCKED_SHAREDCACHE",
    "SQLITE_IOERR",
    "SQLITE_IOERR_WRITE",
    "SQLITE_CORRUPT",
    "SQLITE_CORRUPT_INDEX",
    "SQLITE_FULL",
    "SQLITE_NOTADB",
    "SQLITE_READONLY",
    "SQLITE_READONLY_DBMOVED",
    "SQLITE_CANTOPEN",
  ])("%s stops the run and reports every remaining document", async (code) => {
    await schedule("broken", past);
    await schedule("after", later);
    const failure = new Database.SqliteError("database-wide", code);
    const failures: [string, unknown][] = [];
    const published = await onBroken(() => {
      throw failure;
    }).publishDue(undefined, { onFailure: (key, error) => failures.push([key, error]) });
    expect(published).toEqual([]);
    expect(failures).toEqual([
      ["notes/broken", failure],
      ["notes/after", failure],
    ]);
    expect(row("notes/after")?.scheduled_at).toBe(later);
    expect(await store.revisions("notes/after")).toEqual([]);
  });

  test.each([
    "SQLITE_CONSTRAINT",
    "SQLITE_CONSTRAINT_CHECK",
    "SQLITE_CONSTRAINT_UNIQUE",
    "SQLITE_TOOBIG",
    "SQLITE_ERROR",
  ])("%s reports only that document and the run continues", async (code) => {
    await schedule("broken", past);
    await schedule("after", later);
    const failure = new Database.SqliteError("this document", code);
    const failures: [string, unknown][] = [];
    const published = await onBroken(() => {
      throw failure;
    }).publishDue(undefined, { onFailure: (key, error) => failures.push([key, error]) });
    expect(published.map((doc) => doc.key)).toEqual(["notes/after"]);
    expect(failures).toEqual([["notes/broken", failure]]);
  });

  test("a real constraint failure on one document does not stop the run", async () => {
    await schedule("first", past);
    await schedule("broken", later);
    await schedule("after", latest);
    db.exec(
      "CREATE TRIGGER refuse BEFORE UPDATE OF published_payload ON documents WHEN NEW.key = 'notes/broken' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const failures: [string, unknown][] = [];
    const published = await store.publishDue(undefined, { onFailure: (key, error) => failures.push([key, error]) });
    expect(published.map((doc) => doc.key)).toEqual(["notes/first", "notes/after"]);
    expect(failures).toEqual([
      ["notes/broken", expect.objectContaining({ name: "SqliteError", code: "SQLITE_CONSTRAINT_TRIGGER" })],
    ]);
    expect(row("notes/broken")?.scheduled_at).toBe(later);
  });

  test("an onFailure that throws while the run stops still reaches every remaining document", async () => {
    await schedule("broken", past);
    await schedule("after", later);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: string[] = [];
    await onBroken(() => {
      throw new Database.SqliteError("disk full", "SQLITE_FULL");
    }).publishDue(undefined, {
      onFailure: (key) => {
        seen.push(key);
        throw new Error("hook broke");
      },
    });
    expect(seen).toEqual(["notes/broken", "notes/after"]);
    warn.mockRestore();
  });

  test("a row no longer due when its transaction starts is skipped", async () => {
    await schedule("bad", past);
    await schedule("moved", later);
    corruptDraft("notes/bad");
    const onFailure = () => {
      // Another process reschedules the second document between the due query and its transaction.
      db.prepare("UPDATE documents SET scheduled_at = ? WHERE key = 'notes/moved'").run("2999-01-01T00:00:00.000Z");
    };
    expect(await store.publishDue(undefined, { onFailure })).toEqual([]);
    expect(await store.revisions("notes/moved")).toEqual([]);
    expect(row("notes/moved")?.draft_payload).not.toBeNull();
  });

  test("an onFailure that throws does not lose the run", async () => {
    await schedule("bad", past);
    await schedule("good", later);
    corruptDraft("notes/bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const published = await store.publishDue(undefined, {
      onFailure: () => {
        throw new Error("hook broke");
      },
    });
    expect(published.map((doc) => doc.key)).toEqual(["notes/good"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a draft write beside a published payload that cannot be read", () => {
  const published = { title: "Live", tags: [] as string[] };
  const fresh = { title: "Fresh", tags: ["x"] };
  const malformed = "{not json";
  const publishedColumn = () =>
    db.prepare<[], { published_payload: string | null }>("SELECT published_payload FROM documents").get()
      ?.published_payload;
  const versionColumn = () =>
    db.prepare<[], { payload_version: number }>("SELECT payload_version FROM documents").get()?.payload_version;
  /** The shipped schema's CHECK refuses malformed JSON, so a damaged row has to bypass it. It is back on for the write. */
  const corruptPublished = () => {
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE documents SET published_payload = ? WHERE key = 'notes/first'").run(malformed);
    db.pragma("ignore_check_constraints = OFF");
  };

  /** A store at version 2 whose `migrate` refuses the published payload and passes anything else through. */
  const refusing = () => {
    const entry: RegistryEntry = {
      ...(contractRegistry.entry("note") as RegistryEntry),
      version: 2,
      migrate: (_from, payload) => {
        if ((payload as { title: string }).title === published.title) throw new Error("migrate blew up");
        return payload;
      },
    };
    return createSqliteContentStore(db, { entry: () => entry, byCollection: () => entry }, clock);
  };

  /** Publishes `fresh`, then publishes `published` over it, so a valid revision of `fresh` can be restored. */
  const withRevisionOfFresh = async () => {
    await store.create("note", "first", fresh);
    await store.publish("notes/first");
    const [revision] = await store.revisions("notes/first");
    await store.writeField("notes/first", "title", published.title);
    await store.writeField("notes/first", "tags", []);
    await store.publish("notes/first");
    return revision?.id as number;
  };

  test("restoreRevision succeeds over malformed published JSON, which stays as stored", async () => {
    const revisionId = await withRevisionOfFresh();
    corruptPublished();
    const restored = await store.restoreRevision("notes/first", revisionId);
    expect(restored).toMatchObject({ isDraft: true, payload: fresh });
    expect(publishedColumn()).toBe(malformed);
  });

  test("restoreRevision succeeds when migrate throws on the published payload, which stays as stored", async () => {
    const revisionId = await withRevisionOfFresh();
    const before = publishedColumn();
    const restored = await refusing().restoreRevision("notes/first", revisionId);
    expect(restored).toMatchObject({ isDraft: true, payload: fresh });
    expect(publishedColumn()).toBe(before);
    expect(versionColumn()).toBe(2);
  });

  test("a migrate that returns nothing leaves the published payload as stored", async () => {
    await store.create("note", "first", published);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    const before = publishedColumn();
    const entry: RegistryEntry = {
      ...(contractRegistry.entry("note") as RegistryEntry),
      version: 2,
      migrate: (_from, payload) => ((payload as { title: string }).title === published.title ? undefined : payload),
    };
    const next = createSqliteContentStore(db, { entry: () => entry, byCollection: () => entry }, clock);
    expect((await next.writeField("notes/first", "title", "Next")).payload).toMatchObject({ title: "Next" });
    expect(publishedColumn()).toBe(before);
  });

  test("a stale published payload that does migrate is still migrated in the same write", async () => {
    await store.create("note", "first", published);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    const entry: RegistryEntry = {
      ...(contractRegistry.entry("note") as RegistryEntry),
      version: 2,
      migrate: (_from, payload) => ({ ...(payload as object), tags: ["migrated"] }),
    };
    const next = createSqliteContentStore(db, { entry: () => entry, byCollection: () => entry }, clock);
    await next.writeField("notes/first", "title", "Next");
    expect(JSON.parse(publishedColumn() as string)).toEqual({ title: "Live", tags: ["migrated"] });
    expect(versionColumn()).toBe(2);
  });

  test("writeField and arrayOp over a valid draft succeed beside malformed published JSON", async () => {
    await store.create("note", "first", published);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    corruptPublished();
    expect((await store.writeField("notes/first", "title", "Field")).payload).toMatchObject({ title: "Field" });
    const inserted = await store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "x" });
    expect(inserted.payload).toEqual({ title: "Field", tags: ["x"] });
    expect(publishedColumn()).toBe(malformed);
  });

  test("a write whose own result is invalid is refused and changes nothing, beside malformed published JSON", async () => {
    await store.create("note", "first", published);
    await store.publish("notes/first");
    await store.writeField("notes/first", "title", "Draft");
    corruptPublished();
    const before = db.prepare("SELECT * FROM documents").get();
    await expect(store.writeField("notes/first", "title", "")).rejects.toThrow(ContentValidationError);
    expect(db.prepare("SELECT * FROM documents").get()).toEqual(before);
  });

  test("with no draft and malformed published JSON, a field write has nothing to edit and is refused", async () => {
    await store.create("note", "first", published);
    await store.publish("notes/first");
    corruptPublished();
    await expect(store.writeField("notes/first", "title", "Field")).rejects.toThrow(ContentValidationError);
    expect(publishedColumn()).toBe(malformed);
  });
});

describe("unvalidated reads of a damaged row", () => {
  test("a document of an unregistered type is readable, for its identity", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET type = 'poster' WHERE key = ?").run("notes/first");
    expect(await store.get("notes/first", { draft: true, unvalidated: true })).toMatchObject({
      type: "poster",
      payload: { title: "A", tags: [] },
    });
  });
  test("a retire of a document of an unregistered type still works", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET type = 'poster' WHERE key = ?").run("notes/first");
    expect((await store.retire("notes/first")).retiredAt).not.toBeNull();
  });
  test("a malformed previous_slugs is not a payload problem and still throws", async () => {
    await store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET previous_slugs = ? WHERE key = ?").run('{"a":1}', "notes/first");
    await expect(store.get("notes/first", { draft: true, unvalidated: true })).rejects.toThrow(ContentValidationError);
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
