import { z } from "zod";
import { applyArrayOp, parsePath, setAt } from "./path.js";
import { ArrayOpSchema, ConflictError, ContentValidationError, DocumentNotFoundError, DocumentStateError, PathError, RevisionSchema, SlugError, } from "./types.js";
const SLUG_LIST = z.array(z.string());
/** Parses a JSON text column; a malformed value throws an error naming the document and column. */
function parseColumn(key, column, raw, schema) {
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch {
        throw new ContentValidationError(key, [
            { code: "custom", path: [column], message: `column ${column} is not valid JSON` },
        ]);
    }
    const result = schema.safeParse(json);
    if (!result.success)
        throw new ContentValidationError(key, result.error.issues.map((issue) => ({ ...issue, path: [column, ...issue.path] })));
    return result.data;
}
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * The shipped ContentStore on better-sqlite3. The interface is async; the SQLite calls stay synchronous underneath
 * and each method simply resolves. Every mutation reads, checks and writes inside one transaction.
 */
export function createSqliteContentStore(db, registry, clock = () => new Date()) {
    const now = () => clock().toISOString();
    const entryFor = (type, key = type) => {
        const entry = registry.entry(type);
        if (!entry)
            throw new ContentValidationError(key, [{ code: "custom", path: [], message: `Unknown document type ${type}` }]);
        return entry;
    };
    const validate = (key, type, payload) => {
        const result = entryFor(type, key).schema.safeParse(payload);
        if (!result.success)
            throw new ContentValidationError(key, result.error.issues);
        return result.data;
    };
    const rowByKey = (key) => db.prepare("SELECT * FROM documents WHERE key = ?").get(key);
    const requireRow = (key) => {
        const row = rowByKey(key);
        if (!row)
            throw new DocumentNotFoundError(key);
        return row;
    };
    const toDoc = (row, draft) => {
        const raw = draft ? (row.draft_payload ?? row.published_payload) : row.published_payload;
        if (raw === null)
            return null;
        return {
            id: row.id,
            key: row.key,
            type: row.type,
            slug: row.slug,
            payload: validate(row.key, row.type, parseColumn(row.key, draft && row.draft_payload !== null ? "draft_payload" : "published_payload", raw, z.unknown())),
            isDraft: draft && row.draft_payload !== null,
            publishedAt: row.published_at,
            draftUpdatedAt: row.draft_updated_at,
            previousSlugs: parseColumn(row.key, "previous_slugs", row.previous_slugs, SLUG_LIST),
            retiredAt: row.retired_at,
            version: row.version,
        };
    };
    const mustDoc = (key, draft = true) => {
        const doc = toDoc(requireRow(key), draft);
        if (!doc)
            throw new DocumentNotFoundError(key);
        return doc;
    };
    /** The payload text a lifecycle revision records: published if present, else the draft. */
    const livePayload = (row) => {
        const raw = row.published_payload ?? row.draft_payload;
        if (raw === null)
            throw new DocumentStateError(`Document ${row.key} has no payload`);
        return raw;
    };
    const currentPayload = (row) => {
        const hasDraft = row.draft_payload !== null;
        return parseColumn(row.key, hasDraft ? "draft_payload" : "published_payload", (row.draft_payload ?? row.published_payload), z.unknown());
    };
    const addRevision = (row, action, payload, context) => db
        .prepare("INSERT INTO revisions (document_id, action, slug, payload, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.id, action, row.slug, payload, now(), context.actor ?? null);
    const requireSlug = (slug) => {
        if (!SLUG.test(slug))
            throw new SlugError(slug);
    };
    /**
     * Runs one mutation inside a transaction: loads the row, refuses a stale `expectedVersion` before anything is
     * written, then hands the row to the work. Every UPDATE the work issues bumps `version` itself.
     */
    const mutate = (key, context, work) => db.transaction(() => {
        const row = requireRow(key);
        if (context.expectedVersion !== undefined && context.expectedVersion !== row.version)
            throw new ConflictError(key, context.expectedVersion, row.version);
        return work(row);
    })();
    const writeDraft = (row, payload) => {
        const valid = validate(row.key, row.type, payload);
        db.prepare("UPDATE documents SET draft_payload = ?, draft_updated_at = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(valid), now(), row.id);
    };
    return {
        async create(type, slug, payload) {
            const { collection } = entryFor(type);
            requireSlug(slug);
            const key = `${collection}/${slug}`;
            return db.transaction(() => {
                if (rowByKey(key))
                    throw new DocumentStateError(`Document ${key} already exists`);
                const valid = validate(key, type, payload);
                const createdAt = now();
                db.prepare("INSERT INTO documents (key, type, slug, draft_payload, draft_updated_at, created_at, version) VALUES (?, ?, ?, ?, ?, ?, 1)").run(key, type, slug, JSON.stringify(valid), createdAt, createdAt);
                return mustDoc(key);
            })();
        },
        async get(key, opts = {}) {
            const row = rowByKey(key);
            if (!row)
                return null;
            if (row.retired_at && !opts.includeRetired)
                return null;
            return toDoc(row, opts.draft ?? false);
        },
        async list(type, opts = {}) {
            const rows = db.prepare("SELECT * FROM documents WHERE type = ? ORDER BY key").all(type);
            return rows
                .filter((row) => opts.includeRetired || !row.retired_at)
                .map((row) => toDoc(row, opts.draft ?? false))
                .filter((doc) => doc !== null);
        },
        async writeField(key, path, value, context = {}) {
            return mutate(key, context, (row) => {
                writeDraft(row, setAt(currentPayload(row), parsePath(path), value));
                return mustDoc(key);
            });
        },
        async arrayOp(key, path, rawOp, context = {}) {
            const parsed = ArrayOpSchema.safeParse(rawOp);
            if (!parsed.success)
                throw new PathError(`Invalid array operation: ${parsed.error.message}`);
            const op = parsed.data;
            return mutate(key, context, (row) => {
                writeDraft(row, applyArrayOp(currentPayload(row), parsePath(path), op));
                return mustDoc(key);
            });
        },
        async publish(key, context = {}) {
            return mutate(key, context, (row) => {
                if (row.draft_payload === null)
                    throw new DocumentStateError(`Document ${key} has no draft to publish`);
                validate(key, row.type, parseColumn(key, "draft_payload", row.draft_payload, z.unknown()));
                db.prepare("UPDATE documents SET published_payload = draft_payload, draft_payload = NULL, draft_updated_at = NULL, published_at = ?, version = version + 1 WHERE id = ?").run(now(), row.id);
                addRevision(row, "publish", row.draft_payload, context);
                return mustDoc(key, false);
            });
        },
        async discardDraft(key, context = {}) {
            return mutate(key, context, (row) => {
                if (row.published_payload === null) {
                    db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
                    return null;
                }
                db.prepare("UPDATE documents SET draft_payload = NULL, draft_updated_at = NULL, version = version + 1 WHERE id = ?").run(row.id);
                return mustDoc(key, false);
            });
        },
        async retire(key, context = {}) {
            return mutate(key, context, (row) => {
                if (row.retired_at)
                    throw new DocumentStateError(`Document ${key} is already retired`);
                db.prepare("UPDATE documents SET retired_at = ?, version = version + 1 WHERE id = ?").run(now(), row.id);
                addRevision(row, "retire", livePayload(row), context);
                return mustDoc(key);
            });
        },
        async restore(key, context = {}) {
            return mutate(key, context, (row) => {
                if (!row.retired_at)
                    throw new DocumentStateError(`Document ${key} is not retired`);
                db.prepare("UPDATE documents SET retired_at = NULL, version = version + 1 WHERE id = ?").run(row.id);
                addRevision(row, "restore", livePayload(row), context);
                return mustDoc(key);
            });
        },
        async rename(key, newSlug, context = {}) {
            requireSlug(newSlug);
            return mutate(key, context, (row) => {
                const { collection } = entryFor(row.type, key);
                const newKey = `${collection}/${newSlug}`;
                if (rowByKey(newKey))
                    throw new DocumentStateError(`Document ${newKey} already exists`);
                const earlier = parseColumn(key, "previous_slugs", row.previous_slugs, SLUG_LIST);
                const previous = [...earlier.filter((slug) => slug !== newSlug && slug !== row.slug), row.slug];
                db.prepare("UPDATE documents SET key = ?, slug = ?, previous_slugs = ?, version = version + 1 WHERE id = ?").run(newKey, newSlug, JSON.stringify(previous), row.id);
                addRevision({ ...row, slug: newSlug }, "rename", livePayload(row), context);
                return mustDoc(newKey);
            });
        },
        async revisions(key) {
            const row = requireRow(key);
            return db
                .prepare("SELECT id, action, slug, payload, created_at, actor FROM revisions WHERE document_id = ? ORDER BY id")
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
                .prepare("SELECT d.key FROM documents d, json_each(d.previous_slugs) p WHERE substr(d.key, 1, length(?) + 1) = ? || '/' AND p.value = ? AND d.retired_at IS NULL ORDER BY d.id LIMIT 1")
                .get(collection, collection, slug);
            return hit?.key ?? null;
        },
    };
}
//# sourceMappingURL=sqlite-store.js.map