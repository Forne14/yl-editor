import { describe, expect, test } from "vitest";
import { AtomError, createAccessEngine, documentAccess } from "./index.ts";
import { fixtureCatalogue } from "./test-fixture.ts";

const engine = createAccessEngine(fixtureCatalogue());
const map = {
  page: { edit: "pages.edit", publish: "pages.publish" },
  show: { edit: "radio.manage", publish: "radio.manage" },
};
type Locals = { roleId: string | null };
const access = documentAccess({
  atomsOf: (locals) => {
    const { roleId } = locals as Locals;
    return roleId === null ? null : engine.atomsOfRole(roleId);
  },
  map,
});
const page = { type: "page", key: "page:home" };
const show = { type: "show", key: "show:breakfast" };

describe("documentAccess", () => {
  test("nobody signed in is denied", async () => {
    expect(await access.canEdit({ roleId: null }, page)).toEqual({ allowed: false, reason: "not signed in" });
    expect(await access.canPublish({ roleId: null }, page)).toEqual({ allowed: false, reason: "not signed in" });
  });
  test("an unmapped document type fails closed, even for the owner", async () => {
    const product = { type: "product", key: "product:tee" };
    const expected = { allowed: false, reason: "no permission mapped for type product" };
    expect(await access.canEdit({ roleId: "owner" }, product)).toEqual(expected);
    expect(await access.canPublish({ roleId: "owner" }, product)).toEqual(expected);
  });
  test("an inherited object key is not a mapping", async () =>
    expect(await access.canEdit({ roleId: "owner" }, { type: "constructor", key: "x" })).toEqual({
      allowed: false,
      reason: "no permission mapped for type constructor",
    }));
  test("allowed when the atom is held through a family wildcard", async () => {
    expect(await access.canPublish({ roleId: "editor" }, page)).toEqual({ allowed: true });
    expect(await access.canEdit({ roleId: "radio_desk" }, show)).toEqual({ allowed: true });
  });
  test("the reason names the missing atom", async () => {
    expect(await access.canPublish({ roleId: "contributor" }, page)).toEqual({ allowed: false, reason: "missing pages.publish" });
    expect(await access.canEdit({ roleId: "editor" }, show)).toEqual({ allowed: false, reason: "missing radio.manage" });
  });
  test("an async atom source works", async () => {
    const asyncAccess = documentAccess({ atomsOf: async () => new Set(["pages.*"]), map });
    expect(await asyncAccess.canPublish({}, page)).toEqual({ allowed: true });
  });
  test("a malformed mapped atom throws at construction", () =>
    expect(() => documentAccess({ atomsOf: () => null, map: { page: { edit: "pages", publish: "pages.publish" } } })).toThrow(
      AtomError,
    ));
});
