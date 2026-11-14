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

| Attribute            | Source                 | Meaning                                                              |
| -------------------- | ---------------------- | -------------------------------------------------------------------- |
| `data-edit-field`    | `"<docKey>:<path>"`    | Which document and which dotted payload path                         |
| `data-edit-type`     | `type`                 | One of the `EditFieldType` union                                     |
| `data-edit-options`  | `attrs.options` (JSON) | Choices for a `select`                                               |
| `data-edit-label`    | `attrs.label`          | Human name shown in the badge                                        |
| `data-edit-headings` | `attrs.headings`       | Heading levels a `richtext` field allows (`"2 3"`); omitted for none |

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
  lists: { "artist/list:artists": { newItem: () => ({ name: "New artist" }) } }, // see "Lists" below
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
- Discard, Restore, a conflict catch-up or Take theirs can remove a field's value. A field of plain text is emptied, and
  until the next value arrives the chrome ignores the `data-edit-value` it had at that moment, so the widget doesn't
  reopen on the value just removed. The attribute itself stays as the host wrote it, and a different one the host writes
  later counts, even if the value is removed again. A `richtext` field is emptied too, whatever elements it holds. A
  field the chrome doesn't empty (any other with child elements, or a toggle) still shows its content, so its
  `data-edit-value` counts as before.
- Click or Enter opens the widget registered for the field's type. Text commits on blur or Enter; select and toggle
  commit on change; number, date and url commit on Enter, not on change (arrow keys and date segments fire change at
  every step), except that a date picked from the browser's date picker commits at once, however soon after the key
  that opened the picker. Only the keys that type or step a segment (digits, arrows without Alt, Backspace, Delete,
  Home, End, Page Up and Page Down) hold a date's `change` back until Enter; Space, Enter, Alt+ArrowDown and F4 don't.
  Tags commit on Enter in an empty input or Done. Esc and Cancel back out and write nothing. Every popover also commits
  when it is left: a primary click outside it and its field, a completed tap there, or focus moving out of it. A
  Ctrl+click is a click on Windows and Linux and commits. A press that opens a context menu (a right-click, or a Mac's
  Ctrl+click, which the browser reports with `contextmenu` before the press completes), a middle-click, a press on the
  page's scrollbar and a touch that becomes a scroll aren't leaving: the popover stays open. If such a press moved focus
  to nowhere, focus goes back to the control; if it focused something, such as a host input right-clicked for its Paste,
  focus stays there. That covers only the press's own focus change: focus moved later by a script or assistive
  technology is leaving. A press inside the popover off its controls keeps it open and focus where it was, so Esc and
  Enter go on working. A popover edit still open when another field is opened, a sheet or panel is opened, the page is
  refreshed, or the editor is exited or destroyed is committed, not dropped. Text is too. Paste goes in through the
  browser's own text insertion when it allows it. Focus returns to the field when the widget closes.
- Enter or leaving with nothing changed writes nothing, for every popover input (a failed save still resends).
- A half-typed date or an invalid number (`validity.badInput`) reads as empty, but it isn't the editor emptying the
  field. Enter keeps the popover open and shows why on a line under the input (the `invalidValue` string, in
  `.cms-diff` > `.cms-error`), marks the input `aria-invalid="true"`, and scrolls Cancel back into view if the taller
  popover pushed it out of the window or the bottom sheet. Like the Publish sheet's note, the line's `.cms-diff` is
  under the input from the start and named in its `aria-describedby`, hidden and empty, so it describes nothing until
  it shows. Each refused Enter also announces it through the live region; a second one adds no second line. The line
  and `aria-invalid` go as soon as the value is readable or empty again, and with the popover. Leaving, or the chrome
  closing the popover, cancels, keeps the stored value and says so in an info toast (`invalidValueKept`) that hides
  itself; while an error toast is showing (a failed save's Retry, a conflict's choice) it stays, and the message is
  only announced. A host widget that wraps a default one with a spread context (`{ ...ctx, commit }`) keeps that
  toast. Esc cancels silently, as always. An input emptied on purpose still commits empty. Url and the other widgets
  are unaffected.
- A text edit normalises only what it changed. Firefox types a space next to another space, or at the end, as a no-break
  space, and those are stored as plain spaces. A no-break space outside the changed stretch, the part between what is
  the same at the start and at the end of the text, stays: "10\u00a0km" keeps it when the edit is elsewhere. The stored
  value says which spaces are deliberate, so one the page renders as a plain space survives too: stored "10\u00a0km",
  shown "10 km", "s" typed at the end saves "10\u00a0kms". An edit on both sides of it makes the whole stretch between
  them changed, so that one is normalised too.
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
  Publish sheet, so it can go live again. Publish and Discard commit an open edit first, then list the touched
  documents the editor may act on before acting: `access.publish` for Publish, `access.edit` for Discard (the server
  gates discard by edit access). The endpoint is called once per document, after that document's pending field writes
  finish. Touched documents they may not act on are counted, not acted on.
- A document whose first save this session is still queued or on the wire is listed too, with the count it has so far.
  Each row's count updates as its writes settle. A row listed only for such a save, which settles without changing the
  document (it failed), drops out: the sheet then says "Left out, with no saved change from this session: <keys>" and
  the live region announces each such document once. Such a document may hold another editor's draft, so it is never
  published or discarded on this session's behalf. Confirm pressed while those saves are on their way waits for them,
  checks the rows again and acts only on what is left; if nothing is left, the sheet says so and nothing is sent. The
  count of documents the editor may not act on follows the same saves.
- Discarding a document with nothing live deletes it, whether it was never published or was unpublished, so its fields
  stop being editable until the page is reloaded. Its revisions go with it and can't be recovered through the chrome or
  the HTTP API. The Discard sheet says so on each such document, and they stay listed because discarding is still valid.
  If a document loses its published version while the sheet is open, the warning appears and that Confirm does nothing,
  so it can be read first.
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
  markup itself. Discard, Restore, a conflict catch-up and Take theirs repaint the same way; when the new content lacks
  the field's path, the text is emptied (same child-element rule, and never a toggle's) and `detail.value` is
  `undefined`.
- Those four also repaint a `richtext` field, child elements or not, since its value is HTML the chrome can render
  safely: a string value is run through `sanitizeRichText` with the field's `data-edit-headings`, parsed in an inert
  document and its nodes imported, so the page never sees `innerHTML`. A missing path empties the field, and so does a
  value that isn't a string, as for plain text. Take theirs first closes a widget reopened on the field, without
  committing it. A save doesn't repaint it: the widget already shows what it committed.
- When the page's documents fail to load, a toast offers Retry. A later load that succeeds hides it, unless another
  toast has replaced it.

### Lists

A keyed array (a roster, a list of events) can be edited as a list: add, remove, move up and down, and duplicate. Mark
the list element with `edit.list(path, attrs)` and each item with `edit.item(path, item, index)`. The item's fields
are ordinary fields, addressed with `itemPath` so a save lands on the right item after a concurrent reorder.

```astro
---
import { editable, itemPath } from "@yl/editor";
const edit = editable(editor ? "artist/list" : undefined);
---
<ul {...edit.list("artists", { label: "Artists", noun: "artist", plural: "artists", min: 1, max: 6, itemLabel: "name" })}>
  {artists.map((artist, index) => (
    <li {...edit.item("artists", artist, index)}>
      <h3 {...edit(`${itemPath("artists", artist, index)}.name`, "text", { label: "Name" })}>{artist.name}</h3>
    </li>
  ))}
</ul>
```

| Attribute                   | Source              | Meaning                                                                                       |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `data-edit-list`            | `"<docKey>:<path>"` | The array, same grammar as `data-edit-field`                                                  |
| `data-edit-list-label`      | `attrs.label`       | Shown in the tag on the outline; default the path's last name                                 |
| `data-edit-list-noun`       | `attrs.noun`        | "Add {noun}"; default `item`                                                                  |
| `data-edit-list-plural`     | `attrs.plural`      | Messages like "No {plural} yet"; default the noun plus "s"                                    |
| `data-edit-list-min`        | `attrs.min`         | Remove is inert, with its reason, at this many items; default 0                               |
| `data-edit-list-max`        | `attrs.max`         | Add and Duplicate are inert, with their reason, at this many; default none                    |
| `data-edit-list-order`      | `attrs.order`       | `manual` (default) shows Move up and Move down; `data` (you sort, e.g. by date) shows neither |
| `data-edit-list-duplicate`  | `attrs.duplicate`   | Present: each item offers Duplicate (default off)                                             |
| `data-edit-list-item-label` | `attrs.itemLabel`   | The field name whose text names an item in labels and messages; else "{noun} {position}"      |
| `data-edit-item`            | `edit.item(...)`    | One item's full address, `artists[_key=a1]` or `artists.3`                                    |

`edit.list` throws a `RangeError` for a `min` or `max` that isn't a whole number of 0 or more, or a `min` above `max`.

Add needs the item's starting value, which the page can't carry, so it comes from `mountEditor`:

```ts
mountEditor({
  lists: {
    "artist/list:artists": {
      newItem: () => ({ name: "New artist", line: "", visible: true }),
      focusField: "name", // default: the item's first field
    },
  },
});
```

A list with no `newItem` offers no Add but can still move, duplicate and remove. In a keyed list (or an empty one), when
`newItem` returns no `_key` the chrome adds one (10 characters of `[a-z0-9]`), and Duplicate gives the copy a new one.
A list addressed by index stays unkeyed: neither adds a `_key` there. These are the only items the
chrome creates (see docs/paths.md).

**How it behaves.**

- In edit mode the list gets one dashed outline, with a tag on its top edge ("Artists · 3 of 6"). A thin dashed line
  separates each item from the next, and each field from the next inside an item; fields in a list lose their own
  outline. Nothing nests or crosses. A field's hover, editing and focus states are solid and drawn inside it. The lines
  are placed from the boxes on the page, through custom properties, and redrawn when the list or a field resizes.
- Each item has a toolbar on its top line: Move up, Move down, Duplicate (when on) and Remove, 44px each. It shows on
  hover and on focus inside the item, which also tints the item. It is one Tab stop (`role="toolbar"`), with Left,
  Right, Home and End between its buttons, and it comes before the item's fields in Tab order. On a device without
  hover (`@media (hover: none)`) each item shows a chip ("⋯ 2 of 3") on its line instead; tapping it opens the toolbar,
  and Escape closes it.
- The Add button is the list's last row, in the empty state too ("No artists yet."). Add puts the new item last and
  opens its first field with the text selected. Duplicate puts the copy straight after the original and opens it the
  same way.
- An inert button (the first item's Move up, Add at `max`, Remove at `min`) stays focusable with
  `aria-disabled="true"` and announces why when pressed. Add's reason is also on screen beside it.
- Remove takes effect at once. For 15 seconds a toast offers Undo, and so does a button in the list's last row, right
  after the items, so Tab from the list reaches it (`.cms-list__undo`). Ctrl+Z or ⌘Z with focus in the list (not in a
  field being edited) undoes that list's last removal at any time; the list's own Undo also undoes that list's. Undo inserts the same item, `_key` and all, where it was. Discard and
  Restore forget the removals of their document.
- Focus after each operation: a move keeps it on the same button of the moved item, or its other move button once
  that one is inert; Remove moves it to the item now in that place, else the one before, else Add; Undo to the
  restored item's toolbar. Each one is announced in the polite live region (`itemMoved`, `itemAdded`,
  `itemDuplicated`, `itemRemoved`, `itemRestored`).
- Every operation is an `array` write (`insert`, `move` or `remove`) on the document's write chain, after the saves
  queued before it, with `expectedVersion`. Its index is read from the stored array at that moment, by `_key` when the
  item has one. A conflict writes nothing, shows `actionConflict` and catches the page up, as Discard does.
- **The chrome can write the data but not your markup**, so after each write it requests the page again
  (`GET location.href`, same-origin credentials, `cache: "no-store"`), finds every element with the same
  `data-edit-list` as the document's lists and swaps them in. It does the same when Discard, Restore or a conflict
  replaces the document's content. A field value still saving or failed, and its state, are put back on the new
  markup. Only the lists are swapped (a list nested in another comes with it); every other field keeps its state and
  any open editor, and swaps run one at a time, each fetching after the one before, so an older page never lands over a newer one. In a list addressed by index, a write drops a
  failed value at an index it shifts, so Retry can't write it into the wrong item; values at other indices stay, and
  removing a keyed item drops its own. While a document's lists are about to change (its own list write, or a swap after Discard,
  Restore or a conflict), nothing inside any of them, nested lists included, acts or opens. A Retry pressed meanwhile at
  a shifted index is dropped too, and so is every index value after a conflict; a Save failed toast left over for a
  dropped value goes, and its Retry does nothing. Focus moves after an operation only if the editor hasn't opened something else meanwhile.
  Your page must therefore render the draft for an editor, as it already does on a reload. If the response has no such
  list, a toast (`listReload`) offers Reload.
- A list whose document the editor can't edit gets no list chrome; its fields show as locked.
- The chrome adds `.cms-list` to the list and `.cms-item` to each item, and its own `.cms-root` children:
  `.cms-list__frame` (the outline and `.cms-list__tag`), `.cms-list__add`, and in each item `.cms-item__tools`,
  `.cms-item__band` and `.cms-item__sep`. Leave room between items for the toolbar on the line between them, for
  example `.my-list.cms-list { gap: 3.75rem; }`: the chrome never changes your layout, so with a smaller gap the
  toolbar overlaps the items next to it. Done and `destroy()` take it all out again.

### Scheduling

`scheduling: true` adds an optional "Publish at" input to the Publish sheet (`datetime-local`, in the browser's time
zone). It is off by default because a scheduled draft goes live only when something runs `publish-due`, so without that
it would silently never publish. **A host that turns it on must run `POST {base}/publish-due` on a schedule and read
`failed` from the response**: a document that failed stays scheduled and is retried on the next run, and nothing else
tells anyone. See docs/http.md.

When set, the button reads Schedule and sends `at` as an ISO string with offset. The document stays in the change count
until it goes live. Past times are refused: the input carries `min`, and because `min` isn't enforced on typed values or
by a clock that has moved on, the time is checked again on every change and at Confirm. A past time or a half-typed
date disables the button, and a line under the input says why: `scheduleInPast` at once, `scheduleIncomplete` once
focus leaves the input while it is still half-typed (every date is half-typed while it is typed). The input gets
`aria-invalid="true"` and is described by the line, which is announced once when it appears. The line clears on the
keystroke that finishes or empties the date.

### Strings

Every label is a key of `defaultStrings` in `src/chrome/strings.ts`, overridable through `strings`. The lifecycle
actions added these: `restore`, `restoreRevisionLabel`, `restoreConfirm`, `restored`, `unpublish`, `unpublishConfirm`,
`unpublished`, `schedule`, `publishAt`, `scheduled`, `scheduledFor`, `publishNow`, `loadingChanges`, `changesFailed`,
`firstPublish`, `noDifferences`, `diffRoot`, `diffAdded`, `diffRemoved`, `diffChanged`, `loadFieldFailed`,
`loadFieldFallback`, `actionConflict`, `publishConflict`, `reviewChanges`, `bulkDone`, `bulkPartial`, `bulkStopped`,
`scheduleInPast`, `scheduleIncomplete`, `changesKeptMoving`, `changesUnreadable`, `discardDeletes`, `bulkLeftOut`.
The number and date widgets added `invalidValue` (Enter on a half-typed date or invalid number) and `invalidValueKept`
(leaving one). Lists added `listTag`, `listTagNoMax`, `listAdd`, `listEmpty`, `listFull`, `listAtMin`, `itemFallback`,
`itemChip`, `itemChipOpen`, `itemToolbar`, `itemActions`, `itemMoveUp`, `itemMoveDown`, `itemDuplicate`, `itemRemove`,
`itemIsFirst`, `itemIsLast`, `itemMoved`, `itemAdded`, `itemDuplicated`, `itemRemoved`, `itemRestored`, `removedToast`,
`undo`, `listReload` and `reload`.

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
a rich widget, such as the one in `@yl/editor/richtext` (see Rich text below). `media` has no default. A type with nothing registered shows "No editor registered for <type>"; it
never throws.

`openPopover(anchor, label, onLeave?)` is exported for host widgets that want the same themed popover. It appends a
`.cms-root.cms-popover` dialog to `body`, labelled by `label` and placed under `anchor` through custom properties, and
returns `{ root, close }`. The host puts its controls in `root`, moves focus into it, and calls `close()` to remove it.

What it does:

- `onLeave` fires at most once per popover, and never after `close()`, when the editor leaves it: a primary click or a
  completed tap outside the popover's element and `anchor`, or focus moving out of the popover's element. A Ctrl+click
  counts as a click where it is one (Windows, Linux).
- A press that opens a context menu (a right-click, or a Mac's Ctrl+click), a middle-click, a press on the page's
  scrollbar and a touch that becomes a scroll don't fire it. If such a press moved focus to nowhere, focus goes back to
  the control it left; focus it gave to an element, such as a host input right-clicked for its Paste, stays there.
- Outside means outside the DOM subtree, so a host's own dropdown or date picker appended to `body` counts as outside and
  fires `onLeave` when pressed: render it inside `popover.root`, or ignore the call and reopen. Since it fires only once,
  a host that keeps the popover open after it gets no second call.

What it doesn't do:

- It leaves every press inside the popover to the browser, so text selection, drag and drop and custom controls work.
  A press on the host's own non-focusable content moves focus to the body, as anywhere else on the page; with `onLeave`
  that isn't leaving, because the press was inside. The chrome's default widgets keep focus on their control after a
  press on the popover's title or empty space; a host popover that wants that prevents `mousedown` itself.
- It doesn't handle Esc, Enter or a focus trap, commit or cancel anything, or return focus to the field: the host's
  widget does that through its `WidgetContext`, and the chrome returns focus when the widget closes.
- With no `onLeave` it listens to nothing.

### Rich text

`@yl/editor/richtext` is the rich text widget (decided in #29, built in #37). It is built on TipTap, which hosts install
as optional peer dependencies: `@tiptap/core`, `@tiptap/pm` and `@tiptap/starter-kit` (3.x). `@yl/editor/chrome` never
imports it, so a host that doesn't register it never loads TipTap. Register it for `richtext`:

```ts
import "@yl/editor/chrome/chrome.css";
import { mountEditor } from "@yl/editor/chrome";
import { richTextWidget } from "@yl/editor/richtext";

mountEditor({ widgets: { richtext: richTextWidget } });
```

It reads its words from the `strings` given to `mountEditor`, including the H2/H3 glyphs (`headingGlyph`), the
shortcut key names shown in tooltips off Apple devices (`keyControl`, `keyShift`, `keyAlt`, `keyEnter`, `keyEscape`;
Apple devices show the standard ⌘ ⇧ ⌥ ↩ symbols) and the address placeholder (`linkPlaceholder`). `createRichTextWidget({ strings })` overrides some for this
widget only. Its CSS is in `chrome.css`, themed by the same tokens.

**Editing.** The editor types into the host element itself, so the page's own typography stays. A toolbar
(`.cms-toolbar`, `role="toolbar"`, named "Formatting for <label>") floats just above the field. It holds Bold, Italic,
Link, Bulleted list, Numbered list, H2 and H3 (only the levels the field allows, from `data-edit-headings`), then Cancel
and Done. A button shows its state with `aria-pressed`. Under 40em the toolbar docks to the top of the viewport. Its
position comes in through `--cms-toolbar-top` and `--cms-toolbar-left`, set with `style.setProperty`, so it needs no
inline styles. The design is `docs/specs/artefacts/2026-11-richtext-toolbar.html`.

**Committing.** Done, Ctrl/⌘+Enter and leaving the field and toolbar (a click elsewhere, or focus moving out of both)
commit. Cancel and Esc in the text put the field back as it was and write nothing. Leaving untouched writes nothing,
unless the last save failed. The committed value is the stored shape below, and the field shows it.

**Keyboard.** It follows the ARIA toolbar pattern, and nothing traps focus.

| Where           | Key                            | Does                                                                   |
| --------------- | ------------------------------ | ---------------------------------------------------------------------- |
| Text            | Ctrl/⌘ B, Ctrl/⌘ I             | Bold, italic                                                           |
| Text            | Ctrl/⌘ K                       | Open the link row                                                      |
| Text            | Ctrl/⌘ ⇧ 8, Ctrl/⌘ ⇧ 7         | Bulleted list, numbered list                                           |
| Text            | Ctrl/⌘ ⌥ 2, Ctrl/⌘ ⌥ 3         | H2, H3, when the field allows them                                     |
| Text            | Ctrl/⌘ ⇧ V                     | Paste as plain text                                                    |
| Text            | Alt F10, or Tab outside a list | Focus the toolbar (Plain text while the paste options are up)          |
| Text, in a list | Tab, ⇧ Tab                     | Nest or un-nest the item; where it can't nest, Tab goes to the toolbar |
| Text            | Ctrl/⌘ Enter                   | Done                                                                   |
| Text            | Esc                            | Cancel                                                                 |
| Toolbar         | ← → Home End                   | Move between buttons, wrapping at the ends                             |
| Toolbar         | Enter, Space                   | Press the button; focus goes back to the text, except for Link         |
| Toolbar         | Esc                            | Hide the tooltip if one shows, else back to the text                   |
| Toolbar         | ⇧ Tab / Tab                    | Back to the text, or on past the toolbar (which commits)               |
| Link row        | Enter / Esc                    | Apply, or close the row; either way back to the text                   |

A tooltip shows each button's name and shortcut on hover and keyboard focus. It is `aria-hidden`: screen readers get
the name from `aria-label` and the shortcut from `aria-keyshortcuts`. The H2 and H3 buttons are named "H2 Heading" and
"H3 Subheading" (the `heading` and `subheading` strings, visually hidden after the visible text), so a speech user can
say what they see (WCAG 2.5.3).

**Links.** Link (or Ctrl/⌘ K) opens a row inside the toolbar with the address input, focused. On a link it starts from
its address, selects the whole link and offers Remove link. A bare domain (`example.com`, `example.com:8080`) gets `https://` and an email address gets `mailto:`. An address
that isn't `https:`, `http:`, `mailto:`, `tel:` or a path starting with one `/` is refused with the `linkRefused` line
under the input (`aria-invalid`, `aria-describedby`). With nothing selected, the address is inserted as its own text.

**Paste.** Pasted content keeps the formatting the field allows and drops the rest without a word. When the paste kept
some formatting, a Paste options row offers Keep formatting and Plain text (`aria-pressed`), and a screen reader hears
`pasteAnnounce`. Switching replaces the pasted content, and switching back restores it. The row goes away when the
editor types or clicks in the text, or anything else changes the document. Ctrl/⌘ ⇧ V pastes plain text with no row;
pressed while the row is up, it switches the paste just made to plain text.

**The stored shape.** A rich text value is an HTML string of:

- blocks: `<p>`, `<h2>` and `<h3>` (only the levels the field allows), `<ul>` and `<ol>`, whose `<li>` hold paragraphs
  and nested lists;
- inside blocks: text, `<strong>`, `<em>`, `<br>` and `<a href>`;
- no other element and no other attribute. An `href` is `https:`, `http:`, `mailto:`, `tel:` or a path starting with
  one `/`. Text is escaped (`&amp;`, `&lt;`, `&gt;`, and `&nbsp;` for a no-break space);
- `""` for a value with no text.

**The server half.** The server must not trust HTML from a client, so `@yl/editor` exports the sanitiser that enforces
this shape whichever widget wrote the value:

```ts
import { richText, sanitizeRichText } from "@yl/editor";

const pageSchema = z.object({ lede: richText({ headings: [2, 3] }).optional() });
sanitizeRichText('<p onclick="x">Hi<script>…</script></p>'); // "<p>Hi</p>"
```

`richText(options)` is a zod string schema that runs `sanitizeRichText` on every parse, so a write stores the clean
shape (in a store that keeps the parsed payload, as the SQLite store does) and a validated read serves it.
`sanitizeRichText(html, { headings })` rewrites any HTML into the shape: `b` and `i` become `strong` and `em`, a heading
the field doesn't allow becomes a paragraph, loose text is put in paragraphs, and any other element is dropped but
keeps its text. Scripts, styles, embedded documents (`iframe`, `object`, `embed`), `template`, `svg` and `math` go
with their content. A link to anything else keeps its text and loses the link. It needs no DOM, and running it twice
gives the same result. Named entities beyond the common few (`&amp;`, `&nbsp;`, typographic quotes and dashes) are kept
as written text. `isAllowedHref(href)` is the link rule on its own.

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
| `--cms-control-h`   | `44px` (minimum touch target; the fixed height of a `select`)     | same                           |
| `--cms-sheet-max-h` | `70vh`                                                            | same                           |

Stable class names, all prefixed `cms-`: `cms-root`, `cms-bar`, `cms-bar__state`, `cms-bar__actions`, `cms-enter`,
`cms-field`, `cms-field--editing`, `cms-field--locked`, `cms-field--saving`, `cms-field--saved`,
`cms-field--failed`, `cms-bar__schedule`, `cms-bar__scheduled`, `cms-diff`, `cms-field-label`, `cms-badge`, `cms-panel`, `cms-sheet`, `cms-popover`, `cms-toast`, `cms-btn`,
`cms-btn--primary`, `cms-btn--danger`, `cms-btn--ghost`, `cms-input`, `cms-chip`, `cms-list`. A field's save state is
also on `data-cms-state`, and the toast's kind on `data-kind`.

## Accessibility

- Every control is a real `<button>`, `<input>` or `<select>`, reachable by Tab, with a visible `:focus-visible`
  ring. Date and date-time inputs use `:focus-within`, because Chromium and WebKit don't match `:focus-visible` on them,
  so they also show the ring on a mouse click. Fields get `tabindex="0"` while editing and an `aria-describedby` naming the field, its type and either
  "Press Enter to edit" or the reason it is locked.
- Esc closes the open widget or panel; focus returns to the field or to the button that opened the panel.
- Status goes to one `aria-live="polite"` region; only one toast shows at a time. Errors stay until dismissed or
  resolved; "saved" and "info" toasts hide themselves. A message the region already holds is announced again: the
  region empties, then gets the text back 100ms later, since many screen readers ignore a region set to the same text.
  This covers `ctx.announce` and `api.status` too.
- An error is shown in text, not only announced (WCAG 3.3.1): a number or date the browser can't read, refused on Enter,
  shows a line under its input that the input names with `aria-describedby` and marks with `aria-invalid="true"`.
- Touch targets are at least `--cms-control-h` (44px). Under 40em the bar, panels and popovers become bottom
  sheets that respect the safe-area inset.
- With `prefers-reduced-motion: reduce` transitions are opacity-only and at most 120ms.

## Content Security Policy

The chrome ships no inline scripts and builds every node with `createElement` and text nodes (no `innerHTML`). The
only inline styles it sets are computed custom properties (`--cms-badge-top`, `--cms-badge-left`,
`--cms-popover-top`, `--cms-popover-left`, `--cms-toolbar-top`, `--cms-toolbar-left`) for positioning, which a
`style-src` policy permits through the CSSOM. The rich text widget turns off TipTap's injected `<style>` tag
(`injectCSS: false`); the few rules ProseMirror needs are in `chrome.css` under `.cms-richtext`.
It loads nothing from other origins and makes requests only to `base`.
