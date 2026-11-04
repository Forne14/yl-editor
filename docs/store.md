# The content store

`@yl/editor` owns the content model and its rules; the host owns storage. The two meet at one interface,
`ContentStore` (in `src/types.ts`). The package ships one implementation, `createSqliteContentStore` from
`@yl/editor/sqlite`, and a contract suite, `runContentStoreContract` from `@yl/editor/contract`, that any other
implementation must pass.

## The seam

```ts
interface ContentStore {
  create(type, slug, payload, context?): Promise<StoredDocument>;
  get(key, opts?): Promise<StoredDocument | null>;
  list(type, opts?): Promise<StoredDocument[]>;
  writeField(key, path, value, context?): Promise<StoredDocument>;
  arrayOp(key, path, op, context?): Promise<StoredDocument>;
  publish(key, context?): Promise<StoredDocument>;
  discardDraft(key, context?): Promise<StoredDocument | null>;
  retire(key, context?): Promise<StoredDocument>;
  restore(key, context?): Promise<StoredDocument>;
  rename(key, newSlug, context?): Promise<StoredDocument>;
  revisions(key): Promise<Revision[]>;
  findByPreviousSlug(collection, slug): Promise<string | null>;
}
```

Every method is async. The SQLite store is synchronous underneath and simply resolves; a store on a network database
cannot be. Every write takes a trailing `WriteContext`:

```ts
interface WriteContext {
  actor?: string;
  expectedVersion?: number;
}
```

A store is built with a `SchemaRegistry`, which maps a document type to its collection and its zod schema. Documents
are keyed `collection/slug`. Slugs are lower-case letters and digits joined by single hyphens; anything else throws
`SlugError`.

Every write is validated against the type's schema before it is stored (`ContentValidationError`), and every read is
validated again, so a payload that drifts from its schema fails loudly with the document's key rather than rendering
half a page. Paths into a payload refuse `__proto__`, `prototype`, `constructor` and negative or non-integer indices
(`PathError`); a path that misses changes nothing.

## Drafts and publishing

A document has at most two payloads: the published one, which visitors see, and a draft, which editors see.

- `create` stores a draft only. Published reads do not see the document until it is published.
- `writeField` and `arrayOp` edit the draft. When there is no draft yet, they start one from the published payload. The
  published payload is never touched.
- `get(key, { draft: true })` returns the draft when one exists and the published payload otherwise (the editor's
  view). Without `draft`, reads return published payloads only.
- `publish` copies the draft over the published payload, clears the draft and writes a `publish` revision. Publishing
  with no draft throws `DocumentStateError`.
- `discardDraft` drops the draft and returns the published document. On a document that was never published it deletes
  the document and returns `null`.
- `retire` hides a document from every read unless the caller passes `includeRetired`; `restore` brings it back. Both
  write a revision.
- `rename` moves the key, records the old slug in `previousSlugs` (unique, never the current slug) and writes a
  revision. `findByPreviousSlug` lets a host redirect an old URL; retired documents are not found.

Revisions record publish, retire, restore and rename, each with the payload that was live at the time. Draft edits are
not revisions.

## Versions and conflicts

Every document carries a `version`. It starts at 1 on `create` and increments by one on every draft write, publish,
discard, retire, restore and rename, inside the same transaction as the write. Reads and refused writes leave it
alone.

A caller that passes `expectedVersion` gets optimistic concurrency: when the stored version differs, the store throws
`ConflictError` (carrying `key`, `expected` and `actual`) before writing anything. The usual pattern is for the editor
chrome to send the version it last rendered and, on a conflict, reload the document and show the editor what changed.
Omitting `expectedVersion` means last write wins.

## Who made the change

The store records `actor` on revisions when the host passes it; the host writes its own activity log around the call
for anything richer. `actor` is an opaque string the host chooses (a user id, an email address, a role); the package
never learns the host's user shape. It is stored on the publish, retire, restore and rename revisions and is `null`
when absent. `create`, `writeField`, `arrayOp` and `discardDraft` accept it too, for symmetry, but write no revision.

## Running the contract against your own store

The contract registers the whole lifecycle as vitest tests. It assumes only the `ContentStore` interface and a registry
carrying one `note` type under the `notes` collection, `{ title: string (at least one character), tags: string[] }`.
`contractRegistry` is exported so you can build your store with it, or merge its entry into your own registry.

`makeStore` runs before every test and must return a store over empty storage: a fresh schema, a truncated table or a
transaction you roll back.

```ts
// src/lib/content/postgres-store.test.ts
import { contractRegistry, runContentStoreContract } from "@yl/editor/contract";
import { createPostgresContentStore } from "./postgres-store";
import { freshTestDatabase } from "./test-database";

runContentStoreContract(
  "postgres",
  async () => createPostgresContentStore(await freshTestDatabase(), contractRegistry),
  { registry: contractRegistry },
);
```

Keep tests that depend on your storage (malformed rows, clock injection, migrations) in your own file next to the
contract call, as `src/sqlite-store.test.ts` does here.

## Schema evolution

A registry entry may declare `version` (default 1) and `migrate(fromVersion, payload)`. Bump `version` when the schema
changes shape and have `migrate` return the payload in the new shape. The store records the entry's version in
`payload_version` on create, `writeField`, `arrayOp` and `publish`.

- **Reads.** When a row's stored version is behind the entry's and `migrate` exists, it runs before validation. Reads
  never write: the migrated payload is persisted by the next draft write, which migrates first and stamps the new
  version. Because one version column covers both payloads, that write also migrates a stale published payload in
  place.
- **Public reads (`draft: false`).** Validated with `safeParse`. A payload that fails the current schema is still
  served as stored (after migrate), and `onReadIssue(key, issues)` is called. The default logs `console.warn` once per
  key per process. Pass your own in the store's fourth argument: `createSqliteContentStore(db, registry, clock, { onReadIssue })`.
- **Editor reads (`draft: true`) and all writes** validate strictly and throw `ContentValidationError`.

`migrate` must be pure and cheap: it runs on every read of a stale row until a draft write persists the result.

## Migrations

The SQLite schema lives in `migrations/`, applied in name order:

| File                         | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `0001_documents.sql`         | The `documents` and `revisions` tables, with JSON checks and indexes.              |
| `0002_version_and_actor.sql` | Adds `documents.version` (default 0) and `revisions.actor` (nullable).             |
| `0003_payload_version.sql`   | Adds `documents.payload_version` (default 1), the registry version of the payload. |

Rows written before `0002` read as version 0; their first mutation takes them to 1.

Existing rows read as payload version 1.

A host on another database translates these files into its own dialect (for example `TEXT` JSON columns become
`jsonb`, `json_valid` checks become type constraints) and keeps the same columns and meanings. The contract suite is
the test that the translation is faithful.
