# The editor chrome: `@yl/editor/chrome`

The in-place editor that signed-in editors see on top of a server-rendered page: dashed outlines on every editable
field with a badge naming it, a widget that opens on click or Enter, drafts that save as you go, and a bottom bar
with Done, Discard and Publish. It is a framework-free TypeScript island plus one stylesheet. It knows nothing about
your database or your brand: it talks to the server through the HTTP contract below, and every colour, size and
radius comes from `--cms-*` custom properties a host overrides from one CSS file.

## Mounting it

Three rules keep visitors' pages clean and cheap:

1. **Render `data-edit-*` only for signed-in editors.** `editable(docKey)` returns the attributes; pass `undefined`
   for everyone else and it returns `{}`, so anonymous HTML carries no editor markup at all.
2. **Load the island only for them.** The script and the stylesheet are never part of the public bundle.
3. **Call `mountEditor()`** once the page has rendered.

```astro
---
import { editable } from "@yl/editor";
const editor = Astro.locals.editor; // however your app knows the visitor may edit
const field = editable(editor ? `pages/${page.slug}` : undefined);
---
<h1 {...field("title", "text", { label: "Heading" })}>{page.payload.title}</h1>
<p {...field("lede", "richtext", { label: "Lede" })} set:html={page.payload.lede} />
<span {...field("status", "select", { label: "Status", options: ["draft", "live", "archived"] })}>
  {page.payload.status}
</span>

{editor && (
  <script>
    import "@yl/editor/chrome/chrome.css";
    import { mountEditor } from "@yl/editor/chrome";
    mountEditor({ actorLabel: document.body.dataset.actorLabel });
  </script>
)}
```

Any other server-rendered stack works the same way: emit the attributes from `editable()` for editors only, and
include a bundled module that imports the stylesheet and calls `mountEditor`. Nothing else is required in the
markup. A field may also carry `data-edit-value` (JSON) when the rendered text is not the stored value, for example a
date shown as "14 Nov"; without it the chrome reads the element's text until the server returns the payload.

### `editable(docKey)(path, type, attrs?)`

| Attribute           | Source                 | Meaning                                      |
| ------------------- | ---------------------- | -------------------------------------------- |
| `data-edit-field`   | `"<docKey>:<path>"`    | Which document and which dotted payload path |
| `data-edit-type`    | `type`                 | One of the `EditFieldType` union             |
| `data-edit-options` | `attrs.options` (JSON) | Choices for a `select`                       |
| `data-edit-label`   | `attrs.label`          | Human name shown in the badge                |

`EditFieldType` is `"text" | "richtext" | "media" | "select" | "number" | "url" | "date" | "tags" | "toggle"`.

### Options

```ts
mountEditor({
  base: "/api/content", // where the wire contract lives
  root: document.body, // element scanned for [data-edit-field]
  widgets: { richtext: myRichWidget },
  panels: [myPanel],
  actorLabel: "Editing as Maya (Editor)",
  strings: { publish: "Make live" }, // any visible text, see src/chrome/strings.ts
  onExit: () => location.reload(), // called when the editor presses Done
});
```

It returns `{ api, ready, destroy }`. `ready` resolves when the first load has finished. `destroy()` removes every
node, class, attribute and listener the chrome added and leaves the host's markup as it found it.

## Behaviour

- On mount the chrome scans `root` for `[data-edit-field]`, groups the fields by document key, and makes one
  `GET documents` request for all the keys. It keeps each document's `version` and `access`.
- Every field gets the highlight. A field whose document lacks `access.edit` is still outlined, in the muted
  colour, and its badge and accessible description give the reason. Clicking it shows the reason as a toast.
- Click or Enter opens the widget registered for the field's type. Text commits on blur or Enter; select, toggle,
  date and number commit on change; Esc cancels and restores. Focus returns to the field when the widget closes.
- Commits go through a save queue. Each field moves idle → saving → saved, or → failed with a Retry button in the
  toast. Writes to one document are serialised, each sends `expectedVersion`, and the returned `version` is
  stored for the next write. Values committed while a save is in flight coalesce: only the latest is sent.
- A `conflict` shows a non-blocking choice: **Keep mine (overwrite)** resends against the server's version;
  **Take theirs (reload field)** repaints the field from the server's copy.
- The bar shows the actor label, the number of fields and documents changed this session (kept in session storage,
  so a reload does not forget), and Revisions, Done, Discard and Publish. Publish and Discard list the touched
  documents the editor may publish (`access.publish`) before acting, then call the endpoint once per document.
  Touched documents they may not publish are counted, not acted on.
- Revisions opens a drawer with the history of one document on the page: action, actor and time. Restoring is not
  offered yet.
- After a non-text field saves, the chrome replaces the element's text only when it holds no child elements, and
  always dispatches a bubbling `cms:change` event (`detail: { key, path, value }`) so a host can re-render richer
  markup itself.

## Wire contract

`base` defaults to `/api/content`. Every request is sent with `credentials: "same-origin"`, a JSON body, and the
header `X-Requested-With: yl-editor`.

| Request                                                         | Success                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET  {base}/documents?keys=k1,k2`                              | `200 { documents: { [key]: summary } }`                                |
| `POST {base}/field` `{ key, path, value, expectedVersion? }`    | `200 { document }`                                                     |
| `POST {base}/array` `{ key, path, op, expectedVersion? }`       | `200 { document }`                                                     |
| `POST {base}/publish` `{ key }`                                 | `200 { document }`                                                     |
| `POST {base}/discard` `{ key }`                                 | `200 { document: document \| null }`                                   |
| `POST {base}/retire` `{ key }`, `POST {base}/restore` `{ key }` | `200 { document }`                                                     |
| `POST {base}/rename` `{ key, slug }`                            | `200 { document }`                                                     |
| `GET  {base}/revisions?key=`                                    | `200 { revisions: [{ id, action, slug, payload, actor, createdAt }] }` |

- `summary` = `{ key, type, version, isDraft, draftUpdatedAt, publishedAt, access: { edit: boolean, publish: boolean } }`
- `document` = `{ id, key, type, slug, payload, isDraft, publishedAt, draftUpdatedAt, previousSlugs, retiredAt, version }`
- `op` = `{ kind: "insert", index, value } | { kind: "move", from, to } | { kind: "remove", index }`
- Errors are `{ error: { code, message, issues?, current?: document } }`:

| `code`        | Status                                                       |
| ------------- | ------------------------------------------------------------ |
| `forbidden`   | 403                                                          |
| `not_found`   | 404                                                          |
| `conflict`    | 409, carries `current` so the client can offer "take theirs" |
| `validation`  | 422, may carry `issues`                                      |
| `path`        | 400                                                          |
| `state`       | 409                                                          |
| `slug`        | 400                                                          |
| `bad_request` | 400                                                          |

`createClient(base)` is exported if a host panel wants to call the same endpoints.

## Widgets

A widget is any object with `mount`:

```ts
interface Widget {
  mount(ctx: WidgetContext): WidgetHandle;
}
interface WidgetContext {
  element: HTMLElement; // the host element carrying data-edit-field
  field: { key: string; path: string; type: EditFieldType; options?: string[]; label?: string };
  value: unknown; // current value
  commit(next: unknown): Promise<void>; // save it; the chrome closes the widget
  cancel(): void; // back out; the chrome closes the widget
  announce(message: string): void; // polite live region
}
interface WidgetHandle {
  destroy(): void;
  focus?(): void;
}
```

The widget owns whatever DOM it changes and restores it in `destroy` or on cancel. The chrome owns focus, the save
queue and status. Only the first `commit` or `cancel` counts, and committing an unchanged value sends nothing.

The defaults: `text` (plain-text contenteditable; paste and drop are reduced to text), `number`, `url`, `date`
(`<input type="date">`), `toggle`, `select` (a native `<select>` from `data-edit-options`) and `tags` (chips and a
text input; commas split). `richtext` falls back to the text widget with a visible note asking the host to register
a rich widget. `media` has no default. A type with nothing registered shows "No editor registered for <type>"; it
never throws. `openPopover(anchor, label, onLeave?)` is exported for host widgets that want the same themed popover.

A rich text widget built on TipTap, as a sketch:

```ts
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Widget } from "@yl/editor/chrome";

export const tiptapWidget: Widget = {
  mount(ctx) {
    const original = ctx.element.innerHTML;
    ctx.element.replaceChildren();
    const editor = new Editor({
      element: ctx.element,
      extensions: [StarterKit],
      content: typeof ctx.value === "string" ? ctx.value : original,
      onBlur: () => void ctx.commit(editor.getHTML()),
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      ctx.cancel();
    };
    ctx.element.addEventListener("keydown", onKey);
    return {
      focus: () => editor.commands.focus("end"),
      destroy() {
        ctx.element.removeEventListener("keydown", onKey);
        const html = editor.getHTML();
        editor.destroy();
        ctx.element.innerHTML = html || original;
      },
    };
  },
};

mountEditor({ widgets: { richtext: tiptapWidget } });
```

## Panels

A host adds its own surfaces (SEO, media library, anything) as panels. Each becomes a button in the bar and opens in
the shared sheet, which closes on Esc and returns focus to the button.

```ts
interface Panel {
  id: string;
  label: string;
  mount(root: HTMLElement, api: EditorApi): { destroy(): void };
}
interface EditorApi {
  documents(): ReadonlyMap<string, DocumentState>;
  publish(key: string): Promise<void>;
  discard(key: string): Promise<void>;
  refresh(): Promise<void>; // rescan the page and reload the documents
  status(message: string, kind?: "info" | "saving" | "saved" | "error"): void;
}
```

## Theming

All visuals come from custom properties declared with neutral defaults in `chrome.css`, in light and dark (via
`prefers-color-scheme`). They are declared on `.cms-root`, every chrome surface, and on `.cms-field`, the host
elements being edited, which sit outside `.cms-root`. Override both from your own stylesheet:

```css
.cms-root,
.cms-field {
  --cms-font: "Inter", sans-serif;
  --cms-accent: #c2410c;
  --cms-outline: 2px dashed #c2410c;
  --cms-radius: 0;
}
```

Every default rule is wrapped in `:where()`, so it has no specificity and your selectors win without `!important`.
Outside the token block the stylesheet has no raw colours, pixel sizes or radii.

| Token               | Light default                                                     | Dark default                   |
| ------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `--cms-font`        | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` | same                           |
| `--cms-size-sm`     | `0.8125rem`                                                       | same                           |
| `--cms-size-md`     | `0.9375rem`                                                       | same                           |
| `--cms-line`        | `1.4` (line height)                                               | same                           |
| `--cms-bg`          | `#ffffff`                                                         | `#1b1d24`                      |
| `--cms-fg`          | `#16181d`                                                         | `#f3f4f8`                      |
| `--cms-muted`       | `#5b6170`                                                         | `#aab0bf`                      |
| `--cms-border`      | `#d5d8e0`                                                         | `#3a3e4a`                      |
| `--cms-accent`      | `#2557d6`                                                         | `#6b9bff`                      |
| `--cms-accent-fg`   | `#ffffff`                                                         | `#0b1020`                      |
| `--cms-danger`      | `#b42318`                                                         | `#ff8a7a`                      |
| `--cms-success`     | `#1f7a45`                                                         | `#5fd394`                      |
| `--cms-warning`     | `#a15c07`                                                         | `#f0b429`                      |
| `--cms-outline`     | `2px dashed #2557d6` (the field highlight)                        | `2px dashed #6b9bff`           |
| `--cms-radius`      | `6px`                                                             | same                           |
| `--cms-space-1`     | `4px`                                                             | same                           |
| `--cms-space-2`     | `8px`                                                             | same                           |
| `--cms-space-3`     | `12px`                                                            | same                           |
| `--cms-space-4`     | `16px`                                                            | same                           |
| `--cms-space-5`     | `24px`                                                            | same                           |
| `--cms-shadow`      | `0 8px 28px rgb(15 18 30 / 18%)`                                  | `0 10px 30px rgb(0 0 0 / 45%)` |
| `--cms-z`           | `1000`                                                            | same                           |
| `--cms-control-h`   | `44px` (minimum touch target)                                     | same                           |
| `--cms-sheet-max-h` | `70vh`                                                            | same                           |

Stable class names, all prefixed `cms-`: `cms-root`, `cms-bar`, `cms-bar__state`, `cms-bar__actions`, `cms-enter`,
`cms-field`, `cms-field--editing`, `cms-field--locked`, `cms-field--saving`, `cms-field--saved`,
`cms-field--failed`, `cms-badge`, `cms-panel`, `cms-sheet`, `cms-popover`, `cms-toast`, `cms-btn`,
`cms-btn--primary`, `cms-btn--danger`, `cms-btn--ghost`, `cms-input`, `cms-chip`, `cms-list`. A field's save state is
also on `data-cms-state`, and the toast's kind on `data-kind`.

## Accessibility

- Every control is a real `<button>`, `<input>` or `<select>`, reachable by Tab, with a visible `:focus-visible`
  ring. Fields get `tabindex="0"` while editing and an `aria-describedby` naming the field, its type and either
  "Press Enter to edit" or the reason it is locked.
- Esc closes the open widget or panel; focus returns to the field or to the button that opened the panel.
- Status goes to one `aria-live="polite"` region; only one toast shows at a time. Errors stay until dismissed or
  resolved; "saved" and "info" toasts hide themselves.
- Touch targets are at least `--cms-control-h` (44px). Under 40em the bar, panels and popovers become bottom
  sheets that respect the safe-area inset.
- With `prefers-reduced-motion: reduce` transitions are opacity-only and at most 120ms.

## Content Security Policy

The chrome ships no inline scripts and builds every node with `createElement` and text nodes (no `innerHTML`). The
only inline styles it sets are computed custom properties (`--cms-badge-top`, `--cms-badge-left`,
`--cms-popover-top`, `--cms-popover-left`) for positioning, which a `style-src` policy permits through the CSSOM.
It loads nothing from other origins and makes requests only to `base`.
