# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are git tags, not registry publishes.

## [Unreleased]

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

### Removed

- **Breaking:** `MediaStore`, `MediaVariantSchema` and `MediaVariant` are no longer exported. They had no implementation and no consumer; media storage stays the host's concern (#3).
- **Breaking:** the chrome no longer reads a non-text field's value from its rendered text or from `data-edit-value`.

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

[Unreleased]: https://github.com/Forne14/yl-editor/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Forne14/yl-editor/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Forne14/yl-editor/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Forne14/yl-editor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Forne14/yl-editor/releases/tag/v0.1.0
