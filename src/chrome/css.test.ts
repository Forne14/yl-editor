import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const css = readFileSync(new URL("./chrome.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Token blocks are the `:where(.cms-root, .cms-field) { … }` declarations; they hold the only raw values. */
const tokenBlock = /:where\(\.cms-root, \.cms-field\)\s*\{[^}]*\}/g;

test("chrome.css has no hex colour or px outside the token blocks", () => {
  const blocks = css.match(tokenBlock) ?? [];
  expect(blocks).toHaveLength(2);
  const rest = css.replace(tokenBlock, "");
  expect(rest.match(/#[0-9a-f]{3,8}\b/gi)).toBeNull();
  expect(rest.match(/\d+(\.\d+)?px\b/g)).toBeNull();
  expect(rest.match(/\brgba?\(/g)).toBeNull();
});

test("every documented token has a default", () => {
  const tokens = [
    "font", "size-sm", "size-md", "line", "bg", "fg", "muted", "border", "accent", "accent-fg", "danger",
    "success", "warning", "outline", "radius", "space-1", "space-2", "space-3", "space-4", "space-5", "shadow", "z",
    "control-h", "sheet-max-h",
  ];
  const defaults = (css.match(tokenBlock) ?? [])[0] ?? "";
  for (const token of tokens) expect(defaults).toContain(`--cms-${token}:`);
  expect(defaults).toContain("--cms-control-h: 44px");
});

test("every class the stylesheet styles is prefixed cms-", () => {
  const classes = [...css.matchAll(/\.([a-z][\w-]*)/gi)].map((match) => match[1]);
  expect(classes.filter((name) => !name?.startsWith("cms-"))).toEqual([]);
});
