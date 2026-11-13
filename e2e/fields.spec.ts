// Every default widget, in a real browser: it opens from the stored value, saves a draft, and the saved value is what
// the page renders after a reload. Also the plain-text contenteditable (typing, paste, drop, caret) and the tags widget.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const HOME = "pages/home";

/** Waits until the stored draft of pages/home holds `value` at `path`. */
async function expectDraft(demo: Demo, path: string, value: unknown): Promise<void> {
  await expect
    .poll(async () => ((await demo.readDoc(HOME))?.draft as Record<string, unknown> | undefined)?.[path])
    .toEqual(value);
}

async function reloadEditor(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
}

/**
 * Dispatches a paste carrying `data`. Firefox ignores `clipboardData` in the ClipboardEvent constructor, so the
 * property is defined on the event instead, which every engine honours. Returns false when the chrome cancelled it.
 */
const paste = (field: Locator, data: Record<string, string>) =>
  field.evaluate((node, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) transfer.setData(type, value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    return node.dispatchEvent(event);
  }, data);

const popover = (page: Page) => page.locator(".cms-popover:not(.cms-popover--note)");

test.describe("each field type saves a draft that survives a reload", () => {
  test("text: typed in place, committed on Enter", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type(" today");
    await page.keyboard.press("Enter");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expectDraft(demo, "title", "Welcome to the demo today");

    await reloadEditor(page);
    await expect(page.locator("#home-title")).toHaveText("Welcome to the demo today");
  });

  test("richtext: falls back to plain text with a note, and saves the text", async ({ page, demo }) => {
    await demo.openEditor({ richtext: "fallback" });
    const field = page.locator(".lede");
    await expect(field.locator("strong")).toHaveText("every morning");
    await field.click();
    await expect(page.locator(".cms-popover--note")).toContainText("Plain text only");
    await page.keyboard.type(" Always.");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover--note")).toHaveCount(0);
    // The demo's schema sanitises rich text, which puts loose text in a paragraph.
    await expectDraft(demo, "lede", "<p>Fresh bread every morning. Always.</p>");

    await page.goto("/?edit=1&richtext=fallback");
    await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
    await expect(page.locator(".lede")).toHaveText("Fresh bread every morning. Always.");
  });

  test("toggle: opens on the stored true although the page says Live, and saves false", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-live");
    await expect(field).toHaveText("Live");
    await field.click();
    const toggle = popover(page).getByRole("switch");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "live", false);

    await reloadEditor(page);
    await expect(page.locator("#home-live")).toHaveText("Off");
    await page.locator("#home-live").click();
    await expect(popover(page).getByRole("switch")).not.toBeChecked();
  });

  test("select: opens on the stored option and saves the chosen one", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-status").click();
    const select = popover(page).getByRole("combobox", { name: "Status" });
    await expect(select).toHaveValue("live");
    await select.selectOption("archived");
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-status")).toHaveText("archived");
    await expectDraft(demo, "status", "archived");

    await reloadEditor(page);
    await expect(page.locator("#home-status")).toHaveText("archived");
  });

  test("number: saves a number, not a string", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-price").click();
    const input = popover(page).getByRole("spinbutton", { name: "Price" });
    await expect(input).toHaveValue("12");
    await input.fill("15.5");
    await input.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "price", 15.5);

    await reloadEditor(page);
    await expect(page.locator("#home-price")).toHaveText("15.5");
  });

  test("tags: saves the list", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    const chips = popover(page).locator(".cms-chip");
    await expect(chips).toHaveText(["bakery×", "local×"]);
    const input = popover(page).getByRole("textbox", { name: "Add tag" });
    await input.fill("sourdough");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "tags", ["bakery", "local", "sourdough"]);

    await reloadEditor(page);
    await expect(page.locator("#home-tags")).toHaveText("bakery, local, sourdough");
  });

  test("date: opens on the stored ISO date, not the rendered 14 Nov 2026", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-date");
    await expect(field).toHaveText("14 Nov 2026");
    // Garble the rendered text: the widget must not read it.
    await field.evaluate((node) => (node.textContent = "sometime soon"));
    await field.click();
    const input = popover(page).locator('input[type="date"]');
    await expect(input).toHaveValue("2026-11-14");
    await input.fill("2026-12-24");
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "date", "2026-12-24");

    await reloadEditor(page);
    await expect(page.locator("#home-date")).toHaveText("24 Dec 2026");
  });

  test("url: saves on Enter", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-link").click();
    const input = popover(page).getByRole("textbox", { name: "Menu link" });
    await expect(input).toHaveValue("https://example.com/menu");
    await input.fill("https://example.com/winter-menu");
    await input.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "link", "https://example.com/winter-menu");

    await reloadEditor(page);
    await expect(page.locator("#home-link")).toHaveText("https://example.com/winter-menu");
  });

  test("a field of another document saves to that document", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#about-body").click();
    await page.keyboard.type(" Since 1999.");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => ((await demo.readDoc("pages/about"))?.draft as { body?: string } | undefined)?.body)
      .toBe("A small bakery on the corner. Since 1999.");
    expect((await demo.readDoc(HOME))?.draftPayload).toBeNull();

    await reloadEditor(page);
    await expect(page.locator("#about-body")).toHaveText("A small bakery on the corner. Since 1999.");
  });
});

test.describe("the plain-text contenteditable", () => {
  test("puts the caret at the end of the text when it opens", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click({ position: { x: 4, y: 4 } });
    await expect(field).toBeFocused();
    const caret = await field.evaluate((node) => {
      const selection = node.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const before = node.ownerDocument.createRange();
      before.selectNodeContents(node);
      before.setEnd(range.endContainer, range.endOffset);
      return { collapsed: selection.isCollapsed, offset: before.toString().length, length: node.textContent?.length };
    });
    expect(caret).toEqual({
      collapsed: true,
      offset: "Welcome to the demo".length,
      length: "Welcome to the demo".length,
    });
  });

  test("is plaintext-only where the browser supports it, else true, and is removed on close", async ({
    page,
    demo,
  }) => {
    await demo.openEditor();
    const supported = await page.evaluate(() => {
      const probe = document.createElement("div");
      try {
        probe.contentEditable = "plaintext-only";
      } catch {
        return false;
      }
      return probe.contentEditable === "plaintext-only";
    });
    const field = page.locator("#home-title");
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", supported ? "plaintext-only" : "true");
    await expect(field).toBeFocused();
    // Either mode takes typing; in the "true" fallback, Enter must still commit rather than insert a line break.
    await page.keyboard.type("!");
    await page.keyboard.press("Enter");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expect(field.locator("*")).toHaveCount(0);
    await expectDraft(demo, "title", "Welcome to the demo!");
  });

  test("paste is reduced to plain text on one line", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    const notCancelled = await paste(field, {
      "text/html": "<b>Bold</b> <a href='https://evil.example'>link</a>",
      "text/plain": " Bold\nlink",
    });
    expect(notCancelled).toBe(false);
    await expect(field).toHaveText("Welcome to the demo Bold link");
    await expect(field.locator("*")).toHaveCount(0);
    // The caret sits after the pasted text, so typing continues from there.
    await page.keyboard.type("s");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Welcome to the demo Bold links");
  });

  test("a pasted trailing space survives typing after it", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await paste(field, { "text/plain": " and" + " " });
    await page.keyboard.type("more");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Welcome to the demo and more");
  });

  test("drop is prevented", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    const notCancelled = await field.evaluate((node) => {
      const data = new DataTransfer();
      data.setData("text/plain", "dropped");
      data.setData("text/html", "<img src=x>");
      return node.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    expect(notCancelled).toBe(false);
    await expect(field).toHaveText("Welcome to the demo");
    await page.keyboard.press("Escape");
    await expect(field).not.toHaveAttribute("contenteditable");
    expect(await demo.changes()).toEqual([]);
  });

  test("leaving a text field unchanged writes nothing", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.press("Enter");
    await expect(field).not.toHaveAttribute("contenteditable");
    await page.locator("#about-title").click();
    await page.locator("#home-live").click();
    await expect(popover(page)).toBeVisible();
    expect(await demo.changes()).toEqual([]);
  });
});

test.describe("the tags widget", () => {
  /** The popover opens once its document has loaded; keys pressed before that go nowhere, as they would for a user. */
  async function openTags(page: Page): Promise<Locator> {
    await page.locator("#home-tags").click();
    const input = popover(page).getByRole("textbox", { name: "Add tag" });
    await expect(input).toBeFocused();
    return input;
  }

  test("commas split the input into chips, skipping blanks and duplicates", async ({ page, demo }) => {
    await demo.openEditor();
    const input = await openTags(page);
    await page.keyboard.type("rye, , local,spelt,");
    await expect(popover(page).locator(".cms-chip")).toHaveText(["bakery×", "local×", "rye×", "spelt×"]);
    await expect(input).toHaveValue("");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "tags", ["bakery", "local", "rye", "spelt"]);
  });

  test("Enter adds the typed tag, and Enter on an empty input commits", async ({ page, demo }) => {
    await demo.openEditor();
    const input = await openTags(page);
    await page.keyboard.type("sourdough");
    await page.keyboard.press("Enter");
    await expect(popover(page).locator(".cms-chip")).toHaveText(["bakery×", "local×", "sourdough×"]);
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    expect(await demo.changes()).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-tags")).toBeFocused();
    await expectDraft(demo, "tags", ["bakery", "local", "sourdough"]);
  });

  test("a chip's remove button removes it and keeps focus in the widget", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    const widget = popover(page);
    const input = widget.getByRole("textbox", { name: "Add tag" });
    await widget.getByRole("button", { name: "Remove bakery" }).click();
    await expect(widget.locator(".cms-chip")).toHaveText(["local×"]);
    await expect(widget).toBeVisible();
    await expect(input).toBeFocused();
    expect(await demo.changes()).toEqual([]);

    // The same with the keyboard: Shift+Tab back to the remaining chip's button, Enter. Safari's Tab skips buttons
    // unless "Press Tab to highlight each item" is on; Option+Tab reaches them either way.
    await page.keyboard.press(browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
    await expect(widget.getByRole("button", { name: "Remove local" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(widget.locator(".cms-chip")).toHaveCount(0);
    await expect(widget).toBeVisible();
    await expect(input).toBeFocused();

    await page.keyboard.type("rye");
    await widget.getByRole("button", { name: "Done" }).click();
    await expect(widget).toHaveCount(0);
    await expectDraft(demo, "tags", ["rye"]);
  });
});

test.describe("no-break spaces in a text edit", () => {
  test("one the text already had stays when another part is edited, and a typed space is stored plain", async ({
    page,
    demo,
  }) => {
    await demo.seed({ key: HOME, published: { title: "Run 10\u00a0km" }, draft: { title: "Run 10\u00a0km" } });
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type(" today");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Run 10\u00a0km today");
  });

  test("a stored one the page renders as a plain space survives typing at the end", async ({ page, demo }) => {
    await demo.seed({ key: HOME, published: { title: "10 km" }, draft: { title: "10 km" } });
    await demo.openEditor();
    const field = page.locator("#home-title");
    // A host that renders the text with plain spaces, and the stored value in data-edit-value.
    await field.evaluate((node) => {
      node.textContent = "10 km";
      node.dataset.editValue = JSON.stringify("10 km");
    });
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type("s");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "10 kms");
  });

  test("a space typed at the end and then after it is stored plain", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type(" and  more");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Welcome to the demo and  more");
  });

  test("a second edit doesn't keep what the first typed", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.type(" today");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Welcome to the demo today");
    await field.click();
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type("!");
    await page.keyboard.press("Enter");
    await expectDraft(demo, "title", "Welcome to the demo today!");
  });
});
