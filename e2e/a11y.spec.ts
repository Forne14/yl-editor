// WCAG 2.2 AA checks of the chrome in a real browser, under the demo's strict CSP (never `bypassCSP`):
//
// - axe-core over the chrome's surfaces (`.cms-root`, which popovers appended to <body> carry too) and the highlighted
//   `.cms-field`s, in every state the chrome can be in, light and dark, at desktop width and at 375px;
// - visible focus (2.4.7), its contrast against what it is drawn on (1.4.11, 3:1), focus not hidden behind the fixed
//   bar or toast (2.4.11) and target size (2.5.8, 24px; the chrome documents 44px) for every Tab stop;
// - reduced motion: transitions are opacity-only.
//
// axe is injected with `page.evaluate`, which no CSP governs, and the guard (fixtures.ts) would fail any test where it
// tripped one. It runs in legacy mode, so it never opens a second page in the context while a widget holds focus.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Demo, type Guard } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SCHEMES = ["light", "dark"] as const;

const tabKey = (browserName: string): string => (browserName === "webkit" ? "Alt+Tab" : "Tab");

/** axe over the chrome only (not the demo page around it), one line per failing node. */
async function axeChrome(page: Page): Promise<string[]> {
  let builder = new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS).include(".cms-root");
  if ((await page.locator(".cms-field").count()) > 0) builder = builder.include(".cms-field");
  const { violations } = await builder.analyze();
  return violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id} on ${node.target.join(" ")}: ${node.failureSummary?.replace(/\s+/g, " ").trim() ?? ""}`,
    ),
  );
}

/** Runs axe in light and dark, the page staying in whatever state the test built. */
async function expectNoAxeViolations(page: Page): Promise<void> {
  const found: string[] = [];
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme });
    found.push(...(await axeChrome(page)).map((line) => `[${colorScheme}] ${line}`));
  }
  await page.emulateMedia({ colorScheme: null });
  expect(found).toEqual([]);
}

async function editText(page: Page, field: Locator, text: string): Promise<void> {
  await field.click();
  await expect(field).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(field).toHaveAttribute("data-cms-state", /^(saved|failed)$/);
}

const barButton = (page: Page, name: string) => page.locator(".cms-bar").getByRole("button", { name, exact: true });

interface StateContext {
  page: Page;
  demo: Demo;
  guard: Guard;
}

interface ChromeState {
  name: string;
  /** Builds the state from a fresh tenant and leaves the page in it. */
  setup(context: StateContext): Promise<void>;
}

const popoverState = (name: string, selector: string, ready: (popover: Locator) => Promise<void>): ChromeState => ({
  name: `${name} popover open`,
  async setup({ page, demo }) {
    await demo.openEditor();
    await page.locator(selector).click();
    const popover = page.locator(".cms-popover");
    await expect(popover).toBeVisible();
    await ready(popover);
  },
});

const STATES: ChromeState[] = [
  {
    name: "idle bar",
    async setup({ demo }) {
      await demo.openEditor();
    },
  },
  {
    name: "badge shown on a focused field",
    async setup({ page, demo }) {
      await demo.openEditor();
      await page.locator("#home-price").focus();
      await expect(page.locator(".cms-badge")).toHaveText("Price · number");
    },
  },
  {
    name: "text widget editing in place",
    async setup({ page, demo }) {
      await demo.openEditor();
      await page.locator("#home-title").click();
      await expect(page.locator("#home-title")).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
    },
  },
  popoverState("toggle", "#home-live", (popover) => expect(popover.getByRole("switch")).toBeFocused()),
  popoverState("select", "#home-status", (popover) => expect(popover.getByRole("combobox")).toBeFocused()),
  popoverState("number", "#home-price", (popover) => expect(popover.getByRole("spinbutton")).toBeFocused()),
  popoverState("tags", "#home-tags", (popover) => expect(popover.locator(".cms-chip")).toHaveCount(2)),
  popoverState("date", "#home-date", (popover) => expect(popover.locator("input[type=date]")).toBeFocused()),
  popoverState("url", "#home-link", (popover) => expect(popover.getByRole("textbox")).toBeFocused()),
  {
    name: "richtext fallback note",
    async setup({ page, demo }) {
      await demo.openEditor();
      await page.locator(".lede").click();
      await expect(page.locator(".cms-popover--note")).toContainText("Plain text only");
    },
  },
  {
    name: "Publish sheet with diffs",
    async setup({ page, demo }) {
      await demo.openEditor();
      await editText(page, page.locator("#home-title"), "A new title");
      await editText(page, page.locator("#about-body"), "A new body");
      await barButton(page, "Publish").click();
      const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
      await expect(sheet.locator(".cms-diff li")).toHaveCount(2);
    },
  },
  {
    name: "Publish sheet with scheduling and the past-time note",
    async setup({ page, demo }) {
      await demo.openEditor({ scheduling: true });
      await editText(page, page.locator("#home-title"), "Later title");
      await barButton(page, "Publish").click();
      const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
      await expect(sheet.locator(".cms-diff li")).toHaveCount(1);
      await sheet.getByLabel("Publish at (optional)").fill("2020-01-01T09:00");
      await expect(sheet).toContainText("That time is in the past");
      await expect(sheet.getByRole("button", { name: "Schedule" })).toBeDisabled();
    },
  },
  {
    name: "Discard sheet with the delete warning",
    async setup({ page, demo }) {
      await demo.seed({ key: "pages/about", draft: { title: "Never published", body: "Draft only" } });
      await demo.openEditor();
      await editText(page, page.locator("#about-title"), "Still never published");
      await barButton(page, "Discard").click();
      const sheet = page.getByRole("dialog", { name: "Discard drafts for these documents?" });
      await expect(sheet).toContainText("discarding deletes pages/about");
    },
  },
  {
    name: "Revisions drawer with the Restore confirm",
    async setup({ page, demo }) {
      await demo.openEditor();
      await barButton(page, "Revisions").click();
      const sheet = page.getByRole("dialog", { name: "Revisions" });
      await sheet
        .getByRole("button", { name: /^Restore revision/ })
        .first()
        .click();
      await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(sheet).toContainText("will be replaced");
    },
  },
  {
    name: "Revisions drawer with the Unpublish confirm",
    async setup({ page, demo }) {
      await demo.openEditor();
      await barButton(page, "Revisions").click();
      const sheet = page.getByRole("dialog", { name: "Revisions" });
      await sheet.getByRole("button", { name: "Unpublish" }).click();
      await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(sheet).toContainText("Take pages/home off the live site?");
    },
  },
  {
    name: "error toast with Retry after a failed save",
    async setup({ page, demo, guard }) {
      guard.allowFailedRequests();
      await page.route("**/api/content/field", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal", message: "The disk is full" } }),
        }),
      );
      await demo.openEditor();
      await editText(page, page.locator("#home-title"), "Will not save");
      const toast = page.locator(".cms-toast");
      await expect(toast).toHaveAttribute("data-kind", "error");
      await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();
    },
  },
  {
    name: "conflict toast",
    async setup({ page, demo, guard }) {
      guard.allowFailedRequests();
      await demo.openEditor();
      await demo.content("POST", "field", { key: "pages/about", path: "title", value: "Changed elsewhere" });
      await editText(page, page.locator("#about-title"), "Mine");
      const toast = page.locator(".cms-toast");
      await expect(toast.getByRole("button", { name: "Keep mine (overwrite)" })).toBeVisible();
      await expect(toast.getByRole("button", { name: "Take theirs (reload field)" })).toBeVisible();
    },
  },
  {
    name: "locked field focused, its reason in the badge and the toast",
    async setup({ page, demo }) {
      // The reason toast hides itself after a few seconds; a paused clock keeps it up while axe runs.
      await page.clock.install();
      await demo.openEditor();
      const footer = page.locator("#site-footer");
      await footer.click();
      await expect(page.locator(".cms-toast")).toContainText("Not editable");
      await expect(page.locator(".cms-badge")).toHaveClass(/cms-badge--locked/);
    },
  },
  {
    name: "collapsed to Edit this page after Done",
    async setup({ page, demo }) {
      await demo.openEditor();
      await barButton(page, "Done").click();
      await expect(page.getByRole("button", { name: "Edit this page" })).toBeVisible();
    },
  },
];

test.describe("axe, desktop", () => {
  for (const state of STATES) {
    test(`no WCAG 2.2 AA violations: ${state.name}`, async ({ page, demo, guard }) => {
      await state.setup({ page, demo, guard });
      await expectNoAxeViolations(page);
    });
  }
});

test.describe("axe, 375px wide", () => {
  test.use({ viewport: { width: 375, height: 740 } });
  for (const state of STATES) {
    test(`no WCAG 2.2 AA violations at 375px: ${state.name}`, async ({ page, demo, guard }) => {
      await state.setup({ page, demo, guard });
      await expectNoAxeViolations(page);
    });
  }
});

// ---------- Visible focus, focus not obscured, target size ----------

interface FocusStop {
  name: string;
  chrome: boolean;
  focusVisible: boolean;
  /** Whether plain `:focus` matches, to tell a missing ring apart from focus that isn't on the element at all. */
  focus: boolean;
  focusWithin: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outline: Rgba;
  background: Rgba;
  /** The fixed surfaces covering every sampled point of the element, or null when any point shows it. */
  hiddenBy: string[] | null;
  width: number;
  height: number;
  /** 44px is what the chrome documents for its buttons and inputs; anything else needs the 24px of 2.5.8. */
  documentedTarget: boolean;
}

type Rgba = [number, number, number, number];

/** Everything about the focused element the checks need, measured in the page. */
const measureFocus = (page: Page): Promise<FocusStop | null> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return null;
    const chrome = active.closest(".cms-root") !== null;
    if (!chrome && !active.classList.contains("cms-field")) return null;

    const parse = (color: string): [number, number, number, number] => {
      const parts = (/rgba?\(([^)]+)\)/.exec(color)?.[1] ?? "0,0,0,0")
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const over = (top: number[], bottom: number[]): [number, number, number, number] => {
      const alpha = top[3] ?? 1;
      return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (bottom[i] ?? 0) * (1 - alpha)).concat(1) as [
        number,
        number,
        number,
        number,
      ];
    };
    // The canvas behind everything, in the page's used color scheme. CSSOM writes are allowed under the CSP.
    const probe = document.createElement("div");
    probe.style.backgroundColor = "Canvas";
    document.documentElement.append(probe);
    let background = parse(getComputedStyle(probe).backgroundColor);
    probe.remove();
    // The outline sits outside the element (offset), so what it is drawn on is the ancestors' background.
    const layers: number[][] = [];
    for (let node = active.parentElement; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] === 1) break;
    }
    for (const layer of layers.reverse()) background = over(layer, background);

    const style = getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    const target = active.matches("input[type=checkbox]") ? (active.closest("label") ?? active) : active;
    const targetRect = target.getBoundingClientRect();

    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, innerHeight);
    let hiddenBy: string[] | null = [];
    if (right - left < 1 || bottom - top < 1) hiddenBy = ["outside the viewport"];
    else {
      for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95]) {
          const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
          if (!hit || hit === active || active.contains(hit) || hit.contains(active)) {
            hiddenBy = null;
            break;
          }
          const surface = hit.closest(".cms-bar, .cms-toast, .cms-sheet, .cms-popover, .cms-enter");
          const label = surface ? `.${surface.className.split(" ").at(-1) ?? ""}` : hit.tagName.toLowerCase();
          if (!hiddenBy.includes(label)) hiddenBy.push(label);
        }
        if (hiddenBy === null) break;
      }
    }

    const name = active.id
      ? `#${active.id}`
      : `${active.tagName.toLowerCase()}${active instanceof HTMLInputElement ? `[type=${active.type}]` : ""}:${(
          active.getAttribute("aria-label") ??
          active.textContent ??
          ""
        )
          .trim()
          .slice(0, 30)}`;
    return {
      name,
      chrome,
      focusVisible: active.matches(":focus-visible"),
      focus: active.matches(":focus"),
      focusWithin: active.matches(":focus-within"),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth) || 0,
      outline: parse(style.outlineColor),
      background,
      hiddenBy,
      width: targetRect.width,
      height: targetRect.height,
      documentedTarget: active.matches(".cms-btn, .cms-input"),
    };
  });

const luminance = ([r, g, b]: Rgba): number => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: Rgba, b: Rgba): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

const hex = ([r, g, b]: Rgba): string =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/** Every problem with one Tab stop, as readable lines; empty when it passes. */
function focusProblems(stop: FocusStop): string[] {
  const problems: string[] = [];
  const at = stop.name;
  if (!stop.focusVisible)
    problems.push(
      `${at}: keyboard focus does not match :focus-visible (:focus ${stop.focus}, :focus-within ${stop.focusWithin}) (2.4.7)`,
    );
  if (stop.outlineStyle === "none" || stop.outlineStyle === "hidden" || stop.outlineWidth <= 0) {
    problems.push(`${at}: no focus outline (outline ${stop.outlineStyle} ${stop.outlineWidth}px) (2.4.7)`);
  } else {
    const outline: Rgba = [
      ...([0, 1, 2].map((i) => stop.outline[i]! * stop.outline[3] + stop.background[i]! * (1 - stop.outline[3])) as [
        number,
        number,
        number,
      ]),
      1,
    ];
    const ratio = contrast(outline, stop.background);
    if (ratio < 3) {
      problems.push(
        `${at}: focus outline ${hex(outline)} on ${hex(stop.background)} is ${ratio.toFixed(2)}:1, under 3:1 (1.4.11)`,
      );
    }
  }
  if (
    stop.hiddenBy?.some((surface) => [".cms-bar", ".cms-toast", ".cms-enter", "outside the viewport"].includes(surface))
  ) {
    problems.push(`${at}: focused but entirely hidden by ${stop.hiddenBy.join(", ")} (2.4.11)`);
  }
  if (stop.chrome) {
    const min = stop.documentedTarget ? 44 : 24;
    if (stop.width < min - 0.5 || stop.height < min - 0.5) {
      problems.push(
        `${at}: target ${stop.width.toFixed(1)}×${stop.height.toFixed(1)}px, under ${min}px (${stop.documentedTarget ? "documented --cms-control-h" : "2.5.8"})`,
      );
    }
  }
  return problems;
}

/**
 * Presses Tab `presses` times from wherever focus is, measuring every stop in the chrome or on a field, in light and
 * in dark. `within` stops the walk when focus leaves that surface (a popover commits and closes when left).
 */
async function walkFocus(
  page: Page,
  browserName: string,
  presses: number,
  options: { within?: string; includeCurrent?: boolean } = {},
): Promise<{ stops: string[]; problems: string[] }> {
  const stops: string[] = [];
  const problems: string[] = [];
  const check = async () => {
    for (const colorScheme of SCHEMES) {
      await page.emulateMedia({ colorScheme });
      const stop = await measureFocus(page);
      if (!stop) return;
      if (colorScheme === "light") stops.push(stop.name);
      problems.push(...focusProblems(stop).map((line) => `[${colorScheme}] ${line}`));
    }
  };
  if (options.includeCurrent) await check();
  for (let press = 0; press < presses; press++) {
    if (options.within) {
      const next = await page.evaluate(
        (selector) => document.activeElement?.closest(selector) !== null,
        options.within,
      );
      // About to leave: measuring the next stop would commit and close the surface under test.
      if (!next) break;
    }
    await page.keyboard.press(tabKey(browserName));
    if (options.within) {
      const inside = await page.evaluate(
        (selector) => document.activeElement?.closest(selector) !== null,
        options.within,
      );
      if (!inside) break;
    }
    await check();
  }
  await page.emulateMedia({ colorScheme: null });
  // A date input in WebKit is several Tab stops (month, day, year) on one element: report each problem once.
  return { stops, problems: [...new Set(problems)] };
}

/**
 * Focuses `target` the way a keyboard user arrives: programmatic focus after a click doesn't count as keyboard focus
 * for `:focus-visible` (Firefox is strict about it), so step away and back with Shift+Tab, Tab.
 */
async function keyboardFocus(page: Page, browserName: string, target: Locator): Promise<void> {
  await target.focus();
  await page.keyboard.press(`Shift+${tabKey(browserName)}`);
  await page.keyboard.press(tabKey(browserName));
  await expect(target).toBeFocused();
}

for (const width of [1280, 375]) {
  test.describe(`visible focus, ${width}px wide`, () => {
    test.use({ viewport: { width, height: width === 375 ? 740 : 720 } });

    test("every field and bar control has a visible, contrasting, unobscured focus ring and a large target", async ({
      page,
      demo,
      browserName,
    }) => {
      await demo.openEditor();
      const { stops, problems } = await walkFocus(page, browserName, 15);
      expect(stops).toHaveLength(15);
      expect(problems).toEqual([]);
    });

    for (const [type, selector] of [
      ["toggle", "#home-live"],
      ["select", "#home-status"],
      ["number", "#home-price"],
      ["tags", "#home-tags"],
      ["date", "#home-date"],
      ["url", "#home-link"],
    ] as const) {
      test(`every control in the ${type} popover`, async ({ page, demo, browserName }) => {
        await demo.openEditor();
        await page.locator(selector).focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".cms-popover")).toBeVisible();
        const { stops, problems } = await walkFocus(page, browserName, 8, {
          within: ".cms-popover",
          includeCurrent: true,
        });
        expect(stops.length).toBeGreaterThanOrEqual(2);
        expect(problems).toEqual([]);
      });
    }

    test("the text field while editing in place", async ({ page, demo, browserName }) => {
      await demo.openEditor();
      await page.locator("#about-body").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#about-body")).toHaveAttribute("contenteditable", /^(plaintext-only|true)$/);
      const { problems } = await walkFocus(page, browserName, 0, { includeCurrent: true });
      expect(problems).toEqual([]);
    });

    test("every control in the Publish sheet, with scheduling", async ({ page, demo, browserName }) => {
      await demo.openEditor({ scheduling: true });
      await editText(page, page.locator("#about-body"), "Changed");
      await barButton(page, "Publish").focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: "Publish these documents?" });
      await expect(sheet.locator(".cms-diff li")).toHaveCount(1);
      await keyboardFocus(page, browserName, sheet.getByRole("button", { name: "Close" }));
      const { stops, problems } = await walkFocus(page, browserName, 6, { within: ".cms-sheet", includeCurrent: true });
      expect(stops.length).toBeGreaterThanOrEqual(4);
      expect(problems).toEqual([]);
    });

    test("every control in the Revisions drawer and its confirm prompt", async ({ page, demo, browserName }) => {
      await demo.openEditor();
      await barButton(page, "Revisions").focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: "Revisions" });
      await expect(sheet.getByRole("button", { name: /^Restore revision/ })).toHaveCount(1);
      await keyboardFocus(page, browserName, sheet.getByRole("button", { name: "Close" }));
      const drawer = await walkFocus(page, browserName, 6, { within: ".cms-sheet", includeCurrent: true });
      expect(drawer.stops.length).toBeGreaterThanOrEqual(4);

      await keyboardFocus(page, browserName, sheet.getByRole("button", { name: "Unpublish" }));
      await page.keyboard.press("Enter");
      await expect(sheet.getByRole("button", { name: "Cancel" })).toBeFocused();
      const prompt = await walkFocus(page, browserName, 1, { within: ".cms-sheet", includeCurrent: true });
      expect(prompt.stops).toEqual(["button:Cancel", "button:Confirm"]);
      expect([...drawer.problems, ...prompt.problems]).toEqual([]);
    });

    test("the error toast's buttons", async ({ page, demo, guard, browserName }) => {
      guard.allowFailedRequests();
      await page.route("**/api/content/field", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "internal", message: "The disk is full" } }),
        }),
      );
      await demo.openEditor();
      await editText(page, page.locator("#home-title"), "Will not save");
      const toast = page.locator(".cms-toast");
      await keyboardFocus(page, browserName, toast.getByRole("button", { name: "Retry" }));
      const { stops, problems } = await walkFocus(page, browserName, 1, { within: ".cms-toast", includeCurrent: true });
      expect(stops).toEqual(["button:Retry", "button:Close"]);
      expect(problems).toEqual([]);
    });

    test("Edit this page, after Done", async ({ page, demo, browserName }) => {
      await demo.openEditor();
      await barButton(page, "Done").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Edit this page" })).toBeFocused();
      const { stops, problems } = await walkFocus(page, browserName, 0, { includeCurrent: true });
      expect(stops).toEqual(["button:Edit this page"]);
      expect(problems).toEqual([]);
    });
  });
}

test.describe("a short window", () => {
  // Set before the page opens: Firefox stalls navigating a page whose viewport was resized while on about:blank.
  test.use({ viewport: { width: 1024, height: 420 } });

  test("a popover control is not hidden behind the bar when its field sits near the bottom", async ({ page, demo }) => {
    await demo.openEditor();
    // Every field, in order: each popover control and each in-place field must show at least partly when focused.
    const problems: string[] = [];
    for (const selector of ["#home-live", "#home-status", "#home-price", "#home-tags", "#home-date", "#home-link"]) {
      await page.locator(selector).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".cms-popover")).toBeVisible();
      const stop = await measureFocus(page);
      if (stop) problems.push(...focusProblems(stop));
      await page.keyboard.press("Escape");
      await expect(page.locator(".cms-popover")).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });
});

// ---------- Reduced motion ----------

/** Every chrome element with a running transition, and what it transitions. */
const transitions = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".cms-root, .cms-root *, .cms-field")].flatMap((node) => {
      const style = getComputedStyle(node);
      const properties = style.transitionProperty.split(",").map((part) => part.trim());
      const durations = style.transitionDuration.split(",").map((part) => parseFloat(part) * 1000);
      return properties
        .map((property, index) => ({ property, duration: durations[index % durations.length] ?? 0 }))
        .filter(({ duration }) => duration > 0)
        .map(({ property, duration }) => ({
          node:
            ["cms-badge", "cms-popover", "cms-sheet", "cms-toast"].find((name) => node.classList.contains(name)) ??
            node.className.toString(),
          property,
          duration,
        }));
    }),
  );

test.describe("reduced motion", () => {
  test("with prefers-reduced-motion: reduce, every chrome transition is opacity-only and at most 120ms", async ({
    page,
    demo,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await demo.openEditor();
    // Bring up the animated surfaces: the toast (paused clock: it stays) and a popover. The sheet and the badge are in
    // the DOM, hidden, and their computed transitions are the same.
    await page.locator("#site-footer").click();
    await expect(page.locator(".cms-toast")).toBeVisible();
    await page.locator("#home-status").click();
    await expect(page.locator(".cms-popover")).toBeVisible();

    const reduced = await transitions(page);
    const surfaces = new Set(reduced.map((entry) => entry.node));
    expect([...surfaces].sort()).toEqual(
      expect.arrayContaining(["cms-badge", "cms-popover", "cms-sheet", "cms-toast"]),
    );
    expect(reduced.filter((entry) => entry.property !== "opacity" || entry.duration > 120)).toEqual([]);
  });

  test("without the preference the same surfaces also move, so the reduced rule is what removes it", async ({
    page,
    demo,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await demo.openEditor();
    expect(
      (await transitions(page)).filter((entry) => entry.property === "transform").map((entry) => entry.node),
    ).toEqual(expect.arrayContaining(["cms-toast", "cms-sheet", "cms-badge"]));
  });

  test("no chrome element runs a CSS animation under reduced motion", async ({ page, demo }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await demo.openEditor();
    await page.locator("#home-tags").click();
    await expect(page.locator(".cms-popover")).toBeVisible();
    const animated = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".cms-root, .cms-root *, .cms-field")]
        .filter((node) => getComputedStyle(node).animationName !== "none")
        .map((node) => node.className.toString()),
    );
    expect(animated).toEqual([]);
  });
});
