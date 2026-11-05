import { describe, expect, test } from "vitest";
import { applyArrayOp, formatPath, getAt, parsePath, setAt, type Segment } from "./path.ts";
import { ArrayOpSchema, PathError } from "./types.ts";

describe("parsePath", () => {
  test("splits on dots and turns digits into indices", () =>
    expect(parsePath("parts.problem.media.0.alt")).toEqual(["parts", "problem", "media", 0, "alt"]));
  test.each(["", "a..b", ".a", "a.", "__proto__.x", "a.constructor", "a.prototype"])("rejects %j", (p) =>
    expect(() => parsePath(p)).toThrow(PathError),
  );
});

describe("setAt", () => {
  const doc = { a: { b: [1, 2, 3] }, c: "x" };
  const snapshot = structuredClone(doc);
  test("sets a nested value without mutating the input", () => {
    const next = setAt(doc, ["a", "b", 1], 9);
    expect(next.a.b).toEqual([1, 9, 3]);
    expect(doc.a.b).toEqual([1, 2, 3]);
  });
  test("may add a key to an existing object", () => expect(setAt(doc, ["d"], 1)).toMatchObject({ d: 1 }));
  test.each([
    ["a missing intermediate", ["x", "y"]],
    ["an index out of range", ["a", "b", 3]],
    ["an index into a non-array", ["c", 0]],
    ["an empty path", []],
  ] as const)("refuses %s and leaves the input untouched", (_name, path) => {
    expect(() => setAt(doc, [...path], 1)).toThrow(PathError);
    expect(doc).toEqual(snapshot);
  });
});

describe("getAt", () => {
  test("returns undefined for a missing path", () => expect(getAt({ a: 1 }, ["b", "c"])).toBeUndefined());
});

describe("applyArrayOp", () => {
  const doc = { list: ["a", "b", "c"] };
  test("insert at end", () =>
    expect(applyArrayOp(doc, ["list"], { kind: "insert", index: 3, value: "d" }).list).toEqual(["a", "b", "c", "d"]));
  test("move", () =>
    expect(applyArrayOp(doc, ["list"], { kind: "move", from: 0, to: 2 }).list).toEqual(["b", "c", "a"]));
  test("remove", () => expect(applyArrayOp(doc, ["list"], { kind: "remove", index: 1 }).list).toEqual(["a", "c"]));
  test("insert past the end is refused", () =>
    expect(() => applyArrayOp(doc, ["list"], { kind: "insert", index: 5, value: "x" })).toThrow(PathError));
  test("remove out of range is refused", () =>
    expect(() => applyArrayOp(doc, ["list"], { kind: "remove", index: 3 })).toThrow(PathError));
  test("target must be an array", () =>
    expect(() => applyArrayOp({ list: "no" }, ["list"], { kind: "remove", index: 0 })).toThrow(PathError));
  test("a missing target path is refused", () =>
    expect(() => applyArrayOp(doc, ["nope", "list"], { kind: "remove", index: 0 })).toThrow(PathError));
  test("does not mutate the input on success", () => {
    applyArrayOp(doc, ["list"], { kind: "remove", index: 0 });
    expect(doc.list).toEqual(["a", "b", "c"]);
  });
  test.each([
    { kind: "insert", index: 5, value: "x" },
    { kind: "move", from: 0, to: 3 },
    { kind: "move", from: -1, to: 0 },
    { kind: "remove", index: 3 },
    { kind: "remove", index: 1.5 },
  ] as const)("does not mutate the input when %j is refused", (op) => {
    const input = { list: ["a", "b", "c"] };
    expect(() => applyArrayOp(input, ["list"], op)).toThrow(PathError);
    expect(input).toEqual({ list: ["a", "b", "c"] });
  });
});

describe("ArrayOpSchema", () => {
  test("accepts the three kinds", () => {
    expect(ArrayOpSchema.safeParse({ kind: "insert", index: 0, value: 1 }).success).toBe(true);
    expect(ArrayOpSchema.safeParse({ kind: "move", from: 0, to: 1 }).success).toBe(true);
    expect(ArrayOpSchema.safeParse({ kind: "remove", index: 0 }).success).toBe(true);
  });
  test("rejects an unknown kind", () =>
    expect(ArrayOpSchema.safeParse({ kind: "swap", index: 0 }).success).toBe(false));
  test.each([-1, 1.5])("rejects index %j", (index) =>
    expect(ArrayOpSchema.safeParse({ kind: "remove", index }).success).toBe(false),
  );
});

describe("prototype safety and numeric segments", () => {
  test.each(["__proto__", "constructor", "prototype"])("setAt and applyArrayOp refuse %s", (seg) => {
    expect(() => setAt({}, [seg, "x"], 1)).toThrow(PathError);
    expect(() => setAt({ a: {} }, ["a", seg], 1)).toThrow(PathError);
    expect(() => applyArrayOp({ a: [] }, ["a", seg], { kind: "insert", index: 0, value: 1 })).toThrow(PathError);
    expect(() => applyArrayOp({}, [seg], { kind: "insert", index: 0, value: 1 })).toThrow(PathError);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    expect(Array.prototype).toHaveLength(0);
    expect(getAt({}, [seg])).toBeUndefined();
  });
  test("does not follow inherited properties", () => {
    expect(() => setAt({ a: 1 }, ["toString", "x"], 1)).toThrow(PathError);
    expect(getAt({}, ["toString"])).toBeUndefined();
  });
  test.each([-1, Number.NaN, 1.5])("setAt refuses index %j and leaves the input untouched", (i) => {
    const input = { l: [1, 2] };
    expect(() => setAt(input, ["l", i], 9)).toThrow(PathError);
    expect(input).toEqual({ l: [1, 2] });
    expect(Object.keys(input.l)).toEqual(["0", "1"]);
  });
});

describe("ArrayOpSchema value", () => {
  test("insert requires the value key (Zod 4 treats a missing key as invalid)", () => {
    expect(ArrayOpSchema.safeParse({ kind: "insert", index: 0 }).success).toBe(false);
    expect(ArrayOpSchema.safeParse({ kind: "insert", index: 0, value: null }).success).toBe(true);
  });
});

describe("keyed segments", () => {
  const doc = {
    items: [
      { _key: "a", title: "A" },
      { _key: "b-2", title: "B" },
    ],
    sections: [
      { _key: "s1", items: [{ _key: "x", title: "X" }] },
      { _key: "a", items: [{ _key: "b", title: "Nested", tags: ["t1"] }] },
    ],
    plain: [1, 2, 3],
    obj: { _key: "a" },
  };
  const snapshot = structuredClone(doc);

  test("parse yields a key segment after its name", () =>
    expect(parsePath("items[_key=abc].title")).toEqual(["items", { key: "abc" }, "title"]));
  test("parse handles nested keyed segments and indices", () =>
    expect(parsePath("sections[_key=a].items[_key=b_C-9].title")).toEqual([
      "sections",
      { key: "a" },
      "items",
      { key: "b_C-9" },
      "title",
    ]));
  test.each([
    "items",
    "a.b.0.c",
    "items[_key=abc].title",
    "sections[_key=a].items[_key=b].title",
    "rows.0[_key=k]",
    "items[_key=z]",
  ])("format(parse(%j)) round-trips", (p) => expect(formatPath(parsePath(p))).toBe(p));
  test.each<[Segment[]]>([[["a", 0, "b"]], [["items", { key: "k" }, "tags", 2]], [[3, { key: "a-b" }]]])(
    "parse(format(%j)) round-trips",
    (segs) => expect(parsePath(formatPath(segs))).toEqual(segs),
  );
  test.each([
    "items[_key=]",
    "items[_key=a b]",
    "items[_key=a.b]",
    "items[_key=a",
    "[_key=a]",
    "items[_key=a][_key=b]",
    "items[_key=a]x",
    "__proto__[_key=a]",
    "constructor[_key=a].x",
    "items[_key=__proto__]",
    "items[_key=constructor]",
    "items[_key=prototype].title",
  ])("parse rejects %j", (p) => expect(() => parsePath(p)).toThrow(PathError));
  test.each<[Segment[]]>([
    [[]],
    [[{ key: "a" }]],
    [["a", { key: "x" }, { key: "y" }]],
    [["a", { key: "bad id" }]],
    [["a", { key: "__proto__" }]],
    [["a.b"]],
    [["7"]],
    [[""]],
    [["x[_key=a]"]],
    [["__proto__"]],
    [[-1]],
    [[1.5]],
  ])("format rejects %j", (segs) => expect(() => formatPath(segs)).toThrow(PathError));

  test("getAt resolves by _key, not position", () => {
    expect(getAt(doc, parsePath("items[_key=b-2].title"))).toBe("B");
    expect(getAt(doc, parsePath("sections[_key=a].items[_key=b].title"))).toBe("Nested");
    expect(getAt(doc, parsePath("sections[_key=a].items[_key=b].tags.0"))).toBe("t1");
  });
  test("getAt is undefined when no element matches or the parent is not an array", () => {
    expect(getAt(doc, parsePath("items[_key=nope].title"))).toBeUndefined();
    expect(getAt(doc, parsePath("obj[_key=a]"))).toBeUndefined();
    expect(getAt(doc, parsePath("plain[_key=a]"))).toBeUndefined();
    expect(getAt(doc, ["items", { key: "bad id" }])).toBeUndefined();
  });
  test("index paths still work, including arrays of primitives", () => {
    expect(getAt(doc, parsePath("items.1.title"))).toBe("B");
    expect(setAt(doc, parsePath("plain.1"), 9).plain).toEqual([1, 9, 3]);
  });

  test("setAt writes through a keyed segment after a reorder", () => {
    const reordered = { ...doc, items: [doc.items[1], doc.items[0]] };
    const next = setAt(reordered, parsePath("items[_key=a].title"), "A2");
    expect(next.items).toEqual([
      { _key: "b-2", title: "B" },
      { _key: "a", title: "A2" },
    ]);
  });
  test("setAt writes through nested keyed segments without mutating the input", () => {
    const next = setAt(doc, parsePath("sections[_key=a].items[_key=b].title"), "N2");
    expect(next.sections[1]?.items[0]?.title).toBe("N2");
    expect(doc).toEqual(snapshot);
  });
  test("setAt can replace a keyed element itself", () =>
    expect(setAt(doc, parsePath("items[_key=a]"), { _key: "a", title: "new" }).items[0]).toEqual({
      _key: "a",
      title: "new",
    }));
  test.each([
    ["an unmatched final key", "items[_key=nope]"],
    ["an unmatched intermediate key", "items[_key=nope].title"],
    ["an unmatched nested key", "sections[_key=a].items[_key=nope].title"],
    ["a key into a non-array", "obj[_key=a]"],
  ])("setAt refuses %s with PathError", (_name, p) => {
    expect(() => setAt(doc, parsePath(p), 1)).toThrow(PathError);
    expect(doc).toEqual(snapshot);
  });
  test("setAt names the missing key", () =>
    expect(() => setAt(doc, parsePath("items[_key=nope].title"), 1)).toThrow("No item with _key=nope"));

  test("applyArrayOp reaches an array through keyed segments", () => {
    const next = applyArrayOp(doc, parsePath("sections[_key=a].items[_key=b].tags"), {
      kind: "insert",
      index: 1,
      value: "t2",
    });
    expect(getAt(next, parsePath("sections[_key=a].items[_key=b].tags"))).toEqual(["t1", "t2"]);
    expect(doc).toEqual(snapshot);
  });
  test("applyArrayOp moves inside a keyed parent", () =>
    expect(
      applyArrayOp({ s: [{ _key: "k", l: [1, 2] }] }, parsePath("s[_key=k].l"), { kind: "move", from: 0, to: 1 }).s[0]
        ?.l,
    ).toEqual([2, 1]));
  test.each(["sections[_key=nope].items", "sections[_key=a].items[_key=nope].tags", "items[_key=nope]"])(
    "applyArrayOp refuses unmatched %j with PathError",
    (p) => {
      expect(() => applyArrayOp(doc, parsePath(p), { kind: "insert", index: 0, value: 1 })).toThrow(PathError);
      expect(doc).toEqual(snapshot);
    },
  );
  test("forbidden keys in hand-built segments are refused", () => {
    expect(() => setAt(doc, ["items", { key: "__proto__" }, "x"], 1)).toThrow(PathError);
    expect(() => applyArrayOp(doc, ["items", { key: "constructor" }], { kind: "remove", index: 0 })).toThrow(PathError);
    expect(getAt(doc, ["items", { key: "prototype" }])).toBeUndefined();
  });
  test("does not match an inherited _key", () => {
    const proto = { _key: "p" };
    const list = [Object.create(proto) as object];
    expect(getAt({ list }, parsePath("list[_key=p]"))).toBeUndefined();
  });
});
