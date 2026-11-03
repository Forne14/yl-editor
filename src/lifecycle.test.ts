import { beforeEach, expect, test } from "vitest";
import { createSqliteContentStore } from "./sqlite-store";
import { makeTestDb, testRegistry } from "./test-support";
import { DocumentStateError, type ContentStore } from "./types";

let store: ContentStore;
beforeEach(() => {
  store = createSqliteContentStore(makeTestDb(), testRegistry);
  store.create("note", "first", { title: "A", tags: [] });
  store.publish("notes/first");
});

test("retire hides the document from reads; restore brings it back", () => {
  store.retire("notes/first");
  expect(store.get("notes/first")).toBeNull();
  expect(store.list("note")).toEqual([]);
  expect(store.get("notes/first", { includeRetired: true })?.retiredAt).not.toBeNull();
  store.restore("notes/first");
  expect(store.get("notes/first")?.retiredAt).toBeNull();
  expect(store.revisions("notes/first").map((r) => r.action)).toEqual(["publish", "retire", "restore"]);
});

test("retiring twice is refused", () => {
  store.retire("notes/first");
  expect(() => store.retire("notes/first")).toThrow(DocumentStateError);
});

test("restoring a live document is refused", () =>
  expect(() => store.restore("notes/first")).toThrow(DocumentStateError));

test("rename moves the key and remembers the old slug", () => {
  const doc = store.rename("notes/first", "renamed");
  expect(doc.key).toBe("notes/renamed");
  expect(doc.previousSlugs).toEqual(["first"]);
  expect(store.get("notes/first")).toBeNull();
  expect(store.findByPreviousSlug("notes", "first")).toBe("notes/renamed");
  expect(store.findByPreviousSlug("notes", "nope")).toBeNull();
  expect(store.revisions("notes/renamed").map((r) => r.action)).toEqual(["publish", "rename"]);
});

test("renaming back and forth keeps previous slugs unique and excludes the current slug", () => {
  store.rename("notes/first", "second");
  const doc = store.rename("notes/second", "first");
  expect(doc.previousSlugs).toEqual(["second"]);
  const again = store.rename("notes/first", "third");
  expect(again.previousSlugs).toEqual(["second", "first"]);
});

test("rename of a draft-only document works", () => {
  store.create("note", "draft", { title: "D", tags: [] });
  expect(store.rename("notes/draft", "drafty").key).toBe("notes/drafty");
});

test("rename to an existing key is refused", () => {
  store.create("note", "other", { title: "B", tags: [] });
  expect(() => store.rename("notes/first", "other")).toThrow(DocumentStateError);
});

test("rename to an invalid slug is refused", () => expect(() => store.rename("notes/first", "Not OK")).toThrow(/slug/));

test("a retired document is not found by a previous slug", () => {
  store.rename("notes/first", "renamed");
  store.retire("notes/renamed");
  expect(store.findByPreviousSlug("notes", "first")).toBeNull();
});
