import { Guard, TENANT_COOKIE, expect, test, waitForEditor, type Role } from "./fixtures.ts";
import type { Browser, Page } from "@playwright/test";

/** Every attribute on the page whose name starts with `data-edit`. */
const editAttributes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((node) =>
      [...node.attributes].filter((attribute) => attribute.name.startsWith("data-edit")).map((a) => a.name),
    ),
  );

/** Requests for the island or its stylesheet, recorded from before the first navigation. */
const recordEditorRequests = (page: Page): string[] => {
  const urls: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === "/editor.js" || pathname.startsWith("/pkg/")) urls.push(pathname);
  });
  return urls;
};

async function expectNoEditor(page: Page, editorRequests: string[]): Promise<void> {
  await expect(page.locator("#home-title")).toHaveText("Welcome to the demo");
  await expect(page.locator("[data-edit-field]")).toHaveCount(0);
  expect(await editAttributes(page)).toEqual([]);
  await expect(page.locator('script[src="/editor.js"], script[src^="/pkg/"]')).toHaveCount(0);
  await expect(page.locator('link[href^="/pkg/"]')).toHaveCount(0);
  await expect(page.locator(".cms-root, .cms-bar")).toHaveCount(0);
  expect(editorRequests).toEqual([]);
}

test.describe("visitors", () => {
  test.use({ role: "anonymous" });

  test("the visitor page carries no editor markup, script or stylesheet", async ({ page, demo }) => {
    const editorRequests = recordEditorRequests(page);
    await demo.openVisitor();
    await expectNoEditor(page, editorRequests);
  });

  test("an anonymous visitor asking for ?edit=1 gets the visitor page", async ({ page }) => {
    const editorRequests = recordEditorRequests(page);
    await page.goto("/?edit=1");
    await expectNoEditor(page, editorRequests);
  });

  test("signing in through setRole turns ?edit=1 into the editor", async ({ page, demo }) => {
    await page.goto("/?edit=1");
    await expect(page.locator("[data-edit-field]")).toHaveCount(0);
    await demo.setRole("editor");
    await page.reload();
    await waitForEditor(page);
  });
});

test("an editor without ?edit=1 sees the visitor page", async ({ page, demo }) => {
  const editorRequests = recordEditorRequests(page);
  await demo.openVisitor();
  await expectNoEditor(page, editorRequests);
});

test("the visitor page shows the published version, the editor the draft", async ({ page, demo }) => {
  await demo.seed({
    key: "pages/home",
    published: { title: "Live title" },
    draft: { title: "Draft title" },
  });
  await demo.openVisitor();
  await expect(page.locator("#home-title")).toHaveText("Live title");
  await demo.openEditor();
  await expect(page.locator("#home-title")).toHaveText("Draft title");
});

test("an editor's ?edit=1 mounts the bar and highlights every field", async ({ page, demo }) => {
  await demo.openEditor();
  await expect(page.locator(".cms-bar")).toContainText("Editing as Editor");
  const fields = page.locator("[data-edit-field]");
  await expect(fields).toHaveCount(11);
  await expect(page.locator(".cms-field")).toHaveCount(11);
  await expect(page.locator(".cms-field--locked")).toHaveCount(1);
  await expect(page.locator("#home-title")).toHaveAttribute("tabindex", "0");
  await expect(page.locator("#home-title")).toHaveAttribute("data-cms-state", "idle");
});

test("a field the role cannot edit shows muted with its reason", async ({ page, demo }) => {
  await demo.openEditor();
  const footer = page.locator("#site-footer");
  await expect(footer).toHaveClass(/cms-field--locked/);
  await expect(page.locator("#home-title")).not.toHaveClass(/cms-field--locked/);
  // The summary carries only `access.edit: false`, not the server's reason, so the chrome names it in its own words.
  const reason = "Not editable: you don’t have edit access to this document";
  await expect(footer).toHaveAccessibleDescription(`Footer · text · ${reason}`);

  await footer.hover();
  const badge = page.locator(".cms-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/cms-badge--locked/);
  await expect(badge).toHaveText(`Footer · text · ${reason}`);

  await footer.click();
  await expect(page.locator(".cms-toast")).toContainText(reason);
});

test.describe("roles", () => {
  const cases: [Role, boolean][] = [
    ["contributor", true],
    ["owner", true],
    ["cron", false],
  ];
  for (const [role, editor] of cases) {
    test(`${role} ${editor ? "gets" : "does not get"} the editor`, async ({ page, demo }) => {
      await demo.setRole(role);
      await page.goto("/?edit=1");
      if (editor) await waitForEditor(page);
      else await expect(page.locator("[data-edit-field]")).toHaveCount(0);
    });
  }

  test("the owner may edit the settings document", async ({ page, demo }) => {
    await demo.setRole("owner");
    await demo.openEditor();
    await expect(page.locator(".cms-field--locked")).toHaveCount(0);
  });
});

test.describe("the guard", () => {
  // Each opens its own context, outside the test's guard and in its own tenant, so the test's own guard stays clean.
  // Reports and events arrive asynchronously, and slowly on a loaded machine: hence the longer polls.
  const isolated = async (browser: Browser, baseURL: string | undefined, name: string) => {
    const guard = new Guard();
    const context = await browser.newContext({ baseURL });
    const tenant = `guard-${name}-${test.info().testId}-${test.info().repeatEachIndex}`;
    await context.addCookies([{ name: TENANT_COOKIE, value: tenant, url: baseURL! }]);
    await context.request.post("/__test/reset", { data: {} });
    await guard.attach(context);
    return { guard, context };
  };

  test("detects an inline-style CSP violation, in the browser and as a server report", async ({ browser, baseURL }) => {
    const { guard, context } = await isolated(browser, baseURL, "csp");
    try {
      const page = await context.newPage();
      await page.goto("/__test/csp-violation");

      await expect.poll(() => guard.problems().map((problem) => problem.kind), { timeout: 15_000 }).toContain("csp");
      expect(guard.problems().find((problem) => problem.kind === "csp")?.text).toMatch(/^style-src/);
      const reports = async () =>
        ((await (await context.request.get("/__test/csp-reports")).json()) as { reports: unknown[] }).reports;
      await expect.poll(reports, { timeout: 15_000 }).not.toHaveLength(0);
    } finally {
      await context.request.post("/__test/drop");
      await context.close();
    }
  });

  test("detects console and page errors, and lets an allowlisted console error through", async ({
    browser,
    baseURL,
  }) => {
    const { guard, context } = await isolated(browser, baseURL, "console");
    try {
      const page = await context.newPage();
      await page.goto("/__test/console-error");

      const kinds = () => guard.problems().map((problem) => problem.kind);
      await expect.poll(() => kinds().sort(), { timeout: 15_000 }).toEqual(["console", "pageerror"]);
      guard.allowConsoleError("demo console error");
      expect(kinds()).toEqual(["pageerror"]);
    } finally {
      await context.request.post("/__test/drop");
      await context.close();
    }
  });
});
