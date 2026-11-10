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

/** Options for the chrome's own popovers. Not part of `openPopover`'s public contract. */
interface PopoverOptions {
  onLeave?: (() => void) | undefined;
  /**
   * A press on the popover off its controls keeps focus where it was, so Esc and Enter go on working. Only the chrome's
   * default widgets ask for it: it prevents `mousedown`, which would break text selection, drag and drop and custom
   * controls in a host's popover.
   */
  keepFocus?: boolean;
}

/**
 * A small dialog anchored under a field, themed by `.cms-root` so it picks up the tokens wherever it is appended.
 * Under 40em the stylesheet turns it into a bottom sheet. Exported so host widgets can reuse it.
 *
 * `onLeave` fires at most once per popover, when the editor leaves it: a completed primary press or tap outside the
 * popover and `anchor`, or focus moving out of the popover. A press that opens a context menu isn't leaving. Anything
 * of the host's outside the popover's own element counts as outside, including a dropdown it appends to `body`. It
 * never fires after `close()`. Presses inside the popover are left to the browser.
 */
export function openPopover(anchor: HTMLElement, label: string, onLeave?: () => void): Popover {
  return openChromePopover(anchor, label, { onLeave });
}

function openChromePopover(anchor: HTMLElement, label: string, options: PopoverOptions = {}): Popover {
  const { onLeave } = options;
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
  // A press outside that may not be the editor leaving. "pending" is a primary mouse press: it leaves once it
  // completes, unless it opens a context menu first (a Mac's Ctrl+click). "ignored" is a press that isn't leaving (a
  // right-click), for as long as its own focus change takes. Nothing after that is ignored.
  let outsidePress: "pending" | "ignored" | undefined;
  // The control a pending press took focus from, in case the press turns out not to be leaving.
  let focusTakenFrom: HTMLElement | undefined;
  // A touch outside may turn into a scroll, so it only counts once it completes as a tap.
  let touchOutside = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
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
  const clearPressTimer = () => {
    if (pressTimer !== undefined) clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  /**
   * A press that wasn't leaving took focus from `control`. Focus that went nowhere comes back, or Esc and Enter would
   * stop working with the popover still open. Focus on something the editor pressed, such as a host input
   * right-clicked for its Paste, stays there.
   */
  const handBackFocus = (control: HTMLElement | undefined) => {
    if (!control) return;
    afterFocusSettles(() => {
      const current = doc.activeElement;
      if (current === null || current === doc.body || current === doc.documentElement) control.focus();
    });
  };
  const ignorePress = () => {
    clearPressTimer();
    outsidePress = "ignored";
    handBackFocus(focusTakenFrom);
    focusTakenFrom = undefined;
    // Its own focus change comes with the press. A later one, from a host script or assistive technology, counts.
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      if (outsidePress === "ignored") outsidePress = undefined;
    }, 0);
  };
  const completePress = () => {
    if (outsidePress !== "pending") return;
    clearPressTimer();
    outsidePress = undefined;
    focusTakenFrom = undefined;
    leave();
  };
  // A press off the controls would drop focus to the body with the popover still open, and Esc and Enter with it.
  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(POPOVER_CONTROLS);
    if (!control || !root.contains(control)) event.preventDefault();
  };
  // Clicking content that cannot take focus, and any button in Safari, moves focus nowhere, so `focusout` alone misses
  // it. A primary press outside the popover and its field commits once it completes. A right-click or middle-click
  // isn't leaving, and neither is a primary press that opens a context menu: `contextmenu` says so before the press
  // completes, so no platform's modifier keys need guessing. The root scrollbar's press has the root as its target. An
  // empty stretch of the root has that target too, but a click there drops focus, which `handleFocusOut` catches.
  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    pressInside = target !== null && root.contains(target);
    clearPressTimer();
    outsidePress = undefined;
    focusTakenFrom = undefined;
    touchOutside = false;
    if (pressInside) return;
    if (event.button !== 0) {
      ignorePress();
      return;
    }
    if ((target && anchor.contains(target)) || target === doc.documentElement) return;
    if (event.pointerType === "touch" || event.pointerType === "pen") touchOutside = true;
    else outsidePress = "pending";
  };
  const handleContextMenu = () => {
    if (outsidePress === "pending") ignorePress();
  };
  const handlePointerUp = () => {
    if (outsidePress !== "pending") return;
    // The click that follows completes it first. One released where no click follows completes here.
    clearPressTimer();
    pressTimer = setTimeout(completePress, 0);
  };
  const handlePointerCancel = (event: PointerEvent) => {
    touchOutside = false;
    // A mouse press cancelled by a drag starting outside is still the editor leaving.
    if (event.pointerType !== "touch" && event.pointerType !== "pen") handlePointerUp();
  };
  const handleClick = (event: Event) => {
    if (outsidePress === "pending") {
      completePress();
      return;
    }
    if (!touchOutside) return;
    touchOutside = false;
    const target = event.target instanceof Node ? event.target : null;
    if (!(target && (root.contains(target) || anchor.contains(target)))) leave();
  };
  const handleKeyDown = () => {
    pressInside = false;
    touchOutside = false;
  };
  const handleFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    if (outsidePress !== undefined) {
      // The press decides: it leaves if it completes, and hands focus back if it isn't leaving.
      const control = event.target instanceof HTMLElement ? event.target : undefined;
      if (outsidePress === "ignored") handBackFocus(control);
      else focusTakenFrom = control;
      return;
    }
    if (next instanceof Node) {
      leave();
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
  if (options.keepFocus) root.addEventListener("mousedown", handleMouseDown);
  if (onLeave) {
    root.addEventListener("focusout", handleFocusOut);
    doc.addEventListener("pointerdown", handlePointerDown, true);
    doc.addEventListener("pointerup", handlePointerUp, true);
    doc.addEventListener("pointercancel", handlePointerCancel, true);
    doc.addEventListener("contextmenu", handleContextMenu, true);
    doc.addEventListener("click", handleClick, true);
    doc.addEventListener("keydown", handleKeyDown, true);
  }
  doc.body.append(root);
  return {
    root,
    close() {
      closed = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      clearPressTimer();
      root.removeEventListener("mousedown", handleMouseDown);
      root.removeEventListener("focusout", handleFocusOut);
      doc.removeEventListener("pointerdown", handlePointerDown, true);
      doc.removeEventListener("pointerup", handlePointerUp, true);
      doc.removeEventListener("pointercancel", handlePointerCancel, true);
      doc.removeEventListener("contextmenu", handleContextMenu, true);
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
 * `start`, the stretch between the common prefix and suffix, is normalised. The page can render a deliberate one as a
 * plain space, so the two count as the same character there, and the unchanged parts are taken from `start`.
 */
function plainText(target: HTMLElement, start: string): string {
  const text = (target.textContent ?? "").trim();
  const same = (left: string | undefined, right: string | undefined) =>
    left === right || (left !== undefined && right !== undefined && withPlainSpaces(left + right) === "  ");
  const limit = Math.min(text.length, start.length);
  let prefix = 0;
  while (prefix < limit && same(text[prefix], start[prefix])) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && same(text[text.length - 1 - suffix], start[start.length - 1 - suffix])) suffix += 1;
  return (
    start.slice(0, prefix) +
    withPlainSpaces(text.slice(prefix, text.length - suffix)) +
    start.slice(start.length - suffix)
  );
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
      const notePopover = note ? openChromePopover(target, note, { keepFocus: true }) : undefined;
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
 * Exported for the tests only; `index.ts` doesn't re-export it.
 */
export function formWidget(
  strings: Strings,
  build: (ctx: WidgetContext, outcome: ReturnType<typeof once>, finish: () => void) => FormWidgetParts,
): Widget {
  return {
    mount(ctx): WidgetHandle {
      const outcome = once(ctx);
      // Filled in once `build` returns. A `finish` it calls before then runs once the widget is mounted.
      const state: { built?: { parts: FormWidgetParts; untouched: string }; finishWhenBuilt?: boolean } = {};
      const finish = () => {
        const { built } = state;
        if (!built) {
          state.finishWhenBuilt = true;
          return;
        }
        // It reads as empty, but the editor didn't empty it: erasing the stored value would be the wrong guess.
        if (built.parts.unreadable?.()) {
          ctx.announce(format(strings.invalidValueKept, { label: fieldLabel(ctx) }));
          outcome.cancel();
          return;
        }
        const value = built.parts.read();
        if (JSON.stringify(value) === built.untouched && !ctx.unsaved) outcome.cancel();
        else outcome.commit(value);
      };
      const parts = build(ctx, outcome, finish);
      // Leaving untouched must write nothing, even when the stored value is missing and the control shows a default.
      // The one exception is a value that failed to save, which the control starts from.
      state.built = { parts, untouched: JSON.stringify(parts.read()) };
      // After `mount` returns, so the chrome holds the handle that closing the widget destroys.
      if (state.finishWhenBuilt) queueMicrotask(finish);
      const popover = openChromePopover(ctx.element, fieldLabel(ctx), { onLeave: finish, keepFocus: true });
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

/**
 * The keys that type or step a date's segments. Space, Enter, Alt+ArrowDown and F4 open the date picker instead, and
 * a day picked from it must commit at once, however soon after.
 */
function editsDateSegment(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  if (/^[0-9]$/.test(event.key)) return true;
  if (event.altKey) return false;
  return [
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
    "Delete",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(event.key);
}

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
      // Only segment keys count (see `editsDateSegment`): a key that opens the picker may never send its keyup.
      let keying = false;
      let keyingTimer: ReturnType<typeof setTimeout> | undefined;
      const stopKeying = () => {
        if (keyingTimer !== undefined) clearTimeout(keyingTimer);
        keyingTimer = undefined;
        keying = false;
      };
      input.addEventListener("keydown", (event) => {
        if (!editsDateSegment(event)) return;
        if (keyingTimer !== undefined) clearTimeout(keyingTimer);
        keyingTimer = undefined;
        keying = true;
      });
      // A key that moves focus away has its keyup elsewhere.
      input.addEventListener("blur", stopKeying);
      // After the key's own events have fired: a `change` it causes can follow the keyup.
      input.addEventListener("keyup", () => {
        if (!keying) return;
        if (keyingTimer !== undefined) clearTimeout(keyingTimer);
        keyingTimer = setTimeout(stopKeying, 0);
      });
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
      const popover = openChromePopover(ctx.element, message, { keepFocus: true });
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
