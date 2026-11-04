import { describe, expect, test } from "vitest";
import { ALL, AtomError, holds, parseAtom } from "./index.ts";

describe("parseAtom", () => {
  test("parses the three shapes", () => {
    expect(parseAtom("posts.publish")).toEqual({ family: "posts", rest: "publish", wildcard: null });
    expect(parseAtom("posts.write.own")).toEqual({ family: "posts", rest: "write.own", wildcard: null });
    expect(parseAtom("radio.*")).toEqual({ family: "radio", rest: null, wildcard: "family" });
    expect(parseAtom(ALL)).toEqual({ family: "*", rest: null, wildcard: "all" });
  });

  test.each(["", "posts", "posts.", ".publish", "posts..publish", "Posts.publish", "posts.write.*", "*.publish", "posts.*.own", "posts publish", "1posts.read", "**"])(
    "rejects %j",
    (malformed) => expect(() => parseAtom(malformed)).toThrow(AtomError),
  );
});

describe("holds: resolution order exact, then family.*, then *", () => {
  test("an exact atom is held", () => expect(holds(new Set(["posts.publish"]), "posts.publish")).toBe(true));
  test("a family wildcard confers its family only", () => {
    const held = new Set(["posts.*"]);
    expect(holds(held, "posts.publish")).toBe(true);
    expect(holds(held, "posts.write.own")).toBe(true);
    expect(holds(held, "pages.publish")).toBe(false);
  });
  test("* confers everything", () => {
    expect(holds(new Set([ALL]), "anything.at_all")).toBe(true);
    expect(holds(new Set([ALL]), "radio.*")).toBe(true);
  });
  test("radio.* picks up a future radio.schedule without being told about it", () =>
    expect(holds(new Set(["radio.*"]), "radio.schedule")).toBe(true));
  test("a wildcard is held only by itself or a wider wildcard", () => {
    expect(holds(new Set(["radio.manage", "radio.password.own"]), "radio.*")).toBe(false);
    expect(holds(new Set(["radio.*"]), ALL)).toBe(false);
    expect(holds(new Set(["radio.*"]), "radio.*")).toBe(true);
  });
  test("a nearby atom is not held", () => {
    expect(holds(new Set(["posts.write.own"]), "posts.write.any")).toBe(false);
    expect(holds(new Set(["posts.write"]), "posts.write.own")).toBe(false);
  });
  test("a malformed atom is never held, even by *", () => expect(holds(new Set([ALL]), "posts")).toBe(false));
  test("nothing is held by the empty set", () => expect(holds(new Set(), "posts.publish")).toBe(false));
});
