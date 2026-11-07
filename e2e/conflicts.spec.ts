// Real version conflicts between two editors in two browser contexts, and field saves queued behind a lifecycle
// action from the same page. Every outcome is checked in the database.
import { expect, test, type Demo, type Guard } from "./fixtures.ts";
import type { Page, Request } from "@playwright/test";

// Each test walks a whole flow of twenty-odd steps across two or three pages. On a machine shared with other suites a
// single step has taken 3-4s, so the default 30s is too tight for the flow, not for any one assertion.
test.describe.configure({ timeout: 60_000 });

/** Edits a text field in place and commits it with Enter. Clicks near the left edge, clear of the sheet on the right. */
async function typeText(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector);
  await field.click({ position: { x: 4, y: 4 } });
  await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await field.fill(value);
  await field.press("Enter");
}

async function editText(page: Page, selector: string, value: string): Promise<void> {
  await typeText(page, selector, value);
  await expect(page.locator(selector)).toHaveAttribute("data-cms-state", "saved");
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

/** A second editor's page in this tenant. */
async function secondEditor(demo: Demo): Promise<Page> {
  return demo.openEditor({ context: await demo.newContext() });
}

/** Status of every response to `route` (e.g. "field"), in order. */
function statuses(page: Page, route: string): number[] {
  const seen: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === `/api/content/${route}`) seen.push(response.status());
  });
  return seen;
}

test.describe("two editors on the same field", () => {
  const conflicted = async (page: Page, demo: Demo, guard: Guard) => {
    guard.allowFailedRequests();
    await demo.openEditor();
    const other = await secondEditor(demo);
    await editText(other, "#about-title", "Theirs");
    expect((await demo.readDoc("pages/about"))?.draft).toMatchObject({ title: "Theirs" });

    await typeText(page, "#about-title", "Mine");
    await expect(page.locator("#about-title")).toHaveAttribute("data-cms-state", "failed");
    await expect(toast(page)).toContainText("Someone else changed this field since you opened the page.");
    await expect(toast(page).getByRole("button", { name: "Keep mine (overwrite)" })).toBeVisible();
    await expect(toast(page).getByRole("button", { name: "Take theirs (reload field)" })).toBeVisible();
    // The conflict wrote nothing.
    expect((await demo.readDoc("pages/about"))?.draft).toMatchObject({ title: "Theirs" });
  };

  test("Keep mine overwrites the other editor's value", async ({ page, demo, guard }) => {
    await conflicted(page, demo, guard);
    await toast(page).getByRole("button", { name: "Keep mine (overwrite)" }).click();
    await expect(page.locator("#about-title")).toHaveAttribute("data-cms-state", "saved");
    await expect(page.locator("#about-title")).toHaveText("Mine");
    expect((await demo.readDoc("pages/about"))?.draft).toEqual({
      title: "Mine",
      body: "A small bakery on the corner.",
    });
  });

  test("Take theirs repaints the field from the server and writes nothing", async ({ page, demo, guard }) => {
    await conflicted(page, demo, guard);
    const before = await demo.readDoc("pages/about");
    await toast(page).getByRole("button", { name: "Take theirs (reload field)" }).click();
    await expect(page.locator("#about-title")).toHaveText("Theirs");
    await expect(page.locator("#about-title")).toHaveAttribute("data-cms-state", "idle");
    await expect(toast(page)).toBeHidden();
    const after = await demo.readDoc("pages/about");
    expect(after?.version).toBe(before?.version);
    expect(after?.draft).toEqual({ title: "Theirs", body: "A small bakery on the corner." });

    // Taking theirs adopted their version, so the next edit saves cleanly.
    await editText(page, "#about-body", "Mine after theirs");
    expect((await demo.readDoc("pages/about"))?.draft).toEqual({ title: "Theirs", body: "Mine after theirs" });
  });
});

test("a publish of a document another editor changed after review publishes nothing and reloads the diff", async ({
  page,
  demo,
  guard,
}) => {
  guard.allowFailedRequests();
  const publishes = statuses(page, "publish");
  await demo.openEditor();
  await editText(page, "#about-title", "My title");
  const other = await secondEditor(demo);
  await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
  const about = sheet(page).locator('li[data-key="pages/about"]');
  await expect(about.locator('li[data-path="title"]')).toHaveText('title "About us" → "My title"');
  await expect(about.locator('li[data-path="body"]')).toHaveCount(0);

  await editText(other, "#about-body", "Their body");
  await sheetButton(page, "Publish").click();
  await expect(about).toContainText(
    "pages/about changed since you reviewed it, so it was not published. Review the changes and confirm again.",
  );
  await expect.poll(() => publishes).toEqual([409]);
  const unpublished = await demo.readDoc("pages/about");
  expect(unpublished?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });
  expect(unpublished?.draft).toEqual({ title: "My title", body: "Their body" });
  // The diff reloaded with the other editor's change in it.
  await expect(about.locator('li[data-path="body"]')).toHaveText('body "A small bakery on the corner." → "Their body"');
  await expect(about.locator('li[data-path="title"]')).toHaveText('title "About us" → "My title"');
  await expect(sheetButton(page, "Publish")).toBeEnabled();

  await sheetButton(page, "Publish").click();
  await expect(sheet(page)).toBeHidden();
  await expect.poll(() => publishes).toEqual([409, 200]);
  expect((await demo.readDoc("pages/about"))?.published).toEqual({ title: "My title", body: "Their body" });
});

test.describe("a lifecycle action on a document another editor changed", () => {
  const conflictText = "has changed since this page loaded. The page now shows the latest version.";

  test("Unpublish does nothing, says so, and the page catches up", async ({ page, demo, guard }) => {
    guard.allowFailedRequests();
    await demo.openEditor();
    const other = await secondEditor(demo);
    await editText(other, "#about-title", "Their title");
    await openRevisions(page, "pages/about");
    await sheet(page).getByRole("button", { name: "Unpublish", exact: true }).click();
    await sheetButton(page, "Confirm").click();
    await expect(toast(page)).toContainText(`Unpublish did nothing: pages/about ${conflictText}`);
    await expect(page.locator("#about-title")).toHaveText("Their title");
    const row = await demo.readDoc("pages/about");
    expect(row?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });
    expect(row?.draft).toEqual({ title: "Their title", body: "A small bakery on the corner." });

    // Caught up, the same action now goes through.
    await sheet(page).getByRole("button", { name: "Unpublish", exact: true }).click();
    await sheetButton(page, "Confirm").click();
    await expect(toast(page)).toContainText("Unpublished pages/about.");
    expect((await demo.readDoc("pages/about"))?.publishedPayload).toBeNull();
  });

  test("Restore does nothing, says so, and the page catches up", async ({ page, demo, guard }) => {
    guard.allowFailedRequests();
    const [seeded] = await demo.seed({
      key: "pages/about",
      published: { title: "About us", body: "Live body" },
      revisions: [{ action: "publish", payload: JSON.stringify({ title: "Old title", body: "Old body" }) }],
    });
    const revisionId = seeded!.revisions[0]!.id;
    await demo.openEditor();
    const other = await secondEditor(demo);
    await editText(other, "#about-body", "Their body");
    await openRevisions(page, "pages/about");
    await sheet(page)
      .getByRole("button", { name: `Restore revision ${revisionId} into the draft` })
      .click();
    await sheetButton(page, "Confirm").click();
    await expect(toast(page)).toContainText(`Restore did nothing: pages/about ${conflictText}`);
    await expect(page.locator("#about-body")).toHaveText("Their body");
    await expect(page.locator("#about-title")).toHaveText("About us");
    expect((await demo.readDoc("pages/about"))?.draft).toEqual({ title: "About us", body: "Their body" });
  });

  test("Discard does nothing, says so, and the page catches up", async ({ page, demo, guard }) => {
    guard.allowFailedRequests();
    await demo.openEditor();
    await editText(page, "#about-body", "My body");
    const other = await secondEditor(demo);
    await editText(other, "#about-title", "Their title");
    await bar(page).getByRole("button", { name: "Discard", exact: true }).click();
    await sheetButton(page, "Discard").click();
    await expect(toast(page)).toContainText(`Discard did nothing: pages/about ${conflictText}`);
    await expect(sheet(page).locator('li[data-key="pages/about"]')).toContainText(conflictText);
    await expect(page.locator("#about-title")).toHaveText("Their title");
    const row = await demo.readDoc("pages/about");
    expect(row?.draft).toEqual({ title: "Their title", body: "My body" });
    expect(row?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });
  });
});

/**
 * Holds every request to `route` until `release()`. `arrived` resolves when the first one is held, so a test can act
 * while the lifecycle write is genuinely in flight.
 */
async function hold(page: Page, route: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrive!: (request: Request) => void;
  const arrived = new Promise<Request>((resolve) => (arrive = resolve));
  await page.route(
    (url) => url.pathname === `/api/content/${route}`,
    async (held) => {
      arrive(held.request());
      await released;
      await held.continue();
    },
  );
  return { arrived, release };
}

test.describe("a field save queued behind a lifecycle action", () => {
  /** Commits `value` into the about body while the action is held, and checks the save waits its turn. */
  const queueBodyEdit = async (page: Page, value: string, fieldStatuses: number[]) => {
    await typeText(page, "#about-body", value);
    await expect(page.locator("#about-body")).toHaveAttribute("data-cms-state", "saving");
    expect(fieldStatuses).toEqual([]);
  };

  test("behind Publish: published, then saved on the new version", async ({ page, demo }) => {
    await demo.openEditor();
    await editText(page, "#about-title", "Published title");
    const fields = statuses(page, "field");
    const publish = await hold(page, "publish");
    await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(sheet(page).locator('li[data-path="title"]')).toBeVisible();
    await sheetButton(page, "Publish").click();
    await publish.arrived;

    await queueBodyEdit(page, "Queued body", fields);
    publish.release();
    await expect(page.locator("#about-body")).toHaveAttribute("data-cms-state", "saved");
    await expect(sheet(page)).toBeHidden();
    await expect(toast(page)).not.toContainText("Someone else changed");
    await expect.poll(() => fields).toEqual([200]);
    const row = await demo.readDoc("pages/about");
    expect(row?.published).toEqual({ title: "Published title", body: "A small bakery on the corner." });
    expect(row?.draft).toEqual({ title: "Published title", body: "Queued body" });
  });

  test("behind Discard: discarded, then saved on the new version", async ({ page, demo }) => {
    await demo.openEditor();
    await editText(page, "#about-title", "Discarded title");
    const fields = statuses(page, "field");
    const discard = await hold(page, "discard");
    await bar(page).getByRole("button", { name: "Discard", exact: true }).click();
    await sheetButton(page, "Discard").click();
    await discard.arrived;

    await queueBodyEdit(page, "Queued body", fields);
    discard.release();
    await expect(page.locator("#about-body")).toHaveAttribute("data-cms-state", "saved");
    await expect(page.locator("#about-title")).toHaveText("About us");
    await expect(page.locator("#about-body")).toHaveText("Queued body");
    await expect(toast(page)).not.toContainText("Someone else changed");
    await expect.poll(() => fields).toEqual([200]);
    const row = await demo.readDoc("pages/about");
    expect(row?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });
    expect(row?.draft).toEqual({ title: "About us", body: "Queued body" });
  });

  test("behind Unpublish: unpublished, then saved on the new version", async ({ page, demo }) => {
    await demo.openEditor();
    const fields = statuses(page, "field");
    const unpublish = await hold(page, "unpublish");
    await openRevisions(page, "pages/about");
    await sheet(page).getByRole("button", { name: "Unpublish", exact: true }).click();
    await sheetButton(page, "Confirm").click();
    await unpublish.arrived;

    await queueBodyEdit(page, "Queued body", fields);
    unpublish.release();
    await expect(page.locator("#about-body")).toHaveAttribute("data-cms-state", "saved");
    await expect(toast(page)).not.toContainText("Someone else changed");
    await expect.poll(() => fields).toEqual([200]);
    const row = await demo.readDoc("pages/about");
    expect(row?.publishedPayload).toBeNull();
    expect(row?.draft).toEqual({ title: "About us", body: "Queued body" });
  });

  test("behind Restore: restored, then saved on the new version", async ({ page, demo }) => {
    const [seeded] = await demo.seed({
      key: "pages/about",
      published: { title: "About us", body: "Live body" },
      revisions: [{ action: "publish", payload: JSON.stringify({ title: "Old title", body: "Old body" }) }],
    });
    const revisionId = seeded!.revisions[0]!.id;
    await demo.openEditor();
    const fields = statuses(page, "field");
    const restore = await hold(page, "restore-revision");
    await openRevisions(page, "pages/about");
    await sheet(page)
      .getByRole("button", { name: `Restore revision ${revisionId} into the draft` })
      .click();
    await sheetButton(page, "Confirm").click();
    await restore.arrived;

    await queueBodyEdit(page, "Queued body", fields);
    restore.release();
    await expect(page.locator("#about-body")).toHaveAttribute("data-cms-state", "saved");
    await expect(page.locator("#about-title")).toHaveText("Old title");
    await expect(page.locator("#about-body")).toHaveText("Queued body");
    await expect(toast(page)).not.toContainText("Someone else changed");
    await expect.poll(() => fields).toEqual([200]);
    const row = await demo.readDoc("pages/about");
    expect(row?.published).toEqual({ title: "About us", body: "Live body" });
    expect(row?.draft).toEqual({ title: "Old title", body: "Queued body" });
  });
});
