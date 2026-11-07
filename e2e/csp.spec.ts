// The chrome positions its badge and popovers only through custom properties set with `style.setProperty`, which a
// strict `style-src 'self'` allows. These prove it in a real browser: the surfaces land next to their field, not at 0,0.
import { expect, test } from "./fixtures.ts";
import type { Locator } from "@playwright/test";

const box = async (locator: Locator) => {
  const result = await locator.boundingBox();
  if (!result) throw new Error("element has no box");
  return result;
};

test("the badge sits just above the hovered field", async ({ page, demo }) => {
  await demo.openEditor();
  const field = page.locator("#about-title");
  await field.hover();
  const badge = page.locator(".cms-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("About heading · text");

  const fieldBox = await box(field);
  const badgeBox = await box(badge);
  expect(Math.abs(badgeBox.x - fieldBox.x)).toBeLessThan(2);
  // Lifted by its own height plus one spacing step, so its bottom edge sits a few pixels above the field.
  const gap = fieldBox.y - (badgeBox.y + badgeBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(12);
  expect(badgeBox.y).toBeGreaterThan(20);
});

test("the badge follows keyboard focus to another field", async ({ page, demo }) => {
  await demo.openEditor();
  await page.locator("#home-title").hover();
  await page.mouse.move(0, 0);
  const field = page.locator("#home-price");
  await field.focus();
  const badge = page.locator(".cms-badge");
  await expect(badge).toHaveText("Price · number");

  const fieldBox = await box(field);
  const badgeBox = await box(badge);
  expect(Math.abs(badgeBox.x - fieldBox.x)).toBeLessThan(2);
  const gap = fieldBox.y - (badgeBox.y + badgeBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(12);
});

test("a popover widget opens under its field, from the stored value", async ({ page, demo }) => {
  await demo.openEditor();
  const field = page.locator("#home-status");
  await field.click();
  const popover = page.locator(".cms-popover");
  await expect(popover).toBeVisible();
  await expect(popover.locator("select")).toHaveValue("live");

  const fieldBox = await box(field);
  const popoverBox = await box(popover);
  expect(Math.abs(popoverBox.x - fieldBox.x)).toBeLessThan(2);
  // One spacing step (8px) under the field's bottom edge.
  const gap = popoverBox.y - (fieldBox.y + fieldBox.height);
  expect(gap).toBeGreaterThanOrEqual(4);
  expect(gap).toBeLessThan(16);

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(field).toBeFocused();
});

test("a popover stays under its field on a scrolled page", async ({ page, demo }) => {
  await page.setViewportSize({ width: 1024, height: 360 });
  await demo.openEditor();
  const field = page.locator("#home-link");
  await field.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 40));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await field.click();
  const popover = page.locator(".cms-popover");
  await expect(popover).toBeVisible();
  await expect(popover.locator("input")).toHaveValue("https://example.com/menu");

  const fieldBox = await box(field);
  const popoverBox = await box(popover);
  expect(Math.abs(popoverBox.x - fieldBox.x)).toBeLessThan(2);
  const gap = popoverBox.y - (fieldBox.y + fieldBox.height);
  expect(gap).toBeGreaterThanOrEqual(4);
  expect(gap).toBeLessThan(16);
});
