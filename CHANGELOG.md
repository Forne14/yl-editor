# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are git tags, not registry publishes.

## [Unreleased]

### Added

- Schema evolution: `RegistryEntry` takes `version` (default 1) and `migrate(fromVersion, payload)`. Migration
  `0003_payload_version.sql` adds `documents.payload_version`; apply it before upgrading a SQLite store.
- `createSqliteContentStore` takes an `onReadIssue(key, issues)` option.

### Changed

- Public reads (`draft: false`) no longer throw when a stored payload fails the current schema: they serve it and call
  `onReadIssue` (default: `console.warn` once per key). Editor reads and writes still throw `ContentValidationError`.

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

[Unreleased]: https://github.com/Forne14/yl-editor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Forne14/yl-editor/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Forne14/yl-editor/releases/tag/v0.1.0
