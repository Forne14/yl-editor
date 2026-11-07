// Real focus and blur order, which happy-dom can't prove: when a text edit or a popover commits, cancels, and where
// focus goes after. WebKit matters most here: clicking a <button> doesn't focus it, so a focusout's relatedTarget is
// null and only paths that don't depend on it commit. Also keyboard-only operation of every widget, the visible focus
// ring, and popovers as bottom sheets under 40em.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const HOME = "pages/home";

async function expectDraft(demo: Demo, path: string, value: unknown): Promise<void> {
  await expect
    .poll(async () => ((await demo.readDoc(HOME))?.draft as Record<string, unknown> | undefined)?.[path])
    .toEqual(value);
}

/** No field write reached the server. Checked after the UI has settled, so a late write would already be recorded. */
async function expectNoWrites(demo: Demo): Promise<void> {
  expect(await demo.changes()).toEqual([]);
  expect((await demo.readDoc(HOME))?.draftPayload).toBeNull();
}

const popover = (page: Page) => page.locator(".cms-popover:not(.cms-popover--note)");
const bar = (page: Page) => page.locator(".cms-bar");
/** Somewhere on the page that is neither a field nor focusable. */
const plainText = (page: Page) => page.locator(".facts dt").first();

test.describe("text fields", () => {
  test("commit on blur when the user clicks elsewhere on the page", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.type(" today");
    await plainText(page).click();
    await expect(field).not.toHaveAttribute("contenteditable");
    await expectDraft(demo, "title", "Welcome to the demo today");
  });

  test("commit on Enter and keep focus on the field", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.type(" today");
    await page.keyboard.press("Enter");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expect(field).toBeFocused();
    await expect(field).toHaveText("Welcome to the demo today");
    await expectDraft(demo, "title", "Welcome to the demo today");
  });

  test("Esc cancels, restores the original text and writes nothing", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.press("Backspace");
    await page.keyboard.type("XYZ");
    await expect(field).toHaveText("Welcome to the demXYZ");
    await page.keyboard.press("Escape");
    await expect(field).toHaveText("Welcome to the demo");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expect(field).toBeFocused();
    // Leaving after the cancel must not resurrect the edit.
    await plainText(page).click();
    await expectNoWrites(demo);
  });

  test("Esc on the rich text fallback restores the original markup", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator(".lede");
    await field.click();
    await page.keyboard.type(" Always.");
    await page.keyboard.press("Escape");
    await expect(field.locator("strong")).toHaveText("every morning");
    await expect(field).toHaveText("Fresh bread every morning.");
    await expect(page.locator(".cms-popover--note")).toHaveCount(0);
    await expectNoWrites(demo);
  });

  test("clicking Publish while a text edit is open commits it first", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-title");
    await field.click();
    await page.keyboard.type(" today");
    await bar(page).getByRole("button", { name: "Publish" }).click();
    const sheet = page.locator(".cms-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("pages/home");
    await expect(sheet).toContainText("Welcome to the demo today");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expectDraft(demo, "title", "Welcome to the demo today");
  });

  test("opening another field while a text edit is open commits it", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-title").click();
    await page.keyboard.type(" today");
    await page.locator("#home-price").click();
    await expect(popover(page).getByRole("spinbutton", { name: "Price" })).toBeFocused();
    await expect(page.locator("#home-title")).not.toHaveAttribute("contenteditable");
    await expectDraft(demo, "title", "Welcome to the demo today");
  });
});

test.describe("popover widgets", () => {
  test("focus returns to the field after a commit, Cancel and Esc", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-live");

    await field.click();
    await popover(page).getByRole("switch").click();
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();

    await page.locator("#about-title").focus();
    await field.click();
    await popover(page).getByRole("button", { name: "Cancel" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();

    await page.locator("#about-title").focus();
    await field.click();
    await expect(popover(page).getByRole("switch")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "live", false);
  });

  test("Cancel writes nothing although the control was changed", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await expect(popover(page).getByRole("textbox", { name: "Add tag" })).toBeFocused();
    await page.keyboard.type("rye");
    await popover(page).getByRole("button", { name: "Cancel" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-tags")).toBeFocused();
    await expect(page.locator("#home-tags")).toHaveText("bakery, local");
    await plainText(page).click();
    await expectNoWrites(demo);
  });

  test("Done commits and returns focus to the field", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await expect(popover(page).getByRole("textbox", { name: "Add tag" })).toBeFocused();
    await page.keyboard.type("rye");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-tags")).toBeFocused();
    await expect(page.locator("#home-tags")).toHaveText("bakery, local, rye");
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("clicking inside the popover, off its controls, keeps it open and commits nothing", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await page.keyboard.type("rye");
    await popover(page).locator(".cms-popover__title").click();
    await expect(popover(page)).toBeVisible();
    expect(await demo.changes()).toEqual([]);
    await popover(page).getByRole("textbox", { name: "Add tag" }).press("Enter");
    await expect(popover(page).locator(".cms-chip")).toHaveCount(3);
  });

  test("opening another field commits the open popover", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await page.keyboard.type("rye");
    await page.locator("#home-price").click();
    await expect(popover(page).getByRole("spinbutton", { name: "Price" })).toBeFocused();
    await expect(popover(page)).toHaveCount(1);
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("opening a text field commits the open popover", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await page.keyboard.type("rye");
    await page.locator("#home-title").click();
    await expect(page.locator("#home-title")).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("clicking a bar button commits the open popover", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await page.keyboard.type("rye");
    await bar(page).getByRole("button", { name: "Publish" }).click();
    await expect(page.locator(".cms-sheet")).toBeVisible();
    await expect(page.locator(".cms-sheet")).toContainText("pages/home");
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("clicking elsewhere on the page commits the open popover", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    // The popover opens once its document has loaded; keys pressed before that go nowhere, as they would for a user.
    await expect(popover(page).getByRole("textbox", { name: "Add tag" })).toBeFocused();
    await page.keyboard.type("rye");
    await plainText(page).click();
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("Cancel after typing a number writes nothing", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-price").click();
    await popover(page).getByRole("spinbutton", { name: "Price" }).fill("30");
    await popover(page).getByRole("button", { name: "Cancel" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-price")).toBeFocused();
    await expect(page.locator("#home-price")).toHaveText("12");
    await expectNoWrites(demo);
  });

  test("a number typed and left by clicking elsewhere is saved", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-price").click();
    await popover(page).getByRole("spinbutton", { name: "Price" }).fill("20");
    await plainText(page).click();
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "price", 20);
  });
});

test.describe("keyboard only", () => {
  test("Tab reaches the first field, which shows a visible focus ring", async ({ page, demo }) => {
    await demo.openEditor();
    await page.keyboard.press("Tab");
    const field = page.locator("#home-title");
    await expect(field).toBeFocused();
    expect(await field.evaluate((node) => node.matches(":focus-visible"))).toBe(true);
    const outline = await field.evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).not.toBe("0px");
  });

  test("Tab moves through the fields in page order", async ({ page, demo }) => {
    await demo.openEditor();
    const order = [
      "#home-title",
      ".lede",
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
    for (const selector of order) {
      await page.keyboard.press("Tab");
      await expect(page.locator(selector)).toBeFocused();
      expect(await page.locator(selector).evaluate((node) => node.matches(":focus-visible"))).toBe(true);
    }
  });

  test("text: Enter opens, typing edits, Enter commits", async ({ page, demo }) => {
    await demo.openEditor();
    await page.keyboard.press("Tab");
    const field = page.locator("#home-title");
    await expect(field).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    await page.keyboard.type(" today");
    await page.keyboard.press("Enter");
    await expect(field).not.toHaveAttribute("contenteditable");
    await expect(field).toBeFocused();
    await expectDraft(demo, "title", "Welcome to the demo today");
  });

  test("toggle: Enter opens, Space flips and commits", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-live");
    await field.focus();
    await page.keyboard.press("Enter");
    const toggle = popover(page).getByRole("switch");
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Space");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "live", false);
  });

  test("select: Enter opens, a typed letter picks an option and commits", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-status");
    await field.focus();
    await page.keyboard.press("Enter");
    const select = popover(page).getByRole("combobox", { name: "Status" });
    await expect(select).toBeFocused();
    await page.keyboard.press("a");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "status", "archived");
  });

  test("number: Enter opens, typing replaces, Enter commits", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-price");
    await field.focus();
    await page.keyboard.press("Enter");
    const input = popover(page).getByRole("spinbutton", { name: "Price" });
    await expect(input).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("14");
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "price", 14);
  });

  test("number: ArrowUp steps the value twice, Enter saves it", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-price");
    await field.focus();
    await page.keyboard.press("Enter");
    await expect(popover(page).getByRole("spinbutton", { name: "Price" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(popover(page).getByRole("spinbutton", { name: "Price" })).toHaveValue("14");
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "price", 14);
  });

  test("tags: Enter opens, Enter adds a tag, Enter on empty commits", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-tags");
    await field.focus();
    await page.keyboard.press("Enter");
    await expect(popover(page).getByRole("textbox", { name: "Add tag" })).toBeFocused();
    await page.keyboard.type("rye");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "tags", ["bakery", "local", "rye"]);
  });

  test("date: Enter opens, arrow keys change two segments, Enter saves", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-date");
    await field.focus();
    await page.keyboard.press("Enter");
    const input = popover(page).locator('input[type="date"]');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("2026-11-14");
    // Steps the first segment, moves to the second and steps it. Day and month come first in either order in the
    // engines' default locales, so the result doesn't depend on the machine's date format.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await expect(input).toHaveValue("2026-12-15");
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "date", "2026-12-15");
  });

  test("url: Enter opens, typing replaces, Enter commits", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-link");
    await field.focus();
    await page.keyboard.press("Enter");
    await expect(popover(page).getByRole("textbox", { name: "Menu link" })).toBeFocused();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("https://example.com/spring");
    await page.keyboard.press("Enter");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expectDraft(demo, "link", "https://example.com/spring");
  });

  test("Esc cancels every popover widget after a keyboard change, writing nothing", async ({ page, demo }) => {
    await demo.openEditor();
    const cases: [string, string][] = [
      ["#home-price", "99"],
      ["#home-tags", "rye"],
      ["#home-link", "https://example.com/other"],
      ["#home-live", ""],
      ["#home-status", ""],
      ["#home-date", ""],
    ];
    for (const [selector, typed] of cases) {
      const field = page.locator(selector);
      await field.focus();
      await page.keyboard.press("Enter");
      await expect(popover(page)).toBeVisible();
      await expect(popover(page).locator("input, select").first()).toBeFocused();
      if (typed) {
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(typed);
      }
      await page.keyboard.press("Escape");
      await expect(popover(page)).toHaveCount(0);
      await expect(field).toBeFocused();
    }
    await expectNoWrites(demo);
  });

  test("Enter on a locked field explains why and opens nothing", async ({ page, demo }) => {
    await demo.openEditor();
    const footer = page.locator("#site-footer");
    await footer.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-toast")).toContainText("Not editable");
    await expect(footer).not.toHaveAttribute("contenteditable");
    await expect(footer).toBeFocused();
  });
});

test.describe("under 40em popovers are bottom sheets", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  async function expectBottomSheet(page: Page): Promise<void> {
    const sheet = popover(page);
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
    const box = await sheet.boundingBox();
    if (!box) throw new Error("popover has no box");
    expect(box.x).toBe(0);
    expect(box.width).toBe(375);
    expect(Math.abs(box.y + box.height - 700)).toBeLessThan(1);
  }

  test("a select opens as a bottom sheet and saves", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-status").click();
    await expectBottomSheet(page);
    await popover(page).getByRole("combobox", { name: "Status" }).selectOption("draft");
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "status", "draft");
  });

  test("the toggle in a bottom sheet takes a click, above the bar", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-live").click();
    await expectBottomSheet(page);
    await popover(page).getByRole("switch").click();
    await expect(popover(page)).toHaveCount(0);
    await expectDraft(demo, "live", false);
  });

  test("tags in a bottom sheet: chips, remove and Done take clicks", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await expectBottomSheet(page);
    await popover(page).getByRole("button", { name: "Remove local" }).click();
    await expect(popover(page).getByRole("textbox", { name: "Add tag" })).toBeFocused();
    await page.keyboard.type("rye");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-tags")).toBeFocused();
    await expectDraft(demo, "tags", ["bakery", "rye"]);
  });

  test("Cancel in a bottom sheet takes a click and writes nothing", async ({ page, demo }) => {
    await demo.openEditor();
    await page.locator("#home-price").click();
    await expectBottomSheet(page);
    await popover(page).getByRole("spinbutton", { name: "Price" }).fill("30");
    await popover(page).getByRole("button", { name: "Cancel" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.locator("#home-price")).toBeFocused();
    await expectNoWrites(demo);
  });

  test("a bottom sheet works by keyboard: Enter opens, Esc cancels", async ({ page, demo }) => {
    await demo.openEditor();
    const field = page.locator("#home-link");
    await field.focus();
    await page.keyboard.press("Enter");
    await expectBottomSheet(page);
    await expect(popover(page).getByRole("textbox", { name: "Menu link" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(field).toBeFocused();
  });
});
