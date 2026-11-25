// Lists laid out in a row or a grid, and dragging, in a real browser (#43, ruling D10 on #28). `/?edit=1&rowlist=1`
// renders the crew (`pages/crew:crew`, four members): a flex row at the default 1280px viewport that wraps into two
// lines of two below ~30rem. `/?edit=1&lists=1` is the team column. The chrome reads the axis from the items' boxes and
// puts `cms-list--row` or `cms-list--grid` on the list; each item's band (`.cms-item__band`) carries `--top` and
// `--left` classes that turn into dashed borders.
import { expect, test, type Demo } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const CREW = "pages/crew";
const TEAM = "pages/team";

const crewNames = (page: Page) => page.locator("#crew-list .crew__name").allTextContents();
const member = (page: Page, index: number) => page.locator("#crew-list .crew__member").nth(index);

async function expectDraft(demo: Demo, key: string, field: "crew" | "team", expected: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const draft = (await demo.readDoc(key))?.draft as Record<string, { name: string }[] | undefined> | undefined;
      return draft?.[field]?.map((entry) => entry.name);
    })
    .toEqual(expected);
}

/** Which of an item's cell borders are drawn: the computed styles, so a missing rule or class shows. */
async function borders(item: Locator): Promise<{ top: boolean; left: boolean }> {
  return item.evaluate((node) => {
    const band = [...node.children].find((child) => child.classList.contains("cms-item__band"));
    if (!band) throw new Error("no band");
    const style = getComputedStyle(band);
    return { top: style.borderTopStyle === "dashed", left: style.borderLeftStyle === "dashed" };
  });
}

async function box(node: Locator) {
  const found = await node.boundingBox();
  if (!found) throw new Error("not visible");
  return found;
}

test.describe("a list laid out sideways", () => {
  test("a row has vertical lines between items, none between lines", async ({ page, demo }) => {
    await demo.openEditor({ rowlist: true });
    const list = page.locator("#crew-list");
    await expect(list).toHaveClass(/cms-list--row/);
    await expect(list).not.toHaveClass(/cms-list--grid/);
    await expect(page.locator("#crew-list .crew__member")).toHaveCount(4);

    expect(await borders(member(page, 0))).toEqual({ top: false, left: false });
    for (const index of [1, 2, 3]) expect(await borders(member(page, index))).toEqual({ top: false, left: true });

    // Each cell's left line sits between its item and the one before it, and every cell spans the same height.
    const bands = page.locator("#crew-list > .crew__member > .cms-item__band");
    const first = await box(member(page, 0));
    for (const index of [1, 2, 3]) {
      const before = await box(member(page, index - 1));
      const item = await box(member(page, index));
      const band = await box(bands.nth(index));
      expect(band.x).toBeGreaterThanOrEqual(before.x + before.width - 1);
      expect(band.x).toBeLessThanOrEqual(item.x + 1);
      expect(Math.abs(band.y - (await box(bands.first())).y)).toBeLessThanOrEqual(1);
      expect(Math.abs(band.height - (await box(bands.first())).height)).toBeLessThanOrEqual(1);
    }
    // All four items share one line.
    for (const index of [1, 2, 3]) expect(Math.abs((await box(member(page, index))).y - first.y)).toBeLessThan(2);

    // The Add row is a line of its own, under the items: it gets the line above it.
    const add = page.locator("#crew-list > .cms-list__add > .cms-item__band");
    expect(await add.evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe("dashed");
    expect(await add.evaluate((node) => getComputedStyle(node).borderLeftStyle)).toBe("none");
  });

  test("a row that wraps becomes a grid, and goes back to a row when the page widens", async ({ page, demo }) => {
    await demo.openEditor({ rowlist: true });
    const list = page.locator("#crew-list");
    await expect(list).toHaveClass(/cms-list--row/);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(list).toHaveClass(/cms-list--grid/);
    await expect(list).not.toHaveClass(/cms-list--row/);
    // Two items per line: the first of each line has no left line, the second line's items have the line above.
    expect(await borders(member(page, 0))).toEqual({ top: false, left: false });
    expect(await borders(member(page, 1))).toEqual({ top: false, left: true });
    expect(await borders(member(page, 2))).toEqual({ top: true, left: false });
    expect(await borders(member(page, 3))).toEqual({ top: true, left: true });
    // The second line's top line is shared: its cells start at the same height, below the first line's items.
    const bands = page.locator("#crew-list > .crew__member > .cms-item__band");
    const upper = await box(member(page, 0));
    const second = await box(bands.nth(2));
    const third = await box(bands.nth(3));
    expect(Math.abs(second.y - third.y)).toBeLessThanOrEqual(1);
    expect(second.y).toBeGreaterThanOrEqual(upper.y + upper.height - 1);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(list).toHaveClass(/cms-list--row/);
    expect(await borders(member(page, 2))).toEqual({ top: false, left: true });
  });

  test("the toolbar sits at the top left of an item in a row", async ({ page, demo }) => {
    await demo.openEditor({ rowlist: true });
    await expect(page.locator("#crew-list")).toHaveClass(/cms-list--row/);
    const item = member(page, 1);
    await item.hover();
    const tools = item.locator(".cms-item__tools");
    await expect(tools).toBeVisible();
    const where = await box(tools);
    const cell = await box(item);
    // Left of the item's own box side by side with its start, not at the outline's right edge.
    expect(where.x).toBeLessThan(cell.x + cell.width / 2);
    expect(where.x + where.width).toBeLessThan((await box(member(page, 3))).x);
  });

  test("dragging a handle along a row writes the new order and announces it", async ({ page, demo }) => {
    await demo.openEditor({ rowlist: true });
    await expect(page.locator("#crew-list")).toHaveClass(/cms-list--row/);
    const first = member(page, 0);
    await first.hover();
    const grip = first.locator(".cms-item__grip");
    await grip.hover();
    const start = await box(grip);
    // To the right half of the last item, on the items' line: past every other item's middle, so Ana goes last.
    const last = await box(member(page, 3));
    const line = await box(first);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 4, line.y + line.height / 2, { steps: 15 });
    // By key: `first` now resolves to whichever item leads, and Ana has already moved.
    const ana = page.locator('#crew-list [data-edit-item="pages/crew:crew[_key=ana]"]');
    await expect(ana).toHaveClass(/cms-item--dragging/);
    await page.mouse.up();
    await expect.poll(() => crewNames(page)).toEqual(["Ben", "Cleo", "Dee", "Ana"]);
    await expectDraft(demo, CREW, "crew", ["Ben", "Cleo", "Dee", "Ana"]);
    await expect(page.locator(".cms-live")).toHaveText("Ana moved to position 4 of 4.");
  });

  test("Arrow Down on the handle moves the item and keeps focus on its handle", async ({ page, demo }) => {
    await demo.openEditor({ rowlist: true });
    await member(page, 0).locator(".cms-item__grip").focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => crewNames(page)).toEqual(["Ben", "Ana", "Cleo", "Dee"]);
    await expectDraft(demo, CREW, "crew", ["Ben", "Ana", "Cleo", "Dee"]);
    await expect(page.locator(".cms-live")).toHaveText("Ana moved to position 2 of 4.");
    await expect(page.locator(":focus")).toHaveAttribute("aria-label", /^Drag to reorder Ana/);
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => crewNames(page)).toEqual(["Ana", "Ben", "Cleo", "Dee"]);
    await expectDraft(demo, CREW, "crew", ["Ana", "Ben", "Cleo", "Dee"]);
  });
});

test.describe("a column list", () => {
  test("keeps its horizontal lines only", async ({ page, demo }) => {
    await demo.openEditor({ lists: true });
    const items = page.locator("#team-list .team__member");
    await expect(items).toHaveCount(2);
    const list = page.locator("#team-list");
    await expect(list).not.toHaveClass(/cms-list--row|cms-list--grid/);
    expect(await borders(items.nth(0))).toEqual({ top: false, left: false });
    expect(await borders(items.nth(1))).toEqual({ top: true, left: false });
  });

  test("dragging a handle down a column writes the new order and announces it", async ({ page, demo }) => {
    await demo.openEditor({ lists: true });
    const items = page.locator("#team-list .team__member");
    await items.first().hover();
    const grip = items.first().locator(".cms-item__grip");
    await grip.hover();
    const start = await box(grip);
    // The lower half of the second item: below its middle, so Ana goes after Ben.
    const second = await box(items.nth(1));
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(second.x + second.width / 2, second.y + second.height - 2, { steps: 15 });
    // The press drags the item, not a text selection across the names it passes.
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.mouse.up();
    await expect.poll(() => page.locator("#team-list .team__name").allTextContents()).toEqual(["Ben", "Ana"]);
    await expectDraft(demo, TEAM, "team", ["Ben", "Ana"]);
    await expect(page.locator(".cms-live")).toHaveText("Ana moved to position 2 of 2.");
  });
});

test.describe("dragging by touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  // A real touch: the browser captures it to the handle, and the list's capture takes it over. Only Chromium can send
  // one (CDP `Input.dispatchTouchEvent`); elsewhere `page.mouse` is a mouse, which the tests above already cover.
  test("a touch drag down a column writes the new order and announces it", async ({ page, demo, browserName }) => {
    test.skip(browserName !== "chromium", "touch input needs CDP");
    await demo.openEditor({ lists: true });
    const items = page.locator("#team-list .team__member");
    await expect(items).toHaveCount(2);
    const grip = items.first().locator(".cms-item__grip");
    // With no hover the toolbar shows only once the item's chip is open.
    if (await page.evaluate(() => matchMedia("(hover: none)").matches)) {
      const chip = items.first().locator(".cms-item__chip");
      await chip.tap();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
    }
    await expect(grip).toBeVisible();
    const start = await box(grip);
    // The lower half of the second item: below its middle, so Ana goes after Ben.
    const second = await box(items.nth(1));
    const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const to = { x: second.x + second.width / 2, y: second.y + second.height - 4 };

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: point ? [{ x: Math.round(point.x), y: Math.round(point.y), id: 1 }] : [],
      });
    await touch("touchStart", from);
    const steps = 15;
    for (let step = 1; step <= steps; step += 1) {
      await touch("touchMove", {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      });
    }
    // Still dragging after every move: the capture's hand-over at the first one didn't cancel it.
    const ana = page.locator('#team-list [data-edit-item="pages/team:team[_key=ana]"]');
    await expect(ana).toHaveClass(/cms-item--dragging/);
    await touch("touchEnd");
    await cdp.detach();

    await expect.poll(() => page.locator("#team-list .team__name").allTextContents()).toEqual(["Ben", "Ana"]);
    await expectDraft(demo, TEAM, "team", ["Ben", "Ana"]);
    await expect(page.locator(".cms-live")).toHaveText("Ana moved to position 2 of 2.");
    await expect(ana).not.toHaveClass(/cms-item--dragging/);
  });
});
