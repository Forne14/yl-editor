import { describe, expect, test } from "vitest";
import { applyArrayOp, getAt, parsePath, setAt } from "./path";
import { ArrayOpSchema, PathError } from "./types";

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
