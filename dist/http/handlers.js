import { ConflictError, ContentValidationError, DocumentNotFoundError, DocumentStateError, PathError, SlugError, } from "../types.js";
import { ArrayRequestSchema, CreateRequestSchema, DEFAULT_BASE, DiscardRequestSchema, DocumentQuerySchema, DocumentsQuerySchema, ERROR_STATUS, FieldRequestSchema, KeyRequestSchema, PublishDueRequestSchema, PublishRequestSchema, RenameRequestSchema, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, RestoreRevisionRequestSchema, RevisionsQuerySchema, UnpublishRequestSchema, } from "./wire.js";
/** Thrown inside a handler to produce an error envelope. */
class HttpError extends Error {
    code;
    extra;
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        this.extra = extra;
    }
}
/** The view an editor works on: the draft when there is one, retired documents included. */
const DRAFT_VIEW = { draft: true, includeRetired: true };
/** Most keys one `documents` request may name, after deduping. */
const MAX_DOCUMENT_KEYS = 100;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});
const errorResponse = (code, message, extra = {}) => json(ERROR_STATUS[code], { error: { code, message, ...extra } });
const methodNotAllowed = (method, allowed) => json(405, { error: { code: "bad_request", message: `Method ${method} not allowed` } }, {
    Allow: allowed,
});
const trimTrailingSlash = (path) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
/** True when the request plainly comes from another site. */
function isCrossSite(request, url) {
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite === "cross-site")
        return true;
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin)
        return true;
    return false;
}
/** The code and message a thrown error has on the wire. Unexpected errors are logged and never leak their message. */
function describeError(error) {
    if (error instanceof HttpError)
        return { code: error.code, message: error.message, extra: error.extra };
    if (error instanceof DocumentNotFoundError)
        return { code: "not_found", message: error.message };
    if (error instanceof ConflictError)
        return { code: "conflict", message: error.message };
    if (error instanceof ContentValidationError)
        return { code: "validation", message: error.message, extra: { issues: error.issues } };
    if (error instanceof PathError)
        return { code: "path", message: error.message };
    if (error instanceof DocumentStateError)
        return { code: "state", message: error.message };
    if (error instanceof SlugError)
        return { code: "slug", message: error.message };
    console.error("[@yl/editor/http] unexpected error", error);
    return { code: "internal", message: "Internal error" };
}
export function createContentHandlers(options) {
    const { store, registry, access } = options;
    const base = trimTrailingSlash(options.base ?? DEFAULT_BASE);
    const sameOrigin = options.sameOrigin ?? true;
    const deny = (verdict) => {
        if (!verdict.allowed)
            throw new HttpError("forbidden", verdict.reason);
    };
    /**
     * The stored row that gates a request; 404 when absent. Read unvalidated, so access checks and the document's
     * identity never depend on its payload: a document that fails its schema must stay repairable.
     */
    const existing = async (key) => {
        const document = await store.get(key, { ...DRAFT_VIEW, unvalidated: true });
        if (!document)
            throw new HttpError("not_found", `No document ${key}`);
        return document;
    };
    const gate = async (context, key, check) => {
        const document = await existing(key);
        deny(await access[check](context.locals, { type: document.type, key: document.key }));
        return document;
    };
    const parseBody = async (request, schema) => {
        let body;
        try {
            body = await request.json();
        }
        catch {
            throw new HttpError("bad_request", "Request body is not valid JSON");
        }
        const result = schema.safeParse(body);
        if (!result.success)
            throw new HttpError("bad_request", "Request body is malformed", { issues: result.error.issues });
        return result.data;
    };
    const parseQuery = (url, schema) => {
        const result = schema.safeParse(Object.fromEntries(url.searchParams));
        if (!result.success)
            throw new HttpError("bad_request", "Query is malformed", { issues: result.error.issues });
        return result.data;
    };
    /** A lifecycle write gated by `check` on the stored row. */
    const keyedWrite = (action, check, write) => async (context) => {
        const { key } = await parseBody(context.request, KeyRequestSchema);
        await gate(context, key, check);
        const document = await write(key, context.writeContext());
        return { body: { document }, change: { action, key, document } };
    };
    const routeTable = {
        documents: {
            method: "GET",
            run: async (context) => {
                const { keys } = parseQuery(context.url, DocumentsQuerySchema);
                const unique = [...new Set(keys.split(",").map((part) => part.trim()))].filter((part) => part.length > 0);
                if (unique.length > MAX_DOCUMENT_KEYS)
                    throw new HttpError("bad_request", `Too many keys: at most ${MAX_DOCUMENT_KEYS} per request`);
                const documents = {};
                const summaries = await Promise.all(unique.map(async (key) => {
                    // Unvalidated: one document with a bad payload must not hide the page the editor would repair it from.
                    const document = await store.get(key, { ...DRAFT_VIEW, unvalidated: true });
                    if (!document)
                        return null;
                    const ref = { type: document.type, key: document.key };
                    const [edit, publish] = await Promise.all([
                        access.canEdit(context.locals, ref),
                        access.canPublish(context.locals, ref),
                    ]);
                    return [
                        key,
                        {
                            key: document.key,
                            type: document.type,
                            version: document.version,
                            isDraft: document.isDraft,
                            draftUpdatedAt: document.draftUpdatedAt,
                            publishedAt: document.publishedAt,
                            access: { edit: edit.allowed, publish: publish.allowed },
                        },
                    ];
                }));
                for (const entry of summaries)
                    if (entry)
                        documents[entry[0]] = entry[1];
                return { body: { documents } };
            },
        },
        document: {
            method: "GET",
            run: async (context) => {
                const { key } = parseQuery(context.url, DocumentQuerySchema);
                const stored = await gate(context, key, "canEdit");
                // A draft failing its schema is reported, not served. Anything else that stops the validated read is a payload
                // to show as stored, such as a `migrate` that throws. The unvalidated read does not run into those, so if it
                // fails too then the store is failing, and that stays `internal`.
                const document = await store.get(key, DRAFT_VIEW).catch((error) => {
                    if (stored.isDraft && error instanceof ContentValidationError)
                        throw error;
                    return store.get(key, { ...DRAFT_VIEW, unvalidated: true });
                });
                if (!document)
                    throw new HttpError("not_found", `No document ${key}`);
                // `includeRetired`: retiring hides a document from visitors but keeps its published payload.
                const view = { draft: false, includeRetired: true };
                const published = await store.get(key, view).catch(() => store.get(key, { ...view, unvalidated: true }));
                // `null` means nothing is published, so a stored JSON `null` goes out as its text, like any unparseable column.
                const publishedPayload = published ? (published.payload ?? "null") : null;
                return { body: { document, publishedPayload } };
            },
        },
        revisions: {
            method: "GET",
            run: async (context) => {
                const { key } = parseQuery(context.url, RevisionsQuerySchema);
                await gate(context, key, "canEdit");
                const revisions = await store.revisions(key);
                return { body: { revisions } };
            },
        },
        field: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, FieldRequestSchema);
                await gate(context, body.key, "canEdit");
                const document = await store.writeField(body.key, body.path, body.value, context.writeContext(body.expectedVersion));
                return { body: { document }, change: { action: "field", key: body.key, document } };
            },
        },
        array: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, ArrayRequestSchema);
                await gate(context, body.key, "canEdit");
                const document = await store.arrayOp(body.key, body.path, body.op, context.writeContext(body.expectedVersion));
                return { body: { document }, change: { action: "array", key: body.key, document } };
            },
        },
        publish: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, PublishRequestSchema);
                await gate(context, body.key, "canPublish");
                const write = context.writeContext(body.expectedVersion);
                const document = await store.publish(body.key, body.at !== undefined ? { ...write, at: body.at } : write);
                return { body: { document }, change: { action: "publish", key: body.key, document } };
            },
        },
        unpublish: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, UnpublishRequestSchema);
                await gate(context, body.key, "canPublish");
                const document = await store.unpublish(body.key, context.writeContext(body.expectedVersion));
                return { body: { document }, change: { action: "unpublish", key: body.key, document } };
            },
        },
        "restore-revision": {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, RestoreRevisionRequestSchema);
                await gate(context, body.key, "canEdit");
                const document = await store.restoreRevision(body.key, body.revisionId, context.writeContext(body.expectedVersion));
                return { body: { document }, change: { action: "restore_revision", key: body.key, document } };
            },
        },
        "publish-due": {
            method: "POST",
            run: async (context) => {
                if (!options.publishDue)
                    throw new HttpError("forbidden", "publish-due is not enabled");
                const body = await parseBody(context.request, PublishDueRequestSchema);
                deny(await options.publishDue.authorize(context.locals));
                const failed = [];
                const documents = await store.publishDue(body.now, {
                    ...context.writeContext(),
                    onFailure: (key, error) => {
                        const { code, message } = describeError(error);
                        failed.push({ key, code, message });
                    },
                });
                return {
                    body: { documents, failed },
                    changes: documents.map((document) => ({ action: "publish", key: document.key, document })),
                };
            },
        },
        discard: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, DiscardRequestSchema);
                await gate(context, body.key, "canEdit");
                const document = await store.discardDraft(body.key, context.writeContext(body.expectedVersion));
                return { body: { document }, change: { action: "discard", key: body.key, document } };
            },
        },
        retire: { method: "POST", run: keyedWrite("retire", "canPublish", (key, write) => store.retire(key, write)) },
        restore: { method: "POST", run: keyedWrite("restore", "canPublish", (key, write) => store.restore(key, write)) },
        rename: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, RenameRequestSchema);
                await gate(context, body.key, "canPublish");
                const document = await store.rename(body.key, body.slug, context.writeContext());
                return { body: { document }, change: { action: "rename", key: body.key, document } };
            },
        },
        create: {
            method: "POST",
            run: async (context) => {
                const body = await parseBody(context.request, CreateRequestSchema);
                const entry = registry.entry(body.type);
                if (!entry)
                    throw new HttpError("validation", "Unknown document type", {
                        issues: [{ code: "custom", path: ["type"], message: `Unknown document type ${body.type}` }],
                    });
                const key = `${entry.collection}/${body.slug}`;
                deny(await access.canEdit(context.locals, { type: entry.type, key }));
                const document = await store.create(entry.type, body.slug, body.payload, context.writeContext());
                return { status: 201, body: { document }, change: { action: "create", key: document.key, document } };
            },
        },
    };
    const routes = Object.entries(routeTable).map(([name, route]) => `${route.method} ${name}`);
    /** Maps a thrown error onto the wire. Unexpected errors are logged and never leak their message. */
    const toResponse = async (error) => {
        const { code, message, extra } = describeError(error);
        if (error instanceof ConflictError) {
            // The document may fail its schema: a conflict during a repair still shows what is stored.
            const current = await store
                .get(error.key, DRAFT_VIEW)
                .catch(() => store.get(error.key, { ...DRAFT_VIEW, unvalidated: true }))
                .catch(() => null);
            return errorResponse(code, message, current ? { current } : {});
        }
        return errorResponse(code, message, extra);
    };
    /** Fire-and-forget: never rejects, so callers may leave it unawaited. */
    const notify = async (event) => {
        if (!options.onChange)
            return;
        try {
            await options.onChange(event);
        }
        catch (error) {
            console.error("[@yl/editor/http] onChange failed", error);
        }
    };
    async function handle(request) {
        try {
            const url = new URL(request.url);
            const pathname = url.pathname;
            const name = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : undefined;
            const route = name !== undefined && Object.hasOwn(routeTable, name) ? routeTable[name] : undefined;
            if (!route)
                return errorResponse("not_found", "Unknown route");
            if (request.method !== route.method)
                return methodNotAllowed(request.method, route.method);
            if (request.headers.get(REQUESTED_WITH_HEADER) !== REQUESTED_WITH_VALUE)
                return errorResponse("forbidden", `Missing ${REQUESTED_WITH_HEADER} header`);
            if (sameOrigin && isCrossSite(request, url))
                return errorResponse("forbidden", "Cross-site request refused");
            const locals = await options.locals(request);
            const actor = options.actor?.(locals);
            const context = {
                request,
                url,
                locals,
                writeContext: (expectedVersion) => ({
                    ...(actor !== undefined ? { actor } : {}),
                    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
                }),
            };
            const result = await route.run(context);
            const response = json(result.status ?? 200, result.body);
            for (const change of [...(result.change ? [result.change] : []), ...(result.changes ?? [])])
                void notify({ ...change, ...(actor !== undefined ? { actor } : {}) });
            return response;
        }
        catch (error) {
            return toResponse(error);
        }
    }
    return { handle, routes };
}
//# sourceMappingURL=handlers.js.map