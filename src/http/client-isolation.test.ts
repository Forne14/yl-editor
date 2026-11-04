import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { isErrorEnvelope } from "./wire-types.ts";

const source = (fileName: string) => readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8");

describe("the browser client stays free of zod and the core", () => {
  test.each(["client.ts", "wire-types.ts"])("%s imports neither zod nor ../types.ts", (fileName) => {
    const text = source(fileName);
    expect(text).not.toMatch(/from\s+["']zod["']/);
    expect(text).not.toMatch(/from\s+["']\.\.\/types\.ts["']/);
  });

  test("client.ts imports only from wire-types.ts", () => {
    const specifiers = [...source("client.ts").matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers).toEqual(["./wire-types.ts"]);
  });

  test("wire-types.ts has no imports at all", () => {
    expect(source("wire-types.ts")).not.toMatch(/^\s*import\s/m);
  });
});

describe("isErrorEnvelope", () => {
  test("accepts a well-formed envelope, with or without current", () => {
    expect(isErrorEnvelope({ error: { code: "forbidden", message: "No" } })).toBe(true);
    expect(isErrorEnvelope({ error: { code: "conflict", message: "Stale", current: { version: 2 } } })).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isErrorEnvelope(null)).toBe(false);
    expect(isErrorEnvelope("Bad gateway")).toBe(false);
    expect(isErrorEnvelope({ error: "nope" })).toBe(false);
    expect(isErrorEnvelope({ error: { code: "teapot", message: "Short and stout" } })).toBe(false);
    expect(isErrorEnvelope({ error: { code: "toString", message: "Inherited" } })).toBe(false);
    expect(isErrorEnvelope({ error: { code: "forbidden" } })).toBe(false);
    expect(isErrorEnvelope({ error: { code: "conflict", message: "Stale", current: 3 } })).toBe(false);
  });
});
