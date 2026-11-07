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
markup. Non-text widgets start from the stored value, whatever the page renders (see Behaviour). A field may also
carry `data-edit-value` (JSON), which is used only when the stored value is missing or not yet known.

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
  scheduling: false, // show "Publish at" in the publish sheet; see "Scheduling" below before turning it on
  onExit: () => location.reload(), // called when the editor presses Done
});
```

It returns `{ api, ready, destroy }`. `ready` resolves when the first load has finished. `destroy()` removes every
node, class, attribute and listener the chrome added and leaves the host's markup as it found it.

## Behaviour

- On mount the chrome scans `root` for `[data-edit-field]`, groups the fields by document key, and makes one
  `GET documents` request for all the keys. It keeps each document's `version` and `access`. A later load (`api.refresh`)
  waits for the writes queued for those documents first, and a summary older than what the session already holds, because
  a write landed during the read, changes only `access`. The version never moves backwards.
- Every field gets the highlight. A field whose document lacks `access.edit` is still outlined, in the muted
  colour, and its badge and accessible description give the reason. Clicking it shows the reason as a toast.
- The first time a non-text field opens, the chrome fetches its document with `GET document` and reads the value at
  the field's path, so a toggle rendered as "Live" or a date shown as "14 Nov" still opens on the stored value. There
  is one fetch per document per session; every write returns the document, which replaces the cached copy, and so does
  opening the Publish sheet. A stored `null` counts as a stored value.
- `text` and `richtext` open at once, without a fetch. Their widget starts from the stored value if the document's
  payload is already known, else the field's `data-edit-value` (parsed the same way as below), else the element's text.
  So a host's rich text widget can receive markup the element's text would lose. The default text widget edits the
  element in place whatever the starting value, and leaving it with its text unchanged writes nothing, unless its last
  save failed (see below).
- Any widget starts from the newest value the editor has committed for its path, ahead of the cached document: a value
  queued or in flight, or one that failed to save. Reopening a popover straight after a change shows that change, and
  changing it back is saved after it (a queued value is replaced, an in-flight one is followed).
- Reopening a field whose save failed and leaving it resends the value, for text and popover widgets alike; Esc leaves it
  failed. A host widget that commits the same value resends too, and can read `ctx.unsaved`. A field whose last save
  didn't fail writes nothing when left untouched. Discard and Restore replace the content, so they drop failed values.
- When the path is missing from the document, or the fetch fails, a non-text widget starts from the field's
  `data-edit-value`, parsed as JSON or taken as written when it is not valid JSON. The element's rendered text is never
  read. If the fetch failed, a toast says the field started from the page's value; with no `data-edit-value` the widget
  stays closed and a toast says why. A failed fetch is not cached, so the next opening tries again. Leaving the widget
  untouched writes nothing, wherever the starting value came from.
- Click or Enter opens the widget registered for the field's type. Text commits on blur or Enter; select and toggle
  commit on change; number, date and url commit on Enter, not on change (arrow keys and date segments fire change at
  every step); tags commit on Enter in an empty input or Done. Esc and Cancel back out and write nothing. Every popover
  also commits when it is left: a press anywhere outside it and its field, or focus moving out of it. A press inside the
  popover off its controls keeps it open. A popover edit still open when another field is opened, a sheet or panel is
  opened, the page is refreshed, or the editor is exited or destroyed is committed, not dropped. Text is too, and its
  no-break spaces are stored as plain spaces. Paste goes in through the browser's own text insertion when it allows it.
  Focus returns to the field when the widget closes.
- A popover still waiting on its fetch is cancelled by opening any sheet, panel or the revisions drawer and by starting
  any lifecycle action, and it doesn't open on a document deleted during the wait.
- Commits go through a save queue. Each field moves idle → saving → saved, or → failed with a Retry button in the
  toast. Writes to one document are serialised, each sends `expectedVersion`, and the returned `version` is
  stored for the next write. Values committed while a save is in flight coalesce: only the latest is sent.
- A `conflict` shows a non-blocking choice: **Keep mine (overwrite)** resends against the server's version;
  **Take theirs (reload field)** repaints the field from the server's copy.
- The bar shows the actor label, the number of changes and documents changed this session (kept in session storage,
  so a reload does not forget), and Revisions, Done, Discard and Publish. A change is a field, or one for a document
  changed with no field to name: Unpublish, or a Restore that left the draft as it was. Both leave the document in the
  Publish sheet, so it can go live again. Publish and Discard commit an open edit first, then list the
  touched documents the editor may act on before acting (a document whose first save is still on its way counts): `access.publish` for Publish, `access.edit` for Discard (the server
  gates discard by edit access). The endpoint is called once per document, after that document's pending field
  writes finish. Touched documents they may not act on are counted, not acted on. Discarding a document with nothing
  live deletes it, whether it was never published or was unpublished, so its fields stop being editable until the page
  is reloaded. Its revisions go with it and can't be recovered through the chrome or the HTTP API. The Discard sheet says
  so on each such document, and they stay listed because discarding is still valid. If a document loses its published
  version while the sheet is open, the warning appears and that Confirm does nothing, so it can be read first.
  `api.discard` asks nothing and warns about nothing: a panel that calls it does its own asking.
- One document failing doesn't stop or misreport the others. Those that worked leave the sheet; those that failed stay in
  it with the reason, a toast counts both, and Confirm tries the failed ones again.
- While a run is going, Confirm and "Publish at" are disabled and focus moves to Cancel. Cancel, Close, Esc or anything
  else that closes the sheet stops the documents not yet started. The one in flight finishes, on its reviewed version if
  it had one, even if it is still waiting behind that document's queued saves. A toast then says how many finished and
  names the rest, and stays until dismissed. Those documents stay touched, so they can be published or discarded later.
- The Publish sheet shows what will change for each document: path and short before and after, from `diffPayloads`.
  A document with nothing live says so. Each opening makes one fresh `GET document` per listed document,
  after that document's pending writes finish, and compares the `publishedPayload` it returns with its draft, so
  another editor's change shows. The two always come from one response: if a write this session takes lands during the
  read, the read is repeated, up to three times in all. Only the newest read of a row can render or become its reviewed
  version. The response replaces the session's cached copy of the document but not its `version`: a later write from this
  session still conflicts with a change the page has not repainted. If the fetch fails, the
  sheet says the changes could not be loaded for that document, and Publish stays available. A draft failing its schema
  is one such failure (`GET document` answers `422`); publishing it answers with the validation error. Reads that keep
  being overtaken are another, and so is an unreadable published version: a `publishedPayload` that is a string (the
  stored text of an unparseable column), or `null` with `publishedAt` set. That shows no diff and is never a first publish.
- **Publish never overwrites a change the editor hasn't seen.** It sends as `expectedVersion` the version whose diff the
  sheet showed, per document. The editor's own writes after that move it forward, by this rule: a write sent with the
  reviewed version and accepted proves nothing else landed in between, so the reviewed version becomes that write's
  result. A write from any other version leaves it behind, so the publish conflicts. With no diff on screen at Confirm
  (still loading, or the fetch failed) it sends the session's known version, which is also what **Publish now** and
  `api.publish` send.
- On a publish conflict nothing is published and there is no overwrite. The sheet stays open and says so, and that
  document's diff reloads so the editor can review and confirm again. **Publish now** opens the sheet on that document;
  `api.publish` rejects and its toast has a **Review changes** button.
- Unpublish, Restore and Discard send the session's known version. On a conflict a toast says the document changed, the
  session takes the server's copy and repaints the fields from it, and nothing else happens. A field with a save on its
  way or an open widget keeps what the editor has.
- `api.publish(key, { at })` schedules whatever `scheduling` says, and refuses nothing: a host panel checks its own time.
- An existing `scheduledAt` always shows in the bar as "<key> scheduled for <time>" with **Publish now**, which
  publishes the draft immediately and clears the schedule, by the rule above.
- **Cancelling a schedule without publishing is not exposed.** Discard would drop the draft and Publish now makes it
  live; clearing `scheduledAt` alone is a store-level operation. The bar learns `scheduledAt` when the document is
  fetched or written, because the `documents` summary does not carry it, so a schedule set in an earlier session shows
  only after the document has been opened in a non-text widget or the Publish sheet.
- Revisions opens a drawer with the history of one document on the page: action, actor and time.
  - With `access.edit`, each row has **Restore** with a confirm step, because it replaces the current draft and draft
    edits are not revisions. The prompt says so; Cancel writes nothing. Confirm copies that revision into the draft
    after the document's pending writes finish, repaints the page's fields and says so in a toast. The published
    version is untouched until Publish. `api.restoreRevision` asks nothing: a panel that calls it does its own asking.
  - With `access.publish`, on a published document, the drawer has **Unpublish** with a confirm step. The content
    stays as a draft.
- After a non-text field saves, the chrome replaces the element's text only when it holds no child elements, and
  always dispatches a bubbling `cms:change` event (`detail: { key, path, value }`) so a host can re-render richer
  markup itself. Discard, Restore and a conflict catch-up repaint the same way; when the new content lacks the field's
  path, the text is emptied (same child-element rule) and `detail.value` is `undefined`.
- When the page's documents fail to load, a toast offers Retry. A later load that succeeds hides it, unless another
  toast has replaced it.

### Scheduling

`scheduling: true` adds an optional "Publish at" input to the Publish sheet (`datetime-local`, in the browser's time
zone). It is off by default because a scheduled draft goes live only when something runs `publish-due`, so without that
it would silently never publish. **A host that turns it on must run `POST {base}/publish-due` on a schedule and read
`failed` from the response**: a document that failed stays scheduled and is retried on the next run, and nothing else
tells anyone. See docs/http.md.

When set, the button reads Schedule and sends `at` as an ISO string with offset. The document stays in the change count
until it goes live. Past times are refused: the input carries `min`, and because `min` isn't enforced on typed values or
by a clock that has moved on, the time is checked again on every change and at Confirm. For a past time, as for a
half-typed date, the button is disabled; for a past time a line says why.

### Strings

Every label is a key of `defaultStrings` in `src/chrome/strings.ts`, overridable through `strings`. The lifecycle
actions added these: `restore`, `restoreRevisionLabel`, `restoreConfirm`, `restored`, `unpublish`, `unpublishConfirm`,
`unpublished`, `schedule`, `publishAt`, `scheduled`, `scheduledFor`, `publishNow`, `loadingChanges`, `changesFailed`,
`firstPublish`, `noDifferences`, `diffRoot`, `diffAdded`, `diffRemoved`, `diffChanged`, `loadFieldFailed`,
`loadFieldFallback`, `actionConflict`, `publishConflict`, `reviewChanges`, `bulkDone`, `bulkPartial`, `bulkStopped`,
`scheduleInPast`, `changesKeptMoving`, `changesUnreadable`, `discardDeletes`.

`discardDeletes` describes the built-in SQLite store with foreign keys on, which deletes a document's revisions with it.
A custom store that keeps them should override it.

## Wire contract

`base` defaults to `/api/content`. Every request is sent with `credentials: "same-origin"`, a JSON body, and the
header `X-Requested-With: yl-editor`.

| Request                                                                | Success                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET  {base}/documents?keys=k1,k2`                                     | `200 { documents: { [key]: summary } }`                                |
| `POST {base}/field` `{ key, path, value, expectedVersion? }`           | `200 { document }`                                                     |
| `POST {base}/array` `{ key, path, op, expectedVersion? }`              | `200 { document }`                                                     |
| `GET  {base}/document?key=`                                            | `200 { document, publishedPayload }`                                   |
| `POST {base}/publish` `{ key, at?, expectedVersion? }`                 | `200 { document }`                                                     |
| `POST {base}/unpublish` `{ key, expectedVersion? }`                    | `200 { document }`                                                     |
| `POST {base}/restore-revision` `{ key, revisionId, expectedVersion? }` | `200 { document }`                                                     |
| `POST {base}/discard` `{ key, expectedVersion? }`                      | `200 { document: document \| null }`                                   |
| `POST {base}/retire` `{ key }`, `POST {base}/restore` `{ key }`        | `200 { document }`                                                     |
| `POST {base}/rename` `{ key, slug }`                                   | `200 { document }`                                                     |
| `GET  {base}/revisions?key=`                                           | `200 { revisions: [{ id, action, slug, payload, actor, createdAt }] }` |

The chrome always sends `expectedVersion` on these writes.

- `summary` = `{ key, type, version, isDraft, draftUpdatedAt, publishedAt, access: { edit: boolean, publish: boolean } }`
- `document` = `{ id, key, type, slug, payload, isDraft, publishedAt, draftUpdatedAt, previousSlugs, retiredAt, version, scheduledAt }`
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
| `bad_request` | 400, also a 405 for the wrong method                         |
| `internal`    | 500, also any response without a valid error envelope        |

The chrome uses `createContentClient({ base })` from the package's HTTP module, re-exported from
`@yl/editor/chrome` with `ContentRequestError`, so a host panel can call the same endpoints with the same error
decoding. A response without a valid error envelope arrives as code `internal`.

## Widgets

A widget is any object with `mount`:

```ts
interface Widget {
  mount(ctx: WidgetContext): WidgetHandle;
}
interface WidgetContext {
  element: HTMLElement; // the host element carrying data-edit-field
  field: { key: string; path: string; type: EditFieldType; options?: string[]; label?: string };
  value: unknown; // the newest value committed for this path, else the stored value
  readonly unsaved: boolean; // true while `value` failed to save: leaving should commit it, even unchanged
  commit(next: unknown): Promise<void>; // save it; the chrome closes the widget
  cancel(): void; // back out; the chrome closes the widget
  announce(message: string): void; // polite live region
}
interface WidgetHandle {
  destroy(): void;
  focus?(): void;
  commit?(): void; // commit what it holds now, as if the user had finished; called before the chrome tears it down
}
```

The widget owns whatever DOM it changes and restores it in `destroy` or on cancel. The chrome owns focus, the save
queue and status. Only the first `commit` or `cancel` counts, and committing an unchanged value sends nothing, unless `unsaved` is true.

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
  // `at` schedules, ISO with Z or an offset, whatever `scheduling` says. Rejects with a `conflict` if the document moved.
  publish(key: string, options?: { at?: string }): Promise<void>;
  discard(key: string): Promise<void>;
  unpublish(key: string): Promise<void>;
  restoreRevision(key: string, revisionId: number): Promise<void>; // into the draft; repaints the fields
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
`cms-field--failed`, `cms-bar__schedule`, `cms-bar__scheduled`, `cms-diff`, `cms-field-label`, `cms-badge`, `cms-panel`, `cms-sheet`, `cms-popover`, `cms-toast`, `cms-btn`,
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
