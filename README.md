# yl/editor

The core of in-place editing for server-rendered sites: an editor clicks the text on the live page, changes it, and
publishes it, with drafts and revisions underneath.

> Editing a page happens in place; anything list-shaped, person-shaped or number-shaped belongs in a back office.

## What is in the box

| Import                         | What it gives you                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `@yl/editor`                   | The `ContentStore`, `SchemaRegistry` and `Access` seams, prototype-safe path operations and `editable()` field addressing |
| `@yl/editor/sqlite`            | `createSqliteContentStore()`, a store for apps on one box; its SQL lives in `migrations/`                                 |
| `@yl/editor/contract`          | `runContentStoreContract()`, the store lifecycle suite to run against your own store (needs `vitest`)                     |
| `@yl/editor/access`            | Permission atoms, a catalogue, a role engine and `documentAccess()`, which maps document types to atoms                   |
| `@yl/editor/http`              | `createContentHandlers()`, framework-neutral `Request` to `Response` edit endpoints, and a matching client                |
| `@yl/editor/chrome`            | `mountEditor()`, the framework-free in-page editing island                                                                |
| `@yl/editor/chrome/chrome.css` | The chrome's stylesheet                                                                                                   |
| `@yl/editor/richtext`          | The rich text widget, built on TipTap (optional peer dependencies); see `docs/chrome.md`                                  |

The core depends on zod and TypeScript only. Frameworks, databases, media storage and rich-text widgets stay the
host's concern: the package ships the `MediaStore` interface and `MediaVariantSchema` but no implementation, so the
host implements the store. The chrome has no default `media` widget, so a `media` field needs one the host registers.

## How the pieces fit

The server renders each editable field with `editable(docKey)(path, type)`, and only for a signed-in editor;
`editable(undefined)` returns `{}`, so anonymous visitors get no editor attributes and no editor bytes. The host mounts
`createContentHandlers()` at `/api/content` with a store and an `Access` built by `documentAccess()` from
`@yl/editor/access`, so every write is checked against the document it touches. On pages served to editors, and only
there, the host loads `@yl/editor/chrome` and its stylesheet and calls `mountEditor()`, which finds the marked fields
and talks to those endpoints.

## Install

Releases are git tags; nothing is published to the npm registry. Pin a tag:

```json
"@yl/editor": "github:Forne14/yl-editor#v0.2.0"
```

Tags carry the built `dist/`; branches do not. Pin a tag, never a branch: installing needs no build step and no
install scripts. Requires Node 24 or later.

Peer dependencies: `zod` (required), `better-sqlite3` (only for `@yl/editor/sqlite`) and `vitest` (only for
`@yl/editor/contract`).

## Documentation

- [`docs/store.md`](docs/store.md): the `ContentStore` lifecycle and writing your own store
- [`docs/access.md`](docs/access.md): permission atoms, roles and the `Access` seam
- [`docs/http.md`](docs/http.md): the edit endpoints and their wire format
- [`docs/chrome.md`](docs/chrome.md): mounting the editing chrome
- [`docs/diff.md`](docs/diff.md): `diffPayloads`, a structural draft-vs-published diff

## Commands

| Command                     | What it does                                         |
| --------------------------- | ---------------------------------------------------- |
| `npm install`               | Installs dev dependencies                            |
| `npm run release -- vX.Y.Z` | Verifies, builds and tags a release carrying `dist/` |
| `npm run build`             | `tsc` to `dist/`, then copies stylesheets alongside  |
| `npm run lint`              | ESLint and Prettier check                            |
| `npm run format`            | Prettier, writing changes                            |
| `npm run check`             | `tsc --noEmit`                                       |
| `npm test`                  | Vitest: core, SQLite store, access, http and chrome  |
| `npm run verify`            | Lint, check and test; must pass before a tag         |

## Releasing

Tag, never publish. Bump `version` in `package.json`, move the `Unreleased` entries in [`CHANGELOG.md`](CHANGELOG.md)
under a `## [X.Y.Z]` heading, commit, then:

```sh
npm run release -- vX.Y.Z
git push origin vX.Y.Z
git push
```

`npm run release` refuses unless the tree is clean, the tag matches `package.json`, the tag is new and the changelog
has the version's section. It runs `verify` and a clean `build`, then makes a release commit that adds `dist/` on top
of `HEAD` and tags it, without moving the branch: `dist/` stays untracked on branches. `--dry-run` does everything
except creating the tag. It never pushes.

- Keep `version` in `package.json` equal to the latest tag.
- A change that breaks a consumer is a major tag (the minor number while below 1.0), and the tag message says so.
- Consumers upgrade by bumping the tag in their own `package.json`.

## Security

See [`SECURITY.md`](SECURITY.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
