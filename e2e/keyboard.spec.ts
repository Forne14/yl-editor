// Keyboard-only runs of the main flows: no clicks, no hover, no programmatic focus. Each step asserts where focus
// lands against what docs/chrome.md promises: back on the field when a widget closes, back on the opener when a sheet
// closes, Cancel when a confirm prompt appears, and never trapped inside a surface.
//
// On macOS's default keyboard setting, WebKit moves plain Tab only between form controls and `tabindex` elements,
// skipping buttons; Option+Tab reaches everything. So these specs press Alt+Tab in WebKit, as a Safari keyboard user
// would, and one test pins down what plain Tab reaches there.
import { expect, test } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const tabKey = (browserName: string): string => (browserName === "webkit" ? "Alt+Tab" : "Tab");

/** A short, stable description of whatever has focus, for asserting a Tab order. */
const focusedName = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    if (active.id) return `#${active.id}`;
    return `${active.tagName.toLowerCase()}:${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim()}`;
  });

/** The popover opens once its document has loaded; keys pressed before that go nowhere, as they would for a user. */
const expectPriceFocused = (page: Page): Promise<void> =>
  expect(page.locator(".cms-popover").getByRole("spinbutton", { name: "Price" })).toBeFocused();

const isFocused = async (locator: Locator): Promise<boolean> =>
  (await locator.count()) > 0 && (await locator.evaluate((node) => node === node.ownerDocument.activeElement));

/** Presses Tab (or Shift+Tab) until `target` has focus. Fails if it takes more than `limit` presses. */
async function tabTo(
  page: Page,
  browserName: string,
  target: Locator,
  options: { back?: boolean; limit?: number } = {},
) {
  const key = options.back ? `Shift+${tabKey(browserName)}` : tabKey(browserName);
  const visited: string[] = [];
  for (let presses = 0; presses < (options.limit ?? 40); presses++) {
    if (await isFocused(target)) return;
    await page.keyboard.press(key);
    visited.push(await focusedName(page));
  }
  if (!(await isFocused(target))) {
    throw new Error(`Focus never reached ${target.toString()} by ${key}; it went: ${visited.join(" → ")}`);
  }
}

/** From wherever focus is, Tab to the field and edit its text in place: select all, type, Enter. */
async function editText(page: Page, browserName: string, field: Locator, text: string): Promise<void> {
  await tabTo(page, browserName, field);
  await page.keyboard.press("Enter");
  await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await expect(field).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(field).not.toHaveAttribute("contenteditable");
  await expect(field).toHaveAttribute("data-cms-state", "saved");
  await expect(field).toBeFocused();
}

/** The document's working content: its draft, or the published version when there is no separate draft. */
const draftOf = async (
  demo: { readDoc(key: string): Promise<{ draft: unknown; published: unknown } | null> },
  key: string,
) => {
  const row = await demo.readDoc(key);
  return (row?.draft ?? row?.published ?? {}) as Record<string, unknown>;
};

test.describe("Tab order", () => {
  test("Tab walks every field in page order, then the bar, then leaves the page and comes back", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const order: string[] = [];
    for (let presses = 0; presses < 17; presses++) {
      await page.keyboard.press(tabKey(browserName));
      order.push(await focusedName(page));
    }
    const fields = [
      "#home-title",
      "div:Fresh bread every morning.",
      "#home-live",
      "#home-status",
      "#home-price",
      "#home-tags",
      "#home-date",
      "#home-link",
      "#about-title",
      "#about-body",
      "#site-footer",
    ];
    const bar = ["button:Revisions", "button:Done", "button:Discard", "button:Publish"];
    // After the last control focus leaves the document (the browser's own UI), and the next Tab starts over.
    expect(order).toEqual([...fields, ...bar, "body", "#home-title"]);
  });

  test("Shift+Tab walks the same order backwards", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const publish = page.locator(".cms-bar").getByRole("button", { name: "Publish" });
    await tabTo(page, browserName, publish);
    const order: string[] = [];
    for (let presses = 0; presses < 5; presses++) {
      await page.keyboard.press(`Shift+${tabKey(browserName)}`);
      order.push(await focusedName(page));
    }
    expect(order).toEqual(["button:Discard", "button:Done", "button:Revisions", "#site-footer", "#about-body"]);
  });

  test("in WebKit, plain Tab reaches every field, skipping the bar's buttons on macOS's default setting", async ({
    page,
    demo,
    browserName,
  }) => {
    test.skip(browserName !== "webkit", "WebKit-only platform behaviour");
    await demo.openEditor();
    const order: string[] = [];
    for (let presses = 0; presses < 12; presses++) {
      await page.keyboard.press("Tab");
      order.push(await focusedName(page));
    }
    expect(order.slice(0, 11)).toContain("#site-footer");
    // A macOS keyboard setting, not WebKit: on Linux, plain Tab goes on to the buttons.
    if (process.platform === "darwin") expect(order.every((name) => !name.startsWith("button:"))).toBe(true);
  });

  test("a locked field is reachable and Enter explains why it can't be edited", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const footer = page.locator("#site-footer");
    await tabTo(page, browserName, footer);
    await expect(page.locator(".cms-badge")).toHaveText(/Footer · text · Not editable/);
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-toast")).toContainText("Not editable");
    await expect(footer).not.toHaveAttribute("contenteditable");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(footer).toBeFocused();
  });
});

test.describe("every widget by keyboard", () => {
  test("text: Enter edits in place, Enter commits, focus stays on the field", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#home-title"), "Keyboard title");
    await expect(page.locator("#home-title")).toHaveText("Keyboard title");
    expect((await draftOf(demo, "pages/home"))["title"]).toBe("Keyboard title");
  });

  test("text: Esc restores the text and returns focus to the field", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const field = page.locator("#about-title");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Abandoned");
    await page.keyboard.press("Escape");
    await expect(field).toHaveText("About us");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expect(field).toBeFocused();
    expect((await draftOf(demo, "pages/about"))["title"]).toBe("About us");
  });

  test("richtext: the fallback note shows, Enter commits plain text, focus stays on the field", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor({ richtext: "fallback" });
    const lede = page.locator(".lede");
    await tabTo(page, browserName, lede);
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover--note")).toContainText("Plain text only");
    await expect(lede).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Rye on Sundays.");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(lede).toHaveAttribute("data-cms-state", "saved");
    await expect(lede).toBeFocused();
    // The demo's schema sanitises rich text, which puts loose text in a paragraph.
    expect((await draftOf(demo, "pages/home"))["lede"]).toBe("<p>Rye on Sundays.</p>");
  });

  test("toggle: Enter opens on the switch, Space commits, focus returns to the field", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-live");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const toggle = page.locator(".cms-popover").getByRole("switch", { name: "Open" });
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Space");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("data-cms-state", "saved");
    expect((await draftOf(demo, "pages/home"))["live"]).toBe(false);
  });

  test("select: Enter opens on the select, typing a letter picks and commits, focus returns", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-status");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const select = page.locator(".cms-popover").getByRole("combobox", { name: "Status" });
    await expect(select).toBeFocused();
    await page.keyboard.type("a");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveText("archived");
    expect((await draftOf(demo, "pages/home"))["status"]).toBe("archived");
  });

  test("number: Enter opens on the input, Enter commits, focus returns", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const field = page.locator("#home-price");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const input = page.locator(".cms-popover").getByRole("spinbutton", { name: "Price" });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("12");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("15");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveText("15");
    expect((await draftOf(demo, "pages/home"))["price"]).toBe(15);
  });

  test("date: Enter opens on the input, an arrow key changes it, Enter commits, focus returns", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-date");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const input = page.locator(".cms-popover input[type=date]");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("2026-11-14");
    // Steps whichever date segment has focus (browsers differ on which one that is). A step changes the value without
    // committing ("number, date and url commit on Enter, not on change"); Enter commits.
    await page.keyboard.press("ArrowUp");
    await expect(input).not.toHaveValue("2026-11-14");
    await expect(page.locator(".cms-popover")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("data-cms-state", "saved");
    expect(["2026-12-14", "2026-11-15", "2027-11-14"]).toContain((await draftOf(demo, "pages/home"))["date"]);
  });

  test("url: Enter opens on the input, Enter commits, focus returns", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const field = page.locator("#home-link");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const input = page.locator(".cms-popover").getByRole("textbox", { name: "Menu link" });
    await expect(input).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("https://example.com/new");
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveText("https://example.com/new");
    expect((await draftOf(demo, "pages/home"))["link"]).toBe("https://example.com/new");
  });

  test("tags: Enter adds a chip, a chip's remove button works by keyboard, Enter on empty commits", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-tags");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const popover = page.locator(".cms-popover");
    const input = popover.getByRole("textbox", { name: "Add tag" });
    await expect(input).toBeFocused();
    await page.keyboard.type("fresh");
    await page.keyboard.press("Enter");
    await expect(popover.locator(".cms-chip")).toHaveText([/bakery/, /local/, /fresh/]);
    await expect(input).toHaveValue("");

    const removeLocal = popover.getByRole("button", { name: "Remove local" });
    await tabTo(page, browserName, removeLocal, { back: true, limit: 6 });
    await page.keyboard.press("Enter");
    await expect(popover.locator(".cms-chip")).toHaveText([/bakery/, /fresh/]);
    // Removing a chip moves focus back to the input, so Enter there commits.
    await expect(input).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popover).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveText("bakery, fresh");
    expect((await draftOf(demo, "pages/home"))["tags"]).toEqual(["bakery", "fresh"]);
  });

  test("a popover's Cancel button, reached by Tab, closes it and returns focus to the field", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-link");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    const cancel = page.locator(".cms-popover").getByRole("button", { name: "Cancel" });
    await tabTo(page, browserName, cancel, { limit: 1 });
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    expect((await draftOf(demo, "pages/home"))["link"]).toBe("https://example.com/menu");
  });

  test("Esc after typing in a popover cancels the change and returns focus", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    const field = page.locator("#home-price");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    await expectPriceFocused(page);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("99");
    await page.keyboard.press("Escape");
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveText("12");
    expect((await draftOf(demo, "pages/home"))["price"]).toBe(12);
  });

  test("Tab out of a changed number popover commits it, focus returns to the field and Tab moves on: no trap", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const field = page.locator("#home-price");
    await tabTo(page, browserName, field);
    await page.keyboard.press("Enter");
    await expectPriceFocused(page);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("20");
    // Tab first reaches the popover's Cancel button. Tabbing on out of the popover is leaving it, which commits, and
    // focus goes back to the field.
    await page.keyboard.press(tabKey(browserName));
    await expect(page.locator(".cms-popover").getByRole("button", { name: "Cancel" })).toBeFocused();
    // One press only: the popover closes once focus settles, so a second would land on the field and move past it.
    await page.keyboard.press(tabKey(browserName));
    await expect(page.locator(".cms-popover")).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("data-cms-state", "saved");
    expect((await draftOf(demo, "pages/home"))["price"]).toBe(20);
    await page.keyboard.press(tabKey(browserName));
    await expect(page.locator("#home-tags")).toBeFocused();
  });
});

test.describe("sheets by keyboard", () => {
  test("Publish: Tab to Publish, review the diff, Confirm; focus returns to Publish", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#home-title"), "Published by keyboard");
    const publish = page.locator(".cms-bar").getByRole("button", { name: "Publish" });
    await tabTo(page, browserName, publish);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".cms-diff li[data-path=title]")).toContainText("Published by keyboard");
    // The sheet focuses its first control: Cancel, so Enter straight away is never the destructive choice.
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    const confirm = sheet.locator(".cms-sheet__actions").getByRole("button", { name: "Publish" });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeHidden();
    await expect(publish).toBeFocused();
    await expect
      .poll(async () => (await demo.readDoc("pages/home"))?.published)
      .toMatchObject({
        title: "Published by keyboard",
      });
  });

  test("Publish sheet: Esc closes it and returns focus to Publish", async ({ page, demo, browserName }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#home-title"), "Changed");
    const publish = page.locator(".cms-bar").getByRole("button", { name: "Publish" });
    await tabTo(page, browserName, publish);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(publish).toBeFocused();
    expect((await demo.readDoc("pages/home"))?.published).toMatchObject({ title: "Welcome to the demo" });
  });

  test("Publish sheet: Tab cycles out of the sheet, forwards and backwards (no keyboard trap)", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#home-title"), "Changed");
    const publish = page.locator(".cms-bar").getByRole("button", { name: "Publish" });
    await tabTo(page, browserName, publish);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();

    const insideSheet = () => page.evaluate(() => document.activeElement?.closest(".cms-sheet") !== null);
    let left = false;
    for (let presses = 0; presses < 6 && !left; presses++) {
      await page.keyboard.press(tabKey(browserName));
      left = !(await insideSheet());
    }
    expect(left, "Tab never left the sheet").toBe(true);
    // And it comes round to the page's fields again.
    let onField = false;
    for (let presses = 0; presses < 4 && !onField; presses++) {
      onField = await page.evaluate(() => document.activeElement?.classList.contains("cms-field") === true);
      if (!onField) await page.keyboard.press(tabKey(browserName));
    }
    await expect(page.locator(".cms-field:focus")).toHaveCount(1);

    await tabTo(page, browserName, sheet.getByRole("button", { name: "Close" }));
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    expect(await insideSheet()).toBe(false);
    await expect(publish).toBeFocused();
  });

  test("Revisions: Restore asks first with Cancel focused; Cancel returns to Restore; Confirm restores", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#home-title"), "Draft to throw away");
    const revisions = page.locator(".cms-bar").getByRole("button", { name: "Revisions" });
    await tabTo(page, browserName, revisions);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Revisions" });
    const picker = sheet.getByRole("combobox", { name: "Document" });
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue("pages/home");
    const restore = sheet.getByRole("button", { name: /^Restore revision \d+ into the draft$/ }).first();
    await expect(restore).toBeVisible();

    await tabTo(page, browserName, restore, { limit: 6 });
    await page.keyboard.press("Enter");
    const cancel = sheet.getByRole("button", { name: "Cancel" });
    await expect(sheet).toContainText("The current draft of pages/home will be replaced.");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).not.toContainText("will be replaced");
    await expect(restore).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    const confirm = sheet.getByRole("button", { name: "Confirm" });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#home-title")).toHaveText("Welcome to the demo");
    // After Confirm the drawer reloads and focus goes to the document picker.
    await expect(picker).toBeFocused();
    expect((await draftOf(demo, "pages/home"))["title"]).toBe("Welcome to the demo");

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(revisions).toBeFocused();
  });

  test("Revisions: Unpublish asks first with Cancel focused; Confirm unpublishes", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const revisions = page.locator(".cms-bar").getByRole("button", { name: "Revisions" });
    await tabTo(page, browserName, revisions);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Revisions" });
    await expect(sheet.getByRole("combobox", { name: "Document" })).toBeFocused();
    const unpublish = sheet.getByRole("button", { name: "Unpublish" });
    await tabTo(page, browserName, unpublish, { limit: 3 });
    await page.keyboard.press("Enter");
    await expect(sheet).toContainText("Take pages/home off the live site?");
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(sheet.getByRole("button", { name: "Confirm" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("combobox", { name: "Document" })).toBeFocused();
    await expect.poll(async () => (await demo.readDoc("pages/home"))?.publishedAt).toBeNull();
  });

  test("Discard: Tab to Discard, Cancel is focused first, Confirm discards; focus returns to Discard", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    await editText(page, browserName, page.locator("#about-title"), "Never mind");
    const discard = page.locator(".cms-bar").getByRole("button", { name: "Discard" });
    await tabTo(page, browserName, discard);
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Discard drafts for these documents?" });
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    const confirm = sheet.locator(".cms-sheet__actions").getByRole("button", { name: "Discard" });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeHidden();
    await expect(discard).toBeFocused();
    await expect.poll(async () => (await draftOf(demo, "pages/about"))["title"]).toBe("About us");
  });
});

test.describe("leaving and re-entering", () => {
  test("Done collapses to a focused Edit this page; Enter brings the editor back and Tab reaches the fields", async ({
    page,
    demo,
    browserName,
  }) => {
    await demo.openEditor();
    const done = page.locator(".cms-bar").getByRole("button", { name: "Done" });
    await tabTo(page, browserName, done);
    await page.keyboard.press("Enter");
    const enter = page.getByRole("button", { name: "Edit this page" });
    await expect(page.locator(".cms-bar")).toBeHidden();
    await expect(enter).toBeFocused();
    await expect(page.locator(".cms-field")).toHaveCount(0);
    // While collapsed the fields are plain page content again: Tab skips them.
    await expect(page.locator("#home-title")).not.toHaveAttribute("tabindex");

    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-bar")).toBeVisible();
    await expect(enter).toBeHidden();
    await expect(page.locator(".cms-field")).toHaveCount(11);
    await tabTo(page, browserName, page.locator("#home-title"), { limit: 4 });
    await page.keyboard.press("Enter");
    await expect(page.locator("#home-title")).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  });
});
