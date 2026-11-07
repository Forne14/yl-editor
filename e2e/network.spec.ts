// Slow and failed networks, made real with `page.route`: a gate holds, fails or passes the chrome's own requests, and
// the specs release held ones when they choose, so nothing here waits on a clock.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Page, Request, Route } from "@playwright/test";

type Mode = "hold" | "pass" | "abort" | "fail";

const FAILURE_MESSAGE = "Server on fire";

/** Intercepts one content route. `hold` parks requests until `release()`; `fail` answers 500 with an error envelope. */
class Gate {
  readonly requests: Request[] = [];
  private readonly held: Route[] = [];

  private constructor(public mode: Mode) {}

  static async on(
    page: Page,
    method: "GET" | "POST",
    route: string,
    mode: Mode,
    matches: (request: Request) => boolean = () => true,
  ): Promise<Gate> {
    const gate = new Gate(mode);
    await page.route(
      (url) => url.pathname === `/api/content/${route}`,
      async (intercepted) => {
        const request = intercepted.request();
        if (request.method() !== method || !matches(request)) return intercepted.fallback();
        gate.requests.push(request);
        if (gate.mode === "pass") return intercepted.continue();
        if (gate.mode === "abort") return intercepted.abort("failed");
        if (gate.mode === "fail") {
          return intercepted.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: FAILURE_MESSAGE } }),
          });
        }
        gate.held.push(intercepted);
      },
    );
    return gate;
  }

  bodies(): Record<string, unknown>[] {
    return this.requests.map((request) => request.postDataJSON() as Record<string, unknown>);
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

const forKey =
  (key: string) =>
  (request: Request): boolean =>
    new URL(request.url()).searchParams.get("key") === key;

const toast = (page: Page) => page.locator(".cms-toast");
const sheet = (page: Page) => page.locator(".cms-sheet");
const bar = (page: Page) => page.locator(".cms-bar");

/** The draft as stored, falling back to the published payload when the row has no separate draft. */
async function storedDraft(demo: Demo, key: string): Promise<Record<string, unknown>> {
  const row = await demo.readDoc(key);
  return (row?.draft ?? row?.published ?? {}) as Record<string, unknown>;
}

/** Opens a text field, replaces its text and commits with Enter. */
async function editText(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector);
  await field.click();
  await expect(field).toHaveAttribute("contenteditable", /^(true|plaintext-only)$/);
  await field.fill(value);
  await field.press("Enter");
  await expect(field).not.toHaveAttribute("contenteditable");
}

/** True once the session has the document's payload: the chrome has handled the `GET document` response. */
const payloadLoaded = (page: Page, key: string) =>
  page.evaluate(
    (documentKey) =>
      (window as unknown as { demoEditor: { api: { documents(): Map<string, { payload: unknown }> } } }).demoEditor.api
        .documents()
        .get(documentKey)?.payload !== undefined,
    key,
  );

const FAILURES = [
  { kind: "aborted", mode: "abort", message: "Couldn’t reach the server" },
  { kind: "500", mode: "fail", message: FAILURE_MESSAGE },
] as const;

for (const failure of FAILURES) {
  test.describe(`a ${failure.kind} save`, () => {
    test.beforeEach(({ guard }) => {
      guard.allowFailedRequests();
    });

    test("marks the field failed with Retry in the toast, and Retry saves once the server answers", async ({
      page,
      demo,
    }) => {
      await demo.openEditor();
      const gate = await Gate.on(page, "POST", "field", failure.mode);
      const title = page.locator("#home-title");

      await editText(page, "#home-title", "Lost title");
      await expect(title).toHaveAttribute("data-cms-state", "failed");
      await expect(title).toHaveClass(/cms-field--failed/);
      await expect(toast(page)).toContainText(`Not saved: ${failure.message}`);
      expect((await storedDraft(demo, "pages/home"))["title"]).toBe("Welcome to the demo");

      gate.mode = "pass";
      await toast(page).getByRole("button", { name: "Retry" }).click();
      await expect(title).toHaveAttribute("data-cms-state", "saved");
      expect(gate.bodies().map((body) => body["value"])).toEqual(["Lost title", "Lost title"]);
      expect((await storedDraft(demo, "pages/home"))["title"]).toBe("Lost title");
    });

    test("a failed text field: Esc leaves it failed, reopening and leaving resends the value", async ({
      page,
      demo,
    }) => {
      await demo.openEditor();
      const gate = await Gate.on(page, "POST", "field", failure.mode);
      const title = page.locator("#home-title");
      await editText(page, "#home-title", "Retried title");
      await expect(title).toHaveAttribute("data-cms-state", "failed");
      gate.mode = "pass";

      await title.click();
      await expect(title).toHaveAttribute("contenteditable", /^(true|plaintext-only)$/);
      await title.press("Escape");
      await expect(title).not.toHaveAttribute("contenteditable");
      await expect(title).toHaveAttribute("data-cms-state", "failed");
      await expect(title).toHaveText("Retried title");
      expect(gate.requests).toHaveLength(1);

      await title.click();
      await expect(title).toHaveAttribute("contenteditable", /^(true|plaintext-only)$/);
      await title.press("Tab");
      await expect(title).toHaveAttribute("data-cms-state", "saved");
      expect(gate.bodies().map((body) => body["value"])).toEqual(["Retried title", "Retried title"]);
      expect((await storedDraft(demo, "pages/home"))["title"]).toBe("Retried title");
    });

    test("a failed popover field: Esc leaves it failed, reopening and leaving resends the value", async ({
      page,
      demo,
    }) => {
      await demo.openEditor();
      const gate = await Gate.on(page, "POST", "field", failure.mode);
      const status = page.locator("#home-status");
      const select = page.locator(".cms-popover select");

      await status.click();
      await expect(select).toHaveValue("live");
      await select.selectOption("archived");
      await expect(status).toHaveAttribute("data-cms-state", "failed");
      gate.mode = "pass";

      await status.click();
      await expect(select).toHaveValue("archived");
      await select.press("Escape");
      await expect(page.locator(".cms-popover")).toHaveCount(0);
      await expect(status).toHaveAttribute("data-cms-state", "failed");
      expect(gate.requests).toHaveLength(1);

      // Leaving the popover for another field commits what it holds: the value that failed.
      await status.click();
      await expect(select).toHaveValue("archived");
      await page.locator("#about-title").click();
      await expect(status).toHaveAttribute("data-cms-state", "saved");
      await page.locator("#about-title").press("Escape");
      expect(gate.bodies().map((body) => body["value"])).toEqual(["archived", "archived"]);
      expect((await storedDraft(demo, "pages/home"))["status"]).toBe("archived");
    });
  });
}

test("values committed while a save is in flight coalesce: only the latest is sent next", async ({ page, demo }) => {
  await demo.openEditor();
  const gate = await Gate.on(page, "POST", "field", "hold");
  const title = page.locator("#home-title");

  await editText(page, "#home-title", "One");
  await gate.waitHeld(1);
  await editText(page, "#home-title", "Two");
  await editText(page, "#home-title", "Three");
  await expect(title).toHaveAttribute("data-cms-state", "saving");
  expect(gate.requests).toHaveLength(1);

  await gate.release();
  await expect(title).toHaveAttribute("data-cms-state", "saved");
  expect(gate.bodies().map((body) => body["value"])).toEqual(["One", "Three"]);
  expect((await storedDraft(demo, "pages/home"))["title"]).toBe("Three");
  expect((await demo.changes()).filter((change) => change.action === "field")).toHaveLength(2);
});

test.describe("a popover waiting on a slow GET document", () => {
  test("doesn't open once the Publish sheet has opened, and the sheet still publishes", async ({ page, demo }) => {
    await demo.openEditor();
    await editText(page, "#about-title", "Fresh about");
    await expect(page.locator("#about-title")).toHaveAttribute("data-cms-state", "saved");
    const gate = await Gate.on(page, "GET", "document", "hold", forKey("pages/home"));

    await page.locator("#home-status").click();
    await gate.waitHeld(1);
    await bar(page).getByRole("button", { name: "Publish" }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('li[data-key="pages/about"] li[data-path="title"]')).toBeVisible();

    await gate.release();
    await expect.poll(() => payloadLoaded(page, "pages/home")).toBe(true);
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(page.locator("#home-status")).not.toHaveClass(/cms-field--editing/);

    await sheet(page).getByRole("button", { name: "Publish" }).click();
    await expect(sheet(page)).toBeHidden();
    expect((await demo.readDoc("pages/about"))?.published).toMatchObject({ title: "Fresh about" });
    await expect(page.locator(".cms-popover")).toHaveCount(0);
  });

  test("doesn't open once the Revisions drawer has opened, and the drawer still lists revisions", async ({
    page,
    demo,
  }) => {
    await demo.openEditor();
    const gate = await Gate.on(page, "GET", "document", "hold", forKey("pages/home"));

    await page.locator("#home-status").click();
    await gate.waitHeld(1);
    await bar(page).getByRole("button", { name: "Revisions" }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator("li[data-revision]").first()).toBeVisible();

    await gate.release();
    await expect.poll(() => payloadLoaded(page, "pages/home")).toBe(true);
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(page.locator("#home-status")).not.toHaveClass(/cms-field--editing/);

    await sheet(page).getByLabel("Document").selectOption("pages/about");
    await expect(sheet(page).locator("li[data-revision]").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect(bar(page).getByRole("button", { name: "Revisions" })).toBeFocused();
  });

  test("doesn't open on a document discarded, and so deleted, during the wait", async ({ page, demo, guard }) => {
    // The held read reaches the server after the delete and answers 404.
    guard.allowFailedRequests();
    await demo.seed({
      key: "pages/home",
      draft: { title: "Never live", status: "draft" },
      publishedPayload: null,
      publishedAt: null,
    });
    await demo.openEditor();
    await editText(page, "#home-title", "Still never live");
    await expect(page.locator("#home-title")).toHaveAttribute("data-cms-state", "saved");
    // A fresh session: the save's returned document would otherwise serve the popover without a fetch. Session
    // storage keeps pages/home touched, so Discard still lists it.
    await demo.openEditor();
    await expect(bar(page)).toContainText("1 change on this page");
    const gate = await Gate.on(page, "GET", "document", "hold", forKey("pages/home"));

    await page.locator("#home-status").click();
    await gate.waitHeld(1);
    await bar(page).getByRole("button", { name: "Discard" }).click();
    await expect(sheet(page)).toContainText("discarding deletes pages/home");
    await sheet(page).getByRole("button", { name: "Discard" }).click();
    await expect(sheet(page)).toBeHidden();
    await expect(toast(page)).toContainText("Discarded pages/home. Nothing was live");
    expect(await demo.readDoc("pages/home")).toBeNull();

    await gate.release();
    expect((await gate.requests[0]?.response())?.status()).toBe(404);
    // One more round trip, so the chrome has handled the rejected read before we look.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(toast(page)).not.toContainText("Couldn’t load this field");

    await page.locator("#home-status").click();
    await expect(toast(page)).toContainText("Not editable: the server doesn’t know this document");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
  });
});

for (const failure of FAILURES) {
  test.describe(`an ${failure.kind} GET document`, () => {
    test.beforeEach(({ guard }) => {
      guard.allowFailedRequests();
    });

    test("opens from data-edit-value with a toast, writes nothing, and the next open retries", async ({
      page,
      demo,
    }) => {
      await demo.openEditor();
      const status = page.locator("#home-status");
      await status.evaluate((node) => node.setAttribute("data-edit-value", JSON.stringify("archived")));
      const gate = await Gate.on(page, "GET", "document", failure.mode, forKey("pages/home"));
      const select = page.locator(".cms-popover select");

      await status.click();
      await expect(select).toHaveValue("archived");
      await expect(toast(page)).toContainText(
        `Couldn’t load this field, so it starts from the page’s value: ${failure.message}`,
      );
      await select.press("Escape");
      await expect(page.locator(".cms-popover")).toHaveCount(0);

      gate.mode = "pass";
      await status.click();
      await expect(select).toHaveValue("live");
      expect(gate.requests).toHaveLength(2);
      await select.press("Escape");
      await expect(page.locator(".cms-popover")).toHaveCount(0);
      expect(await demo.changes()).toEqual([]);
    });

    test("without data-edit-value stays closed with a toast, and the next open retries", async ({ page, demo }) => {
      await demo.openEditor();
      const status = page.locator("#home-status");
      const gate = await Gate.on(page, "GET", "document", failure.mode, forKey("pages/home"));

      await status.click();
      await expect(toast(page)).toContainText(`Couldn’t load this field: ${failure.message}`);
      await expect(toast(page)).toHaveAttribute("data-kind", "error");
      await expect(page.locator(".cms-popover")).toHaveCount(0);
      await expect(status).not.toHaveClass(/cms-field--editing/);

      gate.mode = "pass";
      await status.click();
      await expect(page.locator(".cms-popover select")).toHaveValue("live");
      expect(gate.requests).toHaveLength(2);
      expect(await demo.changes()).toEqual([]);
    });
  });
}

test.describe("loading the page's documents", () => {
  test("a slow GET documents: the fields are highlighted once it settles", async ({ page }) => {
    const gate = await Gate.on(page, "GET", "documents", "hold");
    await page.goto("/?edit=1", { waitUntil: "domcontentloaded" });
    await gate.waitHeld(1);
    await expect(page.locator("html")).not.toHaveAttribute("data-editor-ready");
    await expect(page.locator(".cms-field")).toHaveCount(0);
    await expect(page.locator("#home-title")).not.toHaveAttribute("tabindex");

    await gate.release();
    await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
    await expect(bar(page)).toBeVisible();
    await expect(page.locator(".cms-field")).toHaveCount(11);
    await expect(page.locator(".cms-field--locked")).toHaveCount(1);
    await expect(page.locator("#home-title")).toHaveAttribute("tabindex", "0");
  });

  for (const failure of FAILURES) {
    test(`an ${failure.kind} GET documents shows a toast with Retry, and Retry loads them`, async ({ page, guard }) => {
      guard.allowFailedRequests();
      const gate = await Gate.on(page, "GET", "documents", failure.mode);
      await page.goto("/?edit=1");
      await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
      await expect(toast(page)).toContainText(`Couldn’t load the documents on this page: ${failure.message}`);
      await expect(page.locator(".cms-field--locked")).toHaveCount(11);

      gate.mode = "pass";
      await toast(page).getByRole("button", { name: "Retry" }).click();
      await expect(page.locator(".cms-field--locked")).toHaveCount(1);
      await expect(page.locator("#home-title")).not.toHaveClass(/cms-field--locked/);
      expect(gate.requests).toHaveLength(2);
      // The error is resolved, so its toast (and its Retry) must not linger.
      await expect(toast(page)).toBeHidden();

      await page.locator("#home-status").click();
      await expect(page.locator(".cms-popover select")).toHaveValue("live");
    });
  }
});
