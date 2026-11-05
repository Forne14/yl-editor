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

export type ErrorCode =
  "forbidden" | "not_found" | "conflict" | "validation" | "path" | "state" | "slug" | "bad_request" | "internal";

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation: 422,
  path: 400,
  state: 409,
  slug: 400,
  bad_request: 400,
  internal: 500,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    issues?: unknown;
    /** On `conflict`: the document as it is now (draft view), so the client can offer "take theirs". */
    current?: WireDocument;
  };
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
