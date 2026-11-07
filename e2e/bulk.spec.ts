// Bulk publish over a real network: one document's publish is held or failed with `page.route`, so the run can be
// stopped mid-way or partly fail, and the specs read what reached the store.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Locator, Page, Request, Route } from "@playwright/test";

type Mode = "hold" | "pass" | "fail";

const FAILURE_MESSAGE = "Server on fire";

/** Intercepts `POST /api/content/publish` for one document. `hold` parks it until `release()`; `fail` answers 500. */
class PublishGate {
  readonly requests: Request[] = [];
  private readonly held: Route[] = [];

  private constructor(public mode: Mode) {}

  static async on(page: Page, key: string, mode: Mode): Promise<PublishGate> {
    const gate = new PublishGate(mode);
    await page.route(
      (url) => url.pathname === "/api/content/publish",
      async (route) => {
        const request = route.request();
        if ((request.postDataJSON() as { key?: string } | null)?.key !== key) return route.fallback();
        gate.requests.push(request);
        if (gate.mode === "pass") return route.continue();
        if (gate.mode === "fail") {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: FAILURE_MESSAGE } }),
          });
        }
        gate.held.push(route);
      },
    );
    return gate;
  }

  async waitHeld(count = 1): Promise<void> {
    await expect.poll(() => this.held.length).toBe(count);
  }

  /** Lets every held request through, and new ones from now on. Resolves once their responses have arrived. */
  async release(): Promise<void> {
    this.mode = "pass";
    const routes = this.held.splice(0);
    for (const route of routes) await route.continue();
    for (const route of routes) await route.request().response();
  }
}

const sheet = (page: Page) => page.locator(".cms-sheet");
const toast = (page: Page) => page.locator(".cms-toast");
const bar = (page: Page) => page.locator(".cms-bar");
const confirmButton = (page: Page) =>
  sheet(page).locator(".cms-sheet__actions").getByRole("button", { name: "Publish" });
const cancelButton = (page: Page) => sheet(page).locator(".cms-sheet__actions").getByRole("button", { name: "Cancel" });
const row = (page: Page, key: string): Locator => sheet(page).locator(`li[data-key="${key}"]`);

const EDITS = [
  { key: "pages/home", selector: "#home-title", path: "title", before: "Welcome to the demo", after: "New home" },
  { key: "pages/about", selector: "#about-title", path: "title", before: "About us", after: "New about" },
  { key: "settings/site", selector: "#site-footer", path: "footer", before: "Demo Bakery Ltd", after: "New footer" },
] as const;

/** Edits each document's text field in the browser, so the session counts it as touched, and waits for the save. */
async function touch(page: Page, edits: readonly (typeof EDITS)[number][]): Promise<void> {
  for (const edit of edits) {
    const field = page.locator(edit.selector);
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(true|plaintext-only)$/);
    await field.fill(edit.after);
    await field.press("Enter");
    await expect(field).toHaveAttribute("data-cms-state", "saved");
  }
}

/** Opens the Publish sheet and waits until every listed document's diff has loaded. */
async function openPublish(page: Page, edits: readonly (typeof EDITS)[number][]): Promise<void> {
  await bar(page).getByRole("button", { name: "Publish" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator("li[data-key]")).toHaveCount(edits.length);
  for (const edit of edits) await expect(row(page, edit.key).locator(`li[data-path="${edit.path}"]`)).toBeVisible();
}

async function published(demo: Demo, key: string): Promise<Record<string, unknown>> {
  return ((await demo.readDoc(key))?.published ?? {}) as Record<string, unknown>;
}

test.describe("stopping a bulk publish", () => {
  // The owner may publish all three documents: home goes out, about is held in flight, settings hasn't started.
  test.use({ role: "owner" });

  const stops: { name: string; stop(page: Page): Promise<void> }[] = [
    { name: "Cancel", stop: (page) => cancelButton(page).click() },
    { name: "Esc", stop: (page) => page.keyboard.press("Escape") },
    {
      name: "Close",
      stop: (page) => sheet(page).locator(".cms-sheet__header").getByRole("button", { name: "Close" }).click(),
    },
  ];

  for (const { name, stop } of stops) {
    test(`${name} during the run stops the documents not started; the one in flight finishes`, async ({
      page,
      demo,
    }) => {
      await demo.openEditor();
      await touch(page, EDITS);
      await openPublish(page, EDITS);
      // A fake clock from here, so "stays until dismissed" is proved by moving time on rather than by waiting. The last
      // "Draft saved" toast must hide first: its real timer can't be cleared by the fake clearTimeout and would hide
      // the toast under test. (Installing before the page loads stalls Firefox's first load.)
      await expect(toast(page)).toBeHidden({ timeout: 15_000 });
      await page.clock.install();
      const gate = await PublishGate.on(page, "pages/about", "hold");

      await confirmButton(page).click();
      await expect(confirmButton(page)).toBeDisabled();
      await expect(cancelButton(page)).toBeFocused();
      await gate.waitHeld(1);
      expect((await published(demo, "pages/home"))["title"]).toBe("New home");

      await stop(page);
      await expect(sheet(page)).toBeHidden();
      await gate.release();

      const message = toast(page).locator(".cms-toast__message");
      await expect(message).toHaveText("Publish stopped: 2 of 3 done. Not done: settings/site.");
      expect((await published(demo, "pages/about"))["title"]).toBe("New about");
      const settings = await demo.readDoc("settings/site");
      expect(settings?.published).toMatchObject({ footer: "Demo Bakery Ltd" });
      expect(settings?.draft).toMatchObject({ footer: "New footer" });
      expect(gate.requests).toHaveLength(1);

      await page.clock.runFor(30_000);
      await expect(message).toBeVisible();
      await toast(page).getByRole("button", { name: "Close" }).click();
      await expect(toast(page)).toBeHidden();

      // Still touched: it is all the bar counts, and the Publish sheet lists it alone.
      await expect(bar(page).locator(".cms-bar__changes")).toHaveAttribute("data-documents", "1");
      await bar(page).getByRole("button", { name: "Publish" }).click();
      await expect(sheet(page).locator("li[data-key]")).toHaveCount(1);
      await expect(row(page, "settings/site")).toBeVisible();
      await confirmButton(page).click();
      await expect(sheet(page)).toBeHidden();
      expect((await published(demo, "settings/site"))["footer"]).toBe("New footer");
    });
  }
});

test("while a scheduled-capable run is going, Confirm and Publish at are disabled and focus is on Cancel", async ({
  page,
  demo,
}) => {
  const edits = EDITS.slice(0, 2);
  await demo.openEditor({ scheduling: true });
  await touch(page, edits);
  await openPublish(page, edits);
  const gate = await PublishGate.on(page, "pages/about", "hold");
  const publishAt = sheet(page).getByLabel("Publish at (optional)");
  await expect(publishAt).toBeEnabled();

  await confirmButton(page).click();
  await gate.waitHeld(1);
  await expect(confirmButton(page)).toBeDisabled();
  await expect(publishAt).toBeDisabled();
  await expect(cancelButton(page)).toBeFocused();

  await gate.release();
  await expect(sheet(page)).toBeHidden();
  await expect(toast(page)).toContainText("Publish: all 2 documents done.");
  expect((await published(demo, "pages/home"))["title"]).toBe("New home");
  expect((await published(demo, "pages/about"))["title"]).toBe("New about");
  await expect(bar(page).locator(".cms-bar__changes")).toHaveAttribute("data-documents", "0");
});

test("one document failing doesn't stop the others; it stays listed with the reason and Confirm retries it", async ({
  page,
  demo,
  guard,
}) => {
  guard.allowFailedRequests();
  const edits = EDITS.slice(0, 2);
  await demo.openEditor();
  await touch(page, edits);
  await openPublish(page, edits);
  const gate = await PublishGate.on(page, "pages/home", "fail");

  await confirmButton(page).click();
  await expect(row(page, "pages/about")).toHaveCount(0);
  await expect(row(page, "pages/home").locator(".cms-error")).toHaveText(
    `Publish failed for pages/home: ${FAILURE_MESSAGE}`,
  );
  await expect(toast(page).locator(".cms-toast__message")).toHaveText("Publish: 1 of 2 done. Not done: pages/home.");
  await expect(confirmButton(page)).toBeEnabled();
  await expect(confirmButton(page)).toBeFocused();
  expect((await published(demo, "pages/about"))["title"]).toBe("New about");
  expect((await published(demo, "pages/home"))["title"]).toBe("Welcome to the demo");

  gate.mode = "pass";
  await confirmButton(page).click();
  await expect(sheet(page)).toBeHidden();
  expect(gate.requests).toHaveLength(2);
  expect((await published(demo, "pages/home"))["title"]).toBe("New home");
  await expect(bar(page).locator(".cms-bar__changes")).toHaveAttribute("data-documents", "0");
});
