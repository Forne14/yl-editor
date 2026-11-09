// A press on the page's own scrollbar, which has the root as its target. Its own file because `launchOptions` forces a
// new worker: Playwright hides scrollbars in headless Chromium, and this brings them back.
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 800, height: 300 }, launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("a press on the root scrollbar leaves the popover open and commits nothing", async ({ page, demo }) => {
  await demo.openEditor();
  const width = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);
  test.skip(width === 0, "overlay scrollbars here: nothing a pointer can be aimed at");
  await page.locator("#home-price").click();
  const input = page.locator(".cms-popover:not(.cms-popover--note) input");
  await expect(input).toBeFocused();
  await input.fill("20");
  await page.mouse.click(800 - Math.ceil(width / 2), 150);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("20");
  expect(await demo.changes()).toEqual([]);
});
