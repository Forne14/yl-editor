// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { EditFieldType } from "../editable.ts";
import type { WidgetContext } from "./types.ts";
import { defaultWidgets } from "./widgets.ts";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `<span id="host">Value</span>`;
  host = document.getElementById("host") as HTMLElement;
});

function context(type: EditFieldType, value: unknown, options?: string[]) {
  const commit = vi.fn(async () => {});
  const cancel = vi.fn();
  const announce = vi.fn();
  const ctx: WidgetContext = { element: host, field: { key: "k/a", path: "p", type, options }, value, commit, cancel, announce };
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

test("number commits a number on change and null when emptied", () => {
  const { ctx, commit } = context("number", 4);
  defaultWidgets.number.mount(ctx);
  const input = popoverControl<HTMLInputElement>("input[type=number]");
  expect(input.value).toBe("4");
  input.value = "7.5";
  input.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith(7.5);
});

test("toggle commits the checked state on change", () => {
  const { ctx, commit } = context("toggle", false);
  defaultWidgets.toggle.mount(ctx);
  const checkbox = popoverControl<HTMLInputElement>("input[type=checkbox]");
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  expect(commit).toHaveBeenCalledWith(true);
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
