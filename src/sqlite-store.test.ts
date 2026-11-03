import { beforeEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { createSqliteContentStore } from "./sqlite-store";
import { makeTestDb, testRegistry } from "./test-support";
import {
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  type ContentStore,
} from "./types";

let db: Database.Database;
let store: ContentStore;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++));

beforeEach(() => {
  db = makeTestDb();
  tick = 0;
  store = createSqliteContentStore(db, testRegistry, clock);
});

describe("create and get", () => {
  test("create stores a draft keyed by collection/slug", () => {
    const doc = store.create("note", "first", { title: "A", tags: [] });
    expect(doc.key).toBe("notes/first");
    expect(doc.isDraft).toBe(true);
  });
  test("a draft-only document is invisible to published reads", () => {
    store.create("note", "first", { title: "A", tags: [] });
    expect(store.get("notes/first")).toBeNull();
    expect(store.get("notes/first", { draft: true })?.payload).toEqual({ title: "A", tags: [] });
  });
  test("create validates the payload", () =>
    expect(() => store.create("note", "bad", { title: "", tags: [] })).toThrow(ContentValidationError));
  test("create refuses an unknown type", () =>
    expect(() => store.create("poster", "x", {})).toThrow(/Unknown document type/));
  test("create refuses a bad slug", () =>
    expect(() => store.create("note", "Bad Slug", { title: "A", tags: [] })).toThrow(/slug/));
  test("create refuses a duplicate key", () => {
    store.create("note", "first", { title: "A", tags: [] });
    expect(() => store.create("note", "first", { title: "B", tags: [] })).toThrow(DocumentStateError);
  });
});

describe("writeField", () => {
  beforeEach(() => {
    store.create("note", "first", { title: "A", tags: ["x"] });
    store.publish("notes/first");
  });
  test("writes into a new draft and leaves published untouched", () => {
    store.writeField("notes/first", "title", "B");
    expect(store.get("notes/first")?.payload).toEqual({ title: "A", tags: ["x"] });
    expect(store.get("notes/first", { draft: true })?.payload).toEqual({ title: "B", tags: ["x"] });
  });
  test("an invalid value is refused and the stored draft is unchanged", () => {
    store.writeField("notes/first", "title", "B");
    expect(() => store.writeField("notes/first", "title", "")).toThrow(ContentValidationError);
    expect(store.get("notes/first", { draft: true })?.payload).toEqual({ title: "B", tags: ["x"] });
  });
  test("a path that does not exist is refused and nothing is written", () => {
    expect(() => store.writeField("notes/first", "tags.4", "y")).toThrow(PathError);
    expect(store.get("notes/first", { draft: true })?.isDraft).toBe(false);
  });
  test("unknown document", () =>
    expect(() => store.writeField("notes/none", "title", "B")).toThrow(DocumentNotFoundError));
});

describe("arrayOp", () => {
  test("inserts into a list", () => {
    store.create("note", "first", { title: "A", tags: [] });
    const doc = store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "t" });
    expect(doc.payload).toEqual({ title: "A", tags: ["t"] });
  });
});

describe("publish and discardDraft", () => {
  test("publish copies draft to published, clears the draft and writes a revision", () => {
    store.create("note", "first", { title: "A", tags: [] });
    const doc = store.publish("notes/first");
    expect(doc.isDraft).toBe(false);
    expect(doc.publishedAt).not.toBeNull();
    expect(store.revisions("notes/first").map((r) => r.action)).toEqual(["publish"]);
  });
  test("publish without a draft is refused", () => {
    store.create("note", "first", { title: "A", tags: [] });
    store.publish("notes/first");
    expect(() => store.publish("notes/first")).toThrow(DocumentStateError);
  });
  test("discardDraft on a published document restores the published payload", () => {
    store.create("note", "first", { title: "A", tags: [] });
    store.publish("notes/first");
    store.writeField("notes/first", "title", "B");
    expect(store.discardDraft("notes/first")?.payload).toEqual({ title: "A", tags: [] });
  });
  test("discardDraft on a never-published document deletes it", () => {
    store.create("note", "first", { title: "A", tags: [] });
    expect(store.discardDraft("notes/first")).toBeNull();
    expect(store.get("notes/first", { draft: true })).toBeNull();
  });
});

describe("reads validate (Review Focus 1)", () => {
  test("a stored payload that no longer matches the schema throws naming the key", () => {
    store.create("note", "first", { title: "A", tags: [] });
    store.publish("notes/first");
    db.prepare("UPDATE documents SET published_payload = ? WHERE key = ?").run(
      JSON.stringify({ title: 1 }),
      "notes/first",
    );
    expect(() => store.get("notes/first")).toThrow(/notes\/first/);
    expect(() => store.list("note")).toThrow(ContentValidationError);
  });
});

describe("editor writes that miss (Review Focus 2)", () => {
  beforeEach(() => {
    store.create("note", "first", { title: "A", tags: ["x"] });
    store.publish("notes/first");
    store.writeField("notes/first", "title", "B");
  });
  const draftRow = () => db.prepare("SELECT draft_payload FROM documents WHERE key = ?").get("notes/first");
  test("writeField to a missing parent leaves the stored draft unchanged", () => {
    const before = draftRow();
    expect(() => store.writeField("notes/first", "meta.title", "y")).toThrow(PathError);
    expect(() => store.writeField("notes/first", "tags.9", "y")).toThrow(PathError);
    expect(draftRow()).toEqual(before);
  });
  test("arrayOp out of range leaves the stored draft unchanged", () => {
    const before = draftRow();
    expect(() => store.arrayOp("notes/first", "tags", { kind: "remove", index: 5 })).toThrow(PathError);
    expect(() => store.arrayOp("notes/first", "tags", { kind: "insert", index: 9, value: "z" })).toThrow(PathError);
    expect(draftRow()).toEqual(before);
  });
  test("a malformed op is refused", () =>
    expect(() => store.arrayOp("notes/first", "tags", { kind: "remove", index: -1 })).toThrow(PathError));
});

describe("malformed JSON columns", () => {
  test("a bad previous_slugs column throws naming the key", () => {
    store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET previous_slugs = ? WHERE key = ?").run('{"a":1}', "notes/first");
    expect(() => store.get("notes/first", { draft: true })).toThrow(/notes\/first.*previous_slugs/);
    expect(() => store.get("notes/first", { draft: true })).toThrow(ContentValidationError);
  });
  test("a stored document of an unregistered type throws ContentValidationError naming the key", () => {
    store.create("note", "first", { title: "A", tags: [] });
    db.prepare("UPDATE documents SET type = 'poster' WHERE key = ?").run("notes/first");
    expect(() => store.get("notes/first", { draft: true })).toThrow(ContentValidationError);
    expect(() => store.get("notes/first", { draft: true })).toThrow(/notes\/first/);
  });
});

describe("list", () => {
  test("lists published documents of a type, ordered by key", () => {
    store.create("note", "b", { title: "B", tags: [] });
    store.create("note", "a", { title: "A", tags: [] });
    store.publish("notes/a");
    expect(store.list("note").map((d) => d.key)).toEqual(["notes/a"]);
    expect(store.list("note", { draft: true }).map((d) => d.key)).toEqual(["notes/a", "notes/b"]);
  });
});
