# @yl/editor

The core of in-place editing for server-rendered sites: an editor clicks the text on the live page, changes it, and
publishes it, with drafts and revisions underneath.

> Editing a page happens in place; anything list-shaped, person-shaped or number-shaped belongs in a back office.

## What is in the box

- **`ContentStore` seam.** Draft, publish, discard, retire, restore, rename and revisions behind one async interface.
  Writes take a `WriteContext`, so a store can attribute every revision to whoever made it.
- **`SchemaRegistry`.** Each document type is a zod schema; drafts are validated before they are published.
- **Path operations.** `parsePath`, `getAt`, `setAt` and `applyArrayOp` address fields inside a document and refuse
  `__proto__`, `prototype`, `constructor` and negative or non-integer indices.
- **`editable()` addressing.** Produces the `data-edit-*` attributes the chrome reads. `editable(undefined)` returns
  `{}`, so anonymous visitors get no editor attributes at all.
- **`Access` seam.** The host app answers "may this request edit or publish this document?" from its own permission
  model. The package never learns the shape of the host's users.
- **SQLite store** (`@yl/editor/sqlite`) for apps that run on one box, with its migration in `migrations/`.
- **Contract tests** (`@yl/editor/contract`). An app that writes its own store (Postgres, a hosted API) runs the same
  lifecycle suite against it in its own test run.

Planned subpaths, landing in the next release:

| Subpath             | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| `@yl/editor/access` | Helpers for mapping document types to the host's permissions    |
| `@yl/editor/http`   | Framework-neutral request handlers for the edit endpoints       |
| `@yl/editor/chrome` | The in-page editing chrome, plus `@yl/editor/chrome/chrome.css` |

The core depends on zod and TypeScript only. Stores, frameworks and widgets are the host's concern.

## Install

Releases are git tags; nothing is published to the npm registry. Pin a tag:

```json
"@yl/editor": "github:Forne14/yl-editor#v0.1.0"
```

`npm install` runs the package's `prepare` script, which compiles `src/` to `dist/`, so the install needs the
package's dev dependencies to be fetchable (npm does this for git dependencies automatically). Requires Node 24 or
later.

Peer dependencies: `zod` (required), `better-sqlite3` (only for `@yl/editor/sqlite`) and `vitest` (only for
`@yl/editor/contract`).

## Documentation

- [`docs/store.md`](docs/store.md): the `ContentStore` lifecycle and writing your own store
- [`docs/access.md`](docs/access.md): implementing the `Access` seam
- [`docs/chrome.md`](docs/chrome.md): mounting the editing chrome

## Commands

| Command          | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `npm install`    | Installs dependencies and builds `dist/`              |
| `npm run build`  | `tsc` to `dist/`, then copies stylesheets alongside   |
| `npm run lint`   | ESLint and Prettier check                             |
| `npm run format` | Prettier, writing changes                             |
| `npm run check`  | `tsc --noEmit`                                        |
| `npm test`       | Vitest: path, editable and the SQLite store lifecycle |
| `npm run verify` | Lint, check and test; must pass before a tag          |

## Releasing

Tag, never publish:

```sh
git tag -a v0.2.0 -m "v0.2.0: ..."
git push --tags
```

- Keep `version` in `package.json` equal to the latest tag, and move the `Unreleased` entries in
  [`CHANGELOG.md`](CHANGELOG.md) under the new version.
- A change that breaks a consumer is a major tag, and the tag message says so.
- Consumers upgrade by bumping the tag in their own `package.json`.

## Security

See [`SECURITY.md`](SECURITY.md).

## Licence

MIT. See [`LICENSE`](LICENSE).
