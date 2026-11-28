import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import {
  ConflictError,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  MediaRefusal,
  SlugError,
  type ContentStore,
  type MaybePromise,
  type MediaFieldRef,
  type MediaFileInfo,
  type MediaJobState,
  type MediaStore,
  type RegistryEntry,
  type ResolvedMedia,
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

/** Builds a store over the same storage as the one under test, with a different registry. */
export type ReopenStore = (
  registry: SchemaRegistry,
  hooks: { onReadIssue: (key: string, issues: z.core.$ZodIssue[]) => void },
) => Promise<ContentStore> | ContentStore;

export interface ContentStoreContractOptions {
  /** The registry the store under test was built with. Defaults to `contractRegistry`. */
  registry?: SchemaRegistry;
  /**
   * Reopens the store under test's storage with another registry and an `onReadIssue` hook. Enables the schema
   * evolution tests; without it they are skipped.
   */
  reopen?: ReopenStore;
}

const registryOf = (entry: RegistryEntry): SchemaRegistry => ({
  entry: (type) => (type === entry.type ? entry : undefined),
  byCollection: (collection) => (collection === entry.collection ? entry : undefined),
  entries: () => [entry],
});

/** `note` at version 2: requires a `subtitle`, which `migrate` adds to version 1 payloads. */
const noteV2: RegistryEntry = {
  ...noteEntry,
  version: 2,
  schema: z.strictObject({ title: z.string().min(1), tags: z.array(z.string()), subtitle: z.string() }),
  migrate: (from, payload) => (from < 2 ? { ...(payload as object), subtitle: "" } : payload),
};

/** `note` still at version 1 but with a tighter schema: stored version 1 payloads fail it. */
const noteTightened: RegistryEntry = {
  ...noteEntry,
  schema: z.strictObject({ title: z.string().min(1), tags: z.array(z.string()).min(1) }),
};

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
    });

    test.skipIf(!registry.entries)("the registry's optional entries() lists the note type", () => {
      expect(registry.entries?.().map((entry) => entry.type)).toContain("note");
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

    describe("restoreRevision", () => {
      test("copies the revision payload into the draft and never touches the published payload", async () => {
        await createPublished("first", { title: "One", tags: [] });
        await store.writeField("notes/first", "title", "Two");
        await store.publish("notes/first");
        const [first] = await store.revisions("notes/first");
        const before = await store.get("notes/first");
        const restored = await store.restoreRevision("notes/first", first!.id, { actor: "ada" });
        expect(restored.isDraft).toBe(true);
        expect(restored.payload).toEqual({ title: "One", tags: [] });
        expect(restored.version).toBe((before?.version ?? 0) + 1);
        expect((await store.get("notes/first"))?.payload).toEqual({ title: "Two", tags: [] });
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "One", tags: [] });
      });
      test("records a restore_revision revision carrying the restored payload and actor", async () => {
        await createPublished("first", { title: "One", tags: [] });
        const [first] = await store.revisions("notes/first");
        await store.writeField("notes/first", "title", "Draft");
        await store.restoreRevision("notes/first", first!.id, { actor: "ada" });
        const last = (await store.revisions("notes/first")).at(-1);
        expect(last).toMatchObject({ action: "restore_revision", actor: "ada", payload: { title: "One", tags: [] } });
      });
      test("an unknown revision id throws DocumentNotFoundError and changes nothing", async () => {
        await createPublished();
        const before = await store.get("notes/first", { draft: true });
        await expect(store.restoreRevision("notes/first", 987654)).rejects.toThrow(DocumentNotFoundError);
        expect(await store.get("notes/first", { draft: true })).toEqual(before);
        expect(await store.revisions("notes/first")).toHaveLength(1);
      });
      test("a revision of another document throws DocumentNotFoundError", async () => {
        await createPublished("first");
        await createPublished("second", { title: "B", tags: [] });
        const [other] = await store.revisions("notes/second");
        await expect(store.restoreRevision("notes/first", other!.id)).rejects.toThrow(DocumentNotFoundError);
      });
      test("an unknown document throws DocumentNotFoundError", async () => {
        await expect(store.restoreRevision("notes/nope", 1)).rejects.toThrow(DocumentNotFoundError);
      });
    });

    describe("unpublish", () => {
      test("with no draft, the published payload becomes the draft and reads see nothing public", async () => {
        await createPublished("first", { title: "Live", tags: [] });
        const doc = await store.unpublish("notes/first");
        expect(doc.isDraft).toBe(true);
        expect(doc.publishedAt).toBeNull();
        expect(doc.payload).toEqual({ title: "Live", tags: [] });
        expect(doc.retiredAt).toBeNull();
        expect(doc.version).toBe(3);
        expect(await store.get("notes/first")).toBeNull();
        expect((await store.get("notes/first", { draft: true }))?.payload).toEqual({ title: "Live", tags: [] });
      });
      test("with a draft, the draft is kept and the published payload is dropped", async () => {
        await createPublished("first", { title: "Live", tags: [] });
        await store.writeField("notes/first", "title", "Wip");
        const doc = await store.unpublish("notes/first");
        expect(doc.payload).toEqual({ title: "Wip", tags: [] });
        expect(await store.get("notes/first")).toBeNull();
      });
      test("records an unpublish revision with the previously published payload", async () => {
        await createPublished("first", { title: "Live", tags: [] });
        await store.writeField("notes/first", "title", "Wip");
        await store.unpublish("notes/first", { actor: "ada" });
        const last = (await store.revisions("notes/first")).at(-1);
        expect(last).toMatchObject({ action: "unpublish", actor: "ada", payload: { title: "Live", tags: [] } });
      });
      test("a never-published document throws DocumentStateError", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        await expect(store.unpublish("notes/first")).rejects.toThrow(DocumentStateError);
        await expect(store.unpublish("notes/nope")).rejects.toThrow(DocumentNotFoundError);
      });
      test("can be published again", async () => {
        await createPublished("first", { title: "Live", tags: [] });
        await store.unpublish("notes/first");
        expect((await store.publish("notes/first")).payload).toEqual({ title: "Live", tags: [] });
      });
    });

    describe("scheduled publish", () => {
      const future = "2999-01-01T00:00:00.000Z";
      const past = "2000-01-01T00:00:00.000Z";
      test("publish with at stores the schedule, bumps the version and publishes nothing", async () => {
        const created = await store.create("note", "first", { title: "A", tags: [] });
        const scheduled = await store.publish("notes/first", { at: future });
        expect(scheduled.scheduledAt).toBe(future);
        expect(scheduled.version).toBe(created.version + 1);
        expect(scheduled.publishedAt).toBeNull();
        expect(await store.get("notes/first")).toBeNull();
        expect(await store.revisions("notes/first")).toEqual([]);
      });
      test("publish with at and no draft throws DocumentStateError", async () => {
        await createPublished();
        await expect(store.publish("notes/first", { at: future })).rejects.toThrow(DocumentStateError);
      });
      test("publishDue promotes documents at or before now and returns them", async () => {
        await store.create("note", "due", { title: "Due", tags: [] });
        await store.create("note", "later", { title: "Later", tags: [] });
        await store.create("note", "plain", { title: "Plain", tags: [] });
        await store.publish("notes/due", { at: past });
        await store.publish("notes/later", { at: future });
        const published = await store.publishDue(undefined, { actor: "cron" });
        expect(published.map((doc) => doc.key)).toEqual(["notes/due"]);
        expect(published[0]?.scheduledAt).toBeNull();
        expect((await store.get("notes/due"))?.payload).toEqual({ title: "Due", tags: [] });
        expect(await store.get("notes/later")).toBeNull();
        expect(await store.get("notes/plain")).toBeNull();
        expect((await store.get("notes/later", { draft: true }))?.scheduledAt).toBe(future);
        expect(await store.revisions("notes/due")).toMatchObject([{ action: "publish", actor: "cron" }]);
        expect(await store.revisions("notes/later")).toEqual([]);
      });
      test("publishDue takes an explicit now", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        await store.publish("notes/first", { at: "2030-06-01T00:00:00.000Z" });
        expect(await store.publishDue("2030-05-31T23:59:59.999Z")).toEqual([]);
        expect(await store.publishDue("2030-06-01T00:00:00.000Z")).toHaveLength(1);
        expect(await store.publishDue("2031-01-01T00:00:00.000Z")).toEqual([]);
      });
      test("discardDraft and unpublish clear the schedule", async () => {
        await createPublished("first");
        await store.writeField("notes/first", "title", "B");
        await store.publish("notes/first", { at: past });
        const discarded = await store.discardDraft("notes/first");
        expect(discarded?.scheduledAt).toBeNull();
        expect(await store.publishDue()).toEqual([]);

        await store.writeField("notes/first", "title", "C");
        await store.publish("notes/first", { at: past });
        const unpublished = await store.unpublish("notes/first");
        expect(unpublished.scheduledAt).toBeNull();
        expect(await store.publishDue()).toEqual([]);
        expect(await store.get("notes/first")).toBeNull();
      });
      test("a plain publish clears the schedule", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        await store.publish("notes/first", { at: future });
        expect((await store.publish("notes/first")).scheduledAt).toBeNull();
      });
    });

    describe("unvalidated reads of a healthy document", () => {
      test("the draft view and the published view match the validated reads", async () => {
        await createPublished("first", { title: "Live", tags: [] });
        await store.writeField("notes/first", "title", "Draft");
        expect(await store.get("notes/first", { draft: true, unvalidated: true })).toEqual(
          await store.get("notes/first", { draft: true }),
        );
        expect(await store.get("notes/first", { unvalidated: true })).toEqual(await store.get("notes/first"));
      });
      test("a draft-only document has no published view, and an unknown key is null", async () => {
        await store.create("note", "first", { title: "A", tags: [] });
        expect(await store.get("notes/first", { unvalidated: true })).toBeNull();
        expect(await store.get("notes/none", { draft: true, unvalidated: true })).toBeNull();
      });
      test("a retired document still needs includeRetired", async () => {
        await createPublished();
        await store.retire("notes/first");
        expect(await store.get("notes/first", { draft: true, unvalidated: true })).toBeNull();
        expect(
          (await store.get("notes/first", { draft: true, unvalidated: true, includeRetired: true }))?.retiredAt,
        ).not.toBeNull();
      });
    });

    describe.skipIf(!options.reopen)("schema evolution", () => {
      const reopen: ReopenStore = (reg, hooks) => (options.reopen as ReopenStore)(reg, hooks);
      const noop = () => undefined;

      test("migrate runs on read when the stored version is behind", async () => {
        await createPublished();
        const next = await reopen(registryOf(noteV2), { onReadIssue: noop });
        expect((await next.get("notes/first"))?.payload).toEqual({ title: "A", tags: [], subtitle: "" });
        await expect(next.get("notes/first", { draft: true })).resolves.toMatchObject({
          payload: { title: "A", tags: [], subtitle: "" },
        });
      });

      test("the migrated payload is persisted on the next draft write", async () => {
        await createPublished();
        const calls: number[] = [];
        const counting: RegistryEntry = {
          ...noteV2,
          migrate: (from, payload) => {
            calls.push(from);
            return noteV2.migrate?.(from, payload);
          },
        };
        const next = await reopen(registryOf(counting), { onReadIssue: noop });
        await next.get("notes/first");
        await next.get("notes/first");
        expect(calls).toEqual([1, 1]);
        await next.writeField("notes/first", "title", "B");
        calls.length = 0;
        expect((await next.get("notes/first", { draft: true }))?.payload).toEqual({
          title: "B",
          tags: [],
          subtitle: "",
        });
        expect((await next.get("notes/first"))?.payload).toEqual({ title: "A", tags: [], subtitle: "" });
        expect(calls).toEqual([]);
      });

      test("a public read of a payload that fails the current schema serves it and reports the issue", async () => {
        await createPublished();
        const reported: string[] = [];
        const next = await reopen(registryOf(noteTightened), { onReadIssue: (key) => reported.push(key) });
        expect((await next.get("notes/first"))?.payload).toEqual({ title: "A", tags: [] });
        expect(reported).toEqual(["notes/first"]);
        expect((await next.list("note")).map((doc) => doc.key)).toEqual(["notes/first"]);
      });

      test("an editor read of a payload that fails the current schema throws", async () => {
        await createPublished();
        const next = await reopen(registryOf(noteTightened), { onReadIssue: noop });
        await expect(next.get("notes/first", { draft: true })).rejects.toThrow(ContentValidationError);
      });

      describe("a payload failing the current schema", () => {
        const invalid = { title: "A", tags: [] as string[] };
        const valid = { title: "A", tags: ["x"] };
        const tightened = () => reopen(registryOf(noteTightened), { onReadIssue: noop });

        /** Published and failing the schema, with no draft. */
        const stalePublished = async () => {
          await createPublished("first", invalid);
          return tightened();
        };
        /** Published and valid, under a draft failing the schema. */
        const invalidDraft = async () => {
          await createPublished("first", valid);
          await store.writeField("notes/first", "tags", []);
          return tightened();
        };
        /** Never published, with a draft failing the schema. */
        const invalidNeverPublished = async () => {
          await store.create("note", "first", invalid);
          return tightened();
        };

        test("an unvalidated read returns a stale published payload as stored, reporting nothing", async () => {
          await createPublished("first", invalid);
          const reported: string[] = [];
          const next = await reopen(registryOf(noteTightened), { onReadIssue: (key) => reported.push(key) });
          for (const draft of [true, false])
            expect(await next.get("notes/first", { draft, unvalidated: true })).toMatchObject({
              key: "notes/first",
              type: "note",
              isDraft: false,
              payload: invalid,
            });
          expect(reported).toEqual([]);
        });

        test("an unvalidated read returns an invalid draft as stored; the strict read still throws", async () => {
          const next = await invalidDraft();
          expect(await next.get("notes/first", { draft: true, unvalidated: true })).toMatchObject({
            isDraft: true,
            payload: invalid,
          });
          expect(await next.get("notes/first", { unvalidated: true })).toMatchObject({
            isDraft: false,
            payload: valid,
          });
          await expect(next.get("notes/first", { draft: true })).rejects.toThrow(ContentValidationError);
        });

        test("an unvalidated read applies migrate, and a migrate that throws returns the stored payload", async () => {
          await createPublished("first", invalid);
          const migrating = await reopen(registryOf(noteV2), { onReadIssue: noop });
          expect((await migrating.get("notes/first", { unvalidated: true }))?.payload).toEqual({
            ...invalid,
            subtitle: "",
          });
          const throwing: RegistryEntry = {
            ...noteV2,
            migrate: () => {
              throw new Error("migrate blew up");
            },
          };
          const next = await reopen(registryOf(throwing), { onReadIssue: noop });
          expect((await next.get("notes/first", { draft: true, unvalidated: true }))?.payload).toEqual(invalid);
          expect((await next.get("notes/first", { unvalidated: true }))?.payload).toEqual(invalid);
        });

        test("list honours unvalidated", async () => {
          const next = await invalidNeverPublished();
          await expect(next.list("note", { draft: true })).rejects.toThrow(ContentValidationError);
          expect((await next.list("note", { draft: true, unvalidated: true })).map((doc) => doc.payload)).toEqual([
            invalid,
          ]);
        });

        test("a stale published payload can be retired, restored, renamed, discarded and unpublished", async () => {
          const next = await stalePublished();
          expect((await next.retire("notes/first")).payload).toEqual(invalid);
          expect((await next.restore("notes/first")).retiredAt).toBeNull();
          expect((await next.rename("notes/first", "second")).key).toBe("notes/second");
          expect(await next.discardDraft("notes/second")).toMatchObject({ isDraft: false, payload: invalid });
          expect(await next.unpublish("notes/second")).toMatchObject({
            isDraft: true,
            publishedAt: null,
            payload: invalid,
          });
          expect(await next.get("notes/second", { includeRetired: true })).toBeNull();
        });

        test("an invalid draft can be retired, restored, renamed and unpublished, keeping the draft", async () => {
          const next = await invalidDraft();
          expect((await next.retire("notes/first")).payload).toEqual(invalid);
          expect((await next.restore("notes/first")).isDraft).toBe(true);
          expect((await next.rename("notes/first", "second")).payload).toEqual(invalid);
          expect(await next.unpublish("notes/second")).toMatchObject({
            isDraft: true,
            publishedAt: null,
            payload: invalid,
          });
        });

        test("discarding an invalid draft leaves the valid published document", async () => {
          const next = await invalidDraft();
          expect(await next.discardDraft("notes/first")).toMatchObject({ isDraft: false, payload: valid });
          expect((await next.get("notes/first", { draft: true }))?.payload).toEqual(valid);
        });

        test("a never-published invalid draft can be retired and discarded, not unpublished", async () => {
          const next = await invalidNeverPublished();
          await expect(next.unpublish("notes/first")).rejects.toThrow(DocumentStateError);
          expect((await next.retire("notes/first")).payload).toEqual(invalid);
          expect((await next.restore("notes/first")).payload).toEqual(invalid);
          expect(await next.discardDraft("notes/first")).toBeNull();
        });

        for (const [state, open] of Object.entries({ stalePublished, invalidDraft, invalidNeverPublished }))
          test(`a draft write still validates (${state}): invalid throws, valid repairs`, async () => {
            const next = await open();
            await expect(next.writeField("notes/first", "title", "B")).rejects.toThrow(ContentValidationError);
            expect(await next.writeField("notes/first", "tags", ["y"])).toMatchObject({
              isDraft: true,
              payload: { title: "A", tags: ["y"] },
            });
            expect((await next.get("notes/first", { draft: true }))?.payload).toEqual({ title: "A", tags: ["y"] });
          });

        test("restoring a valid revision repairs a stale published payload with no draft", async () => {
          await createPublished("first", valid);
          await store.writeField("notes/first", "tags", []);
          await store.publish("notes/first");
          const [revision] = await store.revisions("notes/first");
          const next = await tightened();
          const restored = await next.restoreRevision("notes/first", revision?.id ?? -1);
          expect(restored).toMatchObject({ isDraft: true, payload: valid });
          expect((await next.get("notes/first", { draft: true }))?.payload).toEqual(valid);
        });

        test("restoring a valid revision replaces an invalid draft", async () => {
          const next = await invalidDraft();
          const [revision] = await next.revisions("notes/first");
          const restored = await next.restoreRevision("notes/first", revision?.id ?? -1);
          expect(restored).toMatchObject({ isDraft: true, payload: valid });
        });

        test("restoring a revision that fails the current schema throws and changes nothing", async () => {
          await createPublished("first", invalid);
          const [revision] = await store.revisions("notes/first");
          const next = await tightened();
          const before = await next.get("notes/first", { draft: true, unvalidated: true });
          await expect(next.restoreRevision("notes/first", revision?.id ?? -1)).rejects.toThrow(ContentValidationError);
          expect(await next.get("notes/first", { draft: true, unvalidated: true })).toEqual(before);
        });

        for (const [state, open] of Object.entries({ invalidDraft, invalidNeverPublished }))
          test(`publish refuses an invalid draft, now and when scheduling (${state})`, async () => {
            const next = await open();
            await expect(next.publish("notes/first")).rejects.toThrow(ContentValidationError);
            await expect(next.publish("notes/first", { at: "2999-01-01T00:00:00.000Z" })).rejects.toThrow(
              ContentValidationError,
            );
          });
      });

      describe("a draft write when the published payload cannot be migrated", () => {
        const live = { title: "Live", tags: [] as string[] };
        /** Version 2 with no shape change, so a version 1 revision is still valid. `migrate` refuses only `live`. */
        const refusingLive: RegistryEntry = {
          ...noteEntry,
          version: 2,
          migrate: (_from, payload) => {
            if ((payload as { title: string }).title === live.title) throw new Error("migrate blew up");
            return payload;
          },
        };
        const alwaysRefusing: RegistryEntry = {
          ...noteEntry,
          version: 2,
          migrate: () => {
            throw new Error("migrate blew up");
          },
        };

        test("restoreRevision succeeds and the published payload stays as stored", async () => {
          await createPublished("first", live);
          const [revision] = await store.revisions("notes/first");
          const next = await reopen(registryOf(alwaysRefusing), { onReadIssue: noop });
          const restored = await next.restoreRevision("notes/first", revision?.id as number);
          expect(restored).toMatchObject({ isDraft: true, payload: live });
          expect((await next.get("notes/first"))?.payload).toEqual(live);
        });

        test("writeField and arrayOp over a valid draft succeed and the published payload stays as stored", async () => {
          await createPublished("first", live);
          await store.writeField("notes/first", "title", "Draft");
          const next = await reopen(registryOf(refusingLive), { onReadIssue: noop });
          expect((await next.writeField("notes/first", "title", "Field")).payload).toMatchObject({ title: "Field" });
          const inserted = await next.arrayOp("notes/first", "tags", { kind: "insert", index: 0, value: "x" });
          expect(inserted.payload).toEqual({ title: "Field", tags: ["x"] });
          expect((await next.get("notes/first"))?.payload).toEqual(live);
        });

        test("a write whose own result is invalid is still refused", async () => {
          await createPublished("first", live);
          await store.writeField("notes/first", "title", "Draft");
          const next = await reopen(registryOf(refusingLive), { onReadIssue: noop });
          await expect(next.writeField("notes/first", "title", "")).rejects.toThrow(ContentValidationError);
          expect((await next.get("notes/first", { draft: true }))?.payload).toMatchObject({ title: "Draft" });
        });
      });

      describe("publishDue with a due document that fails", () => {
        const first = "2000-01-01T00:00:00.000Z";
        const second = "2000-01-02T00:00:00.000Z";
        const scheduleBoth = async () => {
          await store.create("note", "bad", { title: "Bad", tags: [] });
          await store.create("note", "good", { title: "Good", tags: ["x"] });
          await store.publish("notes/bad", { at: first });
          await store.publish("notes/good", { at: second });
          return reopen(registryOf(noteTightened), { onReadIssue: noop });
        };

        test("publishes the others, reports the failure and leaves it scheduled", async () => {
          const next = await scheduleBoth();
          const before = await next.get("notes/bad", { draft: true, unvalidated: true });
          const failures: [string, unknown][] = [];
          const published = await next.publishDue(undefined, {
            actor: "cron",
            onFailure: (key, error) => failures.push([key, error]),
          });
          expect(published.map((doc) => doc.key)).toEqual(["notes/good"]);
          expect(failures).toEqual([["notes/bad", expect.any(ContentValidationError)]]);
          expect(await next.get("notes/bad", { draft: true, unvalidated: true })).toEqual(before);
          expect(before?.scheduledAt).toBe(first);
          expect(await next.get("notes/bad")).toBeNull();
          expect(await next.revisions("notes/bad")).toEqual([]);
          expect(await next.revisions("notes/good")).toMatchObject([{ action: "publish", actor: "cron" }]);
        });

        test("retries it on the next run, and publishes it once repaired", async () => {
          const next = await scheduleBoth();
          const failures: string[] = [];
          const onFailure = (key: string) => failures.push(key);
          await next.publishDue(undefined, { onFailure });
          expect(await next.publishDue(undefined, { onFailure })).toEqual([]);
          expect(failures).toEqual(["notes/bad", "notes/bad"]);
          await next.writeField("notes/bad", "tags", ["fixed"]);
          const published = await next.publishDue(undefined, { onFailure });
          expect(published.map((doc) => doc.key)).toEqual(["notes/bad"]);
          expect(failures).toHaveLength(2);
        });
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
        ["publish with at", (context) => store.publish("notes/first", { ...context, at: "2999-01-01T00:00:00.000Z" })],
        ["unpublish", (context) => store.unpublish("notes/first", context)],
        [
          "restoreRevision",
          async (context) =>
            store.restoreRevision("notes/first", (await store.revisions("notes/first"))[0]!.id, context),
        ],
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

/** A file the media store under test takes, for `runMediaStoreContract`. */
export interface MediaContractSample {
  bytes: Uint8Array;
  type: string;
  filename: string;
}

export interface MediaStoreContractOptions {
  /** A file the store accepts and stores, such as a small PNG. */
  sample: MediaContractSample;
  /**
   * The store answers `processing` for the sample, so the contract polls `job` until it settles. Without it the
   * contract expects `ready` straight from `upload`, and the job tests are skipped.
   */
  processesAsync?: boolean;
  /** The largest body the store takes, in bytes, when it enforces a limit of its own. Enables the limit tests. */
  maxBytes?: number;
  /** How many media items the storage holds. Enables the "stores nothing" checks. */
  count?: () => MaybePromise<number>;
  /** Wait between two `job` polls. Default 20 ms. */
  pollIntervalMs?: number;
  /** Most `job` polls before a job counts as stuck. Default 250. */
  maxPolls?: number;
}

const contractField: MediaFieldRef = { key: "notes/first", path: "hero" };
const otherField: MediaFieldRef = { key: "notes/second", path: "hero" };

/** A stream of `bytes`, cut in a few chunks so a store sees more than one read. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const cut = Math.max(1, Math.ceil(bytes.byteLength / 3));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + cut));
      offset += cut;
    },
  });
}

/** `size` zero bytes in 64 KiB chunks, made as they are read. */
function zeros(size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = Math.min(left, 64 * 1024);
      left -= chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

/** Sends half of `bytes`, then errors. */
function erroringStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return controller.error(new Error("connection reset"));
      sent = true;
      controller.enqueue(bytes.slice(0, Math.max(1, Math.floor(bytes.byteLength / 2))));
    },
  });
}

/**
 * Registers the `MediaStore` contract as vitest tests. `makeStore` runs before every test and must return a store over
 * empty storage. The contract never reads `variants`.
 */
export function runMediaStoreContract<V>(
  name: string,
  makeStore: () => MaybePromise<MediaStore<V>>,
  options: MediaStoreContractOptions,
): void {
  const { sample } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const maxPolls = options.maxPolls ?? 250;
  const info = (overrides: Partial<MediaFileInfo> = {}): MediaFileInfo => ({
    filename: sample.filename,
    type: sample.type,
    size: sample.bytes.byteLength,
    ...overrides,
  });
  const live = () => ({ signal: new AbortController().signal });

  describe(`MediaStore contract: ${name}`, () => {
    let store: MediaStore<V>;
    beforeEach(async () => {
      store = await makeStore();
    });

    /** Polls a job until it is no longer processing. */
    const settle = async (job: string, field = contractField): Promise<MediaJobState<V> | null> => {
      for (let poll = 0; poll < maxPolls; poll++) {
        const state = await store.job?.(job, field);
        if (!state || state.status !== "processing") return state ?? null;
        if (state.progress !== undefined) {
          expect(state.progress).toBeGreaterThanOrEqual(0);
          expect(state.progress).toBeLessThanOrEqual(1);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      throw new Error(`job ${job} still processing after ${maxPolls} polls`);
    };

    /** Uploads the sample and returns the stored media, polling when the store processes asynchronously. */
    const uploadSample = async (file = info()): Promise<ResolvedMedia<V>> => {
      const answer = await store.upload(streamOf(sample.bytes), file, contractField, live());
      if (answer.status === "ready") return answer.media;
      const state = await settle(answer.job);
      if (state?.status !== "ready") throw new Error(`job ${answer.job} did not become ready`);
      return state.media;
    };

    const expectRefusal = async (attempt: () => unknown, codes: readonly string[]) => {
      const failure = await Promise.resolve()
        .then(attempt)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(MediaRefusal);
      expect(codes).toContain((failure as MediaRefusal).code);
    };

    const expectNothingStored = async (before: number | undefined) => {
      if (options.count) expect(await options.count()).toBe(before);
    };

    describe("upload", () => {
      test.skipIf(options.processesAsync === true)("the sample answers ready with an id", async () => {
        const answer = await store.upload(streamOf(sample.bytes), info(), contractField, live());
        expect(answer.status).toBe("ready");
        if (answer.status !== "ready") return;
        expect(answer.media.id).toEqual(expect.any(String));
        expect(answer.media.id.length).toBeGreaterThan(0);
      });

      test.skipIf(options.processesAsync !== true)("the sample answers processing with a job id", async () => {
        const answer = await store.upload(streamOf(sample.bytes), info(), contractField, live());
        expect(answer.status).toBe("processing");
        if (answer.status !== "processing") return;
        expect(answer.job).toEqual(expect.any(String));
        if (answer.retryAfterMs !== undefined) expect(answer.retryAfterMs).toBeGreaterThan(0);
      });

      // The handlers refuse to send a render that breaks these rules, so a store that fails here shows no image.
      test("the render has a kind, a src and a positive integer intrinsic size", async () => {
        const { render } = await uploadSample();
        expect(["image", "video"]).toContain(render.kind);
        expect(render.src).toEqual(expect.any(String));
        expect(render.src.length).toBeGreaterThan(0);
        expect(Number.isInteger(render.width) && render.width > 0).toBe(true);
        expect(Number.isInteger(render.height) && render.height > 0).toBe(true);
      });

      test("an undeclared size (null) still uploads", async () => {
        const media = await uploadSample(info({ size: null }));
        expect(media.id.length).toBeGreaterThan(0);
      });

      test("rejects when the body stream errors, and stores nothing", async () => {
        const before = await options.count?.();
        await expect(store.upload(erroringStream(sample.bytes), info(), contractField, live())).rejects.toBeInstanceOf(
          Error,
        );
        await expectNothingStored(before);
      });

      test("rejects when the signal is already aborted, and stores nothing", async () => {
        const before = await options.count?.();
        const controller = new AbortController();
        controller.abort();
        const upload = store.upload(streamOf(sample.bytes), info(), contractField, { signal: controller.signal });
        await expect(upload).rejects.toBeInstanceOf(Error);
        await expectNothingStored(before);
      });

      test("rejects when the signal aborts mid-body, and stores nothing", async () => {
        const before = await options.count?.();
        const controller = new AbortController();
        let sent = false;
        // Sends one byte, then aborts and never sends more: only the signal can end the upload.
        const stalled = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (sent) {
              controller.abort();
              return new Promise(() => {});
            }
            sent = true;
            streamController.enqueue(sample.bytes.slice(0, 1));
          },
        });
        await expect(
          store.upload(stalled, info(), contractField, { signal: controller.signal }),
        ).rejects.toBeInstanceOf(Error);
        await expectNothingStored(before);
      });

      test("bytes that are not a file it takes are refused with a MediaRefusal", async () => {
        const text = new TextEncoder().encode("not an image at all");
        const file = { filename: "notes.txt", type: "text/plain", size: text.byteLength };
        await expectRefusal(
          () => store.upload(streamOf(text), file, contractField, live()),
          ["unsupported", "invalid"],
        );
      });

      test("an untrusted filename with path separators is stored safely or refused", async () => {
        const result = await uploadSample(info({ filename: "../../etc/pass\\wd\u0000.png" })).then(
          (media) => ({ media }),
          (error: unknown) => ({ error }),
        );
        if ("error" in result) {
          expect(result.error).toBeInstanceOf(MediaRefusal);
          return;
        }
        const filename = result.media.render.filename;
        if (filename === undefined) return;
        expect(filename).not.toMatch(/[/\\]/);
        expect(filename.includes("\u0000")).toBe(false);
      });

      test.skipIf(options.maxBytes === undefined)("a body past its limit is refused as too_large", async () => {
        const before = await options.count?.();
        const tooLarge = (options.maxBytes ?? 0) + 1;
        await expectRefusal(
          () => store.upload(zeros(tooLarge), info({ size: null }), contractField, live()),
          ["too_large"],
        );
        await expectNothingStored(before);
      });

      test.skipIf(options.maxBytes === undefined)("accept, when present, refuses a declared size past it", async () => {
        if (!store.accept) return;
        const tooLarge = (options.maxBytes ?? 0) + 1;
        await expectRefusal(() => store.accept?.(contractField, info({ size: tooLarge }), {}), ["too_large"]);
      });
    });

    describe("resolve", () => {
      test("returns an uploaded id with its render", async () => {
        const media = await uploadSample();
        const resolved = await store.resolve([media.id]);
        expect(resolved.get(media.id)?.id).toBe(media.id);
        expect(resolved.get(media.id)?.render).toEqual(media.render);
      });

      test("leaves unknown ids out of the map", async () => {
        const media = await uploadSample();
        const resolved = await store.resolve([media.id, "contract-unknown-id"]);
        expect(resolved.has("contract-unknown-id")).toBe(false);
        expect(resolved.has(media.id)).toBe(true);
      });

      test("no ids is an empty map", async () => {
        expect((await store.resolve([])).size).toBe(0);
      });
    });

    describe.skipIf(options.processesAsync !== true)("jobs", () => {
      const startJob = async () => {
        const answer = await store.upload(streamOf(sample.bytes), info(), contractField, live());
        if (answer.status !== "processing") throw new Error("expected processing");
        return answer.job;
      };

      test("the store has job()", () => {
        expect(typeof store.job).toBe("function");
      });

      test("a job becomes ready with media that resolve returns", async () => {
        const state = await settle(await startJob());
        expect(state?.status).toBe("ready");
        if (state?.status !== "ready") return;
        expect((await store.resolve([state.media.id])).get(state.media.id)?.render).toEqual(state.media.render);
      });

      test("a job stays readable for a while after ready", async () => {
        const job = await startJob();
        const first = await settle(job);
        expect(first?.status).toBe("ready");
        expect(await store.job?.(job, contractField)).toEqual(first);
      });

      test("an unknown job reads null", async () => {
        expect(await store.job?.("contract-unknown-job", contractField)).toBeNull();
      });

      test("a job that belongs to another field reads null", async () => {
        const job = await startJob();
        expect(await store.job?.(job, otherField)).toBeNull();
        expect(await store.job?.(job, { key: contractField.key, path: "other" })).toBeNull();
        expect(await store.job?.(job, contractField)).not.toBeNull();
      });

      test("cancelJob of another field's job leaves it running", async () => {
        if (!store.cancelJob) return;
        const job = await startJob();
        await store.cancelJob(job, otherField);
        expect((await settle(job))?.status).toBe("ready");
      });

      test("after cancelJob the job reads null or failed, never ready", async () => {
        if (!store.cancelJob) return;
        const job = await startJob();
        await store.cancelJob(job, contractField);
        const state = await store.job?.(job, contractField);
        expect(state === null || state?.status === "failed").toBe(true);
      });

      test("cancelJob of an unknown job resolves", async () => {
        if (!store.cancelJob) return;
        await expect(store.cancelJob("contract-unknown-job", contractField)).resolves.toBeUndefined();
      });
    });
  });
}
