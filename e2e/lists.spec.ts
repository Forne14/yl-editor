// Keyed lists in a real browser (#28): `/?edit=1&lists=1` renders the team list (`pages/team:team`, max 4, Duplicate on).
// Keyboard only: reach an item's toolbar, move, remove, undo, add and type; the stored draft follows. Touch: the chip
// opens the toolbar. axe over the list chrome, light and dark. The guard fails any test that trips the strict CSP.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Demo } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const TEAM = "pages/team";

const names = (page: Page) => page.locator("#team-list .team__name").allTextContents();

async function expectTeam(demo: Demo, expected: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const draft = (await demo.readDoc(TEAM))?.draft as { team?: { name: string }[] } | undefined;
      return draft?.team?.map((member) => member.name);
    })
    .toEqual(expected);
}

const shiftTab = (browserName: string) => (browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");

test.describe("a keyed list", () => {
  test("keyboard only: move, remove, undo, add", async ({ page, demo, browserName }) => {
    await demo.openEditor({ lists: true });
    await expect(page.locator("#team-list .cms-list__tag")).toHaveText("Team · 2 of 4");

    // The toolbar comes before the item's fields: one Shift+Tab from Ana's name reaches it.
    await page.locator("#team-list .team__name").first().focus();
    await page.keyboard.press(shiftTab(browserName));
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", "Move Ana up");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", "Move Ana down");
    await page.keyboard.press("Enter");
    await expect.poll(() => names(page)).toEqual(["Ben", "Ana"]);
    await expectTeam(demo, ["Ben", "Ana"]);
    await expect(page.locator(".cms-live")).toHaveText("Ana moved to position 2 of 2.");
    // Ana is last now, so focus took the move that still works.
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", "Move Ana up");

    await page.keyboard.press("End");
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", "Remove Ana");
    await page.keyboard.press("Enter");
    await expect.poll(() => names(page)).toEqual(["Ben"]);
    await expectTeam(demo, ["Ben"]);
    await expect(page.locator(".cms-toast")).toContainText("Removed Ana.");

    await page.keyboard.press("Control+z");
    await expect.poll(() => names(page)).toEqual(["Ben", "Ana"]);
    await expectTeam(demo, ["Ben", "Ana"]);

    await page.locator("#team-list .cms-list__add-button").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => names(page)).toEqual(["Ben", "Ana", "New member"]);
    const added = page.locator("#team-list .team__name").nth(2);
    await expect(added).toBeFocused();
    await page.keyboard.type("Cleo");
    await page.keyboard.press("Enter");
    await expectTeam(demo, ["Ben", "Ana", "Cleo"]);
  });

  test("at the maximum Add says why and writes nothing", async ({ page, demo }) => {
    await demo.openEditor({ lists: true });
    const add = page.locator("#team-list .cms-list__add-button");
    for (const count of [3, 4]) {
      await add.click();
      await expect(page.locator("#team-list .team__member")).toHaveCount(count);
      await page.keyboard.press("Escape");
    }
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#team-list .cms-list__reason")).toHaveText(
      "Maximum of 4 members. Remove one to add another.",
    );
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".cms-live")).toHaveText("Maximum of 4 members. Remove one to add another.");
    await expect(page.locator("#team-list .team__member")).toHaveCount(4);
  });

  test("the list chrome passes axe, light and dark", async ({ page, demo }) => {
    await demo.openEditor({ lists: true });
    await page.locator("#team-list .team__member").nth(1).hover();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const { violations } = await new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .include("#team-list")
        .analyze();
      expect(violations.map((violation) => `[${colorScheme}] ${violation.id}`)).toEqual([]);
    }
  });
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("each item's chip opens its toolbar", async ({ page, demo, browserName }) => {
    // Firefox has no touch emulation that turns off hover, so `(hover: none)` never matches there.
    test.skip(browserName === "firefox", "no hover: none emulation");
    await demo.openEditor({ lists: true });
    const hoverless = await page.evaluate(() => matchMedia("(hover: none)").matches);
    test.skip(!hoverless, "this engine still reports hover with touch on");
    const chip = page.locator("#team-list .cms-item__chip").nth(1);
    await expect(chip.locator(".cms-item__chip-closed")).toBeVisible();
    await expect(chip.locator(".cms-item__chip-closed")).toHaveText("⋯ 2 of 2");
    await expect(page.locator("#team-list .cms-item__remove").nth(1)).toBeHidden();
    await chip.tap();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await page.locator("#team-list .cms-item__remove").nth(1).tap();
    await expectTeam(demo, ["Ana"]);
  });
});
