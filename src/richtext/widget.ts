// The rich text widget: TipTap edits the host element in place, with a toolbar above it. The approved design is
// docs/specs/artefacts/2026-11-richtext-toolbar.html; the behaviour is documented in docs/chrome.md → Rich text.
import { Editor, Extension } from "@tiptap/core";
import type { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { element, uniqueId } from "../chrome/dom.ts";
import { format, type Strings } from "../chrome/strings.ts";
import type { Widget, WidgetContext, WidgetHandle } from "../chrome/types.ts";
import { contextStrings, fieldLabel, once, trackLeaving } from "../chrome/widgets.ts";
import { headingLevels, parseRichText } from "./render.ts";
import { isAllowedHref, sanitizeRichText } from "./sanitize.ts";

export interface RichTextWidgetOptions {
  /** Overrides for this widget's words, on top of the strings `mountEditor` was given. */
  strings?: Partial<Strings>;
}

type Command = "bold" | "italic" | "link" | "bulletList" | "orderedList" | "h2" | "h3";

const SVG = "http://www.w3.org/2000/svg";

/** An icon drawn from stroked paths (the prototype's), hidden from assistive technology: the button has the name. */
function icon(paths: readonly string[], dots: readonly [number, number][] = []): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  for (const [cx, cy] of dots) {
    const dot = document.createElementNS(SVG, "circle");
    for (const [name, value] of Object.entries({ cx: String(cx), cy: String(cy), r: "1", fill: "currentColor" }))
      dot.setAttribute(name, value);
    svg.append(dot);
  }
  return svg;
}

const linkIcon = () =>
  icon(["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"]);
const bulletIcon = () =>
  icon(
    ["M9 6h11M9 12h11M9 18h11"],
    [
      [4.5, 6],
      [4.5, 12],
      [4.5, 18],
    ],
  );
const numberIcon = () =>
  icon([
    "M10 6h10M10 12h10M10 18h10",
    "M4 4.5 5 4v4M4 8h2M4 11.5a1 1 0 0 1 2 .3c0 .9-2 1.2-2 2.2h2M4 16.5h2l-1 1.2a1 1 0 1 1-1 1.4",
  ]);

function isApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

/**
 * What the editor typed as a link address, made into one: an email address gets `mailto:`, and a bare domain
 * (`example.com`, `example.com:8080/menu`) gets `https://`. A path or anything with a scheme is taken as written.
 */
export function normaliseHref(input: string): string {
  const value = input.trim();
  if (value.startsWith("/")) return value;
  if (/^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/.test(value)) return `mailto:${value}`;
  // A host and port looks like a scheme to the pattern below (`example.com:8080`); a scheme has no dot before a number.
  if (/^[^\s/:]+\.[^\s/:]+:\d+(\/|$)/.test(value)) return `https://${value}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^[^\s/]+\.[^\s]+$/.test(value) ? `https://${value}` : value;
}

const STYLE_ATTRIBUTE = /\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Pasted HTML without `style` attributes or `<style>` elements. ProseMirror parses a paste in a detached document,
 * where a strict `style-src` still refuses them and reports each one. Nothing styled survives the schema anyway. Google
 * Docs wraps a whole paste in `<b style="font-weight:normal">`, which only the style says isn't bold, so that wrapper
 * becomes a `<span>` first.
 */
export function stripInlineStyles(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<b\b([^>]*\bstyle\s*=\s*["']?[^"'>]*font-weight\s*:\s*(normal|400)\b[^>]*)>/gi, "<span$1>")
    .replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(STYLE_ATTRIBUTE, ""));
}

/** True when the pasted content carries any formatting the field keeps: marks, headings or lists. */
function hasFormatting(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (node.marks.length > 0 || !["paragraph", "text", "hardBreak"].includes(node.type.name)) found = true;
    return !found;
  });
  return found;
}

/** Classes ProseMirror and this widget add to the host element; the chrome's own `cms-` classes are left alone. */
const BORROWED_CLASSES = ["tiptap", "ProseMirror", "ProseMirror-focused", "cms-richtext"];

export function createRichTextWidget(options: RichTextWidgetOptions = {}): Widget {
  return {
    mount(ctx: WidgetContext): WidgetHandle {
      const strings: Strings = { ...contextStrings(ctx), ...options.strings };
      return mountRichText(ctx, strings);
    },
  };
}

/** The rich text widget with the editor's strings. */
export const richTextWidget: Widget = createRichTextWidget();

function mountRichText(ctx: WidgetContext, strings: Strings): WidgetHandle {
  const target = ctx.element;
  const doc = target.ownerDocument;
  const view = doc.defaultView ?? window;
  const label = fieldLabel(ctx);
  const levels = headingLevels(target);
  const clean = (html: string) => sanitizeRichText(html, { headings: levels });
  const outcome = once(ctx);
  const apple = isApple();
  // On Apple devices the keys are their standard symbols; elsewhere their names come from the strings.
  const mod = (key: string) => (apple ? `⌘${key}` : `${strings.keyControl}+${key}`);
  const shift = (key: string) => (apple ? `⇧${key}` : `${strings.keyShift}+${key}`);
  const alt = (key: string) => (apple ? `⌥${key}` : `${strings.keyAlt}+${key}`);

  const originalNodes = [...target.childNodes].map((node) => node.cloneNode(true));
  // ProseMirror sets attributes on the element it edits in place, and takes `tabindex` off. All of them go back as they
  // were, except the class list and the chrome's state attribute, which the chrome changes while the widget is open.
  const keepAttribute = (name: string) => name !== "class" && !name.startsWith("data-cms-");
  const borrowed = new Map(
    [...target.attributes].filter((attribute) => keepAttribute(attribute.name)).map((a) => [a.name, a.value]),
  );
  // The stored value, unless it is only the page's text standing in for it (no payload and no `data-edit-value`): the
  // element's own markup then says more.
  const rendered = target.innerHTML;
  const start =
    typeof ctx.value === "string" && ctx.value.trim() !== (target.textContent ?? "").trim() ? ctx.value : rendered;

  /** What closing puts back in the element: the original, or the edited document rendered from the schema. */
  let closing: Node[] = originalNodes;
  let pasted: { from: number; to: number; slice: Slice; text: string; mode: "keep" | "plain" } | undefined;
  let switching = false;
  /** Set while the widget changes the document itself, for the paste options. */
  let ownChange = false;
  let rovingIndex = 0;

  // ---------- Toolbar ----------

  const tooltip = element("span", { class: "cms-tooltip", "aria-hidden": "true" });
  const shortcuts = new Map<HTMLElement, string>();
  const toggles = new Map<Command, HTMLButtonElement>();
  /** What the tooltip calls each button: its string, even where the accessible name also carries the visible text. */
  const tooltipNames = new Map<HTMLElement, string>();
  /**
   * `glyph` is drawn and hidden from assistive technology, and `name` labels the button, unless `visibleText` is given:
   * then the button's name starts with that text and adds `name` visually hidden ("H2 Heading"), so a speech user can
   * say what they see (WCAG 2.5.3).
   */
  const toolButton = (
    command: Command,
    name: string,
    glyph: Node,
    shortcut: string,
    aria: string,
    visibleText?: string,
  ) => {
    const node = element("button", {
      type: "button",
      class: "cms-btn cms-toolbar__btn",
      "aria-pressed": "false",
      "aria-label": visibleText === undefined ? name : undefined,
      "aria-keyshortcuts": aria,
      "data-command": command,
    });
    if (visibleText === undefined) node.append(glyph);
    else node.append(visibleText, element("span", { class: "cms-visually-hidden" }, [` ${name}`]));
    tooltipNames.set(node, name);
    shortcuts.set(node, shortcut);
    toggles.set(command, node);
    return node;
  };
  const glyph = (tag: "b" | "span", text: string, className?: string) =>
    element(tag, { "aria-hidden": "true", class: className }, [text]);
  const separator = () => element("span", { class: "cms-toolbar__sep", "aria-hidden": "true" });

  const linkRowId = uniqueId("cms-link-row");
  const bold = toolButton("bold", strings.bold, glyph("b", "B"), mod("B"), "Control+B Meta+B");
  const italic = toolButton(
    "italic",
    strings.italic,
    glyph("span", "I", "cms-toolbar__italic"),
    mod("I"),
    "Control+I Meta+I",
  );
  const link = toolButton("link", strings.link, linkIcon(), mod("K"), "Control+K Meta+K");
  link.setAttribute("aria-expanded", "false");
  link.setAttribute("aria-controls", linkRowId);
  const bullets = toolButton(
    "bulletList",
    strings.bulletList,
    bulletIcon(),
    mod(shift("8")),
    "Control+Shift+8 Meta+Shift+8",
  );
  const numbers = toolButton(
    "orderedList",
    strings.orderedList,
    numberIcon(),
    mod(shift("7")),
    "Control+Shift+7 Meta+Shift+7",
  );
  const headingButtons = levels.map((level) =>
    toolButton(
      `h${level}`,
      level === 2 ? strings.heading : strings.subheading,
      document.createTextNode(""),
      mod(alt(String(level))),
      `Control+Alt+${level} Meta+Alt+${level}`,
      format(strings.headingGlyph, { level }),
    ),
  );
  const cancel = element("button", { type: "button", class: "cms-btn cms-btn--ghost", "aria-keyshortcuts": "Escape" }, [
    strings.cancel,
  ]);
  shortcuts.set(cancel, strings.keyEscape);
  const done = element(
    "button",
    { type: "button", class: "cms-btn cms-btn--primary", "aria-keyshortcuts": "Control+Enter Meta+Enter" },
    [strings.done],
  );
  shortcuts.set(done, mod(apple ? "↩" : strings.keyEnter));

  const pasteMessage = element("p", {}, [strings.pastedFormatted]);
  const keepButton = element("button", { type: "button", class: "cms-btn cms-toolbar__btn", "aria-pressed": "true" }, [
    strings.keepFormatting,
  ]);
  const plainButton = element(
    "button",
    {
      type: "button",
      class: "cms-btn cms-toolbar__btn",
      "aria-pressed": "false",
      "aria-keyshortcuts": "Control+Shift+V Meta+Shift+V",
    },
    [strings.plainText],
  );
  shortcuts.set(plainButton, mod(shift("V")));
  const pasteRow = element(
    "div",
    { class: "cms-toolbar__paste", role: "group", "aria-label": strings.pasteOptions, hidden: true },
    [pasteMessage, keepButton, plainButton],
  );

  const linkInput = element("input", {
    class: "cms-input",
    type: "url",
    inputmode: "url",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: strings.linkPlaceholder,
  });
  const linkError = element("div", { class: "cms-diff", id: uniqueId("cms-link-error"), hidden: true });
  linkInput.setAttribute("aria-describedby", linkError.id);
  const applyLink = element("button", { type: "button", class: "cms-btn cms-btn--primary" }, [strings.applyLink]);
  const removeLink = element("button", { type: "button", class: "cms-btn cms-btn--danger", hidden: true }, [
    strings.removeLink,
  ]);
  const linkRow = element("div", { class: "cms-toolbar__link", id: linkRowId, hidden: true }, [
    element("label", { class: "cms-field-label" }, [
      strings.linkAddress,
      element("span", { class: "cms-toolbar__link-row" }, [linkInput, applyLink, removeLink]),
    ]),
    linkError,
  ]);

  const toolbar = element(
    "div",
    { class: "cms-root cms-toolbar", role: "toolbar", "aria-label": format(strings.formatting, { label }) },
    [
      bold,
      italic,
      link,
      separator(),
      bullets,
      numbers,
      ...(headingButtons.length > 0
        ? [separator(), element("span", { class: "cms-toolbar__group" }, headingButtons)]
        : []),
      element("span", { class: "cms-toolbar__actions" }, [cancel, done]),
      pasteRow,
      linkRow,
    ],
  );

  /** The toolbar's single tab stop moves among these with the arrow keys (the ARIA toolbar pattern). */
  const roving = (): HTMLButtonElement[] => [
    bold,
    italic,
    link,
    bullets,
    numbers,
    ...headingButtons,
    cancel,
    done,
    ...(pasteRow.hidden ? [] : [keepButton, plainButton]),
  ];
  const rove = (index: number, focus = true) => {
    const buttons = roving();
    rovingIndex = (index + buttons.length) % buttons.length;
    for (const node of [keepButton, plainButton]) node.tabIndex = -1;
    buttons.forEach((node, at) => (node.tabIndex = at === rovingIndex ? 0 : -1));
    if (focus) buttons[rovingIndex]?.focus();
  };
  rove(0, false);

  // ---------- Editor ----------

  const finish = () => {
    const html = editor.isEmpty ? "" : clean(editor.getHTML());
    if (html === untouched && !ctx.unsaved) {
      outcome.cancel();
      return;
    }
    closing = renderStored(html);
    outcome.commit(html);
  };
  /**
   * The stored value as nodes, so the field shows what was saved rather than the editor's own rendering (a heading
   * inside a list item, say, is stored as a paragraph). Parsed in an inert document, from sanitised HTML only: the live
   * page never sees `innerHTML`.
   */
  const renderStored = (html: string): Node[] => parseRichText(html, doc);
  const cancelEdit = () => {
    closing = originalNodes;
    outcome.cancel();
  };
  const toToolbar = () => {
    hideTooltip();
    if (!pasteRow.hidden && toolbarFocusTarget === "paste") rove(roving().indexOf(plainButton));
    else rove(rovingIndex);
  };
  let toolbarFocusTarget: "paste" | "last" = "last";

  const Keys = Extension.create({
    name: "cmsRichTextKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        "Mod-Enter": () => {
          finish();
          return true;
        },
        "Mod-k": () => {
          openLinkRow();
          return true;
        },
        "Alt-F10": () => {
          toolbarFocusTarget = "paste";
          toToolbar();
          toolbarFocusTarget = "last";
          return true;
        },
        // In a list Tab nests the item; where it can't (the first item), it goes to the toolbar like anywhere else,
        // rather than letting the browser move focus out of the field, which would commit.
        Tab: ({ editor: current }) => {
          if (current.isActive("listItem") && current.commands.sinkListItem("listItem")) return true;
          toToolbar();
          return true;
        },
        Escape: () => {
          cancelEdit();
          return true;
        },
      };
    },
  });

  target.replaceChildren();
  const editor: Editor = new Editor({
    element: { mount: target },
    injectCSS: false,
    content: clean(start),
    extensions: [
      StarterKit.configure({
        blockquote: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        trailingNode: false,
        heading: levels.length > 0 ? { levels: [...levels] } : false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: "https",
          HTMLAttributes: { target: null, rel: null, class: null },
          isAllowedUri: (url) => isAllowedHref(url),
        },
      }),
      Keys,
    ],
    editorProps: {
      attributes: { class: "cms-richtext", "aria-label": label, "aria-multiline": "true" },
      transformPastedHTML: stripInlineStyles,
      handlePaste: (editorView: EditorView, event: ClipboardEvent, slice: Slice) => {
        if (switching) return false;
        hidePasteRow();
        if (!hasFormatting(slice)) return false;
        const from = editorView.state.selection.from;
        const transaction = editorView.state.tr
          .replaceSelection(slice)
          .scrollIntoView()
          .setMeta("paste", true)
          .setMeta("uiEvent", "paste");
        ownChange = true;
        try {
          editorView.dispatch(transaction);
        } finally {
          ownChange = false;
        }
        pasted = {
          from,
          to: editorView.state.selection.from,
          slice,
          text: event.clipboardData?.getData("text/plain") ?? slice.content.textBetween(0, slice.content.size, "\n"),
          mode: "keep",
        };
        showPasteRow("keep");
        ctx.announce(strings.pasteAnnounce);
        return true;
      },
    },
    onTransaction: ({ transaction }) => {
      // The paste options act on the pasted range as it was; any other change moves it, so they go.
      if (transaction.docChanged && !ownChange) hidePasteRow();
      syncPressed();
    },
  });
  const untouched = editor.isEmpty ? "" : clean(editor.getHTML());

  function syncPressed(): void {
    const active: Record<Command, boolean> = {
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      link: editor.isActive("link") || !linkRow.hidden,
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      h2: editor.isActive("heading", { level: 2 }),
      h3: editor.isActive("heading", { level: 3 }),
    };
    for (const [command, node] of toggles) node.setAttribute("aria-pressed", String(active[command]));
  }

  function run(command: Command): void {
    if (command === "link") {
      openLinkRow();
      return;
    }
    // Focus goes back at once (`view.focus()`); TipTap's focus command would wait a frame.
    editor.view.focus();
    const chain = editor.chain();
    if (command === "bold") chain.toggleBold();
    else if (command === "italic") chain.toggleItalic();
    else if (command === "bulletList") chain.toggleBulletList();
    else if (command === "orderedList") chain.toggleOrderedList();
    else chain.toggleHeading({ level: command === "h2" ? 2 : 3 });
    chain.run();
  }

  // ---------- Link row ----------

  /**
   * ProseMirror reads a selection made with the keyboard on the next `selectionchange`, so a shortcut pressed straight
   * after Shift+Home would see the old one. The link row is about to take focus and restore ProseMirror's selection
   * later, so it reads the browser's first.
   */
  function takeBrowserSelection(): void {
    const selection = doc.getSelection();
    const { anchorNode, focusNode } = selection ?? {};
    if (!selection || !anchorNode || !focusNode || !target.contains(anchorNode) || !target.contains(focusNode)) return;
    const editorView = editor.view;
    try {
      const anchor = editorView.posAtDOM(anchorNode, selection.anchorOffset);
      const head = editorView.posAtDOM(focusNode, selection.focusOffset);
      const current = editorView.state.selection;
      if (current.anchor === anchor && current.head === head) return;
      const { doc: content } = editorView.state;
      editorView.dispatch(
        editorView.state.tr.setSelection(TextSelection.between(content.resolve(anchor), content.resolve(head))),
      );
    } catch {
      // A position ProseMirror can't map keeps the selection it has.
    }
  }

  function openLinkRow(): void {
    takeBrowserSelection();
    hideTooltip();
    const inLink = editor.isActive("link");
    if (inLink) editor.chain().extendMarkRange("link").run();
    linkInput.value = inLink ? String(editor.getAttributes("link")["href"] ?? "") : "";
    removeLink.hidden = !inLink;
    clearLinkError();
    linkRow.hidden = false;
    link.setAttribute("aria-expanded", "true");
    syncPressed();
    place();
    linkInput.focus();
    linkInput.select();
  }
  function closeLinkRow(returnToText = true): void {
    if (linkRow.hidden) return;
    // Focus goes back before the row hides: hiding the focused input would drop focus to the body, which is leaving.
    // `view.focus()` is synchronous; TipTap's focus command waits a frame.
    if (returnToText) editor.view.focus();
    linkRow.hidden = true;
    link.setAttribute("aria-expanded", "false");
    syncPressed();
    place();
  }
  function clearLinkError(): void {
    linkError.hidden = true;
    linkError.replaceChildren();
    linkInput.removeAttribute("aria-invalid");
  }
  function applyLinkRow(): void {
    const href = normaliseHref(linkInput.value);
    if (!isAllowedHref(href)) {
      linkError.replaceChildren(element("p", { class: "cms-error" }, [strings.linkRefused]));
      linkError.hidden = false;
      linkInput.setAttribute("aria-invalid", "true");
      ctx.announce(strings.linkRefused);
      return;
    }
    editor.view.focus();
    const chain = editor.chain();
    if (editor.state.selection.empty && !editor.isActive("link"))
      chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] });
    else chain.extendMarkRange("link").setLink({ href });
    chain.run();
    closeLinkRow();
  }

  // ---------- Paste options ----------

  function showPasteRow(mode: "keep" | "plain"): void {
    pasteMessage.textContent = mode === "keep" ? strings.pastedFormatted : strings.pastedPlain;
    keepButton.setAttribute("aria-pressed", String(mode === "keep"));
    plainButton.setAttribute("aria-pressed", String(mode === "plain"));
    pasteRow.hidden = false;
    rove(rovingIndex, false);
    place();
  }
  function hidePasteRow(): void {
    pasted = undefined;
    if (pasteRow.hidden) return;
    if (pasteRow.contains(doc.activeElement)) editor.view.focus();
    pasteRow.hidden = true;
    rove(Math.min(rovingIndex, roving().length - 1), false);
    place();
  }
  function switchPaste(mode: "keep" | "plain"): void {
    if (!pasted || pasted.mode === mode) return;
    const current = pasted;
    const editorView = editor.view;
    const range = TextSelection.between(
      editorView.state.doc.resolve(current.from),
      editorView.state.doc.resolve(current.to),
    );
    editorView.dispatch(editorView.state.tr.setSelection(range));
    switching = true;
    ownChange = true;
    try {
      if (mode === "plain") editorView.pasteText(current.text);
      else editorView.dispatch(editorView.state.tr.replaceSelection(current.slice).scrollIntoView());
    } finally {
      switching = false;
      ownChange = false;
    }
    pasted = { ...current, to: editorView.state.selection.from, mode };
    showPasteRow(mode);
  }

  // ---------- Tooltip and placement ----------

  /**
   * The tooltip is the toolbar's child, not the button's: inside the button it would count as the button's visible text,
   * which then wouldn't match its name (WCAG 2.5.3). It is placed under the button through custom properties.
   */
  let tooltipFor: HTMLElement | undefined;
  function showTooltip(node: HTMLElement): void {
    const shortcut = shortcuts.get(node);
    if (!shortcut) return hideTooltip();
    tooltip.replaceChildren(tooltipNames.get(node) ?? node.textContent ?? "", element("kbd", {}, [shortcut]));
    const bar = toolbar.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    tooltip.style.setProperty("--cms-tooltip-left", `${box.left - bar.left + box.width / 2}px`);
    tooltip.style.setProperty("--cms-tooltip-top", `${box.bottom - bar.top}px`);
    toolbar.append(tooltip);
    tooltipFor = node;
  }
  function hideTooltip(): void {
    tooltip.remove();
    tooltipFor = undefined;
  }

  /** Over the field's top edge; held inside the window while the field scrolls past. Under 40em the CSS docks it. */
  function place(): void {
    const rect = target.getBoundingClientRect();
    const height = toolbar.offsetHeight;
    const width = toolbar.offsetWidth;
    const top = Math.max(rect.top, height + 8);
    const left = Math.max(16, Math.min(rect.left, view.innerWidth - width - 16));
    toolbar.style.setProperty("--cms-toolbar-top", `${top}px`);
    toolbar.style.setProperty("--cms-toolbar-left", `${left}px`);
  }
  let frame: number | undefined;
  const schedulePlace = () => {
    if (frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      place();
    });
  };

  // ---------- Events ----------

  const onToolbarMouseDown = (event: MouseEvent) => {
    // Presses on the buttons keep the caret and selection in the text. The link input takes focus as usual.
    const hit = event.target instanceof Element ? event.target : null;
    if (!hit?.closest("input")) event.preventDefault();
  };
  const activate = (node: HTMLElement) => {
    const command = node.dataset.command as Command | undefined;
    if (command) run(command);
    else if (node === cancel) cancelEdit();
    else if (node === done) finish();
    else if (node === keepButton) switchPaste("keep");
    else if (node === plainButton) switchPaste("plain");
    else if (node === applyLink) applyLinkRow();
    else if (node === removeLink) {
      editor.view.focus();
      editor.chain().extendMarkRange("link").unsetLink().run();
      closeLinkRow();
    }
  };
  const onToolbarClick = (event: MouseEvent) => {
    const node = event.target instanceof Element ? event.target.closest("button") : null;
    if (!node || !toolbar.contains(node)) return;
    const index = roving().indexOf(node);
    if (index >= 0) rove(index, false);
    activate(node);
  };
  const onToolbarKeyDown = (event: KeyboardEvent) => {
    const node = event.target instanceof HTMLElement ? event.target : null;
    if (!node) return;
    if (node === linkInput) {
      if (event.key === "Enter") {
        event.preventDefault();
        applyLinkRow();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLinkRow();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (tooltip.isConnected) hideTooltip();
      else if (!linkRow.hidden && linkRow.contains(node)) closeLinkRow();
      else editor.view.focus();
      return;
    }
    const index = roving().indexOf(node as HTMLButtonElement);
    if (index < 0) return;
    const keys: Record<string, () => void> = {
      ArrowRight: () => rove(index + 1),
      ArrowLeft: () => rove(index - 1),
      Home: () => rove(0),
      End: () => rove(roving().length - 1),
      // Activated here, not by the browser: focus moves to the text, which must not then receive the key.
      Enter: () => activate(node),
      " ": () => activate(node),
    };
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      action();
    } else if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      editor.view.focus();
    }
  };
  const onTooltipIn = (event: Event) => {
    const node = event.target instanceof Element ? event.target.closest("button") : null;
    if (node && toolbar.contains(node)) showTooltip(node);
  };
  const onTooltipOut = (event: Event) => {
    const node = event.target instanceof Element ? event.target.closest("button") : null;
    if (node && tooltipFor === node && doc.activeElement !== node) hideTooltip();
  };
  const onFocusOut = (event: FocusEvent) => {
    const node = event.target instanceof Element ? event.target.closest("button") : null;
    if (node && tooltipFor === node) hideTooltip();
  };
  const onLinkInput = () => clearLinkError();
  const onEditorKeyDown = (event: KeyboardEvent) => {
    if (pasteRow.hidden) return;
    const modifierOnly = ["Shift", "Control", "Meta", "Alt"].includes(event.key);
    const pasting = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
    if (pasting && event.shiftKey && pasted) {
      // The Plain text button's shortcut: switch the paste just made, rather than paste a second, plain copy.
      event.preventDefault();
      switchPaste("plain");
      return;
    }
    if (!modifierOnly && !pasting && !(event.altKey && event.key === "F10")) hidePasteRow();
  };
  const onEditorPointerDown = () => hidePasteRow();
  const onEditorEscape = (event: KeyboardEvent) => {
    // ProseMirror handles Esc through the keymap; nothing else on the page should also act on it.
    if (event.key === "Escape") event.stopPropagation();
  };

  toolbar.addEventListener("mousedown", onToolbarMouseDown);
  toolbar.addEventListener("click", onToolbarClick);
  toolbar.addEventListener("keydown", onToolbarKeyDown);
  toolbar.addEventListener("mouseover", onTooltipIn);
  toolbar.addEventListener("focusin", onTooltipIn);
  toolbar.addEventListener("mouseout", onTooltipOut);
  toolbar.addEventListener("focusout", onFocusOut);
  linkInput.addEventListener("input", onLinkInput);
  target.addEventListener("keydown", onEditorKeyDown, true);
  target.addEventListener("keydown", onEditorEscape);
  target.addEventListener("pointerdown", onEditorPointerDown);
  view.addEventListener("scroll", schedulePlace, { capture: true, passive: true });
  view.addEventListener("resize", schedulePlace, { passive: true });

  doc.body.append(toolbar);
  place();
  syncPressed();
  const tracker = trackLeaving(target, toolbar, finish, { anchorIsInside: true });

  return {
    // At once, not TipTap's `focus("end")`, which waits a frame: keys pressed meanwhile (Ctrl+K opening the link row)
    // would have focus pulled back to the text afterwards.
    focus: () => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.view.focus();
    },
    commit: finish,
    destroy() {
      tracker.close();
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      view.removeEventListener("scroll", schedulePlace, { capture: true });
      view.removeEventListener("resize", schedulePlace);
      target.removeEventListener("keydown", onEditorKeyDown, true);
      target.removeEventListener("keydown", onEditorEscape);
      target.removeEventListener("pointerdown", onEditorPointerDown);
      toolbar.remove();
      editor.destroy();
      for (const { name } of [...target.attributes])
        if (keepAttribute(name) && !borrowed.has(name)) target.removeAttribute(name);
      for (const [name, value] of borrowed) target.setAttribute(name, value);
      target.classList.remove(...BORROWED_CLASSES);
      target.replaceChildren(...closing);
    },
  };
}
