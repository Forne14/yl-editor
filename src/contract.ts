import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ConflictError,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  SlugError,
  type ContentStore,
  type RegistryEntry,
  type SchemaRegistry,
  type WriteContext,
} from "./types.ts";

const noteEntry: RegistryEntry = {
  type: "note",
  collection: "notes",
  schema: z.strictObject({ title: z.string().min(1), tags: z.array(z.string()) }),
};

/**
 * The one-type registry the contract assumes: `note` under the `notes` collection, `{ title: string (min 1),
 * tags: string[] }`. Seed the host's schema registry with it (or merge its entry) when running the contract.
 */
export const contractRegistry: SchemaRegistry = {
  entry: (type) => (type === noteEntry.type ? noteEntry : undefined),
  byCollection: (collection) => (collection === noteEntry.collection ? noteEntry : undefined),
  entries: () => [noteEntry],
};

export interface ContentStoreContractOptions {
  /** The registry the store under test was built with. Defaults to `contractRegistry`. */
  registry?: SchemaRegistry;
}

/**
 * Registers the full ContentStore lifecycle as vitest `describe`/`test` blocks. `makeStore` runs before every test
 * and must return a store over empty storage whose registry carries the contract's `note` type.
 */
export function runContentStoreContract(
  name: string,
  makeStore: () => Promise<ContentStore> | ContentStore,
  options: ContentStoreContractOptions = {},
): void {
  const registry = options.registry ?? contractRegistry;

  describe(`ContentStore contract: ${name}`, () => {
    let store: ContentStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    const createPublished = async (slug = "first", payload: unknown = { title: "A", tags: [] }) => {
      await store.create("note", slug, payload);
      return store.publish(`notes/${slug}`);
    };

    test("the registry carries the contract's note type", () => {
      expect(registry.entry("note")?.collection).toBe("notes");
      expect(registry.byCollection("notes")?.type).toBe("note");
      expect(registry.entries().map((entry) => entry.type)).toContain("note");
    });

    describe("create and get", () => {
      test("create stores a draft keyed by collection/slug", async () => {
        const doc = await store.create("note", "first", { title: "A", tags: [] });
        expect(doc.key).toBe("notes/first");
        expect(doc.slug).toBe("first");
        expect(doc.type).toBe("note");
        expect(doc.isDraft).toBe(true);
        expect(doc.publishedAt).toBeNull();
        expect(doc.retiredAt).toBeNull();
        expect(doc.previousSlugs).toEqual([]);
      });
      test("a draft-only document is invisible to published reads", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        expect(await store.get("notes/first")).toBeNull();
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: [] });
      });
      test("get of an unknown key is null", async () => {
        expect(await store.get("notes/none")).toBeNull();
        expect(await store.get("notes/none", { draft: true, includeRetired: true })).toBeNull();
      });
      test("create validates the payload", async () => {
        await expect(store.create("note", "bad", { title: "", tags: [] })).rejects.toThrow(ContentValidationError);
        expect(await store.get("notes/bad", { draft: true })).toBeNull();
      });
      test("create refuses an unknown type", async () => {
        await expect(store.create("poster", "x", {})).rejects.toThrow(/Unknown document type/);
      });
      test("create refuses a bad slug with SlugError", async () => {
        await expect(store.create("note", "Bad Slug", { title: "A", tags: [] })).rejects.toThrow(SlugError);
        await expect(store.create("note", "double--hyphen", { title: "A", tags: [] })).rejects.toThrow(/slug/);
        await expect(store.create("note", "", { title: "A", tags: [] })).rejects.toThrow(SlugError);
      });
      test("create refuses a duplicate key", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        await expect(store.create("note", "first", { title: "B", tags: [] })).rejects.toThrow(DocumentStateError);
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: [] });
      });
    });

    describe("writeField", () => {
      beforeEach(async () => {
        await createPublished("first", { title: "A", tags: ["x"] });
      });
      test("writes into a new draft and leaves published untouched", async () => {
        const doc = await store.writeField("notes/first", "title", "B");
        expect(doc.isDraft).toBe(true);
        expect(doc.draftUpdatedAt).not.toBeNull();
        expect((await store.get("notes/first"))?.payload).toEqual({ title: "A", tags: ["x"] });
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "B", tags: ["x"] });
      });
      test("writes into a list item by index", async () => {
        const doc = await store.writeField("notes/first", "tags.0", "y");
        expect(doc.payload).toEqual({ title: "A", tags: ["y"] });
      });
      test("an invalid value is refused and the stored draft is unchanged", async () => {
        await store.writeField("notes/first", "title", "B");
        await expect(store.writeField("notes/first", "title", "")).rejects.toThrow(ContentValidationError);
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "B", tags: ["x"] });
      });
      test("a path that does not exist is refused and nothing is written", async () => {
        await expect(store.writeField("notes/first", "tags.4", "y")).rejects.toThrow(PathError);
        expect((await store.get("notes/first", { draft: true }))?.isDraft).toBe(false);
      });
      test("a missing parent is refused and the draft is unchanged", async () => {
        await store.writeField("notes/first", "title", "B");
        await expect(store.writeField("notes/first", "meta.title", "y")).rejects.toThrow(PathError);
        await expect(store.writeField("notes/first", "tags.9", "y")).rejects.toThrow(PathError);
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "B", tags: ["x"] });
      });
      test("a forbidden path segment is refused", async () => {
        await expect(store.writeField("notes/first", "__proto__.polluted", "y")).rejects.toThrow(PathError);
        await expect(store.writeField("notes/first", "constructor", "y")).rejects.toThrow(PathError);
      });
      test("unknown document", async () => {
        await expect(store.writeField("notes/none", "title", "B")).rejects.toThrow(DocumentNotFoundError);
      });
    });

    describe("arrayOp", () => {
      beforeEach(async () => {
        await store.create("note", "first", { title: "A", tags: ["x", "y"] });
      });
      test("inserts into a list", async () => {
        const doc = await store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "t" });
        expect(doc.payload).toEqual({ title: "A", tags: ["t", "x", "y"] });
      });
      test("moves within a list", async () => {
        const doc = await store.arrayOp("notes/first", "tags", { kind: "move", from: 0, to: 1 });
        expect(doc.payload).toEqual({ title: "A", tags: ["y", "x"] });
      });
      test("removes from a list", async () => {
        const doc = await store.arrayOp("notes/first", "tags", { kind: "remove", index: 0 });
        expect(doc.payload).toEqual({ title: "A", tags: ["y"] });
      });
      test("out of range is refused and the draft is unchanged", async () => {
        await expect(store.arrayOp("notes/first", "tags", { kind: "remove", index: 5 })).rejects.toThrow(PathError);
        await expect(store.arrayOp("notes/first", "tags", { kind: "insert", index: 9, value: "z" })).rejects.toThrow(
          PathError,
        );
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: ["x", "y"] });
      });
      test("a malformed op is refused", async () => {
        await expect(store.arrayOp("notes/first", "tags", { kind: "remove", index: -1 })).rejects.toThrow(PathError);
      });
      test("an op that breaks the schema is refused", async () => {
        await expect(store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: 7 })).rejects.toThrow(
          ContentValidationError,
        );
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: ["x", "y"] });
      });
      test("an op on a path that is not a list is refused", async () => {
        await expect(store.arrayOp("notes/first", "title", { kind: "remove", index: 0 })).rejects.toThrow(PathError);
      });
    });

    describe("publish and discardDraft", () => {
      test("publish copies draft to published, clears the draft and writes a revision", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        const doc = await store.publish("notes/first");
        expect(doc.isDraft).toBe(false);
        expect(doc.publishedAt).not.toBeNull();
        expect(doc.draftUpdatedAt).toBeNull();
        expect((await store.get("notes/first"))?.payload).toEqual({ title: "A", tags: [] });
        const revisions = await store.revisions("notes/first");
        expect(revisions.map((revision) => revision.action)).toEqual(["publish"]);
        expect(revisions[0]?.payload).toEqual({ title: "A", tags: [] });
        expect(revisions[0]?.slug).toBe("first");
      });
      test("publish without a draft is refused", async () => {
        await createPublished();
        await expect(store.publish("notes/first")).rejects.toThrow(DocumentStateError);
      });
      test("publish of an unknown document is refused", async () => {
        await expect(store.publish("notes/none")).rejects.toThrow(DocumentNotFoundError);
      });
      test("a draft read falls back to the published payload", async () => {
        await createPublished();
        const doc = await store.get("notes/first", { draft: true });
        expect(doc?.isDraft).toBe(false);
        expect(doc?.payload).toEqual({ title: "A", tags: [] });
      });
      test("discardDraft on a published document restores the published payload", async () => {
        await createPublished();
        await store.writeField("notes/first", "title", "B");
        const doc = await store.discardDraft("notes/first");
        expect(doc?.payload).toEqual({ title: "A", tags: [] });
        expect(doc?.isDraft).toBe(false);
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: [] });
      });
      test("discardDraft on a never-published document deletes it", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        expect(await store.discardDraft("notes/first")).toBeNull();
        expect(await store.get("notes/first", { draft: true })).toBeNull();
        await store.create("note", "first", { title: "Again", tags: [] });
      });
    });

    describe("list", () => {
      test("lists published documents of a type, ordered by key", async () => {
        await store.create("note", "b", { title: "B", tags: [] });
        await store.create("note", "a", { title: "A", tags: [] });
        await store.publish("notes/a");
        expect((await store.list("note")).map((doc) => doc.key)).toEqual(["notes/a"]);
        expect((await store.list("note", { draft: true })).map((doc) => doc.key)).toEqual(["notes/a", "notes/b"]);
      });
      test("a type with no documents lists empty", async () => {
        expect(await store.list("note")).toEqual([]);
        expect(await store.list("poster")).toEqual([]);
      });
    });

    describe("retire and restore", () => {
      beforeEach(async () => {
        await createPublished();
      });
      test("retire hides the document from reads; restore brings it back", async () => {
        await store.retire("notes/first");
        expect(await store.get("notes/first")).toBeNull();
        expect(await store.list("note")).toEqual([]);
        expect((await store.get("notes/first", { includeRetired: true }))?.retiredAt).not.toBeNull();
        await store.restore("notes/first");
        expect((await store.get("notes/first"))?.retiredAt).toBeNull();
        expect((await store.revisions("notes/first")).map((revision) => revision.action)).toEqual([
          "publish",
          "retire",
          "restore",
        ]);
      });
      test("reads never return a retired document unless includeRetired", async () => {
        await store.create("note", "second", { title: "B", tags: [] });
        await store.retire("notes/first");
        await store.retire("notes/second");
        expect(await store.get("notes/first", { draft: true })).toBeNull();
        expect(await store.get("notes/second", { draft: true })).toBeNull();
        expect(await store.list("note", { draft: true })).toEqual([]);
        expect((await store.list("note", { includeRetired: true })).map((doc) => doc.key)).toEqual(["notes/first"]);
        expect((await store.list("note", { draft: true, includeRetired: true })).map((doc) => doc.key)).toEqual([
          "notes/first",
          "notes/second",
        ]);
        expect((await store.get("notes/second", { draft: true, includeRetired: true }))?.retiredAt).not.toBeNull();
      });
      test("retiring twice is refused", async () => {
        await store.retire("notes/first");
        await expect(store.retire("notes/first")).rejects.toThrow(DocumentStateError);
      });
      test("restoring a live document is refused", async () => {
        await expect(store.restore("notes/first")).rejects.toThrow(DocumentStateError);
      });
      test("a draft-only document can be retired and restored", async () => {
        await store.create("note", "draft", { title: "D", tags: [] });
        await store.retire("notes/draft");
        expect(await store.get("notes/draft", { draft: true })).toBeNull();
        await store.restore("notes/draft");
        expect((await store.get("notes/draft", { draft: true }))?.payload).toEqual({ title: "D", tags: [] });
      });
    });

    describe("rename and previous slugs", () => {
      beforeEach(async () => {
        await createPublished();
      });
      test("rename moves the key and remembers the old slug", async () => {
        const doc = await store.rename("notes/first", "renamed");
        expect(doc.key).toBe("notes/renamed");
        expect(doc.slug).toBe("renamed");
        expect(doc.previousSlugs).toEqual(["first"]);
        expect(await store.get("notes/first")).toBeNull();
        expect(await store.findByPreviousSlug("notes", "first")).toBe("notes/renamed");
        expect(await store.findByPreviousSlug("notes", "nope")).toBeNull();
        expect(await store.findByPreviousSlug("other", "first")).toBeNull();
        const revisions = await store.revisions("notes/renamed");
        expect(revisions.map((revision) => revision.action)).toEqual(["publish", "rename"]);
        expect(revisions[1]?.slug).toBe("renamed");
      });
      test("renaming back and forth keeps previous slugs unique and excludes the current slug", async () => {
        await store.rename("notes/first", "second");
        const doc = await store.rename("notes/second", "first");
        expect(doc.previousSlugs).toEqual(["second"]);
        const again = await store.rename("notes/first", "third");
        expect(again.previousSlugs).toEqual(["second", "first"]);
      });
      test("rename of a draft-only document works", async () => {
        await store.create("note", "draft", { title: "D", tags: [] });
        expect((await store.rename("notes/draft", "drafty")).key).toBe("notes/drafty");
      });
      test("rename to an existing key is refused", async () => {
        await store.create("note", "other", { title: "B", tags: [] });
        await expect(store.rename("notes/first", "other")).rejects.toThrow(DocumentStateError);
      });
      test("rename to an invalid slug is refused with SlugError", async () => {
        await expect(store.rename("notes/first", "Not OK")).rejects.toThrow(SlugError);
        expect((await store.get("notes/first"))?.slug).toBe("first");
      });
      test("rename of an unknown document is refused", async () => {
        await expect(store.rename("notes/none", "fine")).rejects.toThrow(DocumentNotFoundError);
      });
      test("a retired document is not found by a previous slug", async () => {
        await store.rename("notes/first", "renamed");
        await store.retire("notes/renamed");
        expect(await store.findByPreviousSlug("notes", "first")).toBeNull();
      });
    });

    describe("revisions", () => {
      test("a draft-only document has no revisions", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        await store.writeField("notes/first", "title", "B");
        expect(await store.revisions("notes/first")).toEqual([]);
      });
      test("revisions of an unknown document are refused", async () => {
        await expect(store.revisions("notes/none")).rejects.toThrow(DocumentNotFoundError);
      });
      test("each publish records the payload it published", async () => {
        await createPublished();
        await store.writeField("notes/first", "title", "B");
        await store.publish("notes/first");
        const revisions = await store.revisions("notes/first");
        expect(revisions.map((revision) => revision.payload)).toEqual([
          { title: "A", tags: [] },
          { title: "B", tags: [] },
        ]);
        expect(typeof revisions[0]?.createdAt).toBe("string");
      });
      test("actor is recorded on publish, retire, restore and rename", async () => {
        await store.create("note", "first", { title: "A", tags: [] }, { actor: "editor-ada" });
        await store.publish("notes/first", { actor: "editor-ada" });
        await store.retire("notes/first", { actor: "editor-grace" });
        await store.restore("notes/first", { actor: "editor-grace" });
        await store.rename("notes/first", "renamed", { actor: "editor-ada" });
        const revisions = await store.revisions("notes/renamed");
        expect(revisions.map((revision) => [revision.action, revision.actor])).toEqual([
          ["publish", "editor-ada"],
          ["retire", "editor-grace"],
          ["restore", "editor-grace"],
          ["rename", "editor-ada"],
        ]);
      });
      test("actor is null when the host passes none", async () => {
        await createPublished();
        await store.retire("notes/first", {});
        expect((await store.revisions("notes/first")).map((revision) => revision.actor)).toEqual([null, null]);
      });
    });

    describe("versions", () => {
      test("a new document starts at version 1", async () => {
        expect((await store.create("note", "first", { title: "A", tags: [] })).version).toBe(1);
      });
      test("every mutation increments the version by one", async () => {
        const versions: number[] = [];
        versions.push((await store.create("note", "first", { title: "A", tags: ["x"] })).version);
        versions.push((await store.writeField("notes/first", "title", "B")).version);
        versions.push((await store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "y" })).version);
        versions.push((await store.publish("notes/first")).version);
        await store.writeField("notes/first", "title", "C");
        const discarded = await store.discardDraft("notes/first");
        versions.push(discarded?.version ?? Number.NaN);
        versions.push((await store.retire("notes/first")).version);
        versions.push((await store.restore("notes/first")).version);
        versions.push((await store.rename("notes/first", "renamed")).version);
        expect(versions).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
        expect((await store.get("notes/renamed"))?.version).toBe(9);
      });
      test("reads do not change the version", async () => {
        await createPublished();
        await store.get("notes/first");
        await store.list("note", { draft: true });
        await store.revisions("notes/first");
        await store.findByPreviousSlug("notes", "first");
        expect((await store.get("notes/first"))?.version).toBe(2);
      });
      test("a refused write does not change the version", async () => {
        await createPublished();
        await expect(store.writeField("notes/first", "title", "")).rejects.toThrow(ContentValidationError);
        await expect(store.writeField("notes/first", "tags.3", "x")).rejects.toThrow(PathError);
        await expect(store.publish("notes/first")).rejects.toThrow(DocumentStateError);
        await expect(store.restore("notes/first")).rejects.toThrow(DocumentStateError);
        expect((await store.get("notes/first", { draft: true }))?.version).toBe(2);
      });
      test("a matching expectedVersion succeeds", async () => {
        const created = await store.create("note", "first", { title: "A", tags: [] });
        const written = await store.writeField("notes/first", "title", "B", { expectedVersion: created.version });
        const published = await store.publish("notes/first", { expectedVersion: written.version });
        expect(published.payload).toEqual({ title: "B", tags: [] });
        expect(published.version).toBe(written.version + 1);
      });
    });

    describe("conflicts", () => {
      type Attempt = (context: WriteContext) => Promise<unknown>;
      const attempts: [string, Attempt][] = [
        ["writeField", (context) => store.writeField("notes/first", "title", "Stale", context)],
        [
          "arrayOp",
          (context) => store.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "z" }, context),
        ],
        ["publish", (context) => store.publish("notes/first", context)],
        ["discardDraft", (context) => store.discardDraft("notes/first", context)],
        ["retire", (context) => store.retire("notes/first", context)],
        ["rename", (context) => store.rename("notes/first", "moved", context)],
      ];

      beforeEach(async () => {
        await createPublished();
        await store.writeField("notes/first", "title", "B");
      });

      const staleTitle = "%s with a stale expectedVersion throws ConflictError and writes nothing";
      test.each(attempts)(staleTitle, async (_methodName, attempt) => {
        const before = await store.get("notes/first", { draft: true });
        const revisionsBefore = await store.revisions("notes/first");
        const stale = (before?.version ?? 0) - 1;
        const failure = await attempt({ expectedVersion: stale, actor: "editor-ada" }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ConflictError);
        expect(failure).toMatchObject({ key: "notes/first", expected: stale, actual: before?.version });
        expect(await store.get("notes/first", { draft: true })).toEqual(before);
        expect(await store.revisions("notes/first")).toEqual(revisionsBefore);
        expect(await store.get("notes/moved", { draft: true, includeRetired: true })).toBeNull();
      });

      test("restore with a stale expectedVersion throws ConflictError and stays retired", async () => {
        const retired = await store.retire("notes/first");
        await expect(store.restore("notes/first", { expectedVersion: retired.version - 1 })).rejects.toThrow(
          ConflictError,
        );
        expect((await store.get("notes/first", { includeRetired: true }))?.retiredAt).not.toBeNull();
        expect((await store.get("notes/first", { includeRetired: true }))?.version).toBe(retired.version);
      });

      test("two editors racing from the same version: the second is refused", async () => {
        const read = await store.get("notes/first", { draft: true });
        const version = read?.version ?? 0;
        await store.writeField("notes/first", "title", "First editor", { expectedVersion: version });
        await expect(
          store.writeField("notes/first", "title", "Second editor", { expectedVersion: version }),
        ).rejects.toThrow(ConflictError);
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "First editor", tags: [] });
      });
    });
  });
}
