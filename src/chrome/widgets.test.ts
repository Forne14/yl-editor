// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EditFieldType } from "../editable.ts";
import type { WidgetContext } from "./types.ts";
import { defaultStrings } from "./strings.ts";
import { defaultWidgets, formWidget, openPopover, provideStatus } from "./widgets.ts";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `<span id="host">Value</span>`;
  host = document.getElementById("host") as HTMLElement;
});

function context(type: EditFieldType, value: unknown, options?: string[], unsaved = false) {
  const commit = vi.fn(async () => {});
  const cancel = vi.fn();
  const announce = vi.fn();
  const ctx: WidgetContext = {
    element: host,
    field: { key: "k/a", path: "p", type, options },
    value,
    commit,
    cancel,
    announce,
    unsaved,
  };
  return { ctx, commit, cancel, announce };
}

function popoverControl<Control extends HTMLElement>(selector: string): Control {
  const control = document.querySelector<Control>(`.cms-popover ${selector}`);
  if (!control) throw new Error(`no ${selector}`);
  return control;
}

test("select is a native select built from the options, committing on change", () => {
  const { ctx, commit } = context("select", "gig", ["gig", "talk"]);
  const widget = defaultWidgets.select.mount(ctx);
  const select = popoverControl<HTMLSelectElement>("select");
  expect([...select.options].map((option) => option.value)).toEqual(["gig", "talk"]);
  select.value = "talk";
  select.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith("talk");
  widget.destroy();
  expect(document.querySelector(".cms-popover")).toBeNull();
});

function pressKey(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function pointerDown(target: Element, init: MouseEventInit & { pointerType?: string } = {}): void {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  target.dispatchEvent(event);
}

function pointerUp(target: Element): void {
  const event = new MouseEvent("pointerup", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

/** A complete mouse press: down, up and the click it makes. */
function clickOn(target: Element, init: MouseEventInit = {}): void {
  pointerDown(target, init);
  pointerUp(target);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
}

test("number commits a number on Enter and null when emptied, not on change", () => {
  const { ctx, commit } = context("number", 4);
  defaultWidgets.number.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=number]");
  expect(input.value).toBe("4");
  input.value = "7.5";
  // An arrow step fires change in every browser: it must not commit.
  input.dispatchEvent(new Event("change"));
  expect(commit).not.toHaveBeenCalled();
  pressKey(input, "Enter");
  expect(commit).toHaveBeenCalledWith(7.5);

  document.querySelector(".cms-popover")?.remove();
  const emptied = context("number", 4);
  defaultWidgets.number.mount(emptied.ctx);
  const second = popoverControl<HTMLInputElement>("input[type=number]");
  second.value = "";
  pressKey(second, "Enter");
  expect(emptied.commit).toHaveBeenCalledWith(null);
});

test("date commits on Enter, not on the change a keystroke fires on each segment", () => {
  const { ctx, commit } = context("date", "2026-11-14");
  const widget = defaultWidgets.date.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=date]");
  pressKey(input, "ArrowUp");
  input.value = "2026-12-14";
  input.dispatchEvent(new Event("change"));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
  expect(commit).not.toHaveBeenCalled();
  pressKey(input, "Enter");
  expect(commit).toHaveBeenCalledWith("2026-12-14");
  widget.destroy();
});

test("a date picked without a keystroke commits on change", async () => {
  const { ctx, commit } = context("date", "2026-11-14");
  const widget = defaultWidgets.date.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=date]");
  pressKey(input, "ArrowUp");
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  input.value = "2026-12-24";
  input.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith("2026-12-24");
  widget.destroy();
});

test("Cancel after typing a number writes nothing, although the blur fires change", () => {
  const { ctx, commit, cancel } = context("number", 12);
  const widget = defaultWidgets.number.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=number]");
  input.value = "30";
  const cancelButton = [...document.querySelectorAll<HTMLButtonElement>(".cms-popover button")].find(
    (node) => node.textContent === "Cancel",
  );
  if (!cancelButton) throw new Error("no Cancel");
  pointerDown(cancelButton);
  input.dispatchEvent(new Event("change"));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: cancelButton }));
  cancelButton.click();
  expect(cancel).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
  widget.destroy();
});

test("a press outside the popover and its field commits once; one inside or on the field doesn't", () => {
  document.body.insertAdjacentHTML("beforeend", "<p id='elsewhere'>Plain</p>");
  const { ctx, commit } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input");
  input.value = "https://b.test";
  pointerDown(popoverControl(".cms-popover__title"));
  pointerDown(host);
  expect(commit).not.toHaveBeenCalled();
  const elsewhere = document.getElementById("elsewhere") as HTMLElement;
  pointerDown(elsewhere);
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  // It commits once the press completes, which a press opening a context menu never does.
  expect(commit).not.toHaveBeenCalled();
  pointerUp(elsewhere);
  elsewhere.click();
  expect(commit).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledWith("https://b.test");
  widget.destroy();
});

test("a closed popover no longer listens for presses", () => {
  const { ctx, commit, cancel } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  popoverControl<HTMLInputElement>("input").value = "https://b.test";
  widget.destroy();
  clickOn(document.body);
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

test("focus leaving to nowhere commits once it settles, unless the press was inside the popover", async () => {
  const { ctx, commit } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input");
  input.value = "https://b.test";
  input.focus();
  pointerDown(popoverControl(".cms-popover__title"));
  input.blur();
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(commit).not.toHaveBeenCalled();

  // Keyboard focus moving off to nowhere (no press) is a real leave.
  input.focus();
  pressKey(input, "Tab");
  input.blur();
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(commit).toHaveBeenCalledWith("https://b.test");
  widget.destroy();
});

test("focus leaving to nowhere while it stays on the control (a window switch) commits nothing", async () => {
  const { ctx, commit, cancel } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input");
  input.value = "https://b.test";
  input.focus();
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  widget.destroy();
});

test("toggle commits the checked state on change", () => {
  const { ctx, commit } = context("toggle", false);
  defaultWidgets.toggle.mount(ctx);
  const checkbox = popoverControl<HTMLInputElement>("input[type=checkbox]");
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith(true);
});

test("leaving an untouched popover cancels even when the stored value is missing", () => {
  const { ctx, commit, cancel } = context("toggle", undefined);
  const widget = defaultWidgets.toggle.mount(ctx);
  widget.commit?.();
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

test("leaving a changed popover commits", () => {
  const { ctx, commit } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  popoverControl<HTMLInputElement>("input").value = "https://b.test";
  widget.commit?.();
  expect(commit).toHaveBeenCalledWith("https://b.test");
});

test("tags split on commas into chips and commit the list", () => {
  const { ctx, commit } = context("tags", ["soul"]);
  defaultWidgets.tags.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=text]");
  input.value = "grime, jazz,";
  input.dispatchEvent(new Event("input"));
  expect([...document.querySelectorAll(".cms-chip")].map((chip) => chip.firstChild?.textContent)).toEqual([
    "soul",
    "grime",
    "jazz",
  ]);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  expect(commit).toHaveBeenCalledWith(["soul", "grime", "jazz"]);
});

test("Esc in a popover widget cancels", () => {
  const { ctx, cancel, commit } = context("url", "https://example.test");
  defaultWidgets.url.mount(ctx);
  popoverControl<HTMLInputElement>("input").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
});

test("the richtext fallback edits plain text and shows a note asking for a rich widget", () => {
  const { ctx, commit, announce } = context("richtext", "Value");
  const widget = defaultWidgets.richtext.mount(ctx);
  expect(document.querySelector(".cms-popover--note")?.textContent).toContain("Register a rich text widget");
  expect(announce).toHaveBeenCalled();
  host.textContent = "Edited";
  host.dispatchEvent(new FocusEvent("blur"));
  expect(commit).toHaveBeenCalledWith("Edited");
  widget.destroy();
  expect(host.hasAttribute("contenteditable")).toBe(false);
  expect(document.querySelector(".cms-popover")).toBeNull();
});

test("text paste is reduced to plain text", () => {
  const { ctx } = context("text", "Value");
  defaultWidgets.text.mount(ctx);
  const paste = new Event("paste", { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "<b>bold</b>\nline" } });
  host.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  expect(host.querySelector("b")).toBeNull();
  expect(host.textContent).toContain("<b>bold</b> line");
});

test.each(["blur", "commit"])("a text widget holding a failed save commits it when left by %s", (exit) => {
  const { ctx, commit, cancel } = context("text", "Value", undefined, true);
  const widget = defaultWidgets.text.mount(ctx);
  if (exit === "blur") host.dispatchEvent(new FocusEvent("blur"));
  else widget.commit?.();
  expect(commit).toHaveBeenCalledWith("Value");
  expect(cancel).not.toHaveBeenCalled();
});

test("a text widget left untouched through the chrome's commit cancels", () => {
  const { ctx, commit, cancel } = context("text", "Value");
  defaultWidgets.text.mount(ctx).commit?.();
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

test("a text widget's edit is committed when the chrome closes it", () => {
  const { ctx, commit } = context("text", "Value");
  const widget = defaultWidgets.text.mount(ctx);
  host.textContent = "Edited";
  widget.commit?.();
  expect(commit).toHaveBeenCalledWith("Edited");
});

test("a popover holding a failed save commits it when left, and Esc still backs out", () => {
  const first = context("url", "https://a.test", undefined, true);
  defaultWidgets.url.mount(first.ctx).commit?.();
  expect(first.commit).toHaveBeenCalledWith("https://a.test");
  expect(first.cancel).not.toHaveBeenCalled();
  document.querySelector(".cms-popover")?.remove();

  const second = context("url", "https://a.test", undefined, true);
  defaultWidgets.url.mount(second.ctx);
  popoverControl<HTMLInputElement>("input").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(second.cancel).toHaveBeenCalledOnce();
  expect(second.commit).not.toHaveBeenCalled();
});

test("a text widget stores no-break spaces as plain spaces, and an untouched one with them cancels", () => {
  host.textContent = "Value\u00a0";
  const untouched = context("text", "Value");
  defaultWidgets.text.mount(untouched.ctx).commit?.();
  expect(untouched.cancel).toHaveBeenCalledOnce();

  const { ctx, commit } = context("text", "Value");
  const widget = defaultWidgets.text.mount(ctx);
  host.textContent = "Value\u00a0and\u00a0more";
  widget.commit?.();
  expect(commit).toHaveBeenCalledWith("Value and more");
});

describe("paste inserts through the browser's insertText when it can", () => {
  const original = Object.getOwnPropertyDescriptor(document, "execCommand");
  afterEach(() => {
    if (original) Object.defineProperty(document, "execCommand", original);
    else delete (document as { execCommand?: unknown }).execCommand;
  });

  function pasteInto(text: string): ClipboardEvent {
    const range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const paste = new Event("paste", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => text } });
    host.dispatchEvent(paste);
    return paste;
  }

  test("insertText takes the text, trailing space and all", () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    defaultWidgets.text.mount(context("text", "Value").ctx);
    pasteInto(" and ");
    expect(execCommand).toHaveBeenCalledWith("insertText", false, " and ");
    expect(host.textContent).toBe("Value");
  });

  test("when insertText is refused the text goes in through the selection", () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    defaultWidgets.text.mount(context("text", "Value").ctx);
    pasteInto(" and ");
    expect(execCommand).toHaveBeenCalled();
    expect(host.textContent).toBe("Value and ");
  });
});

/** Puts the input in the state a half-typed date or an invalid number leaves it in: an empty value and `badInput`. */
function holdBadInput(input: HTMLInputElement): void {
  input.value = "";
  Object.defineProperty(input, "validity", { value: { badInput: true }, configurable: true });
}

describe("a half-typed date or invalid number", () => {
  test.each(["number", "date"] as const)("%s: the chrome closing it cancels and keeps the stored value", (type) => {
    const { ctx, commit, cancel, announce } = context(type, type === "number" ? 4 : "2026-11-14");
    const widget = defaultWidgets[type].mount(ctx);
    holdBadInput(popoverControl<HTMLInputElement>("input"));
    widget.commit?.();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith("p wasn’t complete or valid, so it keeps the saved value.");
  });

  test("a press outside cancels too, even with a failed save to resend", () => {
    document.body.insertAdjacentHTML("beforeend", "<p id='elsewhere'>Plain</p>");
    const { ctx, commit, cancel } = context("number", 4, undefined, true);
    defaultWidgets.number.mount(ctx);
    holdBadInput(popoverControl<HTMLInputElement>("input"));
    clickOn(document.getElementById("elsewhere") as HTMLElement);
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("Enter keeps the popover open and says why; once valid, Enter commits", () => {
    const { ctx, commit, cancel, announce } = context("number", 4);
    defaultWidgets.number.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    holdBadInput(input);
    pressKey(input, "Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(
      "p isn’t complete or valid. Finish it, or press Esc to keep the saved value.",
    );
    Object.defineProperty(input, "validity", { value: { badInput: false }, configurable: true });
    input.value = "9";
    pressKey(input, "Enter");
    expect(commit).toHaveBeenCalledWith(9);
  });

  test.each(["number", "date"] as const)(
    "%s: Enter shows why under the input, marks it invalid and points at the line",
    (type) => {
      const { ctx, announce } = context(type, type === "number" ? 4 : "2026-11-14");
      defaultWidgets[type].mount(ctx);
      const input = popoverControl<HTMLInputElement>("input");
      // Named from the start, hidden and empty, like the Publish sheet's note. Another id added later stays.
      const line = input.nextElementSibling as HTMLElement;
      expect(line.matches(".cms-popover > .cms-diff[hidden]")).toBe(true);
      expect(line.childNodes).toHaveLength(0);
      expect(input.getAttribute("aria-describedby")).toBe(line.id);
      input.setAttribute("aria-describedby", `${line.id} host-hint`);
      holdBadInput(input);
      pressKey(input, "Enter");
      expect(input.nextElementSibling).toBe(line);
      expect(line.hidden).toBe(false);
      expect(line.querySelector("p.cms-error")?.textContent).toBe(
        "p isn’t complete or valid. Finish it, or press Esc to keep the saved value.",
      );
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(`${line.id} host-hint`);
      expect(announce).toHaveBeenCalledOnce();
    },
  );

  test("a second Enter on a still bad value announces again but adds no second line", () => {
    const { ctx, announce } = context("number", 4);
    defaultWidgets.number.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    holdBadInput(input);
    pressKey(input, "Enter");
    const line = input.nextElementSibling;
    pressKey(input, "Enter");
    expect(document.querySelectorAll(".cms-popover .cms-error")).toHaveLength(1);
    expect(input.nextElementSibling).toBe(line);
    expect(input.getAttribute("aria-describedby")).toBe(line?.id);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["readable", "9"],
    ["empty", ""],
  ])("the line and both attributes go once the value is %s again", (_state, value) => {
    const { ctx } = context("number", 4);
    defaultWidgets.number.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    const line = input.nextElementSibling as HTMLElement;
    holdBadInput(input);
    pressKey(input, "Enter");
    // Still bad: typing more keeps the line.
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".cms-popover .cms-error")).not.toBeNull();
    Object.defineProperty(input, "validity", { value: { badInput: false }, configurable: true });
    input.value = value;
    input.dispatchEvent(new Event("input"));
    expect(line.hidden).toBe(true);
    expect(line.childNodes).toHaveLength(0);
    expect(document.querySelector(".cms-popover .cms-error")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe(line.id);
  });

  test("showing the line scrolls Cancel into view, once", () => {
    const scrolled: { node: Element; options: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ node: this, options });
    };
    try {
      const { ctx } = context("number", 4);
      defaultWidgets.number.mount(ctx);
      const input = popoverControl<HTMLInputElement>("input");
      holdBadInput(input);
      pressKey(input, "Enter");
      pressKey(input, "Enter");
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]?.options).toEqual({ block: "nearest" });
      const actions = scrolled[0]?.node as HTMLElement;
      expect(actions.matches(".cms-popover > .cms-popover__actions:last-child")).toBe(true);
      expect(actions.textContent).toBe("Cancel");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test("a host widget wrapping a default one with a spread context keeps the chrome's toast", () => {
    const { ctx, cancel, announce } = context("number", 4);
    const status = vi.fn();
    provideStatus(ctx, status);
    const wrappedCommit = vi.fn(async () => {});
    const widget = defaultWidgets.number.mount({ ...ctx, commit: wrappedCommit });
    holdBadInput(popoverControl<HTMLInputElement>("input"));
    widget.commit?.();
    expect(status).toHaveBeenCalledWith("p wasn’t complete or valid, so it keeps the saved value.");
    expect(announce).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(wrappedCommit).not.toHaveBeenCalled();
  });

  test("the line goes with the popover", () => {
    const { ctx } = context("date", "2026-11-14");
    const widget = defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    holdBadInput(input);
    pressKey(input, "Enter");
    widget.destroy();
    expect(document.querySelector(".cms-error")).toBeNull();
  });

  test("Esc cancels silently, with no line, toast or announcement", () => {
    const { ctx, commit, cancel, announce } = context("date", "2026-11-14");
    defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    holdBadInput(input);
    pressKey(input, "Escape");
    expect(cancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  test("a url is never refused and shows no line", () => {
    const { ctx, commit } = context("url", "https://a.test");
    defaultWidgets.url.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "https://b.test";
    pressKey(input, "Enter");
    expect(commit).toHaveBeenCalledWith("https://b.test");
    expect(document.querySelector(".cms-error")).toBeNull();
  });

  test("a date deliberately emptied, with no bad input, still commits empty", () => {
    const { ctx, commit } = context("date", "2026-11-14");
    defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "";
    pressKey(input, "Enter");
    expect(commit).toHaveBeenCalledWith("");
  });
});

describe("Enter on an input left as it was", () => {
  test.each([
    ["number", 4],
    ["date", "2026-11-14"],
    ["url", "https://a.test"],
    // Reads back as 4, which isn't what is stored; the chrome's own comparison would write it.
    ["number", "4"],
  ] as const)("%s holding %j writes nothing", (type, value) => {
    const { ctx, commit, cancel } = context(type, value);
    defaultWidgets[type].mount(ctx);
    pressKey(popoverControl<HTMLInputElement>("input"), "Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  test.each([
    ["number", 4],
    ["date", "2026-11-14"],
    ["url", "https://a.test"],
  ] as const)("%s holding a failed save resends it", (type, value) => {
    const { ctx, commit, cancel } = context(type, value, undefined, true);
    defaultWidgets[type].mount(ctx);
    pressKey(popoverControl<HTMLInputElement>("input"), "Enter");
    expect(commit).toHaveBeenCalledWith(value);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("a press inside the popover", () => {
  const mouseDown = (target: Element): boolean =>
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

  test("off its controls keeps focus where it was", () => {
    const { ctx } = context("url", "https://a.test");
    const widget = defaultWidgets.url.mount(ctx);
    expect(mouseDown(popoverControl(".cms-popover__title"))).toBe(false);
    expect(mouseDown(popoverControl(".cms-popover__actions"))).toBe(false);
    widget.destroy();
  });

  test("on a control is left to the browser, so text selection and focus work", () => {
    const toggle = context("toggle", false);
    const toggleWidget = defaultWidgets.toggle.mount(toggle.ctx);
    expect(mouseDown(popoverControl("label"))).toBe(true);
    expect(mouseDown(popoverControl("button"))).toBe(true);
    toggleWidget.destroy();
    const url = context("url", "https://a.test");
    const urlWidget = defaultWidgets.url.mount(url.ctx);
    expect(mouseDown(popoverControl("input"))).toBe(true);
    urlWidget.destroy();
  });

  test("off its controls in a note popover keeps focus too", () => {
    const { ctx } = context("richtext", "Value");
    const widget = defaultWidgets.richtext.mount(ctx);
    expect(mouseDown(document.querySelector(".cms-popover--note .cms-popover__title") as Element)).toBe(false);
    widget.destroy();
  });

  test("in a host's popover is left to the browser, with or without onLeave", () => {
    for (const onLeave of [undefined, vi.fn()]) {
      const popover = openPopover(host, "Host widget", onLeave);
      const content = popover.root.appendChild(document.createElement("div"));
      content.textContent = "Selectable, draggable content";
      expect(mouseDown(popover.root.querySelector("p") as Element)).toBe(true);
      expect(mouseDown(content)).toBe(true);
      popover.close();
    }
  });
});

describe("presses outside that aren't the editor leaving", () => {
  function changedUrl() {
    document.body.insertAdjacentHTML("beforeend", "<p id='elsewhere'>Plain</p>");
    const parts = context("url", "https://a.test");
    const widget = defaultWidgets.url.mount(parts.ctx);
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "https://b.test";
    return { ...parts, widget, input, elsewhere: document.getElementById("elsewhere") as HTMLElement };
  }

  test("a right-click or middle-click commits nothing", () => {
    const { commit, cancel, elsewhere } = changedUrl();
    pointerDown(elsewhere, { button: 2 });
    pointerDown(elsewhere, { button: 1 });
    pointerDown(host, { button: 2 });
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a right-click that takes focus with it hands focus back and commits nothing", async () => {
    const { commit, input, elsewhere } = changedUrl();
    input.focus();
    pointerDown(elsewhere, { button: 2 });
    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.activeElement).toBe(input);
    expect(commit).not.toHaveBeenCalled();
  });

  test("a press on the root, the target of its scrollbar, commits nothing until focus drops", async () => {
    const { commit, input } = changedUrl();
    input.focus();
    pointerDown(document.documentElement);
    expect(commit).not.toHaveBeenCalled();
    // An empty stretch of the root has the same target, but a click there takes focus away.
    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(commit).toHaveBeenCalledWith("https://b.test");
  });

  test("a touch commits on the tap it completes as, not when it starts", () => {
    const { commit, elsewhere } = changedUrl();
    pointerDown(elsewhere, { pointerType: "touch" });
    expect(commit).not.toHaveBeenCalled();
    elsewhere.click();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("https://b.test");
  });

  test("a touch the browser takes for a scroll commits nothing, and neither does a later click it didn't start", () => {
    const { commit, cancel, elsewhere } = changedUrl();
    pointerDown(elsewhere, { pointerType: "touch" });
    document.dispatchEvent(new Event("pointercancel"));
    elsewhere.click();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a mouse click alone is never counted twice", () => {
    const { commit, elsewhere } = changedUrl();
    pointerDown(elsewhere);
    elsewhere.click();
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe("openPopover's onLeave", () => {
  test("fires at most once, even if the host keeps the popover open", async () => {
    const onLeave = vi.fn();
    const popover = openPopover(host, "Label", onLeave);
    const control = popover.root.appendChild(document.createElement("input"));
    clickOn(document.body);
    clickOn(document.body);
    control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onLeave).toHaveBeenCalledOnce();
    popover.close();
  });

  test("a host's dropdown appended to body counts as outside", () => {
    const onLeave = vi.fn();
    const popover = openPopover(host, "Label", onLeave);
    const dropdown = document.body.appendChild(document.createElement("div"));
    clickOn(dropdown);
    expect(onLeave).toHaveBeenCalledOnce();
    popover.close();
  });

  test("doesn't fire after close, nor for a press inside or on the anchor", async () => {
    const onLeave = vi.fn();
    const popover = openPopover(host, "Label", onLeave);
    pointerDown(popover.root);
    pointerDown(host);
    expect(onLeave).not.toHaveBeenCalled();
    popover.close();
    clickOn(document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onLeave).not.toHaveBeenCalled();
  });
});

describe("no-break spaces in a text edit", () => {
  test("one the text already had stays when a different part is edited", () => {
    host.textContent = "Run 10 km";
    const { ctx, commit } = context("text", "Run 10 km");
    const widget = defaultWidgets.text.mount(ctx);
    host.textContent = "Run 10 km today";
    widget.commit?.();
    expect(commit).toHaveBeenCalledWith("Run 10 km today");
  });

  test("one stays when text is typed in front of it, while the typed one goes", () => {
    host.textContent = "10 km";
    const { ctx, commit } = context("text", "10 km");
    const widget = defaultWidgets.text.mount(ctx);
    host.textContent = "About 10 km";
    widget.commit?.();
    expect(commit).toHaveBeenCalledWith("About 10 km");
  });

  test("Firefox's typed space is stored as a plain space, also next to a kept one", () => {
    host.textContent = "10 km";
    const { ctx, commit } = context("text", "10 km");
    const widget = defaultWidgets.text.mount(ctx);
    host.textContent = "10 km today";
    widget.commit?.();
    expect(commit).toHaveBeenCalledWith("10 km today");
  });

  test("a space Firefox typed in an earlier edit, still on the page, isn't taken for a deliberate one", () => {
    host.textContent = "Fresh bread";
    const { ctx, commit, cancel } = context("text", "Fresh bread");
    const widget = defaultWidgets.text.mount(ctx);
    host.textContent = "Fresh bread daily";
    widget.commit?.();
    expect(commit).toHaveBeenCalledWith("Fresh bread daily");
    expect(cancel).not.toHaveBeenCalled();
  });

  test("an untouched text with a deliberate one writes nothing", () => {
    host.textContent = "10 km";
    const { ctx, commit, cancel } = context("text", "10 km");
    defaultWidgets.text.mount(ctx).commit?.();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("the date widget's keystroke tracking", () => {
  test.each([
    ["Space", { key: " " }],
    ["Alt+ArrowDown", { key: "ArrowDown", altKey: true }],
    ["F4", { key: "F4" }],
  ])("a day picked right after %s opened the picker commits at once, its keyup swallowed", (_name, init) => {
    const { ctx, commit } = context("date", "2026-11-14");
    const widget = defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    input.value = "2026-12-24";
    input.dispatchEvent(new Event("change"));
    expect(commit).toHaveBeenCalledWith("2026-12-24");
    widget.destroy();
  });

  test.each(["7", "ArrowUp", "ArrowRight", "Backspace", "Delete"])("a `change` while %s is down waits", (key) => {
    const { ctx, commit } = context("date", "2026-11-14");
    const widget = defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    pressKey(input, key);
    input.value = "2026-12-14";
    input.dispatchEvent(new Event("change"));
    expect(commit).not.toHaveBeenCalled();
    widget.destroy();
  });

  test("a `change` while a key is down waits for Enter", () => {
    const { ctx, commit } = context("date", "2026-11-14");
    const widget = defaultWidgets.date.mount(ctx);
    const input = popoverControl<HTMLInputElement>("input");
    pressKey(input, "ArrowUp");
    input.value = "2026-12-14";
    input.dispatchEvent(new Event("change"));
    expect(commit).not.toHaveBeenCalled();
    widget.destroy();
  });

  test("a day picked that is the stored one writes nothing", () => {
    const { ctx, commit, cancel } = context("date", "2026-11-14");
    defaultWidgets.date.mount(ctx);
    popoverControl<HTMLInputElement>("input").dispatchEvent(new Event("change"));
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("leaving and presses that open a context menu", () => {
  function changedUrl() {
    document.body.insertAdjacentHTML("beforeend", "<p id='elsewhere'>Plain</p><input id='host-input'>");
    const parts = context("url", "https://a.test");
    const widget = defaultWidgets.url.mount(parts.ctx);
    const input = popoverControl<HTMLInputElement>("input");
    input.value = "https://b.test";
    input.focus();
    return {
      ...parts,
      widget,
      input,
      elsewhere: document.getElementById("elsewhere") as HTMLElement,
      hostInput: document.getElementById("host-input") as HTMLInputElement,
    };
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
  const focusDropped = (input: HTMLElement) => {
    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  };

  test("a Ctrl+click elsewhere is a click, as on Windows and Linux, and commits", () => {
    const { commit, elsewhere } = changedUrl();
    clickOn(elsewhere, { ctrlKey: true });
    expect(commit).toHaveBeenCalledWith("https://b.test");
  });

  test("a primary press that opens a context menu (a Mac's Ctrl+click) commits nothing and keeps focus", async () => {
    const { commit, cancel, input, elsewhere } = changedUrl();
    pointerDown(elsewhere, { ctrlKey: true });
    focusDropped(input);
    elsewhere.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    // A pointerup can still arrive once the menu has gone.
    pointerUp(elsewhere);
    await settled();
    expect(document.activeElement).toBe(input);
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a press released where no click follows still commits", async () => {
    const { commit, elsewhere } = changedUrl();
    pointerDown(elsewhere);
    pointerUp(document.body);
    await settled();
    expect(commit).toHaveBeenCalledOnce();
  });

  test("after a right-click, a later focus move with no press is leaving", async () => {
    const { commit, input, elsewhere } = changedUrl();
    pointerDown(elsewhere, { button: 2 });
    await settled();
    expect(commit).not.toHaveBeenCalled();
    // A host script or assistive technology moves focus away.
    focusDropped(input);
    await settled();
    expect(commit).toHaveBeenCalledWith("https://b.test");
  });

  test("a right-click on a focusable host input leaves focus there for its Paste and commits nothing", async () => {
    const { commit, cancel, input, hostInput } = changedUrl();
    pointerDown(hostInput, { button: 2 });
    hostInput.focus();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: hostInput }));
    await settled();
    expect(document.activeElement).toBe(hostInput);
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a right-click that drops focus to nowhere hands it back to the control", async () => {
    const { commit, input, elsewhere } = changedUrl();
    pointerDown(elsewhere, { button: 2 });
    focusDropped(input);
    await settled();
    expect(document.activeElement).toBe(input);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("a deliberate no-break space the page renders as a plain one", () => {
  test("survives typing at the end: stored '10\u00a0km', page '10 km', 's' typed", () => {
    host.textContent = "10 km";
    const { ctx, commit } = context("text", "10\u00a0km");
    const widget = defaultWidgets.text.mount(ctx);
    host.textContent = "10 kms";
    widget.commit?.();
    expect(commit).toHaveBeenCalledWith("10\u00a0kms");
  });

  test("an untouched one writes nothing", () => {
    host.textContent = "10 km";
    const { ctx, commit, cancel } = context("text", "10\u00a0km");
    defaultWidgets.text.mount(ctx).commit?.();
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("formWidget", () => {
  test("a build that finishes at once doesn't throw, and finishes once the widget is mounted", async () => {
    const { ctx, commit, cancel } = context("url", "https://a.test");
    const widget = formWidget(defaultStrings, (_ctx, _outcome, finish) => {
      const control = document.createElement("input");
      control.value = "https://a.test";
      finish();
      return { control, read: () => control.value };
    });
    const handle = widget.mount(ctx);
    expect(cancel).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    handle.destroy();
  });
});
