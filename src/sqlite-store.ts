import type Database from "better-sqlite3";
import { z } from "zod";
import { applyArrayOp, parsePath, setAt } from "./path";
import {
  ArrayOpSchema,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  RevisionSchema,
  type ArrayOp,
  type ContentStore,
  type ReadOptions,
  type Revision,
  type SchemaRegistry,
  type StoredDocument,
} from "./types";

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
      result.error.issues.map((i) => ({ ...i, path: [column, ...i.path] })),
    );
  return result.data;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createSqliteContentStore(
  db: Database.Database,
  registry: SchemaRegistry,
  clock: () => Date = () => new Date(),
): ContentStore {
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

  const rowByKey = (key: string): Row | undefined =>
    db.prepare<[string], Row>("SELECT * FROM documents WHERE key = ?").get(key);

  const requireRow = (key: string): Row => {
    const row = rowByKey(key);
    if (!row) throw new DocumentNotFoundError(key);
    return row;
  };

  const toDoc = (row: Row, draft: boolean): StoredDocument | null => {
    const raw = draft ? (row.draft_payload ?? row.published_payload) : row.published_payload;
    if (raw === null) return null;
    return {
      id: row.id,
      key: row.key,
      type: row.type,
      slug: row.slug,
      payload: validate(
        row.key,
        row.type,
        parseColumn(
          row.key,
          draft && row.draft_payload !== null ? "draft_payload" : "published_payload",
          raw,
          z.unknown(),
        ),
      ),
      isDraft: draft && row.draft_payload !== null,
      publishedAt: row.published_at,
      draftUpdatedAt: row.draft_updated_at,
      previousSlugs: parseColumn(row.key, "previous_slugs", row.previous_slugs, SLUG_LIST),
      retiredAt: row.retired_at,
    };
  };

  const mustDoc = (key: string, draft = true): StoredDocument => {
    const doc = toDoc(requireRow(key), draft);
    if (!doc) throw new DocumentNotFoundError(key);
    return doc;
  };

  /** The payload text a lifecycle revision records: published if present, else the draft. */
  const livePayload = (row: Row): string => {
    const raw = row.published_payload ?? row.draft_payload;
    if (raw === null) throw new DocumentStateError(`Document ${row.key} has no payload`);
    return raw;
  };

  const writeDraft = (row: Row, payload: unknown): StoredDocument => {
    const valid = validate(row.key, row.type, payload);
    db.prepare("UPDATE documents SET draft_payload = ?, draft_updated_at = ? WHERE id = ?").run(
      JSON.stringify(valid),
      now(),
      row.id,
    );
    return mustDoc(row.key);
  };

  const currentPayload = (row: Row): unknown => {
    const draft = row.draft_payload !== null;
    return parseColumn(
      row.key,
      draft ? "draft_payload" : "published_payload",
      (row.draft_payload ?? row.published_payload) as string,
      z.unknown(),
    );
  };

  const addRevision = (row: Row, action: Revision["action"], payload: string) =>
    db
      .prepare("INSERT INTO revisions (document_id, action, slug, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, action, row.slug, payload, now());

  return {
    create(type, slug, payload) {
      const { collection } = entryFor(type);
      if (!SLUG.test(slug)) throw new Error(`Invalid slug ${slug}`);
      const key = `${collection}/${slug}`;
      if (rowByKey(key)) throw new DocumentStateError(`Document ${key} already exists`);
      const valid = validate(key, type, payload);
      const t = now();
      db.prepare(
        "INSERT INTO documents (key, type, slug, draft_payload, draft_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(key, type, slug, JSON.stringify(valid), t, t);
      return mustDoc(key);
    },

    get(key, opts: ReadOptions = {}) {
      const row = rowByKey(key);
      if (!row) return null;
      if (row.retired_at && !opts.includeRetired) return null;
      return toDoc(row, opts.draft ?? false);
    },

    list(type, opts: ReadOptions = {}) {
      const rows = db.prepare<[string], Row>("SELECT * FROM documents WHERE type = ? ORDER BY key").all(type);
      return rows
        .filter((r) => opts.includeRetired || !r.retired_at)
        .map((r) => toDoc(r, opts.draft ?? false))
        .filter((d): d is StoredDocument => d !== null);
    },

    writeField(key, path, value) {
      const row = requireRow(key);
      const next = setAt(currentPayload(row), parsePath(path), value);
      return writeDraft(row, next);
    },

    arrayOp(key, path, rawOp: ArrayOp) {
      const parsed = ArrayOpSchema.safeParse(rawOp);
      if (!parsed.success) throw new PathError(`Invalid array operation: ${parsed.error.message}`);
      const op = parsed.data;
      const row = requireRow(key);
      const next = applyArrayOp(currentPayload(row), parsePath(path), op);
      return writeDraft(row, next);
    },

    publish(key) {
      const row = requireRow(key);
      if (row.draft_payload === null) throw new DocumentStateError(`Document ${key} has no draft to publish`);
      validate(key, row.type, parseColumn(key, "draft_payload", row.draft_payload, z.unknown()));
      db.transaction(() => {
        db.prepare(
          "UPDATE documents SET published_payload = draft_payload, draft_payload = NULL, draft_updated_at = NULL, published_at = ? WHERE id = ?",
        ).run(now(), row.id);
        addRevision(row, "publish", row.draft_payload as string);
      })();
      return mustDoc(key, false);
    },

    discardDraft(key) {
      const row = requireRow(key);
      if (row.published_payload === null) {
        db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
        return null;
      }
      db.prepare("UPDATE documents SET draft_payload = NULL, draft_updated_at = NULL WHERE id = ?").run(row.id);
      return mustDoc(key, false);
    },

    retire(key) {
      const row = requireRow(key);
      if (row.retired_at) throw new DocumentStateError(`Document ${key} is already retired`);
      db.transaction(() => {
        db.prepare("UPDATE documents SET retired_at = ? WHERE id = ?").run(now(), row.id);
        addRevision(row, "retire", livePayload(row));
      })();
      return mustDoc(key);
    },

    restore(key) {
      const row = requireRow(key);
      if (!row.retired_at) throw new DocumentStateError(`Document ${key} is not retired`);
      db.transaction(() => {
        db.prepare("UPDATE documents SET retired_at = NULL WHERE id = ?").run(row.id);
        addRevision(row, "restore", livePayload(row));
      })();
      return mustDoc(key);
    },

    rename(key, newSlug) {
      const row = requireRow(key);
      if (!SLUG.test(newSlug)) throw new Error(`Invalid slug ${newSlug}`);
      const { collection } = entryFor(row.type, key);
      const newKey = `${collection}/${newSlug}`;
      if (rowByKey(newKey)) throw new DocumentStateError(`Document ${newKey} already exists`);
      const earlier = parseColumn(key, "previous_slugs", row.previous_slugs, SLUG_LIST);
      const previous = [...earlier.filter((s) => s !== newSlug && s !== row.slug), row.slug];
      db.transaction(() => {
        db.prepare("UPDATE documents SET key = ?, slug = ?, previous_slugs = ? WHERE id = ?").run(
          newKey,
          newSlug,
          JSON.stringify(previous),
          row.id,
        );
        addRevision({ ...row, slug: newSlug }, "rename", livePayload(row));
      })();
      return mustDoc(newKey);
    },
    revisions(key) {
      const row = requireRow(key);
      return db
        .prepare<
          [number],
          { id: number; action: Revision["action"]; slug: string; payload: string; created_at: string }
        >("SELECT id, action, slug, payload, created_at FROM revisions WHERE document_id = ? ORDER BY id")
        .all(row.id)
        .map((r) => {
          const parsed = RevisionSchema.safeParse({
            id: r.id,
            action: r.action,
            slug: r.slug,
            payload: parseColumn(key, "revisions.payload", r.payload, z.unknown()),
            createdAt: r.created_at,
          });
          if (!parsed.success)
            throw new Error(`Document ${key}: revision ${r.id} is malformed: ${parsed.error.message}`);
          return parsed.data;
        });
    },
    findByPreviousSlug(collection, slug) {
      const hit = db
        .prepare<[string, string, string], { key: string }>(
          "SELECT d.key FROM documents d, json_each(d.previous_slugs) p WHERE substr(d.key, 1, length(?) + 1) = ? || '/' AND p.value = ? AND d.retired_at IS NULL ORDER BY d.id LIMIT 1",
        )
        .get(collection, collection, slug);
      return hit?.key ?? null;
    },
  };
}
