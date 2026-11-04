// The default field editors. Each is a plain object with `mount`, so a host replaces any of them (TipTap for
// `richtext`, a media picker for `media`) by passing its own under the same type in `mountEditor({ widgets })`.
//
// A widget owns the DOM it changes and puts it back in `destroy` or on Esc; the chrome owns focus, the save queue
// and the status. A widget never throws at the chrome: a missing one renders "No editor registered".
import type { EditFieldType } from "../editable.ts";
import { button, element, uniqueId } from "./dom.ts";
import { defaultStrings, format, type Strings } from "./strings.ts";
import type { Widget, WidgetContext, WidgetHandle } from "./types.ts";

export interface Popover {
  root: HTMLElement;
  close(): void;
}

/**
 * A small dialog anchored under a field, themed by `.cms-root` so it picks up the tokens wherever it is appended.
 * Under 40em the stylesheet turns it into a bottom sheet. Exported so host widgets can reuse it.
 */
export function openPopover(anchor: HTMLElement, label: string, onLeave?: () => void): Popover {
  const titleId = uniqueId("cms-popover-title");
  const root = element("div", { class: "cms-root cms-popover", role: "dialog", "aria-labelledby": titleId }, [
    element("p", { class: "cms-popover__title", id: titleId }, [label]),
  ]);
  const rect = anchor.getBoundingClientRect();
  const view = anchor.ownerDocument.defaultView;
  root.style.setProperty("--cms-popover-top", `${rect.bottom + (view?.scrollY ?? 0)}px`);
  root.style.setProperty("--cms-popover-left", `${rect.left + (view?.scrollX ?? 0)}px`);
  const handleFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (onLeave && next instanceof Node && !root.contains(next)) onLeave();
  };
  root.addEventListener("focusout", handleFocusOut);
  anchor.ownerDocument.body.append(root);
  return {
    root,
    close() {
      root.removeEventListener("focusout", handleFocusOut);
      root.remove();
    },
  };
}

/** Commit-or-cancel bookkeeping every widget needs: only the first outcome counts. */
function once(ctx: WidgetContext) {
  let settled = false;
  return {
    commit(next: unknown) {
      if (settled) return;
      settled = true;
      void ctx.commit(next);
    },
    cancel() {
      if (settled) return;
      settled = true;
      ctx.cancel();
    },
  };
}

function fieldLabel(ctx: WidgetContext): string {
  return ctx.field.label ?? ctx.field.path;
}

function setPlainTextEditable(target: HTMLElement): void {
  try {
    target.contentEditable = "plaintext-only";
  } catch {
    target.contentEditable = "true";
  }
  if (target.contentEditable !== "plaintext-only") target.contentEditable = "true";
}

function insertPlainText(target: HTMLElement, text: string): void {
  const selection = target.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !target.contains(selection.anchorNode)) {
    target.append(text);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = target.ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(target: HTMLElement): void {
  const selection = target.ownerDocument.getSelection();
  if (!selection) return;
  const range = target.ownerDocument.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Plain text, edited in place. Paste and drop are reduced to text so no host markup or styling sneaks in. */
function textWidget(note?: string): Widget {
  return {
    mount(ctx) {
      const target = ctx.element;
      const originalNodes = [...target.childNodes].map((node) => node.cloneNode(true));
      const originalEditable = target.getAttribute("contenteditable");
      const outcome = once(ctx);
      const notePopover = note ? openPopover(target, note) : undefined;
      notePopover?.root.classList.add("cms-popover--note");
      if (note) ctx.announce(note);
      setPlainTextEditable(target);

      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          outcome.commit((target.textContent ?? "").trim());
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          target.replaceChildren(...originalNodes);
          outcome.cancel();
        }
      };
      const handlePaste = (event: ClipboardEvent) => {
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        insertPlainText(target, text.replace(/\s*\n\s*/g, " "));
      };
      const preventDrop = (event: Event) => event.preventDefault();
      const handleBlur = () => outcome.commit((target.textContent ?? "").trim());

      target.addEventListener("keydown", handleKeydown);
      target.addEventListener("paste", handlePaste);
      target.addEventListener("drop", preventDrop);
      target.addEventListener("blur", handleBlur);
      return {
        focus() {
          target.focus();
          placeCaretAtEnd(target);
        },
        destroy() {
          target.removeEventListener("keydown", handleKeydown);
          target.removeEventListener("paste", handlePaste);
          target.removeEventListener("drop", preventDrop);
          target.removeEventListener("blur", handleBlur);
          if (originalEditable === null) target.removeAttribute("contenteditable");
          else target.setAttribute("contenteditable", originalEditable);
          notePopover?.close();
        },
      };
    },
  };
}

interface FormWidgetParts {
  control: HTMLElement;
  read(): unknown;
  /** Focus target; defaults to `control`. */
  focusTarget?: HTMLElement;
}

/**
 * The shape every popover widget shares: a labelled control in a popover, Esc and Cancel to back out, and
 * leaving the popover commits whatever the control holds (the chrome skips the save when nothing changed).
 */
function formWidget(
  strings: Strings,
  build: (ctx: WidgetContext, outcome: ReturnType<typeof once>) => FormWidgetParts,
): Widget {
  return {
    mount(ctx): WidgetHandle {
      const outcome = once(ctx);
      const parts = build(ctx, outcome);
      const popover = openPopover(ctx.element, fieldLabel(ctx), () => outcome.commit(parts.read()));
      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        outcome.cancel();
      };
      popover.root.addEventListener("keydown", handleKeydown);
      popover.root.append(
        parts.control,
        element("div", { class: "cms-popover__actions" }, [button(strings.cancel, () => outcome.cancel(), "ghost")]),
      );
      return {
        focus: () => (parts.focusTarget ?? parts.control).focus(),
        destroy() {
          popover.root.removeEventListener("keydown", handleKeydown);
          popover.close();
        },
      };
    },
  };
}

function inputWidget(strings: Strings, inputType: "number" | "url" | "date"): Widget {
  return formWidget(strings, (ctx, outcome) => {
    const input = element("input", {
      class: "cms-input",
      type: inputType,
      "aria-label": fieldLabel(ctx),
      inputmode: inputType === "number" ? "decimal" : undefined,
    });
    input.value = ctx.value === null || ctx.value === undefined ? "" : String(ctx.value);
    const read = () => {
      if (inputType === "number") return input.value === "" ? null : Number(input.value);
      return input.value.trim();
    };
    if (inputType === "url") {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          outcome.commit(read());
        }
      });
    } else {
      input.addEventListener("change", () => outcome.commit(read()));
    }
    return { control: input, read };
  });
}

function toggleWidget(strings: Strings): Widget {
  return formWidget(strings, (ctx, outcome) => {
    const checkbox = element("input", { type: "checkbox", role: "switch", class: "cms-switch" });
    checkbox.checked = ctx.value === true;
    checkbox.addEventListener("change", () => outcome.commit(checkbox.checked));
    const control = element("label", { class: "cms-toggle" }, [checkbox, fieldLabel(ctx)]);
    return { control, read: () => checkbox.checked, focusTarget: checkbox };
  });
}

function selectWidget(strings: Strings): Widget {
  return formWidget(strings, (ctx, outcome) => {
    const current = ctx.value === null || ctx.value === undefined ? "" : String(ctx.value);
    const options = ctx.field.options ?? [];
    const select = element("select", { class: "cms-input", "aria-label": fieldLabel(ctx) }, [
      options.includes(current) ? null : element("option", { value: current }, [current]),
      ...options.map((option) => element("option", { value: option }, [option])),
    ]);
    select.value = current;
    select.addEventListener("change", () => outcome.commit(select.value));
    return { control: select, read: () => select.value };
  });
}

function tagsWidget(strings: Strings): Widget {
  return formWidget(strings, (ctx, outcome) => {
    const tags: string[] = Array.isArray(ctx.value) ? ctx.value.map(String) : [];
    const list = element("ul", { class: "cms-chips", "aria-label": fieldLabel(ctx) });
    const input = element("input", { class: "cms-input", type: "text", "aria-label": strings.addTag });
    const render = () =>
      list.replaceChildren(
        ...tags.map((tag, index) =>
          element("li", { class: "cms-chip" }, [
            tag,
            button(
              "×",
              () => {
                tags.splice(index, 1);
                render();
                input.focus();
              },
              "ghost",
              { "aria-label": format(strings.removeTag, { tag }) },
            ),
          ]),
        ),
      );
    const absorb = () => {
      const parts = input.value.split(",");
      const remainder = parts.pop() ?? "";
      for (const part of parts.map((text) => text.trim())) if (part && !tags.includes(part)) tags.push(part);
      input.value = remainder;
      render();
    };
    const read = () => {
      input.value += ",";
      absorb();
      return [...tags];
    };
    input.addEventListener("input", () => {
      if (input.value.includes(",")) absorb();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (input.value.trim()) {
        input.value += ",";
        absorb();
      } else {
        outcome.commit(read());
      }
    });
    render();
    const control = element("div", { class: "cms-tags" }, [
      list,
      input,
      button(strings.done, () => outcome.commit(read()), "primary"),
    ]);
    return { control, read, focusTarget: input };
  });
}

/** Shown in place of an editor when nothing is registered for a type. It never throws. */
export function missingWidget(strings: Strings, type: string): Widget {
  return {
    mount(ctx) {
      const message = format(strings.noWidget, { type });
      const popover = openPopover(ctx.element, message);
      popover.root.classList.add("cms-popover--note");
      ctx.announce(message);
      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape") ctx.cancel();
      };
      const close = button(strings.close, () => ctx.cancel(), "ghost");
      close.addEventListener("keydown", handleKeydown);
      popover.root.append(close);
      return { focus: () => close.focus(), destroy: () => popover.close() };
    },
  };
}

export function createDefaultWidgets(strings: Strings = defaultStrings): Record<EditFieldType, Widget> {
  return {
    text: textWidget(),
    richtext: textWidget(strings.richtextFallback),
    number: inputWidget(strings, "number"),
    url: inputWidget(strings, "url"),
    date: inputWidget(strings, "date"),
    toggle: toggleWidget(strings),
    select: selectWidget(strings),
    tags: tagsWidget(strings),
    media: missingWidget(strings, "media"),
  };
}

export const defaultWidgets: Record<EditFieldType, Widget> = createDefaultWidgets();
