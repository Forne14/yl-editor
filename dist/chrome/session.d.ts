import { type ContentClient } from "../http/client.ts";
import type { DocumentResponse, DocumentState, WireDocument } from "./types.ts";
export type SaveState = "idle" | "saving" | "saved" | "failed";
export interface SaveSlot {
    readonly id: string;
    readonly key: string;
    readonly path: string;
    state: SaveState;
    /** The value that failed to save, kept for Retry and Keep mine. */
    failedValue?: unknown;
    /** Set when the last failure was a version conflict. */
    conflict?: WireDocument;
    pending?: {
        value: unknown;
    };
    scheduled?: Promise<void>;
}
export interface SessionEvents {
    stateChanged(slot: SaveSlot): void;
    saved(slot: SaveSlot, value: unknown, document: WireDocument): void;
    /** `error` is a `ContentRequestError`, or whatever `fetch` threw when the server was unreachable. */
    failed(slot: SaveSlot, error: unknown): void;
    conflicted(slot: SaveSlot, current: WireDocument): void;
}
interface MutableDocument extends DocumentState {
    touched: boolean;
    touchedPaths: Set<string>;
}
export declare class Session {
    private readonly client;
    private readonly events;
    readonly documents: Map<string, MutableDocument>;
    private readonly slots;
    private readonly chains;
    /** One `GET document` per key per session, plus `documentForPublish`; replaced by every write's returned document. */
    private readonly fetched;
    private readonly storageKey;
    constructor(client: ContentClient, events: SessionEvents, base: string);
    load(keys: readonly string[]): Promise<void>;
    /**
     * The document's draft view, fetched once per session and replaced by whatever each write returns. A failed fetch
     * is not cached, so the next call retries.
     */
    document(key: string): Promise<WireDocument>;
    /**
     * A fresh read for the publish sheet, past the cache and after the document's queued writes. It refreshes the cached
     * document, unless a write landed while it was in flight. A failure leaves the cache as it was.
     */
    documentForPublish(key: string): Promise<DocumentResponse>;
    /**
     * Runs a lifecycle write (publish, discard, unpublish, restore a revision) on the document's write chain, after
     * every field write queued before it. A failure is the caller's; it does not stall the chain.
     */
    run<Result>(key: string, task: () => Promise<Result>): Promise<Result>;
    /** Marks paths as changed this session, for writes that are not field saves (restoring a revision). */
    touch(key: string, paths: readonly string[]): void;
    slot(key: string, path: string): SaveSlot;
    save(key: string, path: string, value: unknown): Promise<void>;
    retry(slot: SaveSlot): Promise<void>;
    /** Overwrite: adopt the server's version so the next write is accepted, then resend our value. */
    keepMine(slot: SaveSlot): Promise<void>;
    /** Accept the other edit. Returns the server's value for the field so the caller can repaint it. */
    takeTheirs(slot: SaveSlot): unknown;
    /** Publish or discard finished: the document is no longer this session's change. */
    settle(key: string, document: WireDocument | null): void;
    /** Takes a document the server returned as the latest: version, payload, lifecycle dates and the fetch cache. */
    adopt(document: WireDocument): void;
    /** Resolves once every write queued so far for the document has finished. */
    pending(key: string): Promise<void>;
    private enqueue;
    private flush;
    private markTouched;
    private setState;
    private readTouched;
    private writeTouched;
}
export {};
//# sourceMappingURL=session.d.ts.map