import { z } from "zod";
import { ArrayOpSchema, type StoredDocument } from "../types.ts";

/** The header every request must carry. A browser cannot send it cross-origin without passing a CORS preflight. */
export const REQUESTED_WITH_HEADER = "X-Requested-With";
export const REQUESTED_WITH_VALUE = "yl-editor";

export const DEFAULT_BASE = "/api/content";

const key = z.string().min(1);
const expectedVersion = z.number().int().nonnegative().optional();

export const FieldRequestSchema = z.object({ key, path: z.string(), value: z.unknown(), expectedVersion });
export type FieldRequest = z.infer<typeof FieldRequestSchema>;

export const ArrayRequestSchema = z.object({ key, path: z.string(), op: ArrayOpSchema, expectedVersion });
export type ArrayRequest = z.infer<typeof ArrayRequestSchema>;

/** Body of `publish`, `discard`, `retire` and `restore`. */
export const KeyRequestSchema = z.object({ key });
export type KeyRequest = z.infer<typeof KeyRequestSchema>;

export const RenameRequestSchema = z.object({ key, slug: z.string() });
export type RenameRequest = z.infer<typeof RenameRequestSchema>;

export const CreateRequestSchema = z.object({ type: z.string().min(1), slug: z.string(), payload: z.unknown() });
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

/** Query of `GET documents`: `keys` is a comma-separated list. */
export const DocumentsQuerySchema = z.object({ keys: z.string() });

/** Query of `GET revisions`. */
export const RevisionsQuerySchema = z.object({ key });

/** A `StoredDocument` as it travels as JSON. */
export type WireDocument = StoredDocument;

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

export interface DocumentResponse {
  document: WireDocument;
}

export interface DiscardResponse {
  document: WireDocument | null;
}

export interface WireRevision {
  id: number;
  action: "publish" | "retire" | "restore" | "rename";
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

const errorCodes = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(errorCodes),
    message: z.string(),
    issues: z.unknown().optional(),
    current: z.custom<WireDocument>((value) => typeof value === "object" && value !== null).optional(),
  }),
});
