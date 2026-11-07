// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EditFieldType } from "../editable.ts";
import type { WidgetContext } from "./types.ts";
import { defaultWidgets } from "./widgets.ts";

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

function pointerDown(target: Element): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
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
  pointerDown(document.getElementById("elsewhere") as HTMLElement);
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  expect(commit).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledWith("https://b.test");
  widget.destroy();
});

test("a closed popover no longer listens for presses", () => {
  const { ctx, commit, cancel } = context("url", "https://a.test");
  const widget = defaultWidgets.url.mount(ctx);
  popoverControl<HTMLInputElement>("input").value = "https://b.test";
  widget.destroy();
  pointerDown(document.body);
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
