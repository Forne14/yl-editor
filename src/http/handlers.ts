import type { z } from "zod";
import {
  ConflictError,
  ContentValidationError,
  DocumentNotFoundError,
  DocumentStateError,
  MediaRefusal,
  PathError,
  SlugError,
  type Access,
  type AccessVerdict,
  type ContentStore,
  type MaybePromise,
  type MediaFileInfo,
  type MediaRender,
  type MediaStore,
  type ResolvedMedia,
  type SchemaRegistry,
  type StoredDocument,
  type WriteContext,
} from "../types.ts";
import {
  ArrayRequestSchema,
  CreateRequestSchema,
  DEFAULT_BASE,
  DiscardRequestSchema,
  DocumentQuerySchema,
  DocumentsQuerySchema,
  ERROR_STATUS,
  FieldRequestSchema,
  KeyRequestSchema,
  MAX_MEDIA_IDS,
  MediaFieldQuerySchema,
  MediaJobQuerySchema,
  MediaQuerySchema,
  PublishDueRequestSchema,
  PublishRequestSchema,
  RenameRequestSchema,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  RestoreRevisionRequestSchema,
  RevisionsQuerySchema,
  UnpublishRequestSchema,
  UPLOAD_FILENAME_HEADER,
  type DocumentSummary,
  type ErrorCode,
  type ErrorEnvelope,
  type MediaJobResponse,
  type MediaResolveResponse,
  type MediaUploadProcessingResponse,
  type MediaUploadReadyResponse,
  type PublishDueFailure,
  type WireMedia,
  type WireMediaRender,
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
  /**
   * Enables `POST media`, `GET media`, `GET media-job` and `DELETE media-job`, gated by `canEdit` on the document the
   * field is in. `maxBytes` caps an upload: a larger declared length is refused before the body is read, and a body
   * that grows past it is cut off. Without the option those routes are `404`.
   */
  media?: { store: MediaStore; maxBytes: number };
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
    readonly extra: { issues?: unknown; current?: StoredDocument; limit?: number } = {},
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
  /** Omitted for a `204`. */
  body?: unknown;
  change?: Change;
  /** Several changes from one request (`publish-due`), each notified on its own. */
  changes?: Change[];
}

type Method = "GET" | "POST" | "DELETE";
type Run = (context: RequestContext) => Promise<RouteResult>;
/** One route name, with a handler per method it takes. */
type Route = Partial<Record<Method, Run>>;

/** The view an editor works on: the draft when there is one, retired documents included. */
const DRAFT_VIEW = { draft: true, includeRetired: true };

/** Most keys one `documents` request may name, after deduping. */
const MAX_DOCUMENT_KEYS = 100;

/** The wait a `busy` refusal advertises when the store names none. */
const DEFAULT_BUSY_RETRY_MS = 5000;

/** The route names that exist only with the `media` option. */
const MEDIA_ROUTES = new Set(["media", "media-job"]);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

type ErrorExtra = Pick<ErrorEnvelope["error"], "issues" | "current" | "limit">;

const errorResponse = (
  code: ErrorCode,
  message: string,
  extra: ErrorExtra = {},
  headers: Record<string, string> = {},
): Response => json(ERROR_STATUS[code], { error: { code, message, ...extra } } satisfies ErrorEnvelope, headers);

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

const REFUSAL_CODES: Readonly<Record<MediaRefusal["code"], ErrorCode>> = {
  too_large: "too_large",
  unsupported: "unsupported",
  invalid: "bad_request",
  busy: "busy",
};

/**
 * A number a store provides (a wait, a limit) that may go on the wire: finite and positive. Anything else (NaN,
 * Infinity, zero, negative, a non-number from a JS store) is treated as absent.
 */
const isUsableNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

interface DescribedError {
  code: ErrorCode;
  message: string;
  extra?: ErrorExtra;
  headers?: Record<string, string>;
}

const MAX_RETRY_AFTER_S = 86_400;

/** The code and message a thrown error has on the wire. Unexpected errors are logged and never leak their message. */
function describeError(error: unknown): DescribedError {
  if (error instanceof HttpError) return { code: error.code, message: error.message, extra: error.extra };
  if (error instanceof MediaRefusal) {
    const code = REFUSAL_CODES[error.code];
    const described: DescribedError = { code, message: error.message };
    if (code === "too_large" && isUsableNumber(error.detail.limit)) described.extra = { limit: error.detail.limit };
    if (code === "busy") {
      const wait = isUsableNumber(error.detail.retryAfterMs) ? error.detail.retryAfterMs : DEFAULT_BUSY_RETRY_MS;
      // Capped at a day: a larger number would print in exponent form, which no Retry-After reader takes.
      const seconds = Math.min(MAX_RETRY_AFTER_S, Math.max(1, Math.ceil(wait / 1000)));
      described.headers = { "Retry-After": String(seconds) };
    }
    return described;
  }
  if (error instanceof DocumentNotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof ConflictError) return { code: "conflict", message: error.message };
  if (error instanceof ContentValidationError)
    return { code: "validation", message: error.message, extra: { issues: error.issues } };
  if (error instanceof PathError) return { code: "path", message: error.message };
  if (error instanceof DocumentStateError) return { code: "state", message: error.message };
  if (error instanceof SlugError) return { code: "slug", message: error.message };
  console.error("[@yl/editor/http] unexpected error", error);
  return { code: "internal", message: "Internal error" };
}

const tooLarge = (limit: number) => new MediaRefusal("too_large", `The file is over ${limit} bytes`, { limit });

/**
 * Passes `body` through, counting bytes. Past `limit`, or past a declared length, the stream errors with a refusal; a
 * body that ends short of its declared length errors too. `onRefuse` hears the refusal first, so the handler can abort
 * the store's signal and answer with it whatever the store does with the stream error.
 */
function countBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  declared: number | null,
  onRefuse: (refusal: MediaRefusal) => void,
): ReadableStream<Uint8Array> {
  let count = 0;
  const refuse = (controller: TransformStreamDefaultController<Uint8Array>, refusal: MediaRefusal) => {
    onRefuse(refusal);
    controller.error(refusal);
  };
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > limit) return refuse(controller, tooLarge(limit));
      if (declared !== null && count > declared)
        return refuse(controller, new MediaRefusal("invalid", "The body is longer than its Content-Length"));
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (declared !== null && count < declared)
        refuse(controller, new MediaRefusal("invalid", "The body is shorter than its Content-Length"));
    },
  });
  return (body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })).pipeThrough(counter);
}

const isPositiveInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

/**
 * Only the render's own keys, so nothing else a store puts there (variants, storage keys) reaches the wire. Undefined
 * when the store's render breaks its shape (a store in plain JS, or a cast): a kind other than image or video, a
 * `src` that is not a string, a width or height that is not a positive integer, or a wrong optional key. The client
 * checks the same rules, so such a render is never sent.
 */
function wireRender(render: MediaRender): WireMediaRender | undefined {
  const { kind, src, width, height, srcset, sources, poster, filename } = render as unknown as Record<string, unknown>;
  if (kind !== "image" && kind !== "video") return undefined;
  if (typeof src !== "string" || !isPositiveInteger(width) || !isPositiveInteger(height)) return undefined;
  if (!isOptionalString(srcset) || !isOptionalString(poster) || !isOptionalString(filename)) return undefined;
  const wire: WireMediaRender = { kind, src, width: width as number, height: height as number };
  if (typeof srcset === "string") wire.srcset = srcset;
  if (sources !== undefined) {
    if (!Array.isArray(sources)) return undefined;
    const wireSources: { type: string; srcset: string }[] = [];
    for (const source of sources as unknown[]) {
      const entry = (typeof source === "object" && source !== null ? source : {}) as Record<string, unknown>;
      if (typeof entry.type !== "string" || typeof entry.srcset !== "string") return undefined;
      wireSources.push({ type: entry.type, srcset: entry.srcset });
    }
    wire.sources = wireSources;
  }
  if (typeof poster === "string") wire.poster = poster;
  if (typeof filename === "string") wire.filename = filename;
  return wire;
}

/** The media type without parameters, lower-cased: `Image/PNG; charset=x` is `image/png`. */
const bareType = (header: string | null) => (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

/** A Content-Length that is a plain non-negative integer, else null (undeclared). */
function declaredLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  const length = Number(header.trim());
  return Number.isSafeInteger(length) ? length : null;
}

type Gate = (context: RequestContext, key: string, check: "canEdit" | "canPublish") => Promise<StoredDocument>;
type ParseQuery = <Schema extends z.ZodType>(url: URL, schema: Schema) => z.infer<Schema>;

/** `media` (GET, POST) and `media-job` (GET, DELETE), each gated by `canEdit` on the field's document. */
function mediaRoutes(
  { store, maxBytes }: NonNullable<ContentHandlerOptions["media"]>,
  gate: Gate,
  parseQuery: ParseQuery,
): Record<string, Route> {
  // One warning per handlers instance, however many bad renders the store answers: it is the host developer's bug.
  let warnedRender = false;
  const badRender = (id: string) => {
    if (warnedRender) return;
    warnedRender = true;
    console.warn(
      `[@yl/editor/http] the media store answered an unusable render for ${id} (it needs kind "image" or "video", ` +
        "a string src and positive integer width and height); it was not sent. Further ones are not reported.",
    );
  };
  /** A ready answer's media for the wire. A bad render is a server error: the editor can't show it. */
  const wireMedia = (media: ResolvedMedia): WireMedia => {
    const render = wireRender(media.render);
    if (!render) {
      badRender(media.id);
      throw new HttpError("internal", "Internal error");
    }
    return { id: media.id, render };
  };

  return {
    media: {
      GET: async (context) => {
        const { key } = parseQuery(context.url, MediaQuerySchema);
        const ids = [...new Set(context.url.searchParams.getAll("id"))].filter((id) => id.length > 0);
        if (ids.length > MAX_MEDIA_IDS)
          throw new HttpError("bad_request", `Too many ids: at most ${MAX_MEDIA_IDS} per request`);
        await gate(context, key, "canEdit");
        if (ids.length === 0) return { body: { media: {} } satisfies MediaResolveResponse };
        const found = await store.resolve(ids);
        // fromEntries defines own properties, so an id such as `__proto__` stays an ordinary key. A bad render is left
        // out like an unknown id, so one broken item never hides the others.
        const media = Object.fromEntries(
          ids.flatMap((id) => {
            const entry = found.get(id);
            if (!entry) return [];
            const render = wireRender(entry.render);
            if (!render) {
              badRender(id);
              return [];
            }
            return [[id, render] as const];
          }),
        );
        return { body: { media } satisfies MediaResolveResponse };
      },
      POST: async (context) => {
        const field = parseQuery(context.url, MediaFieldQuerySchema);
        const { request } = context;
        await gate(context, field.key, "canEdit");
        const header = request.headers.get(UPLOAD_FILENAME_HEADER) ?? "";
        let filename: string;
        try {
          filename = decodeURIComponent(header);
        } catch {
          throw new HttpError("bad_request", `${UPLOAD_FILENAME_HEADER} is not URI-encoded`);
        }
        if (filename.length === 0) throw new HttpError("bad_request", `Missing ${UPLOAD_FILENAME_HEADER} header`);
        const size = declaredLength(request.headers.get("Content-Length"));
        if (size !== null && size > maxBytes) throw tooLarge(maxBytes);
        const file: MediaFileInfo = { filename, type: bareType(request.headers.get("Content-Type")), size };
        const write = context.writeContext();
        await store.accept?.(field, file, write);

        const abort = new AbortController();
        const onRequestAbort = () => abort.abort(request.signal.reason);
        request.signal.addEventListener("abort", onRequestAbort);
        // A listener added after the abort never fires: pass an abort that already happened on now.
        if (request.signal.aborted) abort.abort(request.signal.reason);
        let refusal: MediaRefusal | undefined;
        const body = countBytes(request.body, maxBytes, size, (refused) => {
          refusal = refused;
          abort.abort(refused);
        });
        try {
          const answer = await store.upload(body, file, field, { ...write, signal: abort.signal });
          // The counter's verdict wins: a store that swallowed the stream error must not answer as if it stored.
          if (refusal) throw refusal;
          if (answer.status === "ready")
            return { status: 201, body: { media: wireMedia(answer.media) } satisfies MediaUploadReadyResponse };
          const processing: MediaUploadProcessingResponse = { job: answer.job };
          if (isUsableNumber(answer.retryAfterMs)) processing.retryAfterMs = answer.retryAfterMs;
          return { status: 202, body: processing };
        } catch (error) {
          throw refusal ?? error;
        } finally {
          request.signal.removeEventListener("abort", onRequestAbort);
        }
      },
    },
    "media-job": {
      GET: async (context) => {
        const { key, path, job } = parseQuery(context.url, MediaJobQuerySchema);
        await gate(context, key, "canEdit");
        const state = store.job ? await store.job(job, { key, path }) : null;
        if (!state) throw new HttpError("job_not_found", `No job ${job} for this field`);
        let body: MediaJobResponse;
        if (state.status === "ready") body = { status: "ready", media: wireMedia(state.media) };
        else if (state.status === "failed") {
          body = { status: "failed", reason: state.reason };
          if (state.message !== undefined) body.message = state.message;
        } else {
          body = { status: "processing" };
          // Progress is 0..1: a finite value is clamped into it, anything else is left out.
          if (typeof state.progress === "number" && Number.isFinite(state.progress))
            body.progress = Math.min(1, Math.max(0, state.progress));
          if (isUsableNumber(state.retryAfterMs)) body.retryAfterMs = state.retryAfterMs;
        }
        return { body };
      },
      DELETE: async (context) => {
        const { key, path, job } = parseQuery(context.url, MediaJobQuerySchema);
        await gate(context, key, "canEdit");
        // A store without cancelJob has nothing to cancel: that is still a success.
        await store.cancelJob?.(job, { key, path });
        return { status: 204 };
      },
    },
  };
}

export function createContentHandlers(options: ContentHandlerOptions): ContentHandlers {
  const { store, registry, access } = options;
  const base = trimTrailingSlash(options.base ?? DEFAULT_BASE);
  const sameOrigin = options.sameOrigin ?? true;

  const deny = (verdict: AccessVerdict) => {
    if (!verdict.allowed) throw new HttpError("forbidden", verdict.reason);
  };

  /**
   * The stored row that gates a request; 404 when absent. Read unvalidated, so access checks and the document's
   * identity never depend on its payload: a document that fails its schema must stay repairable.
   */
  const existing = async (key: string): Promise<StoredDocument> => {
    const document = await store.get(key, { ...DRAFT_VIEW, unvalidated: true });
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

  /** A lifecycle write gated by `check` on the stored row. */
  const keyedWrite =
    (
      action: ChangeAction,
      check: "canEdit" | "canPublish",
      write: (key: string, context: WriteContext) => Promise<StoredDocument>,
    ): Run =>
    async (context) => {
      const { key } = await parseBody(context.request, KeyRequestSchema);
      await gate(context, key, check);
      const document = await write(key, context.writeContext());
      return { body: { document }, change: { action, key, document } };
    };

  const routeTable: Record<string, Route> = {
    documents: {
      GET: async (context) => {
        const { keys } = parseQuery(context.url, DocumentsQuerySchema);
        const unique = [...new Set(keys.split(",").map((part) => part.trim()))].filter((part) => part.length > 0);
        if (unique.length > MAX_DOCUMENT_KEYS)
          throw new HttpError("bad_request", `Too many keys: at most ${MAX_DOCUMENT_KEYS} per request`);
        const documents: Record<string, DocumentSummary> = {};
        const summaries = await Promise.all(
          unique.map(async (key): Promise<[string, DocumentSummary] | null> => {
            // Unvalidated: one document with a bad payload must not hide the page the editor would repair it from.
            const document = await store.get(key, { ...DRAFT_VIEW, unvalidated: true });
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
      GET: async (context) => {
        const { key } = parseQuery(context.url, DocumentQuerySchema);
        const stored = await gate(context, key, "canEdit");
        // A draft failing its schema is reported, not served. Anything else that stops the validated read is a payload
        // to show as stored, such as a `migrate` that throws. The unvalidated read does not run into those, so if it
        // fails too then the store is failing, and that stays `internal`.
        const document = await store.get(key, DRAFT_VIEW).catch((error: unknown) => {
          if (stored.isDraft && error instanceof ContentValidationError) throw error;
          return store.get(key, { ...DRAFT_VIEW, unvalidated: true });
        });
        if (!document) throw new HttpError("not_found", `No document ${key}`);
        // `includeRetired`: retiring hides a document from visitors but keeps its published payload.
        const view = { draft: false, includeRetired: true };
        const published = await store.get(key, view).catch(() => store.get(key, { ...view, unvalidated: true }));
        // `null` means nothing is published, so a stored JSON `null` goes out as its text, like any unparseable column.
        const publishedPayload = published ? (published.payload ?? "null") : null;
        return { body: { document, publishedPayload } };
      },
    },
    revisions: {
      GET: async (context) => {
        const { key } = parseQuery(context.url, RevisionsQuerySchema);
        await gate(context, key, "canEdit");
        const revisions = await store.revisions(key);
        return { body: { revisions } };
      },
    },
    field: {
      POST: async (context) => {
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
      POST: async (context) => {
        const body = await parseBody(context.request, ArrayRequestSchema);
        await gate(context, body.key, "canEdit");
        const document = await store.arrayOp(body.key, body.path, body.op, context.writeContext(body.expectedVersion));
        return { body: { document }, change: { action: "array", key: body.key, document } };
      },
    },
    publish: {
      POST: async (context) => {
        const body = await parseBody(context.request, PublishRequestSchema);
        await gate(context, body.key, "canPublish");
        const write = context.writeContext(body.expectedVersion);
        const document = await store.publish(body.key, body.at !== undefined ? { ...write, at: body.at } : write);
        return { body: { document }, change: { action: "publish", key: body.key, document } };
      },
    },
    unpublish: {
      POST: async (context) => {
        const body = await parseBody(context.request, UnpublishRequestSchema);
        await gate(context, body.key, "canPublish");
        const document = await store.unpublish(body.key, context.writeContext(body.expectedVersion));
        return { body: { document }, change: { action: "unpublish", key: body.key, document } };
      },
    },
    "restore-revision": {
      POST: async (context) => {
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
      POST: async (context) => {
        if (!options.publishDue) throw new HttpError("forbidden", "publish-due is not enabled");
        const body = await parseBody(context.request, PublishDueRequestSchema);
        deny(await options.publishDue.authorize(context.locals));
        const failed: PublishDueFailure[] = [];
        const documents = await store.publishDue(body.now, {
          ...context.writeContext(),
          onFailure: (key, error) => {
            const { code, message } = describeError(error);
            failed.push({ key, code, message });
          },
        });
        return {
          body: { documents, failed },
          changes: documents.map((document) => ({ action: "publish" as const, key: document.key, document })),
        };
      },
    },
    discard: {
      POST: async (context) => {
        const body = await parseBody(context.request, DiscardRequestSchema);
        await gate(context, body.key, "canEdit");
        const document = await store.discardDraft(body.key, context.writeContext(body.expectedVersion));
        return { body: { document }, change: { action: "discard", key: body.key, document } };
      },
    },
    retire: { POST: keyedWrite("retire", "canPublish", (key, write) => store.retire(key, write)) },
    restore: { POST: keyedWrite("restore", "canPublish", (key, write) => store.restore(key, write)) },
    rename: {
      POST: async (context) => {
        const body = await parseBody(context.request, RenameRequestSchema);
        await gate(context, body.key, "canPublish");
        const document = await store.rename(body.key, body.slug, context.writeContext());
        return { body: { document }, change: { action: "rename", key: body.key, document } };
      },
    },
    create: {
      POST: async (context) => {
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

  if (options.media) Object.assign(routeTable, mediaRoutes(options.media, gate, parseQuery));

  const routes = Object.entries(routeTable).flatMap(([name, route]) =>
    Object.keys(route).map((method) => `${method} ${name}`),
  );

  let warnedMediaOff = false;

  /** Maps a thrown error onto the wire. Unexpected errors are logged and never leak their message. */
  const toResponse = async (error: unknown): Promise<Response> => {
    const { code, message, extra, headers } = describeError(error);
    if (error instanceof ConflictError) {
      // The document may fail its schema: a conflict during a repair still shows what is stored.
      const current = await store
        .get(error.key, DRAFT_VIEW)
        .catch(() => store.get(error.key, { ...DRAFT_VIEW, unvalidated: true }))
        .catch(() => null);
      return errorResponse(code, message, current ? { current } : {});
    }
    return errorResponse(code, message, extra, headers);
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
      if (!route) {
        if (name !== undefined && MEDIA_ROUTES.has(name) && !warnedMediaOff) {
          warnedMediaOff = true;
          console.warn(
            `[@yl/editor/http] ${request.method} ${name} answered 404: the media routes are off. ` +
              "Pass createContentHandlers({ media: { store, maxBytes } }) to turn them on.",
          );
        }
        return errorResponse("not_found", "Unknown route");
      }
      const run = Object.hasOwn(route, request.method) ? route[request.method as Method] : undefined;
      if (!run) return methodNotAllowed(request.method, Object.keys(route).join(", "));

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
      const result = await run(context);
      const response =
        result.status === 204
          ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
          : json(result.status ?? 200, result.body);
      for (const change of [...(result.change ? [result.change] : []), ...(result.changes ?? [])])
        void notify({ ...change, ...(actor !== undefined ? { actor } : {}) });
      return response;
    } catch (error) {
      return toResponse(error);
    }
  }

  return { handle, routes };
}
