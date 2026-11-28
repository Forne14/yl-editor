/**
 * The wire contract as plain types and constants, with no runtime imports, so a browser client can use it without
 * pulling in zod or the core. The zod request schemas live in `wire.ts`.
 */

/** The header every request must carry. A browser cannot send it cross-origin without passing a CORS preflight. */
export const REQUESTED_WITH_HEADER = "X-Requested-With";
export const REQUESTED_WITH_VALUE = "yl-editor";

export const DEFAULT_BASE = "/api/content";

/** A `StoredDocument` as it travels as JSON. Kept structurally identical to `StoredDocument` (checked in `wire.ts`). */
export interface WireDocument {
  id: number;
  key: string;
  type: string;
  slug: string;
  payload: unknown;
  isDraft: boolean;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
  previousSlugs: string[];
  retiredAt: string | null;
  version: number;
  scheduledAt: string | null;
}

/** An array operation as sent to `array`. Same shape as the core's `ArrayOp`. */
export type WireArrayOp =
  | { kind: "insert"; index: number; value: unknown }
  | { kind: "move"; from: number; to: number }
  | { kind: "remove"; index: number };

export interface DocumentSummary {
  key: string;
  type: string;
  version: number;
  isDraft: boolean;
  draftUpdatedAt: string | null;
  publishedAt: string | null;
  access: { edit: boolean; publish: boolean };
}

export interface DocumentsResponse {
  documents: Record<string, DocumentSummary>;
}

/** Response of the POST routes that return one document. */
export interface DocumentResponse {
  document: WireDocument;
}

/** Response of `GET document`. */
export interface DocumentForPublishResponse {
  document: WireDocument;
  /** The payload published now, whatever the draft says; null only when nothing is published. An unparseable column is its stored text. */
  publishedPayload: unknown | null;
}

/** A due document `publish-due` could not publish. It stays scheduled and is retried on the next run. */
export interface PublishDueFailure {
  key: string;
  code: ErrorCode;
  message: string;
}

/** Response of `publish-due`: every document it published, in the order they were due, and those that failed. */
export interface PublishDueResponse {
  documents: WireDocument[];
  failed: PublishDueFailure[];
}

export interface DiscardResponse {
  document: WireDocument | null;
}

export interface WireRevision {
  id: number;
  action: "publish" | "retire" | "restore" | "rename" | "restore_revision" | "unpublish";
  slug: string;
  payload: unknown;
  actor: string | null;
  createdAt: string;
}

export interface RevisionsResponse {
  revisions: WireRevision[];
}

/** The header `POST media` reads the file's name from, URI-encoded. */
export const UPLOAD_FILENAME_HEADER = "X-Upload-Filename";

/** Most ids one `GET media` request may name, after deduping. */
export const MAX_MEDIA_IDS = 100;

/** A `MediaRender` as it travels as JSON. Kept structurally identical to the core's `MediaRender` (checked in `wire.ts`). */
export interface WireMediaRender {
  kind: "image" | "video";
  src: string;
  srcset?: string;
  sources?: { type: string; srcset: string }[];
  width: number;
  height: number;
  poster?: string;
  filename?: string;
}

/** A stored media item on the wire: its id and render. The store's variants never leave the server. */
export interface WireMedia {
  id: string;
  render: WireMediaRender;
}

/** The field an upload is for. Same shape as the core's `MediaFieldRef`. */
export interface WireMediaField {
  key: string;
  path: string;
}

/** What the client's `uploadMedia` resolves to: the `201` or the `202`, told apart by `status`. */
export type MediaUploadResult =
  { status: "ready"; media: WireMedia } | { status: "processing"; job: string; retryAfterMs?: number };

/** Body of a `201` from `POST media`: stored now. */
export interface MediaUploadReadyResponse {
  media: WireMedia;
}

/** Body of a `202` from `POST media`: still processing; poll `GET media-job`. */
export interface MediaUploadProcessingResponse {
  job: string;
  retryAfterMs?: number;
}

/** Body of `GET media-job`. `progress` is 0..1. */
export type MediaJobResponse =
  | { status: "processing"; progress?: number; retryAfterMs?: number }
  | { status: "ready"; media: WireMedia }
  | { status: "failed"; reason: string; message?: string };

/** Body of `GET media`: the render of every id the store knows. Unknown ids are left out. */
export interface MediaResolveResponse {
  media: Record<string, WireMediaRender>;
}

export type ErrorCode =
  | "forbidden"
  | "not_found"
  | "job_not_found"
  | "conflict"
  | "validation"
  | "path"
  | "state"
  | "slug"
  | "bad_request"
  | "too_large"
  | "unsupported"
  | "busy"
  | "internal";

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  forbidden: 403,
  not_found: 404,
  job_not_found: 404,
  conflict: 409,
  validation: 422,
  path: 400,
  state: 409,
  slug: 400,
  bad_request: 400,
  too_large: 413,
  unsupported: 415,
  busy: 503,
  internal: 500,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    issues?: unknown;
    /** On `conflict`: the document as it is now (draft view), so the client can offer "take theirs". */
    current?: WireDocument;
    /** On `too_large`: the limit in bytes, when the server knows it. */
    limit?: number;
  };
}

/**
 * A `Retry-After` header in milliseconds: delay-seconds or an HTTP date (counted from `now`, never negative).
 * Undefined when absent or unreadable. Not clamped: callers apply their own bounds.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  void value;
  void now;
  throw new Error("not implemented");
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** True when `value` is an error envelope with a known code. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isObject(value) || !isObject(value.error)) return false;
  const { code, message, current } = value.error;
  return (
    typeof code === "string" &&
    Object.hasOwn(ERROR_STATUS, code) &&
    typeof message === "string" &&
    (current === undefined || isObject(current))
  );
}
