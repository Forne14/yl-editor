import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The paths `npm pack` would publish, without building or writing a tarball. */
function packedPaths(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [pack] = JSON.parse(output) as [{ files: { path: string }[] }];
  return pack.files.map((file) => file.path);
}

test("the published package carries no demo site, browser specs or Playwright config", () => {
  const paths = packedPaths();
  expect(paths).toContain("package.json");
  expect(paths.filter((path) => /^(examples|e2e|playwright-report|test-results)\//.test(path))).toEqual([]);
  expect(paths.filter((path) => /^(playwright\.config|tsconfig\.e2e)/.test(path))).toEqual([]);
}, 60_000);
