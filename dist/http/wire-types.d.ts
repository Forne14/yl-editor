/**
 * The wire contract as plain types and constants, with no runtime imports, so a browser client can use it without
 * pulling in zod or the core. The zod request schemas live in `wire.ts`.
 */
/** The header every request must carry. A browser cannot send it cross-origin without passing a CORS preflight. */
export declare const REQUESTED_WITH_HEADER = "X-Requested-With";
export declare const REQUESTED_WITH_VALUE = "yl-editor";
export declare const DEFAULT_BASE = "/api/content";
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
}
/** An array operation as sent to `array`. Same shape as the core's `ArrayOp`. */
export type WireArrayOp = {
    kind: "insert";
    index: number;
    value: unknown;
} | {
    kind: "move";
    from: number;
    to: number;
} | {
    kind: "remove";
    index: number;
};
export interface DocumentSummary {
    key: string;
    type: string;
    version: number;
    isDraft: boolean;
    draftUpdatedAt: string | null;
    publishedAt: string | null;
    access: {
        edit: boolean;
        publish: boolean;
    };
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
export type ErrorCode = "forbidden" | "not_found" | "conflict" | "validation" | "path" | "state" | "slug" | "bad_request" | "internal";
export declare const ERROR_STATUS: Readonly<Record<ErrorCode, number>>;
export interface ErrorEnvelope {
    error: {
        code: ErrorCode;
        message: string;
        issues?: unknown;
        /** On `conflict`: the document as it is now (draft view), so the client can offer "take theirs". */
        current?: WireDocument;
    };
}
/** True when `value` is an error envelope with a known code. */
export declare function isErrorEnvelope(value: unknown): value is ErrorEnvelope;
//# sourceMappingURL=wire-types.d.ts.map