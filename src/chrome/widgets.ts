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

/** What a press can land on in a popover and still mean something: these keep their own focus and text selection. */
const POPOVER_CONTROLS = "input, select, textarea, button, a[href], label, summary, [contenteditable], [tabindex]";

/**
 * A small dialog anchored under a field, themed by `.cms-root` so it picks up the tokens wherever it is appended.
 * Under 40em the stylesheet turns it into a bottom sheet. Exported so host widgets can reuse it.
 *
 * `onLeave` fires at most once per popover, when the editor leaves it: a primary press or a completed tap outside the
 * popover and `anchor`, or focus moving out of the popover. Anything of the host's outside the popover's own element
 * counts as outside, including a dropdown it appends to `body`. It never fires after `close()`.
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
  const doc = anchor.ownerDocument;
  let closed = false;
  let left = false;
  // Whether the latest press landed inside the popover. Safari doesn't focus a button or checkbox on a click, so a
  // press on one blurs the control with no `relatedTarget`, exactly like a click on the page outside; this tells the
  // two apart. A key press clears it.
  let pressInside = false;
  // The latest press wasn't a leave (a right-click), though it can still take focus with it.
  let pressIgnored = false;
  // A touch outside may turn into a scroll, so it only counts once it completes as a tap.
  let touchOutside = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const leave = () => {
    if (closed || left) return;
    left = true;
    onLeave?.();
  };
  const afterFocusSettles = (check: () => void) => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      check();
    }, 0);
  };
  // A press off the controls would drop focus to the body with the popover still open, and Esc and Enter with it.
  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(POPOVER_CONTROLS);
    if (!control || !root.contains(control)) event.preventDefault();
  };
  // Clicking content that cannot take focus, and any button in Safari, moves focus nowhere, so `focusout` alone misses
  // it. A press outside the popover and its field commits on its own, unless it is not the editor leaving: a right-click
  // or a Mac's Ctrl+click opens a menu, and the root scrollbar's press has the root as its target. An empty stretch of
  // the root has that target too, but a click there drops focus, which `handleFocusOut` catches.
  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    pressInside = target !== null && root.contains(target);
    pressIgnored = false;
    touchOutside = false;
    if (pressInside) return;
    if (event.button !== 0 || event.ctrlKey) {
      pressIgnored = true;
      return;
    }
    if ((target && anchor.contains(target)) || target === doc.documentElement) return;
    if (event.pointerType === "touch" || event.pointerType === "pen") touchOutside = true;
    else leave();
  };
  const handlePointerCancel = () => {
    touchOutside = false;
  };
  const handleClick = (event: Event) => {
    if (!touchOutside) return;
    touchOutside = false;
    const target = event.target instanceof Node ? event.target : null;
    if (!(target && (root.contains(target) || anchor.contains(target)))) leave();
  };
  const handleKeyDown = () => {
    pressInside = false;
    pressIgnored = false;
    touchOutside = false;
  };
  const handleFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (pressIgnored) {
      // The popover stays, so focus comes back with it, or Esc and Enter would stop working.
      const control = event.target;
      afterFocusSettles(() => {
        const current = doc.activeElement;
        if (!(current && root.contains(current)) && control instanceof HTMLElement) control.focus();
      });
      return;
    }
    if (next instanceof Node) {
      if (!root.contains(next)) leave();
      return;
    }
    // Focus went nowhere. Once it settles, it left unless it is back inside or the press was inside. A window switch
    // keeps `activeElement` on the control, so it commits nothing.
    afterFocusSettles(() => {
      const current = doc.activeElement;
      if (pressInside || (current && root.contains(current))) return;
      leave();
    });
  };
  root.addEventListener("mousedown", handleMouseDown);
  if (onLeave) {
    root.addEventListener("focusout", handleFocusOut);
    doc.addEventListener("pointerdown", handlePointerDown, true);
    doc.addEventListener("pointercancel", handlePointerCancel, true);
    doc.addEventListener("click", handleClick, true);
    doc.addEventListener("keydown", handleKeyDown, true);
  }
  doc.body.append(root);
  return {
    root,
    close() {
      closed = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      root.removeEventListener("mousedown", handleMouseDown);
      root.removeEventListener("focusout", handleFocusOut);
      doc.removeEventListener("pointerdown", handlePointerDown, true);
      doc.removeEventListener("pointercancel", handlePointerCancel, true);
      doc.removeEventListener("click", handleClick, true);
      doc.removeEventListener("keydown", handleKeyDown, true);
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
  const doc = target.ownerDocument;
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || !target.contains(selection.anchorNode)) {
    target.append(text);
    return;
  }
  // The browser's own insertion keeps a trailing space alive for the next keystroke and joins the undo stack; a bare
  // text node from a Range loses that space in Firefox and Safari. The Range stays as the fallback.
  if (typeof doc.execCommand === "function" && doc.execCommand("insertText", false, text)) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = target.ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

const withPlainSpaces = (text: string): string => text.replace(/\u00a0/g, " ");

/**
 * The text a plain-text edit holds. Firefox types a space next to another space, or at the end, as a no-break space,
 * which the stored value doesn't want; one the text already had is deliberate ("10 km"). So only what changed since
 * `start`, the stretch between the common prefix and suffix, is normalised.
 */
function plainText(target: HTMLElement, start: string): string {
  const text = (target.textContent ?? "").trim();
  const limit = Math.min(text.length, start.length);
  let prefix = 0;
  while (prefix < limit && text[prefix] === start[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && text[text.length - 1 - suffix] === start[start.length - 1 - suffix]) suffix += 1;
  const end = text.length - suffix;
  return text.slice(0, prefix) + withPlainSpaces(text.slice(prefix, end)) + text.slice(end);
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
      // Leaving untouched must write nothing, even when the starting value is not the text the page renders. The one
      // exception is a value that failed to save, which is what the text on the page now is.
      const rendered = (target.textContent ?? "").trim();
      // An earlier edit this session can leave Firefox's no-break space on the page after storing a plain one. The
      // stored value says which spaces are meant, as long as it is this text.
      const start =
        typeof ctx.value === "string" && withPlainSpaces(ctx.value).trim() === withPlainSpaces(rendered)
          ? ctx.value.trim()
          : rendered;
      const untouched = plainText(target, start);
      const finish = () => {
        const text = plainText(target, start);
        if (text === untouched && !ctx.unsaved) outcome.cancel();
        else outcome.commit(text);
      };
      const notePopover = note ? openPopover(target, note) : undefined;
      notePopover?.root.classList.add("cms-popover--note");
      if (note) ctx.announce(note);
      setPlainTextEditable(target);

      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          finish();
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
      const handleBlur = () => finish();

      target.addEventListener("keydown", handleKeydown);
      target.addEventListener("paste", handlePaste);
      target.addEventListener("drop", preventDrop);
      target.addEventListener("blur", handleBlur);
      return {
        focus() {
          target.focus();
          placeCaretAtEnd(target);
        },
        commit: finish,
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
  /** The control holds something `read` can't represent, such as a half-typed date. */
  unreadable?(): boolean;
}

/**
 * The shape every popover widget shares: a labelled control in a popover, Esc and Cancel to back out, and
 * leaving the popover commits whatever the control holds (the chrome skips the save when nothing changed).
 */
function formWidget(
  strings: Strings,
  build: (ctx: WidgetContext, outcome: ReturnType<typeof once>, finish: () => void) => FormWidgetParts,
): Widget {
  return {
    mount(ctx): WidgetHandle {
      const outcome = once(ctx);
      const finish = () => {
        // It reads as empty, but the editor didn't empty it: erasing the stored value would be the wrong guess.
        if (parts.unreadable?.()) {
          ctx.announce(format(strings.invalidValueKept, { label: fieldLabel(ctx) }));
          outcome.cancel();
          return;
        }
        const value = parts.read();
        if (JSON.stringify(value) === untouched && !ctx.unsaved) outcome.cancel();
        else outcome.commit(value);
      };
      const parts = build(ctx, outcome, finish);
      // Leaving untouched must write nothing, even when the stored value is missing and the control shows a default.
      // The one exception is a value that failed to save, which the control starts from.
      const untouched = JSON.stringify(parts.read());
      const popover = openPopover(ctx.element, fieldLabel(ctx), finish);
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
        commit: finish,
        destroy() {
          popover.root.removeEventListener("keydown", handleKeydown);
          popover.close();
        },
      };
    },
  };
}

/** How long a key can stay down with no repeat before a date stops counting it as being typed. */
const KEY_HELD_MS = 1000;

function inputWidget(strings: Strings, inputType: "number" | "url" | "date"): Widget {
  return formWidget(strings, (ctx, _outcome, finish) => {
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
    // Enter commits, and so does leaving the popover (see `formWidget`). A number never commits on `change`: it fires
    // on every arrow step and on the blur that pressing Cancel causes.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (input.validity.badInput) ctx.announce(format(strings.invalidValue, { label: fieldLabel(ctx) }));
      else finish();
    });
    if (inputType === "date") {
      // A date fires `change` on every segment typed or stepped in Chromium and Firefox, so a `change` during a
      // keystroke waits for Enter; one from the date picker commits, because picking a day is the whole edit.
      let keying = false;
      let keyingTimer: ReturnType<typeof setTimeout> | undefined;
      const stopKeyingAfter = (delay: number) => {
        if (keyingTimer !== undefined) clearTimeout(keyingTimer);
        keyingTimer = setTimeout(() => {
          keying = false;
          keyingTimer = undefined;
        }, delay);
      };
      input.addEventListener("keydown", () => {
        keying = true;
        // A key that opens the date picker can have its keyup swallowed by the picker.
        stopKeyingAfter(KEY_HELD_MS);
      });
      // A key that moves focus away (Tab) has its keyup elsewhere.
      input.addEventListener("blur", () => {
        keying = false;
      });
      // After the key's own events have fired: a `change` it causes can follow the keyup.
      input.addEventListener("keyup", () => stopKeyingAfter(0));
      input.addEventListener("change", () => {
        if (!keying) finish();
      });
    }
    return { control: input, read, unreadable: () => input.validity.badInput };
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
