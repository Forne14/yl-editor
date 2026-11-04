# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases are git tags, not registry publishes.

## [Unreleased]

### Added

- Build output: `prepare` compiles `src/` to `dist/` (JavaScript, declarations and source maps) so the package
  installs as a git dependency; Node does not strip types inside `node_modules`.
- `@yl/editor/contract`: the `ContentStore` lifecycle suite, exported so a host can run it against its own store.
- `@yl/editor/access` subpath (planned): helpers for mapping document types to host permissions.
- `@yl/editor/http` subpath (planned): framework-neutral handlers for the edit endpoints.
- `@yl/editor/chrome` subpath (planned): the in-page editing chrome and `@yl/editor/chrome/chrome.css`.
- ESLint, Prettier and a CI workflow running `verify` and `build`.

### Changed

- `zod` is now a peer dependency (`^4`) instead of a dependency, so the host and the package share one copy.
- `vitest` is an optional peer dependency, needed only for `@yl/editor/contract`.
- Requires Node 24 or later.
- **Breaking:** `Access` takes the document being edited and returns a verdict, instead of a boolean from the request
  alone.
- **Breaking:** `ContentStore` is async; every method returns a `Promise`.
- **Breaking:** store writes take a `WriteContext`, used to attribute revisions.

## [0.1.0]

### Added

- First release: `ContentStore` seam, `SchemaRegistry`, path operations, `editable()` addressing, `Access` seam and the
  SQLite store.

[Unreleased]: https://github.com/Forne14/yl-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Forne14/yl-editor/releases/tag/v0.1.0
