// Copies every stylesheet under src/ to the same relative path under dist/, so subpaths such as
// "./chrome/chrome.css" resolve after `tsc` has emitted the JavaScript. A no-op when there are none.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "src");
const outputDir = join(root, "dist");

const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
const stylesheets = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => join(entry.parentPath, entry.name));

for (const sourcePath of stylesheets) {
  const targetPath = join(outputDir, relative(sourceDir, sourcePath));
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

console.log(`copy-assets: ${stylesheets.length} stylesheet(s) copied to dist/`);
