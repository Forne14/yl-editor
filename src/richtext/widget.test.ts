// @vitest-environment happy-dom
// happy-dom proves the widget's logic, not how a browser lays it out or types into it: e2e/richtext.spec.ts does that.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defaultStrings } from "../chrome/strings.ts";
import type { WidgetContext, WidgetHandle } from "../chrome/types.ts";
import { provideStrings } from "../chrome/widgets.ts";
import { createRichTextWidget, richTextWidget } from "./index.ts";
import { headingLevels, normaliseHref, stripInlineStyles } from "./widget.ts";

let host: HTMLElement;
let handle: WidgetHandle | undefined;

beforeEach(() => {
  document.body.innerHTML = `<div id="host" class="lede" tabindex="0"><p>Fresh <strong>bread</strong>.</p></div>`;
  host = document.getElementById("host") as HTMLElement;
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
});

function context(value: unknown = "<p>Fresh <strong>bread</strong>.</p>", unsaved = false) {
  const commit = vi.fn(async () => {});
  const cancel = vi.fn();
  const announce = vi.fn();
  const ctx: WidgetContext = {
    element: host,
    field: { key: "pages/home", path: "lede", type: "richtext", label: "Lede" },
    value,
    commit,
    cancel,
    announce,
    unsaved,
  };
  return { ctx, commit, cancel, announce };
}

const editorOf = (target: HTMLElement) => (target as HTMLElement & { editor: Editor }).editor;
const toolbar = () => document.querySelector<HTMLElement>(".cms-toolbar") as HTMLElement;
const button = (name: string) => {
  // The accessible name: the label, else the text (the tooltip is the toolbar's, not the button's).
  const found = [...toolbar().querySelectorAll("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
/** TipTap's focus command waits a frame. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 50));
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("mounting", () => {
  test("edits the host element itself and shows the approved toolbar", () => {
    const { ctx } = context();
    handle = richTextWidget.mount(ctx);
    expect(host.getAttribute("contenteditable")).toBe("true");
    expect(host.classList.contains("cms-richtext")).toBe(true);
    expect(host.getAttribute("aria-label")).toBe("Lede");
    expect(host.querySelector("strong")?.textContent).toBe("bread");
    expect(toolbar().getAttribute("role")).toBe("toolbar");
    expect(toolbar().getAttribute("aria-label")).toBe("Formatting for Lede");
    const names = [...toolbar().querySelectorAll("button:not([hidden])")]
      .filter((node) => !node.closest("[hidden]"))
      .map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim());
    expect(names).toEqual(["Bold", "Italic", "Link", "Bulleted list", "Numbered list", "Cancel", "Done"]);
  });

  test("shows the heading buttons only for the levels the field allows", () => {
    host.dataset.editHeadings = "2 3";
    handle = richTextWidget.mount(context().ctx);
    // The name starts with the visible text, so a speech user can say "H2" (WCAG 2.5.3).
    expect(button("H2 Heading").firstChild?.textContent).toBe("H2");
    expect(button("H3 Subheading").querySelector(".cms-visually-hidden")?.textContent).toBe(" Subheading");
    handle.destroy();
    host.dataset.editHeadings = "3";
    handle = richTextWidget.mount(context().ctx);
    expect(() => button("H2 Heading")).toThrow();
    expect(button("H3 Subheading")).toBeTruthy();
  });

  test("marks the formatting at the caret as pressed", () => {
    handle = richTextWidget.mount(context().ctx);
    const editor = editorOf(host);
    editor.commands.setTextSelection(9);
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
    expect(button("Italic").getAttribute("aria-pressed")).toBe("false");
  });

  test("takes its words from the strings the chrome hands it, then from its own options", () => {
    const { ctx } = context();
    provideStrings(ctx, { ...defaultStrings, bold: "Gras", formatting: "Mise en forme de {label}" });
    handle = createRichTextWidget({ strings: { italic: "Italique" } }).mount(ctx);
    expect(toolbar().getAttribute("aria-label")).toBe("Mise en forme de Lede");
    expect(button("Gras")).toBeTruthy();
    expect(button("Italique")).toBeTruthy();
  });

  test("starts from the page's markup when the value is only the page's text", () => {
    handle = richTextWidget.mount(context("Fresh bread.").ctx);
    expect(host.querySelector("strong")?.textContent).toBe("bread");
  });

  test("starts from a stored value that differs from the page, sanitised", () => {
    handle = richTextWidget.mount(context('<p>Stored <em>value</em><img src=x onerror="alert(1)"></p>').ctx);
    expect(host.querySelector("em")?.textContent).toBe("value");
    expect(host.querySelector("img")).toBeNull();
  });
});

describe("committing and cancelling", () => {
  test("Done commits the sanitised HTML and leaves it rendered in the element", () => {
    const { ctx, commit } = context();
    handle = richTextWidget.mount(ctx);
    editorOf(host).commands.insertContentAt(editorOf(host).state.doc.content.size - 1, " Daily.");
    button("Done").click();
    expect(commit).toHaveBeenCalledWith("<p>Fresh <strong>bread</strong>. Daily.</p>");
    handle.destroy();
    handle = undefined;
    expect(host.innerHTML).toBe("<p>Fresh <strong>bread</strong>. Daily.</p>");
    expect(host.hasAttribute("contenteditable")).toBe(false);
    expect(host.hasAttribute("role")).toBe(false);
    expect(host.className).toBe("lede");
    expect(document.querySelector(".cms-toolbar")).toBeNull();
  });

  test("Done with nothing changed writes nothing", () => {
    const { ctx, commit, cancel } = context();
    handle = richTextWidget.mount(ctx);
    button("Done").click();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  test("an unchanged value whose save failed is sent again", () => {
    const { ctx, commit } = context(undefined, true);
    handle = richTextWidget.mount(ctx);
    handle.commit?.();
    expect(commit).toHaveBeenCalledWith("<p>Fresh <strong>bread</strong>.</p>");
  });

  test("an emptied field commits an empty string", () => {
    const { ctx, commit } = context();
    handle = richTextWidget.mount(ctx);
    editorOf(host).commands.clearContent();
    handle.commit?.();
    expect(commit).toHaveBeenCalledWith("");
  });

  test.each([
    ["Cancel", () => button("Cancel").click()],
    ["Esc", () => press(host, "Escape")],
  ])("%s puts the original markup and attributes back and writes nothing", (_name, act) => {
    const { ctx, commit, cancel } = context();
    handle = richTextWidget.mount(ctx);
    editorOf(host).commands.setContent("<p>Changed</p>");
    act();
    expect(cancel).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    handle.destroy();
    handle = undefined;
    expect(host.innerHTML).toBe("<p>Fresh <strong>bread</strong>.</p>");
    expect(host.getAttribute("tabindex")).toBe("0");
    expect(host.hasAttribute("aria-label")).toBe(false);
  });

  test("Ctrl or Cmd + Enter is Done", () => {
    const { ctx, commit } = context();
    handle = richTextWidget.mount(ctx);
    editorOf(host).commands.setContent("<p>New</p>");
    press(host, "Enter", { ctrlKey: true });
    expect(commit).toHaveBeenCalledWith("<p>New</p>");
  });
});

describe("paste", () => {
  test("drops everything outside the formatting set", () => {
    host.dataset.editHeadings = "2";
    const { ctx, commit } = context("");
    handle = richTextWidget.mount(ctx);
    editorOf(host).view.pasteHTML(
      '<h1 style="color:red">Title</h1><p class="x">A <u>u</u> <span style="font-size:40px">big</span> ' +
        '<code>code</code> <s>gone</s> <a href="javascript:alert(1)">bad</a> <a href="https://ok.test">good</a></p>' +
        '<blockquote>quote</blockquote><img src="x.png"><script>alert(1)</script><table><tr><td>cell</td></tr></table>',
    );
    handle.commit?.();
    const stored = String(commit.mock.calls[0]?.[0 as never]);
    expect(stored).not.toMatch(/<(u|span|code|s|blockquote|img|script|table|td|h1)\b|style=|class=|javascript:/);
    expect(stored).toContain('<a href="https://ok.test">good</a>');
    expect(stored).toContain("Title");
    expect(stored).toContain("cell");
  });

  test("a formatted paste offers Plain text, which replaces it with its text, and Keep formatting puts it back", () => {
    const { ctx, announce } = context("");
    handle = richTextWidget.mount(ctx);
    const view = editorOf(host).view;
    const data = new DataTransfer();
    data.setData("text/html", "<p>Rye <strong>daily</strong></p>");
    data.setData("text/plain", "Rye daily");
    view.pasteHTML("<p>Rye <strong>daily</strong></p>", new ClipboardEvent("paste", { clipboardData: data }));
    const row = toolbar().querySelector<HTMLElement>(".cms-toolbar__paste") as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(row.textContent).toContain("Pasted with formatting.");
    expect(announce).toHaveBeenCalledWith(defaultStrings.pasteAnnounce);
    expect(host.querySelector("strong")?.textContent).toBe("daily");

    button("Plain text").click();
    expect(host.querySelector("strong")).toBeNull();
    expect(host.textContent).toBe("Rye daily");
    expect(row.textContent).toContain("Pasted as plain text.");
    expect(button("Plain text").getAttribute("aria-pressed")).toBe("true");

    button("Keep formatting").click();
    expect(host.querySelector("strong")?.textContent).toBe("daily");
    expect(host.textContent).toBe("Rye daily");
  });

  test("a plain paste shows no paste options", () => {
    handle = richTextWidget.mount(context("").ctx);
    editorOf(host).view.pasteText("Just words");
    expect(toolbar().querySelector<HTMLElement>(".cms-toolbar__paste")?.hidden).toBe(true);
  });

  test("typing after a paste puts the paste options away", () => {
    handle = richTextWidget.mount(context("").ctx);
    editorOf(host).view.pasteHTML("<p><em>x</em></p>");
    const row = toolbar().querySelector<HTMLElement>(".cms-toolbar__paste") as HTMLElement;
    expect(row.hidden).toBe(false);
    press(host, "a");
    expect(row.hidden).toBe(true);
  });
});

describe("links", () => {
  test("Link opens the address row with focus in it, and refuses an unsafe address with a visible reason", () => {
    const { ctx, announce } = context();
    handle = richTextWidget.mount(ctx);
    editorOf(host).commands.setTextSelection({ from: 1, to: 6 });
    button("Link").click();
    const input = toolbar().querySelector<HTMLInputElement>(".cms-toolbar__link input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(button("Link").getAttribute("aria-expanded")).toBe("true");
    input.value = "javascript:alert(1)";
    press(input, "Enter");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(toolbar().querySelector(".cms-error")?.textContent).toBe(defaultStrings.linkRefused);
    expect(announce).toHaveBeenCalledWith(defaultStrings.linkRefused);
    expect(host.querySelector("a")).toBeNull();

    input.value = "example.com";
    press(input, "Enter");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(host.querySelector("a")?.textContent).toBe("Fresh");
    expect(toolbar().querySelector<HTMLElement>(".cms-toolbar__link")?.hidden).toBe(true);
  });

  test("on an existing link the row starts from its address and offers Remove link", () => {
    handle = richTextWidget.mount(context('<p>See <a href="/bread">bread</a></p>').ctx);
    editorOf(host).commands.setTextSelection(7);
    button("Link").click();
    const input = toolbar().querySelector<HTMLInputElement>(".cms-toolbar__link input") as HTMLInputElement;
    expect(input.value).toBe("/bread");
    button("Remove link").click();
    expect(host.querySelector("a")).toBeNull();
  });

  test("Esc in the address row closes the row, not the edit", () => {
    const { ctx, cancel } = context();
    handle = richTextWidget.mount(ctx);
    button("Link").click();
    const input = toolbar().querySelector<HTMLInputElement>(".cms-toolbar__link input") as HTMLInputElement;
    press(input, "Escape");
    expect(cancel).not.toHaveBeenCalled();
    expect(toolbar().querySelector<HTMLElement>(".cms-toolbar__link")?.hidden).toBe(true);
  });
});

describe("keyboard", () => {
  test("the toolbar is one tab stop and the arrow keys move along it, wrapping", () => {
    handle = richTextWidget.mount(context().ctx);
    // The address row's controls are ordinary tab stops; only the buttons in the bar and the paste row rove.
    const tabbable = () =>
      [...toolbar().querySelectorAll("button")].filter(
        (node) => node.tabIndex === 0 && !node.closest(".cms-toolbar__link"),
      );
    expect(tabbable().map((node) => node.getAttribute("aria-label"))).toEqual(["Bold"]);
    press(host, "F10", { altKey: true });
    expect(document.activeElement).toBe(button("Bold"));
    press(button("Bold"), "ArrowLeft");
    expect(document.activeElement).toBe(button("Done"));
    press(button("Done"), "ArrowRight");
    expect(document.activeElement).toBe(button("Bold"));
    press(button("Bold"), "End");
    expect(document.activeElement).toBe(button("Done"));
    expect(tabbable()).toEqual([button("Done")]);
  });

  test("Enter on a toolbar button formats and puts focus back in the text", async () => {
    handle = richTextWidget.mount(context().ctx);
    editorOf(host).commands.setTextSelection({ from: 1, to: 6 });
    press(host, "F10", { altKey: true });
    press(button("Bold"), "Enter");
    expect(host.querySelectorAll("strong")).toHaveLength(2);
    await nextFrame();
    expect(document.activeElement).toBe(host);
  });

  test("Esc in the toolbar goes back to the text without cancelling", async () => {
    const { ctx, cancel } = context();
    handle = richTextWidget.mount(ctx);
    press(host, "F10", { altKey: true });
    // The first Esc hides the tooltip focus showed (WCAG 1.4.13), the second returns to the text.
    press(button("Bold"), "Escape");
    press(button("Bold"), "Escape");
    await nextFrame();
    expect(cancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host);
  });

  test("the tooltip names the button and its shortcut", () => {
    handle = richTextWidget.mount(context().ctx);
    button("Italic").dispatchEvent(new Event("mouseover", { bubbles: true }));
    const tip = toolbar().querySelector(".cms-tooltip");
    expect(tip?.getAttribute("aria-hidden")).toBe("true");
    expect(tip?.parentElement).toBe(toolbar());
    expect(tip?.textContent).toMatch(/^Italic(⌘I|Ctrl\+I)$/);
  });
});

describe("helpers", () => {
  test("headingLevels reads 2 and 3 and ignores the rest", () => {
    const node = document.createElement("div");
    node.dataset.editHeadings = "1 2 4 3";
    expect(headingLevels(node)).toEqual([2, 3]);
    node.dataset.editHeadings = "";
    expect(headingLevels(node)).toEqual([]);
  });

  test("stripInlineStyles drops style attributes and elements, and unwraps the Google Docs not-bold wrapper", () => {
    expect(stripInlineStyles('<p style="color:red" class="x">a <span style=\'font-size:9px\'>b</span></p>')).toBe(
      '<p class="x">a <span>b</span></p>',
    );
    expect(stripInlineStyles("<style>p{color:red}</style><p>a</p>")).toBe("<p>a</p>");
    expect(stripInlineStyles('<b style="font-weight:normal;" id="docs-internal-guid-1"><p>a</p></b>')).toBe(
      '<span id="docs-internal-guid-1"><p>a</p></b>',
    );
    expect(stripInlineStyles('<b style="font-weight:700">a</b>')).toBe("<b>a</b>");
    expect(stripInlineStyles('<p>Write style="x" in text</p>')).toBe('<p>Write style="x" in text</p>');
  });

  test.each([
    ["example.com", "https://example.com"],
    ["  example.com/a  ", "https://example.com/a"],
    ["/bread", "/bread"],
    ["mailto:a@b.test", "mailto:a@b.test"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["just words", "just words"],
  ])("normaliseHref(%j) is %j", (input, output) => expect(normaliseHref(input)).toBe(output));
});

test("the chrome entry never imports TipTap or the rich text widget", () => {
  // A path, not a URL: happy-dom replaces the global URL, which node:fs refuses.
  const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "chrome");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    const source = readFileSync(join(directory, name), "utf8");
    expect(source, name).not.toMatch(/from\s+["'](@tiptap\/|\.\.\/richtext\/)/);
  }
});
