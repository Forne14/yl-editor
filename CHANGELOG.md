# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are git tags, not registry publishes.

## [Unreleased]

### Changed

- Chrome: the number and date widgets commit on Enter, on leaving the popover, or when the chrome closes it, no longer
  on `change`. A number committed after one arrow step and a date after one segment in Chromium and Firefox, and
  pressing Cancel after typing committed through the blur's `change`. A date picked from the browser's date picker,
  with no keystroke, still commits at once. Url already worked this way; select and toggle still commit on change.

### Fixed

- Chrome: Publish and Discard opened with a text edit or popover still open, or while a document's first save was on
  its way, listed nothing. The open edit is committed before the list is built, and a document with a save queued or
  in flight is listed.
- Chrome: clicking elsewhere on the page never committed an open popover when the click moved focus nowhere (plain
  content, and any button in Safari). A press outside the popover and its field now commits it, as does focus leaving
  to nowhere once it settles; a press inside the popover off its controls keeps it open.
- Chrome: Firefox stored a no-break space typed in a text field. Text widgets store plain spaces.
- Chrome: a pasted trailing space was lost when typing after it in Firefox and Safari. Paste uses the browser's
  `insertText`, with the old range insertion as a fallback.
- Chrome: the "Couldn't load the documents" toast stayed after Retry succeeded. A successful load hides it, unless
  another toast replaced it.
- Chrome: date and date-time inputs had no focus ring in Chromium and Safari (WCAG 2.4.7). They now show the accent ring
  the other controls use, on a mouse click as well as by keyboard.
- Chrome: a `select` was 23px tall in Safari, under the documented 44px and WCAG 2.5.8's 24px. It now takes its height
  from `--cms-control-h`, so a host with a much larger font should raise that token. Other browsers don't change.
- Chrome: Discard, Restore and the conflict catch-up left the old text in a field whose path the new content lacks. The
  field is emptied, and its `cms:change` carries `value: undefined`.

### Internal

- Real-browser test harness (#19). `npm run test:e2e` builds the package and runs Playwright specs in `e2e/` against a
  demo site in `examples/demo/` on Chromium, Firefox and WebKit. The demo serves the built chrome from `dist/` under a
  strict CSP, on the real SQLite store, content handlers and document access, with one in-memory database per test.
  Every spec fails on a console error, page error or CSP violation. CI runs it in a new `e2e` job. Neither directory
  ships in the package, and a unit test checks that.

## [0.4.1] - 2026-11-05

### Fixed

- `publishDue` is no longer all-or-nothing. Each due document is promoted in its own transaction after re-checking it is still due; one that fails stays scheduled and is retried on the next run, and the others publish. Failures go to a new optional `onFailure(key, error)` on its context, or to `console.warn`. A database failure stops the run, reported the same way, keeping what already published.
- A document whose published payload or draft fails its schema stays repairable over HTTP. Access checks no longer read the payload, so `GET revisions`, `POST restore-revision`, `discard`, `unpublish`, `retire`, `restore` and `rename` work on it, and a denied caller gets `403` rather than `422`. `POST field` and `POST array` still answer `422` with issues when the result is invalid and succeed when it is valid. `POST publish` of an invalid draft is still `422`.
- `GET documents` summarises a document with an invalid draft instead of failing the whole request with `422`. `GET document` still answers `422` for an invalid draft.
- Store: `unpublish`, `discardDraft`, `retire`, `restore` and `rename` no longer throw, or roll back, when the document fails its schema. They validate nothing and return it as stored.
- A `conflict` on a document failing its schema now carries `current`, as stored.
- `POST discard` honoured no `expectedVersion`; it now accepts it and answers `409 conflict` when stale (`DiscardRequestSchema`).
- Client: `publish(key, { at?, expectedVersion? })`, `unpublish(key, { expectedVersion? })`, `restoreRevision(key, revisionId, { expectedVersion? })` and `discard(key, { expectedVersion? })` can send `expectedVersion`.
- **Breaking:** `DocumentResponse` is `{ document }` again, as it was before 0.4.0. `GET document` and `client.documentForPublish` use the new `DocumentForPublishResponse`, `{ document, publishedPayload }`.
- Chrome: a field save queued behind Publish, Discard, Unpublish or Restore no longer conflicts with the editor's own write. The lifecycle result is applied before the document's write chain releases, including when Discard deletes the document.
- Chrome: Publish can no longer overwrite a change the editor hasn't seen. It sends the version whose diff the sheet showed, moved forward only by the editor's own accepted writes from that version. On a conflict nothing is published, the sheet says so and reloads that document's diff, and there is no overwrite. **Publish now** follows the same rule and opens the sheet on a conflict.
- Chrome: Unpublish, Restore and Discard send the session's known version. On a conflict a toast says the document changed and the session and page catch up; nothing else happens.
- Chrome: a document failing in a bulk Publish or Discard no longer stops or misreports the others. Those that failed stay in the sheet with the reason, and a toast counts both.
- Chrome: reopening a field whose save failed and leaving it resends the value, for text, popover and host widgets. A truly untouched field still writes nothing. Discard and Restore drop failed values.
- Chrome: Unpublish, and a Restore that leaves the draft as it was, keep the document in the Publish sheet, across a reload too, so it can go live again. The bar counts such a document as one change.
- Chrome: any widget starts from the newest value committed for its path, so a popover reopened while a save is queued or in flight shows that value, and changing it back is saved rather than dropped.
- Chrome: a popover waiting on its fetch is cancelled by opening a sheet, panel or the revisions drawer, or by starting a lifecycle action, and doesn't open on a document deleted during the wait.
- Chrome: a document with an invalid draft stays repairable. The page, bar and revisions drawer load, Restore and Discard work and repaint, the publish sheet says it couldn't load that document only, and publishing it reports the validation error.
- Chrome: opening a sheet or panel commits a widget still open first, and the default text widget now commits when the chrome closes it (it has `handle.commit`), as popovers already did.
- `restoreRevision`, `writeField` and `arrayOp` no longer fail on a valid draft when the published payload is malformed or `migrate` throws on it. The published column stays as stored.
- `GET document` no longer fails when the published payload is malformed or `migrate` throws. `publishedPayload` is `null` only when nothing is published; an unparseable column comes back as its stored text (a string).
- `publishDue` stops only on database-wide SQLite errors such as `SQLITE_BUSY` or `SQLITE_IOERR*`. Per-document errors such as `SQLITE_CONSTRAINT*` report that document and continue. When a run stops, `onFailure` also runs for every remaining due document, so `failed` in `publish-due` is complete.
- Chrome: Cancel, Close or Esc during a bulk Publish or Discard stops documents not yet started. The one in flight finishes on its reviewed version, and a toast says how many finished.
- Chrome: a bulk run can no longer be submitted twice through the "Publish at" input, which is disabled during the run.
- Chrome: `api.refresh()` no longer moves a document's version backwards and causes a self-conflict.
- Chrome: the Publish sheet never shows or adopts a stale or mismatched diff. An unreadable published version, or a read that keeps being overtaken, shows "Couldn't load the changes", never the first-publish wording.

### Changed

- Chrome: the Discard sheet warns on each document with nothing published that discarding deletes it and its revision history. New `defaultStrings` keys: `bulkStopped`, `changesKeptMoving`, `changesUnreadable`, `discardDeletes`.
- **Breaking:** the Publish sheet's "Publish at" input is off by default. Pass `mountEditor({ scheduling: true })` to show it, and only if the host runs `publish-due` on a schedule and reads `failed` from the response, because otherwise a scheduled draft silently never publishes. An existing `scheduledAt` still shows in the bar with Publish now, and `api.publish(key, { at })` still schedules.
- With `scheduling` on, past times are refused: the input has a `min`, the time is checked again at Confirm, and the button is disabled with a line saying why.
- `WidgetContext` gains `unsaved`, true while `value` failed to save. A host widget that cancels when left untouched should commit instead while it is true. `value` is now the newest committed value rather than always the stored one.
- Chrome strings: new `actionConflict`, `publishConflict`, `reviewChanges`, `bulkDone`, `bulkPartial` and `scheduleInPast`. `firstPublish` and `discardedNeverPublished` are reworded, because a document with nothing live may have been unpublished rather than never published.
- **Breaking:** `POST publish-due` responds `{ documents, failed }`, where `failed` is `{ key, code, message }[]`, and `client.publishDue(now?)` returns that object rather than `WireDocument[]`. This changes a method added in 0.4.0.

### Added

- `ReadOptions.unvalidated` on `get` and `list`: the requested view as stored, with no schema validation, no `onReadIssue`, and no failure from `migrate`. Custom stores should implement it: the contract suite covers it, and without it a document failing its schema still answers `422` on every HTTP route.

## [0.4.0] - 2026-11-05

### Added

- HTTP: `GET document?key=` returns `{ document, publishedPayload }`, gated by `canEdit`: one document (draft view, retired included) and the payload published now, or `null` when it has none. A published payload that fails the current schema does not fail the route. Client `document(key)` and `documentForPublish(key)`.
- HTTP: `POST unpublish` (`canPublish`) and `POST restore-revision` (`canEdit`, draft only); client `unpublish(key)` and `restoreRevision(key, revisionId)`. `onChange` gains the `unpublish` and `restore_revision` actions.
- HTTP: `POST publish` accepts an optional ISO `at` to schedule the draft; client `publish(key, { at })`.
- HTTP: `POST publish-due` publishes every scheduled draft that is due and fires one `publish` change per document. It is off unless the host passes `publishDue: { authorize(locals) }`; client `publishDue(now?)`.
- HTTP: `publish`, `unpublish` and `restore-revision` accept an optional `expectedVersion` and answer `409 conflict` when it is stale.
- Stable-key path segments `name[_key=<id>]` (e.g. `sections[_key=a].items[_key=b].title`). `getAt`, `setAt` and `applyArrayOp` find the array item by `_key`, so a save still hits the right item after a concurrent reorder (#4).
- `formatPath(segments)`, the inverse of `parsePath`.
- `itemPath(base, item, index)` builds the keyed path when the item has a `_key` and falls back to the index path otherwise.
- docs/paths.md covers the grammar and the `_key` convention. Index paths are unchanged; `diffPayloads` still emits index paths.
- Chrome: a Restore action with a confirm step on each revision (with `access.edit`) copies it into the draft and repaints the page's fields.
- Chrome: the publish sheet fetches each document afresh on every opening and lists its changes against the published payload with `diffPayloads`, or says it is a first publish.
- Chrome: an optional "Publish at" input schedules the publish; the bar shows "scheduled for <time>" with Publish now.
- Chrome: an Unpublish action with a confirm step in the revisions drawer (with `access.publish`).
- Chrome: `EditorApi` gains `unpublish(key)`, `restoreRevision(key, revisionId)` and `publish(key, { at })`; `DocumentState` gains `publishedAt` and `scheduledAt`; new `defaultStrings` keys (see docs/chrome.md).

### Changed

- **Breaking for code that calls it:** `SchemaRegistry.entries()` is now optional. The library never calls it; it is kept for back-office listing (#7). Custom registries may drop it.
- The store contract suite checks `entries()` only when the registry implements it.
- A keyed segment that matches no item throws `PathError`, and a path part containing a malformed `[_key=` is now rejected.
- Chrome: non-text widgets start from the stored value, fetched once per document per session with `GET document` and replaced by each write's result and each opening of the publish sheet. Publish, discard and the new lifecycle actions run on the document's write chain.
- Chrome: leaving a popover widget untouched writes nothing, even when the stored value is missing.
- Chrome: for non-text widgets, `data-edit-value` is now used only when the stored value is missing: the path is not in the document, or the fetch failed. In 0.3.0 it applied until a write returned the document, so it could win over the stored value. `text` and `richtext` still open without a fetch and use it until the document's payload is known.
- Chrome: leaving the default text widget with its text unchanged writes nothing, even when the starting value differs from the rendered text. In 0.3.0 that sent a write.
- `ContentClient`, `EditorApi` and `DocumentState` gain required members. This affects only hosts that hand-implement or mock them.
- Chrome: non-text widgets need the `GET document` route, unless the field carries `data-edit-value`, which they fall back to when the fetch fails.

### Removed

- Chrome: a non-text field's value is no longer read from its rendered text.

### Fixed

- `GET documents` no longer fails the whole request with `422` when one document has a stale published payload and no draft, which stopped the chrome loading. That document is summarised from the published view, as `GET document` already did; its access verdicts are still asked. A draft that fails its schema still fails the request.

## [0.3.0] - 2026-11-04

### Added

- Schema evolution: `RegistryEntry` takes `version` (default 1) and `migrate(fromVersion, payload)`. Migration
  `0003_payload_version.sql` adds `documents.payload_version`; apply it before upgrading a SQLite store.
- `createSqliteContentStore` takes an `onReadIssue(key, issues)` option.
- Store verbs: `restoreRevision(key, revisionId)` copies a revision into the draft (never the published payload);
  `unpublish(key)` returns a published document to draft-only; scheduled publish via `publish(key, { at })` and
  `publishDue(now?)`. Custom `ContentStore` implementations must add them.
- `StoredDocument` and `WireDocument` gain `scheduledAt`; revision actions gain `restore_revision` and `unpublish`.
- Migration `0004_lifecycle.sql` adds `documents.scheduled_at` and rebuilds `revisions` to widen its action CHECK;
  apply it before upgrading a SQLite store.

### Changed

- Public reads (`draft: false`) no longer throw when a stored payload fails the current schema: they serve it and call
  `onReadIssue` (default: `console.warn` once per key). Editor reads and writes still throw `ContentValidationError`.
- `discardDraft` clears `scheduled_at`.
- Migrations: run 0003 and 0004 before upgrading a SQLite store.

## [0.2.1] - 2026-11-04

### Fixed

- Bulk Discard lists touched documents by `access.edit`, matching the server's gate, with its own "needs edit access"
  copy.
- Publish and Discard wait for the document's in-flight field writes, so a confirmed publish cannot race (and 409)
  the last edit.
- A popover edit (url, tags, and the other form widgets) is committed instead of dropped when another field is
  opened, the page is refreshed, or the editor is exited or destroyed.
- A toggle opens with its current value rather than always unchecked.
- Discarding a never-published document detaches its fields and says "it had never been published" instead of
  asking for a reload.
- Malformed touched-document data in session storage is ignored instead of breaking every refresh.
- GET documents caps `?keys=` at 100 and reads the misses in parallel.
- `onChange` notification no longer delays the write response.
- The revisions route returns `Revision` rows directly.

## [0.2.0] - 2026-11-04

### Breaking

- `Access.canEdit(locals, doc)` and `Access.canPublish(locals, doc)` take the document (`{ type, key }`) and return an
  `AccessVerdict` instead of a boolean from the request alone.
- `ContentStore` is async: every method returns a `Promise`.
- Store writes take an optional `WriteContext`: `actor` is recorded on the revision, and `expectedVersion` makes the
  write fail with a conflict when the document has moved on.
- Migration `0002_version_and_actor.sql` adds `documents.version` and `revisions.actor`. Apply it before upgrading a
  SQLite store.
- `zod` is a peer dependency (`^4`) instead of a dependency, so the host and the package share one copy.
- Exports point at compiled `dist/` instead of `src/*.ts`.

### Added

- Build output on release tags: `src/` compiles to `dist/` (JavaScript, declarations and source maps), committed on
  the tag only, so the package installs as a git dependency with no install scripts. Node does not strip types inside
  `node_modules`. Pin a tag, never a branch.
- `npm run release -- vX.Y.Z`: verifies, builds and tags a release commit carrying `dist/`.
- `@yl/editor/contract`: the `ContentStore` lifecycle suite and its registry, for running against a host's own store.
  `vitest` is an optional peer, needed only here.
- `@yl/editor/access`: permission atoms, a catalogue, a role engine and `documentAccess()`, which adapts atoms to the
  `Access` seam.
- `@yl/editor/http`: `createContentHandlers()`, framework-neutral `Request` to `Response` handlers for the edit
  endpoints, and a matching client.
- `@yl/editor/chrome` and `@yl/editor/chrome/chrome.css`: the in-page editing island, `mountEditor()`.
- `editable()` takes a third argument of extra attributes for a field.
- ESLint, Prettier and a CI workflow running `verify` and `build`.
- Requires Node 24 or later.

## [0.1.0]

### Added

- First release: `ContentStore` seam, `SchemaRegistry`, path operations, `editable()` addressing, `Access` seam and the
  SQLite store.

[Unreleased]: https://github.com/Forne14/yl-editor/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Forne14/yl-editor/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Forne14/yl-editor/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Forne14/yl-editor/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Forne14/yl-editor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Forne14/yl-editor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Forne14/yl-editor/releases/tag/v0.1.0
