import type { z } from "zod";
import {
  ConflictError,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  PathError,
  SlugError,
  type Access,
  type AccessVerdict,
  type ContentStore,
  type MaybePromise,
  type SchemaRegistry,
  type StoredDocument,
  type WriteContext,
} from "../types.ts";
import {
  ArrayRequestSchema,
  CreateRequestSchema,
  DEFAULT_BASE,
  DocumentQuerySchema,
  DocumentsQuerySchema,
  ERROR_STATUS,
  FieldRequestSchema,
  KeyRequestSchema,
  PublishDueRequestSchema,
  PublishRequestSchema,
  RenameRequestSchema,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  RestoreRevisionRequestSchema,
  RevisionsQuerySchema,
  UnpublishRequestSchema,
  type DocumentSummary,
  type ErrorCode,
  type ErrorEnvelope,
} from "./wire.ts";

export type ChangeAction =
  | "create"
  | "field"
  | "array"
  | "publish"
  | "unpublish"
  | "discard"
  | "retire"
  | "restore"
  | "rename"
  | "restore_revision";

export interface ChangeEvent {
  action: ChangeAction;
  key: string;
  document: StoredDocument | null;
  actor?: string;
}

export interface ContentHandlerOptions {
  store: ContentStore;
  registry: SchemaRegistry;
  access: Access;
  /** Resolves the host's session for a request. The package passes it to `access` untouched. */
  locals: (request: Request) => MaybePromise<unknown>;
  /** Names the actor recorded on revisions (`WriteContext.actor`). */
  actor?: (locals: unknown) => string | undefined;
  /** Path prefix the routes live under, matched against the request URL's pathname. Default `/api/content`. */
  base?: string;
  /** Refuse requests whose `Origin` or `Sec-Fetch-Site` shows a cross-site caller. Default true. */
  sameOrigin?: boolean;
  /** Called after every successful write: the activity-log seam. Errors are logged, never surfaced. */
  onChange?: (event: ChangeEvent) => MaybePromise<void>;
  /**
   * Enables `POST publish-due`. That route publishes whatever is due across every document, so no per-document verdict
   * can gate it; `authorize` decides instead (typically: a cron secret or an admin session). Without it the route
   * answers `forbidden`.
   */
  publishDue?: { authorize: (locals: unknown) => MaybePromise<AccessVerdict> };
}

export interface ContentHandlers {
  /** Routes by pathname and method. Always resolves; never throws. */
  handle(request: Request): Promise<Response>;
  /** Every route as `"METHOD name"`. */
  routes: readonly string[];
}

/** Thrown inside a handler to produce an error envelope. */
class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { issues?: unknown; current?: StoredDocument } = {},
  ) {
    super(message);
  }
}

interface RequestContext {
  request: Request;
  url: URL;
  locals: unknown;
  writeContext: (expectedVersion?: number) => WriteContext;
}

type Change = Omit<ChangeEvent, "actor">;

interface RouteResult {
  status?: number;
  body: unknown;
  change?: Change;
  /** Several changes from one request (`publish-due`), each notified on its own. */
  changes?: Change[];
}

interface Route {
  method: "GET" | "POST";
  run: (context: RequestContext) => Promise<RouteResult>;
}

/** Most keys one `documents` request may name, after deduping. */
const MAX_DOCUMENT_KEYS = 100;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

type ErrorExtra = Pick<ErrorEnvelope["error"], "issues" | "current">;

const errorResponse = (code: ErrorCode, message: string, extra: ErrorExtra = {}): Response =>
  json(ERROR_STATUS[code], { error: { code, message, ...extra } } satisfies ErrorEnvelope);

const methodNotAllowed = (method: string, allowed: string): Response =>
  json(405, { error: { code: "bad_request", message: `Method ${method} not allowed` } } satisfies ErrorEnvelope, {
    Allow: allowed,
  });

const trimTrailingSlash = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

/** True when the request plainly comes from another site. */
function isCrossSite(request: Request, url: URL): boolean {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site") return true;
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return true;
  return false;
}

export function createContentHandlers(options: ContentHandlerOptions): ContentHandlers {
  const { store, registry, access } = options;
  const base = trimTrailingSlash(options.base ?? DEFAULT_BASE);
  const sameOrigin = options.sameOrigin ?? true;

  const deny = (verdict: AccessVerdict) => {
    if (!verdict.allowed) throw new HttpError("forbidden", verdict.reason);
  };

  /** The stored row (draft view, retired included) that gates a write; 404 when absent. */
  const existing = async (key: string): Promise<StoredDocument> => {
    const document = await store.get(key, { draft: true, includeRetired: true });
    if (!document) throw new HttpError("not_found", `No document ${key}`);
    return document;
  };

  const gate = async (context: RequestContext, key: string, check: "canEdit" | "canPublish") => {
    const document = await existing(key);
    deny(await access[check](context.locals, { type: document.type, key: document.key }));
    return document;
  };

  const parseBody = async <Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.infer<Schema>> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("bad_request", "Request body is not valid JSON");
    }
    const result = schema.safeParse(body);
    if (!result.success)
      throw new HttpError("bad_request", "Request body is malformed", { issues: result.error.issues });
    return result.data;
  };

  const parseQuery = <Schema extends z.ZodType>(url: URL, schema: Schema): z.infer<Schema> => {
    const result = schema.safeParse(Object.fromEntries(url.searchParams));
    if (!result.success) throw new HttpError("bad_request", "Query is malformed", { issues: result.error.issues });
    return result.data;
  };

  /**
   * The row `GET document` shows. With no draft the draft view is the published payload, which the store validates
   * strictly for editor reads, so a stale one would fail the read; that case takes the lenient published view, which
   * is the same document. A draft that fails its schema still throws: it is the draft being reported on.
   */
  const readable = async (key: string): Promise<StoredDocument> => {
    try {
      return await existing(key);
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      const published = await store.get(key, { draft: false, includeRetired: true });
      if (!published || published.draftUpdatedAt !== null) throw error;
      return published;
    }
  };

  /** A lifecycle write gated by `check` on the stored row. */
  const keyedWrite =
    (
      action: ChangeAction,
      check: "canEdit" | "canPublish",
      write: (key: string, context: WriteContext) => Promise<StoredDocument | null>,
    ): Route["run"] =>
    async (context) => {
      const { key } = await parseBody(context.request, KeyRequestSchema);
      await gate(context, key, check);
      const document = await write(key, context.writeContext());
      return { body: { document }, change: { action, key, document } };
    };

  const routeTable: Record<string, Route> = {
    documents: {
      method: "GET",
      run: async (context) => {
        const { keys } = parseQuery(context.url, DocumentsQuerySchema);
        const unique = [...new Set(keys.split(",").map((part) => part.trim()))].filter((part) => part.length > 0);
        if (unique.length > MAX_DOCUMENT_KEYS)
          throw new HttpError("bad_request", `Too many keys: at most ${MAX_DOCUMENT_KEYS} per request`);
        const documents: Record<string, DocumentSummary> = {};
        const summaries = await Promise.all(
          unique.map(async (key): Promise<[string, DocumentSummary] | null> => {
            const document = await store.get(key, { draft: true, includeRetired: true });
            if (!document) return null;
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
          }),
        );
        for (const entry of summaries) if (entry) documents[entry[0]] = entry[1];
        return { body: { documents } };
      },
    },
    document: {
      method: "GET",
      run: async (context) => {
        const { key } = parseQuery(context.url, DocumentQuerySchema);
        const document = await readable(key);
        deny(await access.canEdit(context.locals, { type: document.type, key: document.key }));
        // `includeRetired`: retiring hides a document from visitors but keeps its published payload.
        const published = await store.get(key, { draft: false, includeRetired: true });
        return { body: { document, publishedPayload: published?.payload ?? null } };
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
        const document = await store.writeField(
          body.key,
          body.path,
          body.value,
          context.writeContext(body.expectedVersion),
        );
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
        const document = await store.restoreRevision(
          body.key,
          body.revisionId,
          context.writeContext(body.expectedVersion),
        );
        return { body: { document }, change: { action: "restore_revision", key: body.key, document } };
      },
    },
    "publish-due": {
      method: "POST",
      run: async (context) => {
        if (!options.publishDue) throw new HttpError("forbidden", "publish-due is not enabled");
        const body = await parseBody(context.request, PublishDueRequestSchema);
        deny(await options.publishDue.authorize(context.locals));
        const documents = await store.publishDue(body.now, context.writeContext());
        return {
          body: { documents },
          changes: documents.map((document) => ({ action: "publish" as const, key: document.key, document })),
        };
      },
    },
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
  const toResponse = async (error: unknown): Promise<Response> => {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.extra);
    if (error instanceof DocumentNotFoundError) return errorResponse("not_found", error.message);
    if (error instanceof ConflictError) {
      const current = await store.get(error.key, { draft: true, includeRetired: true }).catch(() => null);
      return errorResponse("conflict", error.message, current ? { current } : {});
    }
    if (error instanceof ContentValidationError)
      return errorResponse("validation", error.message, { issues: error.issues });
    if (error instanceof PathError) return errorResponse("path", error.message);
    if (error instanceof DocumentStateError) return errorResponse("state", error.message);
    if (error instanceof SlugError) return errorResponse("slug", error.message);
    console.error("[@yl/editor/http] unexpected error", error);
    return errorResponse("internal", "Internal error");
  };

  /** Fire-and-forget: never rejects, so callers may leave it unawaited. */
  const notify = async (event: ChangeEvent) => {
    if (!options.onChange) return;
    try {
      await options.onChange(event);
    } catch (error) {
      console.error("[@yl/editor/http] onChange failed", error);
    }
  };

  async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const name = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : undefined;
      const route = name !== undefined && Object.hasOwn(routeTable, name) ? routeTable[name] : undefined;
      if (!route) return errorResponse("not_found", "Unknown route");
      if (request.method !== route.method) return methodNotAllowed(request.method, route.method);

      if (request.headers.get(REQUESTED_WITH_HEADER) !== REQUESTED_WITH_VALUE)
        return errorResponse("forbidden", `Missing ${REQUESTED_WITH_HEADER} header`);
      if (sameOrigin && isCrossSite(request, url)) return errorResponse("forbidden", "Cross-site request refused");

      const locals = await options.locals(request);
      const actor = options.actor?.(locals);
      const context: RequestContext = {
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
    } catch (error) {
      return toResponse(error);
    }
  }

  return { handle, routes };
}
