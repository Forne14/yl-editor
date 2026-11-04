import { ConflictError, ContentValidationError, DocumentNotFoundError, DocumentStateError, PathError, SlugError, } from "../types.js";
import { ArrayRequestSchema, CreateRequestSchema, DEFAULT_BASE, DocumentsQuerySchema, ERROR_STATUS, FieldRequestSchema, KeyRequestSchema, RenameRequestSchema, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, RevisionsQuerySchema, } from "./wire.js";
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
export function createContentHandlers(options) {
    const { store, registry, access } = options;
    const base = trimTrailingSlash(options.base ?? DEFAULT_BASE);
    const sameOrigin = options.sameOrigin ?? true;
    const deny = (verdict) => {
        if (!verdict.allowed)
            throw new HttpError("forbidden", verdict.reason);
    };
    /** The stored row (draft view, retired included) that gates a write; 404 when absent. */
    const existing = async (key) => {
        const document = await store.get(key, { draft: true, includeRetired: true });
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
                    const document = await store.get(key, { draft: true, includeRetired: true });
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
        publish: { method: "POST", run: keyedWrite("publish", "canPublish", (key, write) => store.publish(key, write)) },
        discard: { method: "POST", run: keyedWrite("discard", "canEdit", (key, write) => store.discardDraft(key, write)) },
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
        if (error instanceof HttpError)
            return errorResponse(error.code, error.message, error.extra);
        if (error instanceof DocumentNotFoundError)
            return errorResponse("not_found", error.message);
        if (error instanceof ConflictError) {
            const current = await store.get(error.key, { draft: true, includeRetired: true }).catch(() => null);
            return errorResponse("conflict", error.message, current ? { current } : {});
        }
        if (error instanceof ContentValidationError)
            return errorResponse("validation", error.message, { issues: error.issues });
        if (error instanceof PathError)
            return errorResponse("path", error.message);
        if (error instanceof DocumentStateError)
            return errorResponse("state", error.message);
        if (error instanceof SlugError)
            return errorResponse("slug", error.message);
        console.error("[@yl/editor/http] unexpected error", error);
        return errorResponse("internal", "Internal error");
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
            if (result.change)
                void notify({ ...result.change, ...(actor !== undefined ? { actor } : {}) });
            return response;
        }
        catch (error) {
            return toResponse(error);
        }
    }
    return { handle, routes };
}
//# sourceMappingURL=handlers.js.map