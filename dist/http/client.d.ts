import { type DocumentForPublishResponse, type DocumentSummary, type ErrorCode, type PublishDueResponse, type WireArrayOp, type WireDocument, type WireRevision } from "./wire-types.ts";
/** A non-2xx response from the content handlers, decoded from its error envelope. */
export declare class ContentRequestError extends Error {
    readonly status: number;
    readonly code: ErrorCode;
    readonly issues?: unknown | undefined;
    readonly current?: WireDocument | undefined;
    constructor(status: number, code: ErrorCode, message: string, issues?: unknown | undefined, current?: WireDocument | undefined);
}
export interface ContentClientOptions {
    /** Where the handlers are mounted. Default `/api/content`. */
    base?: string;
    /** Default: the global `fetch`. */
    fetch?: typeof fetch;
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
    publish(key: string, options?: {
        at?: string;
        expectedVersion?: number;
    }): Promise<WireDocument>;
    unpublish(key: string, options?: {
        expectedVersion?: number;
    }): Promise<WireDocument>;
    /** Copies a revision's payload into the draft. */
    restoreRevision(key: string, revisionId: number, options?: {
        expectedVersion?: number;
    }): Promise<WireDocument>;
    /** Publishes every scheduled draft due at `now` (default: the server's clock), reporting any that failed. */
    publishDue(now?: string): Promise<PublishDueResponse>;
    discard(key: string, options?: {
        expectedVersion?: number;
    }): Promise<WireDocument | null>;
    retire(key: string): Promise<WireDocument>;
    restore(key: string): Promise<WireDocument>;
    rename(key: string, slug: string): Promise<WireDocument>;
    revisions(key: string): Promise<WireRevision[]>;
    create(type: string, slug: string, payload: unknown): Promise<WireDocument>;
}
export declare function createContentClient(options?: ContentClientOptions): ContentClient;
//# sourceMappingURL=client.d.ts.map