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
  publish(key, context?: WriteContext & { at?: string }): Promise<StoredDocument>;
  publishDue(now?, context?: WriteContext & { onFailure? }): Promise<StoredDocument[]>;
  unpublish(key, context?): Promise<StoredDocument>;
  restoreRevision(key, revisionId, context?): Promise<StoredDocument>;
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
`SlugError`. A registry implements `entry(type)` and `byCollection(collection)`; `entries()` is optional and unused
by the library, kept for back-office listing.

The package also exports a `MediaStore` interface (`upload`, `resolve`) and `MediaVariantSchema`, the shape of what
`resolve` returns. It ships no implementation: the host implements `MediaStore` over its own storage. Nothing in the
store, the HTTP handlers or the chrome calls it, so a `media` field also needs a widget the host registers.

Every write of a payload is validated against the type's schema before it is stored (`ContentValidationError`), and
every read is validated again unless it asks for `unvalidated` (see [Schema evolution](#schema-evolution)), so a payload
that drifts from its schema fails loudly with the document's key rather than rendering half a page. Paths into a payload refuse `__proto__`, `prototype`, `constructor` and negative or non-integer indices
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

### Unpublish, restore a revision, schedule

- `unpublish` takes a published document back to draft-only without retiring it. With no draft, the published payload
  becomes the draft; with a draft, the draft is kept and the published payload is dropped. It records an `unpublish`
  revision holding the previously published payload. A never-published document throws `DocumentStateError`.
- `restoreRevision(key, revisionId)` copies that revision's payload into the draft (validated like any draft write) and
  records a `restore_revision` revision holding the restored payload. It never touches the published payload; publish
  afterwards to make it live. A revision id that does not exist, or belongs to another document, throws
  `DocumentNotFoundError` for `key`.
- `publish(key, { at })` with an ISO string schedules instead of publishing: the draft is validated, `scheduledAt` is
  stored (normalised to UTC ISO), the version bumps, nothing is published and no revision is written. It returns the
  draft document. Scheduling needs a draft (`DocumentStateError` otherwise) and an `at` that parses
  (`DocumentStateError` otherwise). Scheduling again replaces the time.
- `publishDue(now?, context?)` runs a plain `publish` (one `publish` revision each, `actor` from the context) for every
  non-retired document whose `scheduledAt` is at or before `now` (default: the store clock), clearing `scheduledAt`,
  and returns the published documents. It ignores `expectedVersion`. The host calls it from a timer or cron. Each
  document is promoted in its own transaction, after re-checking that it is still due. See below for failures.
- A plain `publish`, `discardDraft` and `unpublish` clear `scheduledAt`. Draft edits leave it in place.

#### When a due document fails

A due document that cannot be published (usually a draft that no longer matches its schema) changes nothing: it stays
scheduled, gets no revision, and is retried on every later run, so it publishes once it is repaired. The other due
documents still publish. Each failure goes to `context.onFailure(key, error)`, or to `console.warn` without one.

Failures of the document, including a `migrate` that throws or a per-document SQLite error such as `SQLITE_CONSTRAINT*`
or `SQLITE_TOOBIG`, do not stop the run. A database-wide failure does. In the SQLite store that is a `SqliteError` whose
`code` is `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_IOERR`, `SQLITE_CORRUPT`, `SQLITE_FULL`, `SQLITE_NOTADB`,
`SQLITE_READONLY` or `SQLITE_CANTOPEN`, or an extended code of one of those (`SQLITE_IOERR_WRITE`). It is reported for
the document it hit and, with the same error, for every document not reached, so the failures list everything that did
not publish. The documents already published stay published and are returned, and the rest stay scheduled for the next
run. Carrying on would only repeat the failure, and throwing would lose the list of what did publish. A custom store
decides what counts as a database failure for its own driver, and reports the rest the same way.

Revisions record publish, retire, restore, rename, restore_revision and unpublish, each with the payload that was live at the time. Draft edits are
not revisions.

## Versions and conflicts

Every document carries a `version`. It starts at 1 on `create` and increments by one on every draft write, publish,
discard, retire, restore, rename, unpublish, restoreRevision and scheduling, inside the same transaction as the write. Reads and refused writes leave it
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

The contract also covers `unvalidated` reads and `publishDue` failures. The cases that need a payload failing its schema
run only when you pass `reopen`. A store that ignores `unvalidated` still works behind the HTTP handlers, but a
document failing its schema then answers `422` on every route as it did before, and cannot be repaired over HTTP.

Keep tests that depend on your storage (malformed rows, clock injection, migrations) in your own file next to the
contract call, as `src/sqlite-store.test.ts` does here.

## Schema evolution

A registry entry may declare `version` (default 1) and `migrate(fromVersion, payload)`. Bump `version` when the schema
changes shape and have `migrate` return the payload in the new shape. The store records the entry's version in
`payload_version` on create, `writeField`, `arrayOp` and `publish`.

- **Reads.** When a row's stored version is behind the entry's and `migrate` exists, it runs before validation. Reads
  never write: the migrated payload is persisted by the next draft write, which migrates first and stamps the new
  version. Because one version column covers both payloads, that write also migrates a stale published payload in
  place. A published payload that cannot be migrated (malformed JSON, or a `migrate` that throws on it) does not refuse
  the draft: the column stays as stored and the write goes through. The version column still moves, because the draft
  is at the new version, so a later read no longer migrates that published payload. Public reads serve it unmigrated,
  through `onReadIssue` if it fails the schema, until a publish replaces it, and fixing `migrate` afterwards does not
  reach it. Malformed JSON still throws on a validated read.
- **Public reads (`draft: false`).** Validated with `safeParse`. A payload that fails the current schema is still
  served as stored (after migrate), and `onReadIssue(key, issues)` is called. The default logs `console.warn` once per
  key per process. Pass your own in the store's fourth argument: `createSqliteContentStore(db, registry, clock, { onReadIssue })`.
- **Editor reads (`draft: true`), draft writes and publishing** validate strictly and throw `ContentValidationError`.
- **Unvalidated reads (`unvalidated: true`, on `get` and `list`).** Return the requested view with no schema validation
  and nothing sent to `onReadIssue`. `migrate` still runs; if it throws, the payload comes back as stored. Use them for
  a document's identity (access checks, summaries, repairs), never for rendering. `draft` and `includeRetired` mean
  what they always do. Columns other than the payload, such as `previous_slugs`, are still checked.

### Repairing a document that fails its schema

A document whose published payload or draft fails the current schema stays repairable. These writes apply:

| Write                         | Validates              | With a stale published payload, no draft   | With an invalid draft                                            |
| ----------------------------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `writeField`, `arrayOp`       | The resulting draft    | Works if the result is valid               | Works if the result is valid                                     |
| `restoreRevision`             | The revision's payload | Works if the revision is valid             | Works if the revision is valid                                   |
| `publish`, `publish({ at })`  | The draft              | `DocumentStateError`: no draft             | `ContentValidationError`: invalid content never goes live        |
| `discardDraft`                | Nothing                | Works; the payload stays as stored         | Drops the draft, or deletes the document if never published      |
| `unpublish`                   | Nothing                | Works; the stale payload becomes the draft | Works if published, keeping the draft; else `DocumentStateError` |
| `retire`, `restore`, `rename` | Nothing                | Works                                      | Works                                                            |

The writes that validate nothing only move stored payloads around, so they return the document validated when it can be
and as stored when it cannot. Taking a broken page offline with `unpublish` or `retire` must not depend on it being
valid. The result of `unpublish` on a stale payload is an invalid draft, which then behaves like any other: `publish` refuses
it until a draft write or a restored revision repairs it.

A revision has no recorded payload version, so `restoreRevision` validates it against the current schema without
migrating it. A revision from before a shape change fails with `ContentValidationError`.

The draft writes depend only on their own result, never on the published payload. `restoreRevision` works whatever state
the published column is in. `writeField` and `arrayOp` edit the draft when there is one, so they work too. With no draft
they edit the published payload, so they cannot start from one that cannot be read: malformed JSON throws
`ContentValidationError`, and a `migrate` that throws on it propagates that error.

`migrate` must be pure and cheap: it runs on every read of a stale row until a draft write persists the result.

## Migrations

The SQLite schema lives in `migrations/`, applied in name order:

| File                         | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `0001_documents.sql`         | The `documents` and `revisions` tables, with JSON checks and indexes.              |
| `0002_version_and_actor.sql` | Adds `documents.version` (default 0) and `revisions.actor` (nullable).             |
| `0003_payload_version.sql`   | Adds `documents.payload_version` (default 1), the registry version of the payload. |
| `0004_lifecycle.sql`         | Adds `documents.scheduled_at`; rebuilds `revisions` to widen the `action` CHECK.   |

Rows written before `0002` read as version 0; their first mutation takes them to 1.

Existing rows read as payload version 1.

`0004` rebuilds `revisions` (create, copy, drop, rename, recreate the index) because SQLite cannot alter a CHECK;
revision ids and data are preserved. A host on another database only needs to widen its action constraint.

A host on another database translates these files into its own dialect (for example `TEXT` JSON columns become
`jsonb`, `json_valid` checks become type constraints) and keeps the same columns and meanings. The contract suite is
the test that the translation is faithful.
