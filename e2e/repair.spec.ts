// Repairing documents that fail the current schema, seeded raw: an invalid draft (pages/home) and a stale published
// payload with no draft (pages/about). Both must load in the editor and be repairable through the chrome; publishing
// the invalid draft must fail with the server's validation error, for that document only.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Page } from "@playwright/test";

// Each test walks a whole flow of twenty-odd steps across two or three pages. On a machine shared with other suites a
// single step has taken 3-4s, so the default 30s is too tight for the flow, not for any one assertion.
test.describe.configure({ timeout: 60_000 });

async function typeText(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector);
  await field.click({ position: { x: 4, y: 4 } });
  await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await field.fill(value);
  await field.press("Enter");
}

/** Edits a text field in place and waits for the save. Clicks near the left edge, clear of the sheet on the right. */
async function editText(page: Page, selector: string, value: string): Promise<void> {
  await typeText(page, selector, value);
  await expect(page.locator(selector)).toHaveAttribute("data-cms-state", "saved");
}

async function openVisitorPage(demo: Demo): Promise<Page> {
  const context = await demo.newContext({ role: "anonymous" });
  return demo.openVisitor(await context.newPage());
}

const bar = (page: Page) => page.locator(".cms-bar");
const sheet = (page: Page) => page.locator(".cms-sheet");
const toast = (page: Page) => page.locator(".cms-toast");
const sheetButton = (page: Page, name: string) =>
  sheet(page).locator(".cms-sheet__actions").getByRole("button", { name, exact: true });

async function openRevisions(page: Page, key: string): Promise<void> {
  await bar(page).getByRole("button", { name: "Revisions", exact: true }).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("combobox", { name: "Document" }).selectOption(key);
}

const LIVE_HOME = { title: "Live home" };
const INVALID_DRAFT = { title: 5 };
const STALE_PUBLISHED = { heading: "Old shape" };

/** pages/home with an invalid draft over a valid published version; pages/about with a stale published payload. */
async function seedBroken(demo: Demo) {
  const [home, about] = await demo.seed(
    {
      key: "pages/home",
      published: LIVE_HOME,
      draft: INVALID_DRAFT,
      version: 2,
      revisions: [{ action: "publish", payload: JSON.stringify({ title: "Restored home" }), actor: "Earlier editor" }],
    },
    {
      key: "pages/about",
      published: STALE_PUBLISHED,
      version: 2,
      revisions: [
        {
          action: "publish",
          payload: JSON.stringify({ title: "Restored about", body: "Restored body" }),
          actor: "Earlier editor",
        },
      ],
    },
  );
  return { homeRevision: home!.revisions[0]!.id, aboutRevision: about!.revisions[0]!.id };
}

/**
 * Marks pages/home as changed this session and leaves its draft invalid: a field edit repairs the draft, so the raw
 * seed breaks it again at the version the page holds, as another process writing the row directly would.
 */
async function touchInvalidHome(page: Page, demo: Demo): Promise<void> {
  await editText(page, "#home-title", "Touched");
  const row = await demo.readDoc("pages/home");
  await demo.seed({ key: "pages/home", published: LIVE_HOME, draft: INVALID_DRAFT, version: row!.version });
}

async function restore(page: Page, key: string, revisionId: number): Promise<void> {
  await sheet(page).getByRole("combobox", { name: "Document" }).selectOption(key);
  await sheet(page)
    .getByRole("button", { name: `Restore revision ${revisionId} into the draft` })
    .click();
  await sheetButton(page, "Confirm").click();
  await expect(toast(page)).toContainText(`Restored a revision of ${key} into the draft.`);
}

test("an invalid draft and a stale published payload both load in the editor, with their revisions", async ({
  page,
  demo,
}) => {
  await seedBroken(demo);
  await demo.openEditor();
  for (const selector of ["#home-title", "#about-title", "#about-body"]) {
    await expect(page.locator(selector)).toHaveClass(/cms-field/);
    await expect(page.locator(selector)).not.toHaveClass(/cms-field--locked/);
  }
  await expect(page.locator("#home-title")).toHaveText("5");
  await expect(toast(page)).toBeHidden();

  await openRevisions(page, "pages/home");
  await expect(sheet(page).locator(".cms-revisions li[data-revision]")).toHaveCount(1);
  await expect(sheet(page).locator(".cms-revisions")).toContainText("publish by Earlier editor");
  await sheet(page).getByRole("combobox", { name: "Document" }).selectOption("pages/about");
  await expect(sheet(page).locator(".cms-revisions li[data-revision]")).toHaveCount(1);
  await expect(sheet(page).getByRole("button", { name: "Unpublish", exact: true })).toBeVisible();
});

test("Restore repairs both documents, repaints their fields, and Publish puts the repair live", async ({
  page,
  demo,
  guard,
}) => {
  // Restore reads the document first, and an invalid draft answers that read with a 422.
  guard.allowFailedRequests();
  const { homeRevision, aboutRevision } = await seedBroken(demo);
  await demo.openEditor();
  await openRevisions(page, "pages/home");

  await restore(page, "pages/home", homeRevision);
  await expect(page.locator("#home-title")).toHaveText("Restored home");
  await restore(page, "pages/about", aboutRevision);
  await expect(page.locator("#about-title")).toHaveText("Restored about");
  await expect(page.locator("#about-body")).toHaveText("Restored body");

  const home = await demo.readDoc("pages/home");
  expect(home?.draft).toEqual({ title: "Restored home" });
  expect(home?.published).toEqual(LIVE_HOME);
  const about = await demo.readDoc("pages/about");
  expect(about?.draft).toEqual({ title: "Restored about", body: "Restored body" });
  expect(about?.published).toEqual(STALE_PUBLISHED);

  await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
  await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
  const homeRow = sheet(page).locator('li[data-key="pages/home"]');
  const aboutRow = sheet(page).locator('li[data-key="pages/about"]');
  await expect(homeRow.locator('li[data-path="title"]')).toHaveText('title "Live home" → "Restored home"');
  // The stale published payload is compared as stored.
  await expect(aboutRow.locator('li[data-path="heading"]')).toHaveText('heading removed "Old shape"');
  await expect(aboutRow.locator('li[data-path="title"]')).toHaveText('title added "Restored about"');
  await sheetButton(page, "Publish").click();
  await expect(sheet(page)).toBeHidden();
  expect((await demo.readDoc("pages/home"))?.published).toEqual({ title: "Restored home" });
  expect((await demo.readDoc("pages/about"))?.published).toEqual({ title: "Restored about", body: "Restored body" });
  const visitor = await openVisitorPage(demo);
  await expect(visitor.locator("#home-title")).toHaveText("Restored home");
  await expect(visitor.locator("#about-title")).toHaveText("Restored about");
});

test("Discard drops an invalid draft and repaints the published version", async ({ page, demo }) => {
  await seedBroken(demo);
  await demo.openEditor();
  await touchInvalidHome(page, demo);

  await bar(page).getByRole("button", { name: "Discard", exact: true }).click();
  await expect(sheet(page).locator('li[data-key="pages/home"]')).not.toContainText("discarding deletes");
  await sheetButton(page, "Discard").click();
  await expect(sheet(page)).toBeHidden();
  await expect(toast(page)).toContainText("Discarded draft of pages/home");
  await expect(page.locator("#home-title")).toHaveText("Live home");
  const home = await demo.readDoc("pages/home");
  expect(home?.draftPayload).toBeNull();
  expect(home?.published).toEqual(LIVE_HOME);
});

test("Discard on a stale published document repaints a field its published payload lacks", async ({ page, demo }) => {
  await seedBroken(demo);
  await demo.openEditor();
  // A field edit over a stale published payload is accepted when the result is valid. The heading renders empty, so
  // it has no box to click: open it from the keyboard.
  const title = page.locator("#about-title");
  await title.focus();
  await title.press("Enter");
  await expect(title).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await page.keyboard.type("Repaired title");
  await page.keyboard.press("Enter");
  await expect(title).toHaveAttribute("data-cms-state", "saved");
  expect((await demo.readDoc("pages/about"))?.draft).toEqual({ title: "Repaired title" });

  await bar(page).getByRole("button", { name: "Discard", exact: true }).click();
  await sheetButton(page, "Discard").click();
  await expect(sheet(page)).toBeHidden();
  await expect(toast(page)).toContainText("Discarded draft of pages/about");
  const about = await demo.readDoc("pages/about");
  expect(about?.draftPayload).toBeNull();
  expect(about?.published).toEqual(STALE_PUBLISHED);
  // The draft is gone and the published payload has no title, so the page must not keep showing the discarded one.
  await expect(page.locator("#about-title")).toHaveText("");
});

test("publishing an invalid draft fails with the validation error, and only its changes can't be loaded", async ({
  page,
  demo,
  guard,
}) => {
  guard.allowFailedRequests();
  await demo.seed({ key: "pages/home", published: LIVE_HOME, draft: INVALID_DRAFT, version: 2 });
  await demo.openEditor();
  await touchInvalidHome(page, demo);
  await editText(page, "#about-title", "Valid about");
  const read = await demo.content<never>("GET", "document?key=pages/home");
  expect(read.status).toBe(422);
  const readMessage = (read.body as { error: { message: string } }).error.message;

  await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
  const homeRow = sheet(page).locator('li[data-key="pages/home"]');
  const aboutRow = sheet(page).locator('li[data-key="pages/about"]');
  await expect(homeRow).toContainText(`Couldn’t load the changes: ${readMessage}`);
  await expect(aboutRow.locator('li[data-path="title"]')).toHaveText('title "About us" → "Valid about"');
  await expect(aboutRow).not.toContainText("Couldn’t load the changes");
  await expect(sheetButton(page, "Publish")).toBeEnabled();

  const publishes: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/content/publish") publishes.push(response.status());
  });
  await sheetButton(page, "Publish").click();
  await expect(toast(page)).toContainText("Publish: 1 of 2 done. Not done: pages/home.");
  await expect(aboutRow).toHaveCount(0);
  await expect.poll(() => publishes.sort()).toEqual([200, 422]);

  const attempt = await demo.content<never>("POST", "publish", { key: "pages/home" });
  expect(attempt.status).toBe(422);
  const publishMessage = (attempt.body as { error: { message: string } }).error.message;
  await expect(homeRow).toContainText(`Publish failed for pages/home: ${publishMessage}`);
  await expect(sheet(page)).toBeVisible();

  const home = await demo.readDoc("pages/home");
  expect(home?.published).toEqual(LIVE_HOME);
  expect(home?.draft).toEqual(INVALID_DRAFT);
  expect((await demo.readDoc("pages/about"))?.published).toEqual({
    title: "Valid about",
    body: "A small bakery on the corner.",
  });
  const visitor = await openVisitorPage(demo);
  await expect(visitor.locator("#home-title")).toHaveText("Live home");
  await expect(visitor.locator("#about-title")).toHaveText("Valid about");
});
