# @yl/editor

The in-place editing core shared by portfolio, skinmenu and South of the River: a `ContentStore` seam with drafts,
publish, discard, retire, restore, rename and revisions; a `SchemaRegistry` of zod document types; path operations
that refuse prototype pollution; `editable()` addressing for `data-edit-field` attributes; and an `Access` seam the host
app implements with its own permissions.

The core is store-agnostic. A SQLite store ships for apps that run on one box; an app on Postgres writes its own store
and runs this package's contract tests against it.

Extracted from `portfolio/packages/editor` on 2026-11-04 (decision: SOTR ADR-0013). Consumed as a git dependency
pinned to a tag:

```json
"@yl/editor": "github:Forne14/yl-editor#v0.1.0"
```

## Commands

| Command          | What it does                     |
| ---------------- | -------------------------------- |
| `npm install`    | Dev dependencies                 |
| `npm run check`  | `tsc --noEmit`                   |
| `npm test`       | Vitest: path, editable, SQLite store lifecycle |
| `npm run verify` | Both; must pass before a tag     |

## Releasing

Tag, never publish: `git tag v0.2.0 && git push --tags`. Consumers bump the tag in their `package.json`. Keep
`version` in `package.json` equal to the latest tag.

## What's next

See [`BRIEF.md`](BRIEF.md) for the enhancements the first consumer (SOTR) needs, and [`docs/adopt.md`](docs/adopt.md)
for the prompt that moves an app onto this package.
