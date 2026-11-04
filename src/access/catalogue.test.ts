import { describe, expect, test } from "vitest";
import { CatalogueError, createAccessEngine, validateCatalogue } from "./index.ts";
import { fixtureCatalogue } from "./test-fixture.ts";

type MutableCatalogue = {
  atoms: { atom: string; label: string; family: string }[];
  ownerReserved: string[];
  ownerRoleId: string;
  roles: { id: string; label: string; line: string; atoms: string[]; builtin: boolean }[];
};

function mutableFixture(): MutableCatalogue {
  return fixtureCatalogue() as unknown as MutableCatalogue;
}

function problemsOf(mutate: (catalogue: MutableCatalogue) => void): string[] {
  const catalogue = mutableFixture();
  mutate(catalogue);
  try {
    validateCatalogue(catalogue);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return [...(error as CatalogueError).problems];
  }
  throw new Error("expected the catalogue to be rejected");
}

describe("validateCatalogue", () => {
  test("accepts the fixture", () => expect(() => validateCatalogue(fixtureCatalogue())).not.toThrow());

  test("rejects a wrong shape", () => {
    expect(() => validateCatalogue({ atoms: "nope" })).toThrow(CatalogueError);
    expect(() => validateCatalogue(null)).toThrow(CatalogueError);
  });

  const cases: [string, (catalogue: MutableCatalogue) => void, RegExp][] = [
    [
      "a duplicate atom",
      (catalogue) => void catalogue.atoms.push({ atom: "posts.publish", label: "again", family: "posts" }),
      /posts\.publish is defined more than once/,
    ],
    [
      "a duplicate role",
      (catalogue) => void catalogue.roles.push({ ...catalogue.roles[2]! }),
      /role editor is defined more than once/,
    ],
    [
      "a malformed atom",
      (catalogue) => void catalogue.atoms.push({ atom: "posts", label: "x", family: "posts" }),
      /atom posts is malformed/,
    ],
    [
      "a wildcard in the atom list",
      (catalogue) => void catalogue.atoms.push({ atom: "posts.*", label: "x", family: "posts" }),
      /wildcard/,
    ],
    [
      "a family that disagrees with the spelling",
      (catalogue) => void catalogue.atoms.push({ atom: "posts.archive", label: "x", family: "pages" }),
      /declares family pages/,
    ],
    [
      "a role naming an unknown atom",
      (catalogue) => void catalogue.roles[3]!.atoms.push("posts.delete"),
      /role contributor: unknown atom posts\.delete/,
    ],
    [
      "a role naming a wildcard over an unknown family",
      (catalogue) => void catalogue.roles[3]!.atoms.push("podcasts.*"),
      /unknown atom podcasts\.\*/,
    ],
    [
      "a role naming a malformed atom",
      (catalogue) => void catalogue.roles[3]!.atoms.push("posts..x"),
      /malformed atom posts\.\.x/,
    ],
    [
      "a non-owner role holding a reserved atom",
      (catalogue) => void catalogue.roles[1]!.atoms.push("owner.transfer"),
      /role admin: holds owner-reserved atom owner\.transfer/,
    ],
    [
      "a reserved atom that is not in the catalogue",
      (catalogue) => void catalogue.ownerReserved.push("owner.abdicate"),
      /reserved atom owner\.abdicate is not a known atom/,
    ],
    [
      "a missing owner role",
      (catalogue) => void (catalogue.ownerRoleId = "founder"),
      /owner role founder is not defined/,
    ],
    [
      "an owner role without *",
      (catalogue) => void (catalogue.roles[0]!.atoms = ["posts.*"]),
      /owner role owner must hold \*/,
    ],
    [
      "a custom owner role",
      (catalogue) => void (catalogue.roles[0]!.builtin = false),
      /owner role owner must be built-in/,
    ],
  ];
  test.each(cases)("rejects %s", (_name, mutate, expected) => {
    const problems = problemsOf(mutate);
    expect(problems.join("\n")).toMatch(expected);
  });

  test("reports every problem, not only the first", () => {
    const problems = problemsOf((catalogue) => {
      catalogue.roles[3]!.atoms.push("posts.delete");
      catalogue.ownerRoleId = "founder";
    });
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  test("createAccessEngine validates at construction", () => {
    const catalogue = mutableFixture();
    catalogue.roles[1]!.atoms.push("owner.transfer");
    expect(() => createAccessEngine(catalogue)).toThrow(CatalogueError);
  });
});
