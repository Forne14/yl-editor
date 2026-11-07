// "Publish at" with `scheduling: true`: the datetime-local input and its past-time checks (on change and again at
// Confirm, against the browser's clock), scheduling through the real API, the bar's line and Publish now, and the
// host's publish-due run promoting what is due while an invalid draft fails on its own.
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

async function openVisitorPage(demo: Demo): Promise<Page> {
  const context = await demo.newContext({ role: "anonymous" });
  return demo.openVisitor(await context.newPage());
}

const bar = (page: Page) => page.locator(".cms-bar");
const sheet = (page: Page) => page.locator(".cms-sheet");
const toast = (page: Page) => page.locator(".cms-toast");
const confirmButton = (page: Page) => sheet(page).locator(".cms-sheet__actions button").last();
const publishAt = (page: Page) => sheet(page).getByLabel("Publish at (optional)");
const PAST_REASON = "That time is in the past, so it would never be scheduled.";

/** The ISO instant the browser reads a `datetime-local` value as, in its own time zone. */
const browserInstant = (page: Page, local: string) => page.evaluate((value) => new Date(value).toISOString(), local);

/** Fills the datetime-local input. Every engine accepts `fill` with the input's own format, WebKit's pickerless one too. */
async function fillPublishAt(page: Page, value: string): Promise<void> {
  await publishAt(page).fill(value);
  await expect(publishAt(page)).toHaveValue(value);
}

async function openPublishSheet(page: Page): Promise<void> {
  await bar(page).getByRole("button", { name: "Publish", exact: true }).click();
  await expect(sheet(page)).toContainText("Publish these documents?");
}

test("Publish at is a datetime-local input with a min; a past time disables Schedule and says why", async ({
  page,
  demo,
}) => {
  await demo.openEditor({ scheduling: true });
  await editText(page, "#about-title", "Later title");
  await openPublishSheet(page);

  const input = publishAt(page);
  await expect(input).toHaveAttribute("type", "datetime-local");
  const min = await input.getAttribute("min");
  expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // `min` is the browser's now, to the minute.
  const now = await page.evaluate(() => Date.now());
  const minInstant = new Date(await browserInstant(page, min!)).getTime();
  expect(Math.abs(now - minInstant)).toBeLessThan(2 * 60_000);
  await expect(confirmButton(page)).toHaveText("Publish");
  await expect(confirmButton(page)).toBeEnabled();

  await fillPublishAt(page, "2020-01-01T09:00");
  await expect(confirmButton(page)).toHaveText("Schedule");
  await expect(confirmButton(page)).toBeDisabled();
  await expect(sheet(page)).toContainText(PAST_REASON);
  await expect(input).toHaveAccessibleDescription(new RegExp(PAST_REASON.replace(/[.,]/g, "\\$&")));

  await fillPublishAt(page, "2031-01-01T09:00");
  await expect(confirmButton(page)).toBeEnabled();
  await expect(sheet(page)).not.toContainText(PAST_REASON);

  await fillPublishAt(page, "");
  await expect(confirmButton(page)).toHaveText("Publish");
  await expect(confirmButton(page)).toBeEnabled();
  expect((await demo.readDoc("pages/about"))?.scheduledAt).toBeNull();
});

test("a future time schedules with `at`, the bar says so, and publish-due publishes it while an invalid draft fails", async ({
  page,
  demo,
}) => {
  // Due before the editor's document, and invalid: it must fail on its own and stay scheduled.
  await demo.seed({
    key: "pages/home",
    published: { title: "Live home" },
    draft: { title: 5 },
    scheduledAt: "2030-01-01T00:00:00.000Z",
  });
  await demo.openEditor({ scheduling: true });
  await editText(page, "#about-title", "Scheduled about");
  await openPublishSheet(page);
  await fillPublishAt(page, "2030-06-01T09:30");
  const expectedAt = await browserInstant(page, "2030-06-01T09:30");

  const request = page.waitForRequest((sent) => new URL(sent.url()).pathname === "/api/content/publish");
  await confirmButton(page).click();
  const body = (await request).postDataJSON() as { key: string; at: string; expectedVersion: number };
  expect(body.key).toBe("pages/about");
  expect(body.at).toMatch(/^2030-06-01T09:30:00[+-]\d{2}:\d{2}$/);
  expect(new Date(body.at).toISOString()).toBe(expectedAt);
  await expect(sheet(page)).toBeHidden();
  await expect(toast(page)).toContainText("Scheduled pages/about for");

  const line = bar(page).locator('.cms-bar__scheduled[data-key="pages/about"]');
  await expect(line).toContainText("pages/about scheduled for");
  await expect(line.getByRole("button", { name: "Publish now" })).toBeVisible();
  // Still a change until it goes live.
  await expect(bar(page).locator(".cms-bar__changes")).toContainText("1 change on this page");
  const scheduled = await demo.readDoc("pages/about");
  expect(scheduled?.scheduledAt).toBe(expectedAt);
  expect(scheduled?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });

  const visitor = await openVisitorPage(demo);
  await expect(visitor.locator("#about-title")).toHaveText("About us");

  const early = await demo.publishDue({ now: new Date(Date.parse(expectedAt) - 3_600_000).toISOString() });
  expect(early.status).toBe(200);
  expect(early.body).toMatchObject({ documents: [], failed: [{ key: "pages/home", code: "validation" }] });

  const due = await demo.publishDue({ now: new Date(Date.parse(expectedAt) + 3_600_000).toISOString() });
  expect(due.status).toBe(200);
  expect(due.body).toMatchObject({
    documents: [{ key: "pages/about", scheduledAt: null }],
    failed: [{ key: "pages/home", code: "validation" }],
  });
  const about = await demo.readDoc("pages/about");
  expect(about?.published).toEqual({ title: "Scheduled about", body: "A small bakery on the corner." });
  expect(about?.scheduledAt).toBeNull();
  const home = await demo.readDoc("pages/home");
  expect(home?.scheduledAt).toBe("2030-01-01T00:00:00.000Z");
  expect(home?.published).toEqual({ title: "Live home" });
  await visitor.reload();
  await expect(visitor.locator("#about-title")).toHaveText("Scheduled about");
  await expect(visitor.locator("#home-title")).toHaveText("Live home");
});

test("Publish now in the bar publishes a draft scheduled this session and clears the schedule", async ({
  page,
  demo,
}) => {
  await demo.openEditor({ scheduling: true });
  await editText(page, "#about-title", "Now title");
  await openPublishSheet(page);
  await fillPublishAt(page, "2032-02-02T10:00");
  await confirmButton(page).click();
  const line = bar(page).locator('.cms-bar__scheduled[data-key="pages/about"]');
  await expect(line).toBeVisible();
  expect((await demo.readDoc("pages/about"))?.scheduledAt).not.toBeNull();

  await line.getByRole("button", { name: "Publish now" }).click();
  await expect(toast(page)).toContainText("Published pages/about");
  await expect(line).toHaveCount(0);
  await expect(bar(page).locator(".cms-bar__changes")).toContainText("No changes yet");
  const row = await demo.readDoc("pages/about");
  expect(row?.scheduledAt).toBeNull();
  expect(row?.published).toEqual({ title: "Now title", body: "A small bakery on the corner." });
  const visitor = await openVisitorPage(demo);
  await expect(visitor.locator("#about-title")).toHaveText("Now title");
});

test("a time that passes while the sheet is open is refused at Confirm, by the browser's clock", async ({
  page,
  demo,
}) => {
  // Local wall-clock times, as the input reads them; the browser runs in the same zone as this process.
  await page.clock.setFixedTime(new Date(2031, 0, 1, 8, 0));
  await demo.openEditor({ scheduling: true });
  await editText(page, "#about-title", "Almost scheduled");
  await openPublishSheet(page);
  await expect(publishAt(page)).toHaveAttribute("min", "2031-01-01T08:00");

  await fillPublishAt(page, "2031-01-01T09:00");
  await expect(confirmButton(page)).toHaveText("Schedule");
  await expect(confirmButton(page)).toBeEnabled();
  await expect(sheet(page)).not.toContainText(PAST_REASON);

  const publishes: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/content/publish") publishes.push(sent.url());
  });
  await page.clock.setFixedTime(new Date(2031, 0, 1, 9, 30));
  await confirmButton(page).click();
  await expect(confirmButton(page)).toBeDisabled();
  await expect(sheet(page)).toContainText(PAST_REASON);
  await expect(sheet(page)).toBeVisible();
  // The min moved with the clock.
  await expect(publishAt(page)).toHaveAttribute("min", "2031-01-01T09:30");
  expect(publishes).toEqual([]);
  const row = await demo.readDoc("pages/about");
  expect(row?.scheduledAt).toBeNull();
  expect(row?.published).toEqual({ title: "About us", body: "A small bakery on the corner." });

  // A later time is accepted again.
  await fillPublishAt(page, "2031-01-01T10:00");
  await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).click();
  await expect(sheet(page)).toBeHidden();
  expect((await demo.readDoc("pages/about"))?.scheduledAt).toBe(await browserInstant(page, "2031-01-01T10:00"));
});
