import type Database from "better-sqlite3";
import { z } from "zod";
import { applyArrayOp, parsePath, setAt } from "./path.ts";
import {
  ArrayOpSchema,
  ConflictError,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  RevisionSchema,
  SlugError,
  type ArrayOp,
  type ContentStore,
  type ReadOptions,
  type Revision,
  type SchemaRegistry,
  type StoredDocument,
  type WriteContext,
} from "./types.ts";

interface Row {
  id: number;
  key: string;
  type: string;
  slug: string;
  published_payload: string | null;
  draft_payload: string | null;
  published_at: string | null;
  draft_updated_at: string | null;
  previous_slugs: string;
  retired_at: string | null;
  version: number;
  payload_version: number;
  scheduled_at: string | null;
}

interface RevisionRow {
  id: number;
  action: Revision["action"];
  slug: string;
  payload: string;
  created_at: string;
  actor: string | null;
}

const SLUG_LIST = z.array(z.string());

/** Parses a JSON text column; a malformed value throws an error naming the document and column. */
function parseColumn<T>(key: string, column: string, raw: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ContentValidationError(key, [
      { code: "custom", path: [column], message: `column ${column} is not valid JSON` },
    ]);
  }
  const result = schema.safeParse(json);
  if (!result.success)
    throw new ContentValidationError(
      key,
      result.error.issues.map((issue) => ({ ...issue, path: [column, ...issue.path] })),
    );
  return result.data;
}

/** Keys already reported by the default `onReadIssue`, so a bad row warns once per process rather than per request. */
const warnedKeys = new Set<string>();

function warnOnce(key: string, issues: z.core.$ZodIssue[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(
    `[yl-editor] ${key} no longer matches its schema and is served as stored: ${issues.map((issue) => issue.message).join("; ")}`,
  );
}

export interface SqliteContentStoreOptions {
  /**
   * Called when a public read (`draft: false`) finds a payload that fails the current schema. The stored payload is
   * served anyway. Defaults to a `console.warn` once per key per process.
   */
  onReadIssue?: (key: string, issues: z.core.$ZodIssue[]) => void;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The filter for a document `publishDue` should promote; takes the cutoff as its one parameter. */
const DUE = "scheduled_at IS NOT NULL AND scheduled_at <= ? AND retired_at IS NULL AND draft_payload IS NOT NULL";

/** Result codes, primary or extended, about the database as a whole rather than the statement that hit them. */
const DATABASE_FAILURE_CODE = /^SQLITE_(?:BUSY|LOCKED|IOERR|CORRUPT|FULL|NOTADB|READONLY|CANTOPEN)(?:_|$)/;

/** By name: the store only imports better-sqlite3's types, the host owns the module. */
const isDatabaseFailure = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "SqliteError" &&
  "code" in error &&
  typeof error.code === "string" &&
  DATABASE_FAILURE_CODE.test(error.code);

const warnPublishFailure = (key: string, error: unknown): void => {
  console.warn(
    `[yl-editor] ${key} could not be published and stays scheduled: ${error instanceof Error ? error.message : String(error)}`,
  );
};

/**
 * The shipped ContentStore on better-sqlite3. The interface is async; the SQLite calls stay synchronous underneath
 * and each method simply resolves. Every mutation reads, checks and writes inside one transaction.
 */
export function createSqliteContentStore(
  db: Database.Database,
  registry: SchemaRegistry,
  clock: () => Date = () => new Date(),
  options: SqliteContentStoreOptions = {},
): ContentStore {
  const onReadIssue = options.onReadIssue ?? warnOnce;
  const now = () => clock().toISOString();

  const entryFor = (type: string, key: string = type) => {
    const entry = registry.entry(type);
    if (!entry)
      throw new ContentValidationError(key, [{ code: "custom", path: [], message: `Unknown document type ${type}` }]);
    return entry;
  };

  const validate = (key: string, type: string, payload: unknown): unknown => {
    const result = entryFor(type, key).schema.safeParse(payload);
    if (!result.success) throw new ContentValidationError(key, result.error.issues);
    return result.data;
  };

  const currentVersion = (type: string, key: string): number => entryFor(type, key).version ?? 1;

  /** Brings a stored payload up to the entry's version; a no-op when current or when the entry has no `migrate`. */
  const migrated = (row: Row, payload: unknown): unknown => {
    const entry = entryFor(row.type, row.key);
    if (row.payload_version >= (entry.version ?? 1) || !entry.migrate) return payload;
    return entry.migrate(row.payload_version, payload);
  };

  const rowByKey = (key: string): Row | undefined =>
    db.prepare<[string], Row>("SELECT * FROM documents WHERE key = ?").get(key);

  const requireRow = (key: string): Row => {
    const row = rowByKey(key);
    if (!row) throw new DocumentNotFoundError(key);
    return row;
  };

  /** A payload column as an unvalidated read returns it: migrated where that works, as stored where it does not. */
  const asStored = (row: Row, raw: string): unknown => {
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return raw;
    }
    try {
      return migrated(row, stored);
    } catch {
      return stored;
    }
  };

  const toDoc = (row: Row, draft: boolean, unvalidated = false): StoredDocument | null => {
    const raw = draft ? (row.draft_payload ?? row.published_payload) : row.published_payload;
    if (raw === null) return null;
    const isDraftPayload = draft && row.draft_payload !== null;
    const column = isDraftPayload ? "draft_payload" : "published_payload";
    const stored = unvalidated ? asStored(row, raw) : migrated(row, parseColumn(row.key, column, raw, z.unknown()));
    let payload: unknown;
    if (unvalidated) payload = stored;
    else if (draft) payload = validate(row.key, row.type, stored);
    else {
      const result = entryFor(row.type, row.key).schema.safeParse(stored);
      if (result.success) payload = result.data;
      else {
        onReadIssue(row.key, result.error.issues);
        payload = stored;
      }
    }
    return {
      id: row.id,
      key: row.key,
      type: row.type,
      slug: row.slug,
      payload,
      isDraft: draft && row.draft_payload !== null,
      publishedAt: row.published_at,
      draftUpdatedAt: row.draft_updated_at,
      previousSlugs: parseColumn(row.key, "previous_slugs", row.previous_slugs, SLUG_LIST),
      retiredAt: row.retired_at,
      version: row.version,
      scheduledAt: row.scheduled_at,
    };
  };

  const mustDoc = (key: string, draft = true, unvalidated = false): StoredDocument => {
    const doc = toDoc(requireRow(key), draft, unvalidated);
    if (!doc) throw new DocumentNotFoundError(key);
    return doc;
  };

  /**
   * The draft view after a write that moved stored payloads without validating them (`unpublish`, `discardDraft`,
   * `retire`, `restore`, `rename`). These must work on a document whose payload fails its schema, so a payload that
   * cannot be validated is returned as stored rather than rolling the write back.
   */
  const settledDoc = (key: string): StoredDocument => {
    try {
      return mustDoc(key);
    } catch {
      return mustDoc(key, true, true);
    }
  };

  /** The payload text a lifecycle revision records: published if present, else the draft. */
  const livePayload = (row: Row): string => {
    const raw = row.published_payload ?? row.draft_payload;
    if (raw === null) throw new DocumentStateError(`Document ${row.key} has no payload`);
    return raw;
  };

  const currentPayload = (row: Row): unknown => {
    const hasDraft = row.draft_payload !== null;
    return migrated(
      row,
      parseColumn(
        row.key,
        hasDraft ? "draft_payload" : "published_payload",
        (row.draft_payload ?? row.published_payload) as string,
        z.unknown(),
      ),
    );
  };

  const addRevision = (row: Row, action: Revision["action"], payload: string, context: WriteContext) =>
    db
      .prepare(
        "INSERT INTO revisions (document_id, action, slug, payload, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, action, row.slug, payload, now(), context.actor ?? null);

  /** Validates the draft and moves it to published, clearing any schedule; writes the `publish` revision. */
  const promote = (row: Row, context: WriteContext): StoredDocument => {
    if (row.draft_payload === null) throw new DocumentStateError(`Document ${row.key} has no draft to publish`);
    const valid = JSON.stringify(
      validate(row.key, row.type, migrated(row, parseColumn(row.key, "draft_payload", row.draft_payload, z.unknown()))),
    );
    db.prepare(
      "UPDATE documents SET published_payload = ?, draft_payload = NULL, draft_updated_at = NULL, payload_version = ?, published_at = ?, scheduled_at = NULL, version = version + 1 WHERE id = ?",
    ).run(valid, currentVersion(row.type, row.key), now(), row.id);
    addRevision(row, "publish", valid, context);
    return mustDoc(row.key, false);
  };

  const normalizeAt = (at: string): string => {
    const time = Date.parse(at);
    if (Number.isNaN(time))
      throw new DocumentStateError(`Invalid schedule time ${JSON.stringify(at)}: use an ISO string`);
    return new Date(time).toISOString();
  };

  const requireSlug = (slug: string) => {
    if (!SLUG.test(slug)) throw new SlugError(slug);
  };

  /**
   * Runs one mutation inside a transaction: loads the row, refuses a stale `expectedVersion` before anything is
   * written, then hands the row to the work. Every UPDATE the work issues bumps `version` itself.
   */
  const mutate = <Result>(key: string, context: WriteContext, work: (row: Row) => Result): Result =>
    db.transaction(() => {
      const row = requireRow(key);
      if (context.expectedVersion !== undefined && context.expectedVersion !== row.version)
        throw new ConflictError(key, context.expectedVersion, row.version);
      return work(row);
    })();

  /** The published column at the entry's current version; undefined when there is none or it cannot be brought there. */
  const migratedPublished = (row: Row): string | undefined => {
    if (row.published_payload === null) return undefined;
    try {
      return JSON.stringify(migrated(row, JSON.parse(row.published_payload)));
    } catch {
      return undefined;
    }
  };

  /**
   * Persists a draft under the entry's current version. One `payload_version` covers both columns, so a stale
   * published payload is migrated in the same statement; otherwise it would be misread as current. A published payload
   * that cannot be migrated must not refuse a valid draft, so the statement leaves that column out: naming it would run
   * its CHECK on what is already stored.
   */
  const writeDraft = (row: Row, payload: unknown): void => {
    const valid = validate(row.key, row.type, payload);
    const published = migratedPublished(row);
    db.prepare(
      `UPDATE documents SET draft_payload = ?, ${published === undefined ? "" : "published_payload = ?, "}payload_version = ?, draft_updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(
      JSON.stringify(valid),
      ...(published === undefined ? [] : [published]),
      currentVersion(row.type, row.key),
      now(),
      row.id,
    );
  };

  return {
    async create(type, slug, payload) {
      const { collection } = entryFor(type);
      requireSlug(slug);
      const key = `${collection}/${slug}`;
      return db.transaction(() => {
        if (rowByKey(key)) throw new DocumentStateError(`Document ${key} already exists`);
        const valid = validate(key, type, payload);
        const createdAt = now();
        db.prepare(
          "INSERT INTO documents (key, type, slug, draft_payload, draft_updated_at, created_at, version, payload_version) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        ).run(key, type, slug, JSON.stringify(valid), createdAt, createdAt, entryFor(type).version ?? 1);
        return mustDoc(key);
      })();
    },

    async get(key, opts: ReadOptions = {}) {
      const row = rowByKey(key);
      if (!row) return null;
      if (row.retired_at && !opts.includeRetired) return null;
      return toDoc(row, opts.draft ?? false, opts.unvalidated ?? false);
    },

    async list(type, opts: ReadOptions = {}) {
      const rows = db.prepare<[string], Row>("SELECT * FROM documents WHERE type = ? ORDER BY key").all(type);
      return rows
        .filter((row) => opts.includeRetired || !row.retired_at)
        .map((row) => toDoc(row, opts.draft ?? false, opts.unvalidated ?? false))
        .filter((doc): doc is StoredDocument => doc !== null);
    },

    async writeField(key, path, value, context = {}) {
      return mutate(key, context, (row) => {
        writeDraft(row, setAt(currentPayload(row), parsePath(path), value));
        return mustDoc(key);
      });
    },

    async arrayOp(key, path, rawOp: ArrayOp, context = {}) {
      const parsed = ArrayOpSchema.safeParse(rawOp);
      if (!parsed.success) throw new PathError(`Invalid array operation: ${parsed.error.message}`);
      const op = parsed.data;
      return mutate(key, context, (row) => {
        writeDraft(row, applyArrayOp(currentPayload(row), parsePath(path), op));
        return mustDoc(key);
      });
    },

    async publish(key, context = {}) {
      const at = context.at === undefined ? undefined : normalizeAt(context.at);
      return mutate(key, context, (row) => {
        if (row.draft_payload === null) throw new DocumentStateError(`Document ${key} has no draft to publish`);
        if (at !== undefined) {
          validate(key, row.type, migrated(row, parseColumn(key, "draft_payload", row.draft_payload, z.unknown())));
          db.prepare("UPDATE documents SET scheduled_at = ?, version = version + 1 WHERE id = ?").run(at, row.id);
          return mustDoc(key);
        }
        return promote(row, context);
      });
    },

    async publishDue(at, context = {}) {
      const cutoff = at === undefined ? now() : normalizeAt(at);
      const report = (key: string, error: unknown) => {
        try {
          (context.onFailure ?? warnPublishFailure)(key, error);
        } catch (hookError) {
          // A broken hook must not lose the documents already published in this run.
          warnPublishFailure(key, hookError);
        }
      };
      const due = db
        .prepare<[string], { id: number; key: string }>(
          `SELECT id, key FROM documents WHERE ${DUE} ORDER BY scheduled_at, id`,
        )
        .all(cutoff);
      const published: StoredDocument[] = [];
      for (const [index, { id, key }] of due.entries()) {
        try {
          const document = db.transaction(() => {
            // Re-checked: anything could have changed the row since the query above, or since an earlier promotion.
            const row = db
              .prepare<[number, string], Row>(`SELECT * FROM documents WHERE id = ? AND ${DUE}`)
              .get(id, cutoff);
            return row ? promote(row, { actor: context.actor }) : null;
          })();
          if (document) published.push(document);
        } catch (error) {
          report(key, error);
          if (isDatabaseFailure(error)) {
            // The database itself is failing, not this document, so trying the rest would only repeat it. They stay
            // scheduled for the next run and are reported now, so the failures of a stopped run are complete.
            for (const rest of due.slice(index + 1)) report(rest.key, error);
            break;
          }
        }
      }
      return published;
    },

    async unpublish(key, context = {}) {
      return mutate(key, context, (row) => {
        if (row.published_payload === null) throw new DocumentStateError(`Document ${key} is not published`);
        const draft = row.draft_payload ?? row.published_payload;
        db.prepare(
          "UPDATE documents SET draft_payload = ?, draft_updated_at = ?, published_payload = NULL, published_at = NULL, scheduled_at = NULL, version = version + 1 WHERE id = ?",
        ).run(draft, row.draft_payload === null ? now() : row.draft_updated_at, row.id);
        addRevision(row, "unpublish", row.published_payload, context);
        return settledDoc(key);
      });
    },

    async restoreRevision(key, revisionId, context = {}) {
      return mutate(key, context, (row) => {
        const revision = db
          .prepare<[number, number], { payload: string }>(
            "SELECT payload FROM revisions WHERE id = ? AND document_id = ?",
          )
          .get(revisionId, row.id);
        if (!revision) throw new DocumentNotFoundError(key);
        const payload = parseColumn(key, "revisions.payload", revision.payload, z.unknown());
        writeDraft(row, payload);
        addRevision(row, "restore_revision", JSON.stringify(payload), context);
        return mustDoc(key);
      });
    },

    async discardDraft(key, context = {}) {
      return mutate(key, context, (row) => {
        if (row.published_payload === null) {
          db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
          return null;
        }
        db.prepare(
          "UPDATE documents SET draft_payload = NULL, draft_updated_at = NULL, scheduled_at = NULL, version = version + 1 WHERE id = ?",
        ).run(row.id);
        return settledDoc(key);
      });
    },

    async retire(key, context = {}) {
      return mutate(key, context, (row) => {
        if (row.retired_at) throw new DocumentStateError(`Document ${key} is already retired`);
        db.prepare("UPDATE documents SET retired_at = ?, version = version + 1 WHERE id = ?").run(now(), row.id);
        addRevision(row, "retire", livePayload(row), context);
        return settledDoc(key);
      });
    },

    async restore(key, context = {}) {
      return mutate(key, context, (row) => {
        if (!row.retired_at) throw new DocumentStateError(`Document ${key} is not retired`);
        db.prepare("UPDATE documents SET retired_at = NULL, version = version + 1 WHERE id = ?").run(row.id);
        addRevision(row, "restore", livePayload(row), context);
        return settledDoc(key);
      });
    },

    async rename(key, newSlug, context = {}) {
      requireSlug(newSlug);
      return mutate(key, context, (row) => {
        const { collection } = entryFor(row.type, key);
        const newKey = `${collection}/${newSlug}`;
        if (rowByKey(newKey)) throw new DocumentStateError(`Document ${newKey} already exists`);
        const earlier = parseColumn(key, "previous_slugs", row.previous_slugs, SLUG_LIST);
        const previous = [...earlier.filter((slug) => slug !== newSlug && slug !== row.slug), row.slug];
        db.prepare(
          "UPDATE documents SET key = ?, slug = ?, previous_slugs = ?, version = version + 1 WHERE id = ?",
        ).run(newKey, newSlug, JSON.stringify(previous), row.id);
        addRevision({ ...row, slug: newSlug }, "rename", livePayload(row), context);
        return settledDoc(newKey);
      });
    },

    async revisions(key) {
      const row = requireRow(key);
      return db
        .prepare<[number], RevisionRow>(
          "SELECT id, action, slug, payload, created_at, actor FROM revisions WHERE document_id = ? ORDER BY id",
        )
        .all(row.id)
        .map((revision) => {
          const parsed = RevisionSchema.safeParse({
            id: revision.id,
            action: revision.action,
            slug: revision.slug,
            payload: parseColumn(key, "revisions.payload", revision.payload, z.unknown()),
            createdAt: revision.created_at,
            actor: revision.actor,
          });
          if (!parsed.success)
            throw new Error(`Document ${key}: revision ${revision.id} is malformed: ${parsed.error.message}`);
          return parsed.data;
        });
    },

    async findByPreviousSlug(collection, slug) {
      const hit = db
        .prepare<[string, string, string], { key: string }>(
          "SELECT d.key FROM documents d, json_each(d.previous_slugs) p WHERE substr(d.key, 1, length(?) + 1) = ? || '/' AND p.value = ? AND d.retired_at IS NULL ORDER BY d.id LIMIT 1",
        )
        .get(collection, collection, slug);
      return hit?.key ?? null;
    },
  };
}
