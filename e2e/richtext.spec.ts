// `@yl/editor/richtext` in a real browser, under the demo's strict CSP: the toolbar, keyboard, link entry, paste
// options, Cancel and Done, and what the server stores. The demo's `lede` field allows h2 and h3, and its schema runs
// `richText()`, so the stored value is always the sanitised shape. The approved design is
// docs/specs/artefacts/2026-11-richtext-toolbar.html.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";
import type { Editor } from "@tiptap/core";

const HOME = "pages/home";
const SEEDED = "<p>Fresh bread <strong>every morning</strong>.</p>";

const tabKey = (browserName: string): string => (browserName === "webkit" ? "Alt+Tab" : "Tab");

async function expectDraft(demo: Demo, value: unknown): Promise<void> {
  await expect
    .poll(async () => ((await demo.readDoc(HOME))?.draft as Record<string, unknown> | undefined)?.["lede"])
    .toEqual(value);
}

async function expectNoDraft(demo: Demo): Promise<void> {
  expect(((await demo.readDoc(HOME))?.draft as Record<string, unknown> | null)?.["lede"] ?? SEEDED).toBe(SEEDED);
}

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Formatting for Lede" });
const tool = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });

/**
 * Opens the lede with a click and puts the caret at the end of its text. Through the editor's own command: no key does
 * that in every engine (WebKit on macOS ignores Cmd+End).
 */
async function openLede(page: Page): Promise<Locator> {
  const lede = page.locator(".lede");
  await lede.locator("p").click();
  await expect(toolbar(page)).toBeVisible();
  await expect(lede).toBeFocused();
  await lede.evaluate((node) => (node as HTMLElement & { editor: Editor }).editor.commands.focus("end"));
  return lede;
}

/** A paste event carrying `data`, defined on the event because Firefox ignores `clipboardData` in the constructor. */
const paste = (field: Locator, data: Record<string, string>) =>
  field.evaluate((node, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) transfer.setData(type, value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    node.dispatchEvent(event);
  }, data);

test("the toolbar sits just above the field and holds the approved controls", async ({ page, demo }) => {
  await demo.openEditor();
  const lede = await openLede(page);
  const names = await toolbar(page)
    .locator("button:visible")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim()));
  expect(names).toEqual([
    "Bold",
    "Italic",
    "Link",
    "Bulleted list",
    "Numbered list",
    "H2 Heading",
    "H3 Subheading",
    "Cancel",
    "Done",
  ]);
  const field = await lede.boundingBox();
  const bar = await toolbar(page).boundingBox();
  if (!field || !bar) throw new Error("no box");
  const gap = field.y - (bar.y + bar.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(12);
  expect(Math.abs(bar.x - field.x)).toBeLessThan(2);
  for (const button of await toolbar(page).locator("button:visible").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test("bold and a list from the keyboard shortcuts, Done saves the sanitised HTML, and a reload shows it", async ({
  page,
  demo,
}) => {
  await demo.openEditor();
  const lede = await openLede(page);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("Rye");
  await expect(tool(page, "Bold")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" on Sundays");
  await page.keyboard.press("ControlOrMeta+Shift+8");
  await expect(tool(page, "Bulleted list")).toHaveAttribute("aria-pressed", "true");
  await tool(page, "Done").click();

  await expect(toolbar(page)).toHaveCount(0);
  await expectDraft(demo, `${SEEDED}<ul><li><p><strong>Rye</strong> on Sundays</p></li></ul>`);
  await expect(lede).not.toHaveAttribute("contenteditable");
  await expect(lede).toHaveAttribute("tabindex", "0");
  await expect(lede.locator("li strong")).toHaveText("Rye");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
  await expect(page.locator(".lede li strong")).toHaveText("Rye");
});

test("keyboard only: Tab, Enter, Alt+F10 to the toolbar, arrows, a heading, Esc back, Ctrl/Cmd+Enter", async ({
  page,
  demo,
  browserName,
}) => {
  await demo.openEditor();
  const lede = page.locator(".lede");
  for (let presses = 0; presses < 5 && !(await lede.evaluate((node) => node === document.activeElement)); presses++)
    await page.keyboard.press(tabKey(browserName));
  await expect(lede).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toolbar(page)).toBeVisible();
  await expect(lede).toBeFocused();

  await page.keyboard.press("Alt+F10");
  await expect(tool(page, "Bold")).toBeFocused();
  // The tooltip names the shortcut on keyboard focus.
  await expect(toolbar(page).locator(".cms-tooltip")).toHaveText(/^Bold(⌘B|Ctrl\+B)$/);
  await page.keyboard.press("ArrowLeft");
  await expect(tool(page, "Done")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tool(page, "Bold")).toBeFocused();
  for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowRight");
  await expect(tool(page, "H2 Heading")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(lede).toBeFocused();
  await expect(lede.locator("h2")).toHaveText("Fresh bread every morning.");

  await page.keyboard.press("Alt+F10");
  await expect(tool(page, "H2 Heading")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(lede).toBeFocused();
  await expect(toolbar(page)).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toolbar(page)).toHaveCount(0);
  await expect(lede).toBeFocused();
  await expectDraft(demo, "<h2>Fresh bread <strong>every morning</strong>.</h2>");
});

test("Esc in the text and Cancel both put the field back and write nothing", async ({ page, demo }) => {
  await demo.openEditor();
  let lede = await openLede(page);
  await page.keyboard.type(" Gone.");
  await page.keyboard.press("Escape");
  await expect(toolbar(page)).toHaveCount(0);
  await expect(lede).toBeFocused();
  await expect(lede).toHaveText("Fresh bread every morning.");
  await expect(lede.locator("strong")).toHaveText("every morning");

  lede = await openLede(page);
  await page.keyboard.type(" Gone too.");
  await tool(page, "Cancel").click();
  await expect(toolbar(page)).toHaveCount(0);
  await expect(lede).toHaveText("Fresh bread every morning.");
  await expectNoDraft(demo);
});

test("clicking elsewhere on the page commits; clicking the toolbar does not", async ({ page, demo }) => {
  await demo.openEditor();
  const lede = await openLede(page);
  await page.keyboard.type(" Always.");
  await tool(page, "Italic").click();
  await expect(toolbar(page)).toBeVisible();
  await expect(lede).toBeFocused();
  await page.keyboard.type("!");
  await page.locator(".facts dt").first().click();
  await expect(toolbar(page)).toHaveCount(0);
  await expectDraft(demo, "<p>Fresh bread <strong>every morning</strong>. Always.<em>!</em></p>");
});

test("the link row refuses an unsafe address with a visible reason and links a bare domain over https", async ({
  page,
  demo,
}) => {
  await demo.openEditor();
  const lede = await openLede(page);
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("ControlOrMeta+k");
  const address = toolbar(page).getByRole("textbox", { name: "Link address" });
  await expect(address).toBeFocused();
  await expect(tool(page, "Link")).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.type("javascript:alert(1)");
  await page.keyboard.press("Enter");
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expect(toolbar(page).locator(".cms-error")).toHaveText(
    "Use an address that starts with https://, http://, mailto:, tel: or /.",
  );
  await expect(lede.locator("a")).toHaveCount(0);

  await address.fill("example.com");
  await page.keyboard.press("Enter");
  await expect(lede).toBeFocused();
  await expect(lede.locator("a")).toHaveAttribute("href", "https://example.com");
  await tool(page, "Done").click();
  await expectDraft(demo, '<p><a href="https://example.com">Fresh bread <strong>every morning</strong>.</a></p>');
});

test("a formatted paste keeps what the field allows, and Plain text and Keep formatting switch it", async ({
  page,
  demo,
}) => {
  await demo.openEditor();
  const lede = await openLede(page);
  await page.keyboard.press("Enter");
  await paste(lede, {
    "text/html":
      '<p style="color:red">Rye <b>daily</b> <span class="x">and</span> <u>spelt</u><script>alert(1)</script></p>',
    "text/plain": "Rye daily and spelt",
  });
  const options = toolbar(page).getByRole("group", { name: "Paste options" });
  await expect(options).toBeVisible();
  await expect(options).toContainText("Pasted with formatting.");
  await expect(lede.locator("p").last()).toHaveText("Rye daily and spelt");
  await expect(lede.locator("p").last().locator("strong")).toHaveText("daily");
  await expect(lede.locator("u, span, script")).toHaveCount(0);

  // Alt+F10 goes straight to Plain text while the paste options are up.
  await page.keyboard.press("Alt+F10");
  await expect(options.getByRole("button", { name: "Plain text" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(options).toContainText("Pasted as plain text.");
  await expect(lede.locator("p").last().locator("strong")).toHaveCount(0);
  await expect(lede.locator("p").last()).toHaveText("Rye daily and spelt");
  await expect(options.getByRole("button", { name: "Plain text" })).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("ArrowLeft");
  await expect(options.getByRole("button", { name: "Keep formatting" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(lede.locator("p").last().locator("strong")).toHaveText("daily");

  // Back to the text, with the caret after the paste (Keep formatting has no shortcut, so no tooltip to hide first);
  // typing puts the options away.
  await page.keyboard.press("Escape");
  await expect(lede).toBeFocused();
  await page.keyboard.type(".");
  await expect(options).toBeHidden();
  await tool(page, "Done").click();
  await expectDraft(demo, `${SEEDED}<p>Rye <strong>daily</strong> and spelt.</p>`);
});

test("on a narrow screen the toolbar docks to the top of the viewport", async ({ page, demo }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await demo.openEditor();
  await openLede(page);
  const bar = await toolbar(page).boundingBox();
  expect(bar?.y).toBe(0);
  expect(bar?.x).toBe(0);
  expect(Math.round(bar?.width ?? 0)).toBe(375);
});
