import {
  DEFAULT_BASE,
  isErrorEnvelope,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  type DocumentForPublishResponse,
  type DocumentsResponse,
  type DocumentSummary,
  type ErrorCode,
  type MediaJobResponse,
  type MediaUploadResult,
  type PublishDueResponse,
  type WireArrayOp,
  type WireDocument,
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

async function decodeError(response: Response): Promise<ContentRequestError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!isErrorEnvelope(body))
    return new ContentRequestError(response.status, "internal", `Request failed with status ${response.status}`);
  const { code, message, issues, current } = body.error;
  return new ContentRequestError(response.status, code, message, issues, current);
}

export function createContentClient(options: ContentClientOptions = {}): ContentClient {
  const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const send = async <Result>(method: "GET" | "POST", route: string, body?: unknown): Promise<Result> => {
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
    });
    if (!response.ok) throw await decodeError(response);
    return (await response.json()) as Result;
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
    uploadMedia: () => Promise.reject(new Error("not implemented")),
    mediaJob: () => Promise.reject(new Error("not implemented")),
    cancelMediaJob: () => Promise.reject(new Error("not implemented")),
    media: () => Promise.reject(new Error("not implemented")),
  };
}
