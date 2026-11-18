import { describe, expect, test } from "vitest";
import { z } from "zod";
import { MISSING_KEY_MESSAGE, addListKeys, keyedItems } from "./keys.ts";
import { createSqliteContentStore } from "./sqlite-store.ts";
import { makeTestDb } from "./test-support.ts";
import { ContentValidationError, type RegistryEntry, type SchemaRegistry } from "./types.ts";

const artist = z.object({ name: z.string() });

describe("keyedItems", () => {
  const schema = keyedItems(artist);

  test("accepts items that each carry a usable, unique _key, and keeps it", () => {
    expect(schema.parse([{ _key: "a1", name: "Mara" }])).toEqual([{ _key: "a1", name: "Mara" }]);
  });

  test.each([
    [{ name: "Mara" }],
    [{ _key: 5, name: "Mara" }],
    [{ _key: "a b", name: "Mara" }],
    [{ _key: "constructor", name: "Mara" }],
  ])("refuses an item without a usable _key, saying a key must be provided: %j", (item) => {
    const result = schema.safeParse([item]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(MISSING_KEY_MESSAGE);
    expect(result.error?.issues[0]?.path).toEqual([0, "_key"]);
  });

  test("refuses a _key used twice in one list", () => {
    const result = schema.safeParse([
      { _key: "a", name: "Mara" },
      { _key: "a", name: "Tobias" },
    ]);
    expect(result.error?.issues[0]?.message).toContain("must be unique");
  });
});

describe("addListKeys", () => {
  test("keys the items without one, by place, skipping keys already used, and leaves the rest alone", () => {
    const payload = { title: "T", artists: [{ name: "Mara" }, { _key: "k1", name: "Tobias" }, { name: "Ines" }] };
    expect(addListKeys(payload, ["artists"])).toEqual({
      title: "T",
      artists: [
        { _key: "k0", name: "Mara" },
        { _key: "k1", name: "Tobias" },
        { _key: "k2", name: "Ines" },
      ],
    });
  });

  test("is pure: the same payload gives the same keys, and a keyed payload comes back as it was", () => {
    const payload = { artists: [{ name: "Mara" }] };
    expect(addListKeys(payload, ["artists"])).toEqual(addListKeys(payload, ["artists"]));
    expect(payload).toEqual({ artists: [{ name: "Mara" }] });
    const keyed = { artists: [{ _key: "a", name: "Mara" }] };
    expect(addListKeys(keyed, ["artists"])).toBe(keyed);
  });

  test("a key used twice keeps its first item; the later one gets a new key, so the list validates", () => {
    const keyed = addListKeys(
      {
        team: [
          { _key: "a", n: 1 },
          { _key: "a", n: 2 },
        ],
      },
      ["team"],
    );
    expect(keyed).toEqual({
      team: [
        { _key: "a", n: 1 },
        { _key: "k0", n: 2 },
      ],
    });
    expect(keyedItems(z.object({ n: z.number() })).safeParse((keyed as { team: unknown[] }).team).success).toBe(true);
  });

  test("keys several lists, including nested paths, and leaves non-objects alone", () => {
    expect(addListKeys({ a: [{ x: 1 }], b: { c: [{ y: 2 }, "text"] } }, ["a", "b.c"])).toEqual({
      a: [{ _key: "k0", x: 1 }],
      b: { c: [{ _key: "k0", y: 2 }, "text"] },
    });
  });

  test("in a registry entry's migrate, existing unkeyed content reads keyed, and the next write stores those keys", async () => {
    const schema = z.object({ title: z.string(), artists: keyedItems(artist) });
    const entry: RegistryEntry = {
      type: "page",
      collection: "pages",
      schema,
      version: 2,
      migrate: (from, payload) => (from < 2 ? addListKeys(payload, ["artists"]) : payload),
    };
    const registry: SchemaRegistry = { entry: () => entry, byCollection: () => entry, entries: () => [entry] };
    const db = makeTestDb();
    const unkeyedEntry: RegistryEntry = { type: "page", collection: "pages", schema: z.unknown() };
    const old = createSqliteContentStore(db, {
      entry: () => unkeyedEntry,
      byCollection: () => unkeyedEntry,
      entries: () => [unkeyedEntry],
    });
    await old.create("page", "list", { title: "T", artists: [{ name: "Mara" }, { name: "Tobias" }] });
    const store = createSqliteContentStore(db, registry);
    const first = await store.get("pages/list", { draft: true });
    const again = await store.get("pages/list", { draft: true });
    expect(first?.payload).toEqual({
      title: "T",
      artists: [
        { _key: "k0", name: "Mara" },
        { _key: "k1", name: "Tobias" },
      ],
    });
    expect(again?.payload).toEqual(first?.payload);
    await store.writeField("pages/list", "title", "T2");
    const stored = await store.get("pages/list", { draft: true, unvalidated: true });
    expect((stored?.payload as { artists: unknown[] }).artists).toEqual([
      { _key: "k0", name: "Mara" },
      { _key: "k1", name: "Tobias" },
    ]);
  });

  test("a write of an unkeyed item is refused with the key message", async () => {
    const schema = z.object({ artists: keyedItems(artist) });
    const entry: RegistryEntry = { type: "page", collection: "pages", schema };
    const registry: SchemaRegistry = { entry: () => entry, byCollection: () => entry, entries: () => [entry] };
    const store = createSqliteContentStore(makeTestDb(), registry);
    await store.create("page", "list", { artists: [{ _key: "a", name: "Mara" }] });
    const error = await store
      .arrayOp("pages/list", "artists", { kind: "insert", index: 1, value: { name: "Tobias" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContentValidationError);
    expect(JSON.stringify((error as ContentValidationError).issues)).toContain(MISSING_KEY_MESSAGE);
  });
});
