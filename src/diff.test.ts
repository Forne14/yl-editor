import { describe, expect, it } from "vitest";
import { diffPayloads } from "./diff.ts";
import { formatPath, getAt, parsePath } from "./path.ts";

describe("diffPayloads", () => {
  it("returns [] for identical input", () => {
    const v = { a: 1, b: [1, { c: null }] };
    expect(diffPayloads(v, structuredClone(v))).toEqual([]);
    expect(diffPayloads(undefined, undefined)).toEqual([]);
  });

  it("handles nested add, remove, change in after-then-removed order", () => {
    const before = { hero: { title: "a", sub: "x" }, gone: 1 };
    const after = { hero: { title: "b", extra: true }, fresh: 2 };
    expect(diffPayloads(before, after)).toEqual([
      { path: "hero.title", kind: "changed", before: "a", after: "b" },
      { path: "hero.extra", kind: "added", after: true },
      { path: "hero.sub", kind: "removed", before: "x" },
      { path: "fresh", kind: "added", after: 2 },
      { path: "gone", kind: "removed", before: 1 },
    ]);
  });

  it("compares arrays by index", () => {
    expect(diffPayloads({ l: [1, 2] }, { l: [1, 2, 3] })).toEqual([{ path: "l.2", kind: "added", after: 3 }]);
    expect(diffPayloads({ l: [1, 2, 3] }, { l: [1] })).toEqual([
      { path: "l.1", kind: "removed", before: 2 },
      { path: "l.2", kind: "removed", before: 3 },
    ]);
    expect(diffPayloads(["a", "b"], ["b", "a"])).toEqual([
      { path: "0", kind: "changed", before: "a", after: "b" },
      { path: "1", kind: "changed", before: "b", after: "a" },
    ]);
    expect(
      diffPayloads({ items: [{ label: "a" }, { label: "b" }] }, { items: [{ label: "a" }, { label: "c" }] }),
    ).toEqual([{ path: "items.1.label", kind: "changed", before: "b", after: "c" }]);
  });

  it("reports a type change as one entry", () => {
    expect(diffPayloads({ a: { b: 1 } }, { a: "s" })).toEqual([
      { path: "a", kind: "changed", before: { b: 1 }, after: "s" },
    ]);
    expect(diffPayloads({ a: [1] }, { a: { 0: 1 } })).toHaveLength(1);
  });

  it("distinguishes null from missing, and treats undefined as missing", () => {
    expect(diffPayloads({ a: null }, {})).toEqual([{ path: "a", kind: "removed", before: null }]);
    expect(diffPayloads({}, { a: null })).toEqual([{ path: "a", kind: "added", after: null }]);
    expect(diffPayloads({ a: undefined }, {})).toEqual([]);
    expect(diffPayloads({ a: null }, { a: undefined })).toEqual([{ path: "a", kind: "removed", before: null }]);
  });

  it("emits paths that round-trip through parsePath", () => {
    const after = { items: [{ label: "z" }], hero: { title: "t" } };
    for (const e of diffPayloads({ items: [{ label: "a" }], hero: {} }, after)) {
      expect(formatPath(parsePath(e.path))).toBe(e.path);
      if (e.kind !== "removed") expect(getAt(after, parsePath(e.path))).toEqual(e.after);
    }
  });
});
