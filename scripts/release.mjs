// Tags a release whose commit carries the built dist/, without moving the branch: branches never track dist/.
//
//   npm run release -- vX.Y.Z             verify, build, commit dist/ on a detached release commit, tag it
//   npm run release -- vX.Y.Z --dry-run   everything except creating the tag; prints the would-be commit
//   npm run release -- --tag <name>       tag under another name, skipping the version match (for checking the script)
//
// It never pushes. The next step it prints is `git push origin <tag>`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(args, env = process.env) {
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
}

function run(command, args) {
  console.log(`release: $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

// Arguments.
const args = process.argv.slice(2);
let dryRun = false;
let overrideTag;
let requestedTag;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--tag") {
    overrideTag = args[++index];
    if (!overrideTag) fail("--tag needs a name");
  } else if (arg.startsWith("-")) fail(`unknown flag ${arg}`);
  else if (requestedTag === undefined) requestedTag = arg;
  else fail(`unexpected argument ${arg}`);
}

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = overrideTag ?? requestedTag;
if (!tag) fail("usage: npm run release -- vX.Y.Z [--dry-run]");
if (overrideTag === undefined && tag !== `v${version}`)
  fail(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
if (overrideTag !== undefined) console.log(`release: --tag ${tag} given, skipping the version match`);

// Preconditions.
if (git(["status", "--porcelain"]) !== "") fail("the working tree is not clean; commit or remove changes first");
try {
  git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
  fail(`tag ${tag} already exists`);
} catch (error) {
  if (error.status !== 1) throw error;
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const heading = `## [${version}]`;
const start = changelog.split("\n").findIndex((line) => line.startsWith(heading));
if (start === -1) fail(`CHANGELOG.md has no "${heading}" heading`);

// Tag message: the Breaking bullets of this version's changelog section, else its first bullets.
function sectionLines() {
  const lines = changelog.split("\n").slice(start + 1);
  const end = lines.findIndex((line) => line.startsWith("## "));
  return end === -1 ? lines : lines.slice(0, end);
}
function bullets(lines) {
  const items = [];
  for (const line of lines) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (line.startsWith("  ") && items.length > 0 && line.trim() !== "")
      items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}
function tagMessage() {
  const lines = sectionLines();
  const breakingStart = lines.findIndex((line) => /^### Breaking/i.test(line));
  if (breakingStart !== -1) {
    const rest = lines.slice(breakingStart + 1);
    const breakingEnd = rest.findIndex((line) => line.startsWith("### "));
    const breaking = bullets(breakingEnd === -1 ? rest : rest.slice(0, breakingEnd));
    if (breaking.length > 0) return `${tag}: breaking changes\n\n${breaking.map((item) => `- ${item}`).join("\n")}`;
  }
  const first = bullets(lines).slice(0, 5);
  return `${tag}\n\n${first.map((item) => `- ${item}`).join("\n")}`;
}
const message = tagMessage();

// Verify and build from clean.
run("npm", ["run", "verify"]);
rmSync(join(root, "dist"), { recursive: true, force: true });
run("npm", ["run", "build"]);
if (!existsSync(join(root, "dist", "index.js"))) fail("build produced no dist/index.js");

// Release commit through a temporary index, so the branch and the real index never see dist/.
const head = git(["rev-parse", "HEAD"]);
const realIndex = resolve(root, git(["rev-parse", "--git-path", "index"]));
const tempDir = mkdtempSync(join(tmpdir(), "yl-editor-release-"));
const tempIndex = join(tempDir, "index");
let commit;
try {
  copyFileSync(realIndex, tempIndex);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  git(["add", "-f", "dist"], env);
  const tree = git(["write-tree"], env);
  commit = git(["commit-tree", tree, "-p", head, "-m", `release: ${tag} (dist committed on the tag only)`], env);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const distFiles = git(["ls-tree", "-r", "--name-only", commit])
  .split("\n")
  .filter((name) => name.startsWith("dist/"));
if (distFiles.length === 0) fail(`release commit ${commit} carries no dist/ files`);

if (dryRun) {
  console.log(`release: dry run, no tag created. The would-be release commit (unreferenced object):`);
  console.log(
    git(["show", "--stat", "--format=commit %H%nparent %P%ntree %T%n%n    %s", commit])
      .split("\n")
      .slice(0, 12)
      .join("\n"),
  );
  console.log(`release: ${distFiles.length} dist/ files on it`);
  console.log(`release: would tag ${tag} with message:\n${message}`);
} else {
  git(["tag", "-a", tag, commit, "-m", message]);
  const tagged = git(["ls-tree", "-r", "--name-only", tag])
    .split("\n")
    .filter((name) => name.startsWith("dist/"));
  if (tagged.length === 0) fail(`tag ${tag} carries no dist/ files`);
  console.log(`release: tagged ${tag} -> ${commit} with ${tagged.length} dist/ files`);
}

// The branch is untouched: tree clean, HEAD unmoved, dist/ untracked.
if (git(["status", "--porcelain"]) !== "") fail("the working tree is no longer clean");
if (git(["rev-parse", "HEAD"]) !== head) fail("HEAD moved");
if (git(["ls-files", "dist"]) !== "") fail("dist/ is tracked on the branch");
console.log("release: branch unchanged (HEAD unmoved, tree clean, dist/ untracked)");

if (!dryRun) console.log(`release: next step: git push origin ${tag}`);
