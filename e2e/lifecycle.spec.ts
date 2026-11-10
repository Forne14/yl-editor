// The document lifecycle against the real server: the Publish sheet and its diffs, Publish now, Unpublish and Restore
// from the revisions drawer, and Discard with its delete warning. Every step is checked in the database and, where it
// matters, on the visitor page.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Page } from "@playwright/test";

// Each test walks a whole flow of twenty-odd steps across two or three pages. On a machine shared with other suites a
// single step has taken 3-4s, so the default 30s is too tight for the flow, not for any one assertion.
test.describe.configure({ timeout: 60_000 });

/** Edits a text field in place and waits for the save. Clicks near the left edge, clear of the sheet on the right. */
async function editText(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector);
  await field.click({ position: { x: 4, y: 4 } });
  await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await field.fill(value);
  await field.press("Enter");
  await expect(field).toHaveAttribute("data-cms-state", "saved");
}

/** A signed-out visitor's page in this tenant. */
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

test.describe("the Publish sheet", () => {
  test("shows each document's diff, path and before → after, and publishes both to the visitor page", async ({
    page,
    demo,
  }) => {
    await demo.openEditor();
    await editText(page, "#home-title", "Fresh loaves");
    await editText(page, "#about-body", "A bigger bakery now.");
    await expect(bar(page).locator(".cms-bar__changes")).toContainText("2 changes across 2 documents");

    await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(sheet(page)).toContainText("Publish these documents?");
    const home = sheet(page).locator('li[data-key="pages/home"]');
    const about = sheet(page).locator('li[data-key="pages/about"]');
    await expect(home.locator('li[data-path="title"]')).toHaveText('title "Welcome to the demo" → "Fresh loaves"');
    await expect(home.locator("li[data-path]")).toHaveCount(1);
    await expect(about.locator('li[data-path="body"]')).toHaveText(
      'body "A small bakery on the corner." → "A bigger bakery now."',
    );
    await expect(about.locator("li[data-path]")).toHaveCount(1);

    await sheetButton(page, "Publish").click();
    await expect(sheet(page)).toBeHidden();
    await expect(toast(page)).toContainText("Publish: all 2 documents done.");
    await expect(bar(page).locator(".cms-bar__changes")).toContainText("No changes yet");

    expect((await demo.readDoc("pages/home"))?.published).toMatchObject({ title: "Fresh loaves" });
    expect((await demo.readDoc("pages/about"))?.published).toEqual({
      title: "About us",
      body: "A bigger bakery now.",
    });
    const visitor = await openVisitorPage(demo);
    await expect(visitor.locator("#home-title")).toHaveText("Fresh loaves");
    await expect(visitor.locator("#about-body")).toHaveText("A bigger bakery now.");
  });

  test("says a never-published document goes live for the first time", async ({ page, demo }) => {
    await demo.seed({ key: "pages/about", draft: { title: "Brand new about", body: "Not live yet." } });
    const visitor = await openVisitorPage(demo);
    await expect(visitor.locator("#about-title")).toHaveText("");

    await demo.openEditor();
    await editText(page, "#about-title", "Our story");
    await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
    const about = sheet(page).locator('li[data-key="pages/about"]');
    await expect(about).toContainText("Nothing is live: publishing puts this version on the site.");
    await expect(about.locator("li[data-path]")).toHaveCount(0);

    await sheetButton(page, "Publish").click();
    await expect(sheet(page)).toBeHidden();
    await expect(toast(page)).toContainText("Published pages/about");
    const row = await demo.readDoc("pages/about");
    expect(row?.published).toEqual({ title: "Our story", body: "Not live yet." });
    expect(row?.publishedAt).not.toBeNull();
    await visitor.reload();
    await expect(visitor.locator("#about-title")).toHaveText("Our story");
  });
});

test("Publish now in the bar publishes a scheduled document at once and clears the schedule", async ({
  page,
  demo,
}) => {
  const [home] = await demo.seed({
    key: "pages/home",
    published: { title: "Live title", price: 12 },
    draft: { title: "Scheduled title", price: 14 },
    scheduledAt: "2031-06-01T09:00:00.000Z",
    version: 3,
  });
  await demo.openEditor();
  // The bar learns a schedule when the document is fetched: opening a popover field fetches it.
  await page.locator("#home-price").click();
  const price = page.getByRole("spinbutton", { name: "Price" });
  await expect(price).toHaveValue("14");
  await price.press("Escape");
  const scheduled = bar(page).locator('.cms-bar__scheduled[data-key="pages/home"]');
  await expect(scheduled).toContainText("pages/home scheduled for");

  await scheduled.getByRole("button", { name: "Publish now" }).click();
  await expect(toast(page)).toContainText("Published pages/home");
  await expect(scheduled).toHaveCount(0);
  const row = await demo.readDoc("pages/home");
  expect(row?.published).toEqual({ title: "Scheduled title", price: 14 });
  expect(row?.scheduledAt).toBeNull();
  expect(row?.version).toBeGreaterThan(home!.version);
  const visitor = await openVisitorPage(demo);
  await expect(visitor.locator("#home-title")).toHaveText("Scheduled title");
});

test.describe("the revisions drawer", () => {
  test("Unpublish asks first, takes the document off the visitor page, and Publish puts it back", async ({
    page,
    demo,
  }) => {
    const visitor = await openVisitorPage(demo);
    await expect(visitor.locator("#about-title")).toHaveText("About us");
    await demo.openEditor();
    await openRevisions(page, "pages/about");

    await sheet(page).getByRole("button", { name: "Unpublish", exact: true }).click();
    await expect(sheet(page)).toContainText("Take pages/about off the live site? Its content stays as a draft.");
    await sheetButton(page, "Cancel").click();
    expect((await demo.readDoc("pages/about"))?.published).toEqual({
      title: "About us",
      body: "A small bakery on the corner.",
    });

    await sheet(page).getByRole("button", { name: "Unpublish", exact: true }).click();
    await sheetButton(page, "Confirm").click();
    await expect(toast(page)).toContainText("Unpublished pages/about. Its content stays as a draft.");
    // Unpublished, the drawer offers no Unpublish.
    await expect(sheet(page).getByRole("button", { name: "Unpublish", exact: true })).toHaveCount(0);
    const unpublished = await demo.readDoc("pages/about");
    expect(unpublished?.publishedPayload).toBeNull();
    expect(unpublished?.publishedAt).toBeNull();
    expect(unpublished?.draft).toEqual({ title: "About us", body: "A small bakery on the corner." });
    await visitor.reload();
    await expect(visitor.locator("#about-title")).toHaveText("");
    await expect(page.locator("#about-title")).toHaveText("About us");

    await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(bar(page).locator(".cms-bar__changes")).toContainText("1 change on this page");
    await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(sheet(page).locator('li[data-key="pages/about"]')).toContainText(
      "Nothing is live: publishing puts this version on the site.",
    );
    await sheetButton(page, "Publish").click();
    await expect(sheet(page)).toBeHidden();
    expect((await demo.readDoc("pages/about"))?.published).toEqual({
      title: "About us",
      body: "A small bakery on the corner.",
    });
    await visitor.reload();
    await expect(visitor.locator("#about-title")).toHaveText("About us");
  });

  test("Restore asks first: Cancel writes nothing, Confirm repaints the fields and leaves the published version alone", async ({
    page,
    demo,
  }) => {
    const [seeded] = await demo.seed({
      key: "pages/about",
      published: { title: "Live about", body: "Live body" },
      draft: { title: "Draft about", body: "Draft body" },
      version: 4,
      revisions: [
        {
          action: "publish",
          payload: JSON.stringify({ title: "Old about", body: "Old body" }),
          actor: "Old editor",
          createdAt: "2025-03-04T10:00:00.000Z",
        },
      ],
    });
    const revisionId = seeded!.revisions[0]!.id;
    await demo.openEditor();
    await expect(page.locator("#about-title")).toHaveText("Draft about");
    await openRevisions(page, "pages/about");
    const revision = sheet(page).locator(`li[data-revision="${revisionId}"]`);
    await expect(revision).toContainText("publish by Old editor");
    const restore = revision.getByRole("button", { name: `Restore revision ${revisionId} into the draft` });

    await restore.click();
    await expect(sheet(page)).toContainText(/Restore the publish revision from .+\? The current draft of pages\/about/);
    await sheetButton(page, "Cancel").click();
    await expect(restore).toBeFocused();
    const untouched = await demo.readDoc("pages/about");
    expect(untouched?.version).toBe(4);
    expect(untouched?.draft).toEqual({ title: "Draft about", body: "Draft body" });
    await expect(page.locator("#about-title")).toHaveText("Draft about");

    await restore.click();
    await sheetButton(page, "Confirm").click();
    await expect(toast(page)).toContainText("Restored a revision of pages/about into the draft.");
    await expect(page.locator("#about-title")).toHaveText("Old about");
    await expect(page.locator("#about-body")).toHaveText("Old body");
    const restored = await demo.readDoc("pages/about");
    expect(restored?.draft).toEqual({ title: "Old about", body: "Old body" });
    expect(restored?.published).toEqual({ title: "Live about", body: "Live body" });
    const visitor = await openVisitorPage(demo);
    await expect(visitor.locator("#about-title")).toHaveText("Live about");

    await sheet(page).getByRole("button", { name: "Close", exact: true }).click();
    await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
    const about = sheet(page).locator('li[data-key="pages/about"]');
    await expect(about.locator('li[data-path="title"]')).toHaveText('title "Live about" → "Old about"');
    await sheetButton(page, "Publish").click();
    await expect(sheet(page)).toBeHidden();
    expect((await demo.readDoc("pages/about"))?.published).toEqual({ title: "Old about", body: "Old body" });
    await visitor.reload();
    await expect(visitor.locator("#about-title")).toHaveText("Old about");
  });
});

test.describe("Discard", () => {
  test("warns about deleting only the document with nothing published, and discarding it locks its fields", async ({
    page,
    demo,
  }) => {
    await demo.seed({ key: "pages/about", draft: { title: "Unpublished about", body: "Never live." } });
    await demo.openEditor();
    await editText(page, "#home-title", "Changed home");
    await editText(page, "#about-title", "Changed about");

    await bar(page).getByRole("button", { name: "Discard", exact: true }).click();
    await expect(sheet(page)).toContainText("Discard drafts for these documents?");
    const warning = "Nothing is published, so discarding deletes pages/about and all its revision history.";
    await expect(sheet(page).locator('li[data-key="pages/about"]')).toContainText(warning);
    await expect(sheet(page).locator('li[data-key="pages/home"]')).toBeVisible();
    await expect(sheet(page).locator('li[data-key="pages/home"]')).not.toContainText("discarding deletes");
    await expect(sheet(page).getByText(/discarding deletes/)).toHaveCount(1);

    await sheetButton(page, "Discard").click();
    await expect(sheet(page)).toBeHidden();
    await expect(toast(page)).toContainText("Discard: all 2 documents done.");
    expect(await demo.readDoc("pages/about")).toBeNull();
    const home = await demo.readDoc("pages/home");
    expect(home?.draftPayload).toBeNull();
    expect(home?.published).toMatchObject({ title: "Welcome to the demo" });
    await expect(page.locator("#home-title")).toHaveText("Welcome to the demo");

    // The deleted document's fields no longer open an editor; clicking one says why.
    const aboutTitle = page.locator("#about-title");
    await aboutTitle.click({ position: { x: 4, y: 4 } });
    await expect(toast(page)).toContainText("Not editable: the server doesn’t know this document");
    await expect(aboutTitle).not.toHaveAttribute("contenteditable", /.*/);
    await expect(page.locator("#about-body")).not.toHaveClass(/cms-field--editing/);
    // Home is still editable.
    await editText(page, "#home-title", "Edited after discard");
    expect((await demo.readDoc("pages/home"))?.draft).toMatchObject({ title: "Edited after discard" });
  });
});
