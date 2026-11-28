import {
  DEFAULT_BASE,
  isErrorEnvelope,
  MAX_MEDIA_IDS,
  parseRetryAfter,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  UPLOAD_FILENAME_HEADER,
  type DocumentForPublishResponse,
  type DocumentsResponse,
  type DocumentSummary,
  type ErrorCode,
  type MediaJobResponse,
  type MediaUploadResult,
  type PublishDueResponse,
  type WireArrayOp,
  type WireDocument,
  type WireMedia,
  type WireMediaField,
  type WireMediaRender,
  type WireRevision,
} from "./wire-types.ts";

/** A non-2xx response from the content handlers, decoded from its error envelope (or, without one, from its status). */
export class ContentRequestError extends Error {
  /** From a `Retry-After` header, in milliseconds (`busy`). */
  readonly retryAfterMs?: number;
  /** From a `too_large` envelope: the server's limit in bytes. */
  readonly limit?: number;
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: unknown,
    readonly current?: WireDocument,
    details: { retryAfterMs?: number; limit?: number } = {},
  ) {
    super(message);
    this.name = "ContentRequestError";
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.limit !== undefined) this.limit = details.limit;
  }
}

/** An upload progress event, as `XMLHttpRequest` and its `upload` fire it. */
export interface UploadXhrProgress {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

interface UploadXhrTarget {
  addEventListener(type: string, listener: (event: UploadXhrProgress) => void): void;
}

/** The part of `XMLHttpRequest` `uploadMedia` uses, so tests can pass their own. */
export interface UploadXhr extends UploadXhrTarget {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  getResponseHeader(name: string): string | null;
  readonly upload: UploadXhrTarget;
}

export interface ContentClientOptions {
  /** Where the handlers are mounted. Default `/api/content`. */
  base?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Makes the request `uploadMedia` sends. Default: `new XMLHttpRequest()`, the only API with upload progress in every engine. */
  xhr?: () => UploadXhr;
}

/** A file to upload: a `File`, or any `Blob` with a name. */
export type MediaUploadFile = Blob & { readonly name: string };

export interface MediaUploadOptions {
  /** Bytes sent so far; `total` is null when the browser can't tell. */
  onProgress?: (progress: { loaded: number; total: number | null }) => void;
  /** Every byte is sent; the server's answer is still to come. */
  onSent?: () => void;
  signal?: AbortSignal;
}

export interface ContentClient {
  documents(keys: string[]): Promise<Record<string, DocumentSummary>>;
  /** One document, draft view, retired included. */
  document(key: string): Promise<WireDocument>;
  /** The same read with the payload published now beside it (null when none), for comparing before a publish. */
  documentForPublish(key: string): Promise<DocumentForPublishResponse>;
  field(key: string, path: string, value: unknown, expectedVersion?: number): Promise<WireDocument>;
  array(key: string, path: string, op: WireArrayOp, expectedVersion?: number): Promise<WireDocument>;
  /** Publishes now, or with `at` (an ISO datetime) schedules the draft for `publishDue`. */
  publish(key: string, options?: { at?: string; expectedVersion?: number }): Promise<WireDocument>;
  unpublish(key: string, options?: { expectedVersion?: number }): Promise<WireDocument>;
  /** Copies a revision's payload into the draft. */
  restoreRevision(key: string, revisionId: number, options?: { expectedVersion?: number }): Promise<WireDocument>;
  /** Publishes every scheduled draft due at `now` (default: the server's clock), reporting any that failed. */
  publishDue(now?: string): Promise<PublishDueResponse>;
  discard(key: string, options?: { expectedVersion?: number }): Promise<WireDocument | null>;
  retire(key: string): Promise<WireDocument>;
  restore(key: string): Promise<WireDocument>;
  rename(key: string, slug: string): Promise<WireDocument>;
  revisions(key: string): Promise<WireRevision[]>;
  create(type: string, slug: string, payload: unknown): Promise<WireDocument>;
  /**
   * Uploads `file` for a field over `XMLHttpRequest`, streaming it from disk. Rejects with a `ContentRequestError` for
   * a non-2xx or unreadable answer, a `TypeError` when the network fails, and the signal's reason when it aborts.
   */
  uploadMedia(field: WireMediaField, file: MediaUploadFile, options?: MediaUploadOptions): Promise<MediaUploadResult>;
  /** One poll of an upload's job. `progress` is clamped to 0..1; a `Retry-After` header wins over `retryAfterMs`. */
  mediaJob(field: WireMediaField, job: string, options?: { signal?: AbortSignal }): Promise<MediaJobResponse>;
  cancelMediaJob(field: WireMediaField, job: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** The render of each id the store knows, gated by `canEdit` on `key`. At most 100 ids per request; more are split. */
  media(key: string, ids: readonly string[], options?: { signal?: AbortSignal }): Promise<Map<string, WireMediaRender>>;
}

/** Codes a status means when the body is not our envelope (a proxy's or the platform's own page). */
const STATUS_CODES: Readonly<Record<number, ErrorCode>> = { 413: "too_large", 415: "unsupported", 503: "busy" };

/** A non-2xx answer as a `ContentRequestError`, from its envelope when it has one, else from its status. */
function errorFrom(status: number, body: unknown, retryAfter: string | null): ContentRequestError {
  const retryAfterMs = parseRetryAfter(retryAfter, Date.now());
  const details = retryAfterMs !== undefined ? { retryAfterMs } : {};
  if (!isErrorEnvelope(body))
    return new ContentRequestError(
      status,
      STATUS_CODES[status] ?? "internal",
      `Request failed with status ${status}`,
      undefined,
      undefined,
      details,
    );
  const { code, message, issues, current, limit } = body.error;
  return new ContentRequestError(status, code, message, issues, current, {
    ...details,
    ...(limit !== undefined ? { limit } : {}),
  });
}

async function decodeError(response: Response): Promise<ContentRequestError> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorFrom(response.status, body, response.headers.get("Retry-After"));
}

const unreadable = (status: number, what: string) =>
  new ContentRequestError(status, "internal", `Unreadable ${what} answer`);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** A render as the wire should carry it, rebuilt with only its own keys; undefined when it is not one. */
function readRender(value: unknown): WireMediaRender | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, src, srcset, sources, width, height, poster, filename } = value;
  if (kind !== "image" && kind !== "video") return undefined;
  if (typeof src !== "string" || !isPositive(width) || !isPositive(height)) return undefined;
  if (!optionalString(srcset) || !optionalString(poster) || !optionalString(filename)) return undefined;
  const render: WireMediaRender = { kind, src, width, height };
  if (typeof srcset === "string") render.srcset = srcset;
  if (sources !== undefined) {
    if (!Array.isArray(sources)) return undefined;
    const read: { type: string; srcset: string }[] = [];
    for (const source of sources) {
      if (!isRecord(source) || typeof source.type !== "string" || typeof source.srcset !== "string") return undefined;
      read.push({ type: source.type, srcset: source.srcset });
    }
    render.sources = read;
  }
  if (typeof poster === "string") render.poster = poster;
  if (typeof filename === "string") render.filename = filename;
  return render;
}

function readMedia(value: unknown): WireMedia | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  const render = readRender(value.render);
  return render ? { id: value.id, render } : undefined;
}

/** A Retry-After header wins over a body's `retryAfterMs`; either must be a positive number of milliseconds. */
function retryAfterOf(header: string | null, body: unknown): number | undefined {
  const fromHeader = parseRetryAfter(header, Date.now());
  if (fromHeader !== undefined) return fromHeader;
  return isPositive(body) ? body : undefined;
}

function readUpload(status: number, body: unknown, retryAfter: string | null): MediaUploadResult | undefined {
  if (!isRecord(body)) return undefined;
  if (status === 202) {
    if (typeof body.job !== "string" || body.job.length === 0) return undefined;
    const retryAfterMs = retryAfterOf(retryAfter, body.retryAfterMs);
    return { status: "processing", job: body.job, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  const media = readMedia(body.media);
  return media ? { status: "ready", media } : undefined;
}

function readJob(body: unknown, retryAfter: string | null): MediaJobResponse | undefined {
  if (!isRecord(body)) return undefined;
  if (body.status === "ready") {
    const media = readMedia(body.media);
    return media ? { status: "ready", media } : undefined;
  }
  if (body.status === "failed") {
    if (typeof body.reason !== "string" || !optionalString(body.message)) return undefined;
    return {
      status: "failed",
      reason: body.reason,
      ...(typeof body.message === "string" ? { message: body.message } : {}),
    };
  }
  if (body.status !== "processing") return undefined;
  const answer: MediaJobResponse = { status: "processing" };
  if (typeof body.progress === "number" && !Number.isNaN(body.progress))
    answer.progress = Math.min(1, Math.max(0, body.progress));
  const retryAfterMs = retryAfterOf(retryAfter, body.retryAfterMs);
  if (retryAfterMs !== undefined) answer.retryAfterMs = retryAfterMs;
  return answer;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The upload was aborted", "AbortError");

export function createContentClient(options: ContentClientOptions = {}): ContentClient {
  const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const makeXhr = options.xhr ?? ((): UploadXhr => new XMLHttpRequest());

  const request = async (
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetcher(`${base}/${route}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await decodeError(response);
    return response;
  };

  const send = async <Result>(method: "GET" | "POST", route: string, body?: unknown): Promise<Result> =>
    (await (await request(method, route, body)).json()) as Result;

  /** A GET whose body is hand-checked by `read`; anything it can't read is `internal`. */
  const checked = async <Result>(
    route: string,
    what: string,
    signal: AbortSignal | undefined,
    read: (body: unknown, response: Response) => Result | undefined,
  ): Promise<Result> => {
    const response = await request("GET", route, undefined, signal);
    const body: unknown = await response.json().catch(() => undefined);
    const result = read(body, response);
    if (result === undefined) throw unreadable(response.status, what);
    return result;
  };

  const fieldQuery = (field: WireMediaField, extra: Record<string, string> = {}) =>
    new URLSearchParams({ key: field.key, path: field.path, ...extra });

  const uploadMedia = (
    field: WireMediaField,
    file: MediaUploadFile,
    { onProgress, onSent, signal }: MediaUploadOptions = {},
  ): Promise<MediaUploadResult> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal));
      const xhr = makeXhr();
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const onAbort = () => {
        if (!signal) return;
        settle(() => reject(abortReason(signal)));
        xhr.abort();
      };
      signal?.addEventListener("abort", onAbort);
      xhr.upload.addEventListener("progress", (event) => {
        if (!settled) onProgress?.({ loaded: event.loaded, total: event.lengthComputable ? event.total : null });
      });
      xhr.upload.addEventListener("load", () => {
        if (!settled) onSent?.();
      });
      const networkError = () => settle(() => reject(new TypeError("Network error during the upload")));
      xhr.addEventListener("error", networkError);
      xhr.addEventListener("timeout", networkError);
      // An abort this client didn't ask for (the browser dropped it) reads as a network error.
      xhr.addEventListener("abort", networkError);
      xhr.addEventListener("load", () =>
        settle(() => {
          const { status } = xhr;
          let body: unknown;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            body = undefined;
          }
          const retryAfter = xhr.getResponseHeader("Retry-After");
          if (status < 200 || status >= 300) return reject(errorFrom(status, body, retryAfter));
          const result = readUpload(status, body, retryAfter);
          if (result) resolve(result);
          else reject(unreadable(status, "upload"));
        }),
      );
      xhr.open("POST", `${base}/media?${fieldQuery(field)}`);
      xhr.setRequestHeader(REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE);
      xhr.setRequestHeader("Accept", "application/json");
      if (file.type !== "") xhr.setRequestHeader("Content-Type", file.type);
      xhr.setRequestHeader(UPLOAD_FILENAME_HEADER, encodeURIComponent(file.name));
      xhr.send(file);
    });

  const mediaChunk = async (key: string, ids: string[], signal: AbortSignal | undefined) => {
    const query = new URLSearchParams({ key });
    for (const id of ids) query.append("id", id);
    return checked(`media?${query}`, "media", signal, (body) => {
      if (!isRecord(body) || !isRecord(body.media)) return undefined;
      const renders = new Map<string, WireMediaRender>();
      for (const [id, value] of Object.entries(body.media)) {
        const render = readRender(value);
        if (!render) return undefined;
        renders.set(id, render);
      }
      return renders;
    });
  };

  const post = async (route: string, body: unknown) =>
    (await send<{ document: WireDocument }>("POST", route, body)).document;

  const read = (key: string) => send<DocumentForPublishResponse>("GET", `document?${new URLSearchParams({ key })}`);

  return {
    documents: async (keys) => {
      if (keys.length === 0) return {};
      const query = new URLSearchParams({ keys: keys.join(",") });
      return (await send<DocumentsResponse>("GET", `documents?${query}`)).documents;
    },
    field: (key, path, value, expectedVersion) => post("field", { key, path, value, expectedVersion }),
    array: (key, path, op, expectedVersion) => post("array", { key, path, op, expectedVersion }),
    document: async (key) => (await read(key)).document,
    documentForPublish: read,
    publish: (key, { at, expectedVersion } = {}) => post("publish", { key, at, expectedVersion }),
    unpublish: (key, { expectedVersion } = {}) => post("unpublish", { key, expectedVersion }),
    restoreRevision: (key, revisionId, { expectedVersion } = {}) =>
      post("restore-revision", { key, revisionId, expectedVersion }),
    publishDue: (now) => send<PublishDueResponse>("POST", "publish-due", now !== undefined ? { now } : {}),
    discard: async (key, { expectedVersion } = {}) =>
      (await send<{ document: WireDocument | null }>("POST", "discard", { key, expectedVersion })).document,
    retire: (key) => post("retire", { key }),
    restore: (key) => post("restore", { key }),
    rename: (key, slug) => post("rename", { key, slug }),
    revisions: async (key) =>
      (await send<{ revisions: WireRevision[] }>("GET", `revisions?${new URLSearchParams({ key })}`)).revisions,
    create: (type, slug, payload) => post("create", { type, slug, payload }),
    uploadMedia,
    mediaJob: (field, job, { signal } = {}) =>
      checked(`media-job?${fieldQuery(field, { job })}`, "media-job", signal, (body, response) =>
        readJob(body, response.headers.get("Retry-After")),
      ),
    cancelMediaJob: async (field, job, { signal } = {}) => {
      await request("DELETE", `media-job?${fieldQuery(field, { job })}`, undefined, signal);
    },
    media: async (key, ids, { signal } = {}) => {
      const unique = [...new Set(ids)];
      const renders = new Map<string, WireMediaRender>();
      for (let start = 0; start < unique.length; start += MAX_MEDIA_IDS) {
        const chunk = await mediaChunk(key, unique.slice(start, start + MAX_MEDIA_IDS), signal);
        for (const [id, render] of chunk) renders.set(id, render);
      }
      return renders;
    },
  };
}
