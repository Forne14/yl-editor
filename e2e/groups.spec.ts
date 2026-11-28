// Field groups in a real browser (#44). `/?edit=1&groups=1` wraps the hero (title and lede) and the facts list in
// `editable(docKey).group()` wrappers: each is drawn as one dashed outline (`.cms-group__frame`) with a thin dashed line
// (`.cms-group__sep`) between neighbouring fields, and the fields inside lose their own outline. Without the flag the
// page is as before.
import { expect, test, waitForEditor } from "./fixtures.ts";
import type { Page } from "@playwright/test";

const FIELDS = [
  "#home-title",
  ".lede",
  "#home-live",
  "#home-status",
  "#home-price",
  "#home-tags",
  "#home-date",
  "#home-link",
];

/** Console warnings, collected from before the editor loads. */
function collectWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  return warnings;
}

async function openGroups(page: Page): Promise<void> {
  await page.goto("/?edit=1&groups=1");
  await waitForEditor(page);
  await expect(page.locator(".hero")).toHaveClass(/cms-group/);
}

test.describe("field groups", () => {
  test("each group has one dashed frame, the wrapper's box plus the list padding", async ({ page }) => {
    await openGroups(page);
    for (const selector of [".hero", ".facts"]) {
      await expect(page.locator(`${selector} > .cms-group__frame`)).toHaveCount(1);
      const wrapper = await page.locator(selector).boundingBox();
      const frame = await page.locator(`${selector} > .cms-group__frame`).boundingBox();
      if (!wrapper || !frame) throw new Error("no box");
      const pad = await page.locator(`${selector} > .cms-group__frame`).evaluate((node) => {
        const probe = node.ownerDocument.createElement("span");
        probe.style.width = getComputedStyle(node).getPropertyValue("--cms-list-pad");
        node.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      expect(Math.abs(frame.x - (wrapper.x - pad))).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.y - (wrapper.y - pad))).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.width - (wrapper.width + 2 * pad))).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.height - (wrapper.height + 2 * pad))).toBeLessThanOrEqual(1);
      expect(
        await page.locator(`${selector} > .cms-group__frame`).evaluate((node) => getComputedStyle(node).borderTopStyle),
      ).toBe("dashed");
    }
  });

  test("a line is drawn between neighbouring fields, and the fields lose their own outline", async ({ page }) => {
    await openGroups(page);
    await expect(page.locator(".hero .cms-group__sep")).toHaveCount(1);
    // Six facts one under the other: five lines.
    await expect(page.locator(".facts .cms-group__sep")).toHaveCount(5);
    await expect(page.locator(".facts .cms-group__sep--v")).toHaveCount(0);
    for (const selector of FIELDS) {
      expect(await page.locator(selector).evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("none");
    }
    // A field outside any group keeps its own.
    expect(await page.locator("#about-title").evaluate((node) => getComputedStyle(node).outlineStyle)).toBe("dashed");
    // A line sits between the two fields it separates.
    const title = await page.locator("#home-title").boundingBox();
    const lede = await page.locator(".lede").boundingBox();
    const line = await page.locator(".hero .cms-group__sep").boundingBox();
    if (!title || !lede || !line) throw new Error("no box");
    expect(line.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(line.y).toBeLessThanOrEqual(lede.y + 1);
  });

  test("no two dashed outlines cross, on the page or after a resize", async ({ page }) => {
    const warnings = collectWarnings(page);
    await openGroups(page);
    for (const width of [1280, 700, 400]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
    }
    expect(warnings.filter((text) => text.includes("cross"))).toEqual([]);
  });

  test("Tab still visits each field, and nothing the chrome drew in the group", async ({ page }) => {
    await openGroups(page);
    for (const selector of FIELDS) {
      await page.keyboard.press("Tab");
      await expect(page.locator(selector)).toBeFocused();
    }
    expect(
      await page
        .locator(".cms-group__frame, .cms-group__sep")
        .evaluateAll((nodes) => nodes.map((node) => node.tabIndex)),
    ).not.toContain(0);
  });

  test("Done takes every node and class the groups added back out", async ({ page }) => {
    await openGroups(page);
    await page.locator(".cms-bar").getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Edit this page" })).toBeVisible();
    await expect(page.locator(".cms-group, .cms-group__frame, .cms-group__sep")).toHaveCount(0);
    await expect(page.locator(".hero")).not.toHaveClass(/cms-group/);
    // Editing again draws them afresh, once.
    await page.getByRole("button", { name: "Edit this page" }).click();
    await expect(page.locator(".hero > .cms-group__frame")).toHaveCount(1);
  });

  test("without the flag the page has no groups", async ({ demo, page }) => {
    await demo.openEditor();
    await expect(page.locator(".cms-group, [data-edit-group]")).toHaveCount(0);
  });
});
