import { type ContentClient } from "../http/client.ts";
import type { DocumentForPublishResponse, DocumentState, WireDocument } from "./types.ts";
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
    /** The value of the request on the wire now. */
    sending?: {
        value: unknown;
    };
    scheduled?: Promise<void>;
}
/**
 * The publish sheet's look at one document. `version` is what a publish from that sheet sends as `expectedVersion`:
 * the version whose diff the sheet showed, moved forward by the editor's own writes (see `applyWrite`). Unset until the
 * diff has loaded.
 */
export interface Review {
    version?: number;
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
/** The publish sheet has nothing it can honestly compare: writes kept landing, or the published payload is unreadable. */
export declare class ChangesUnavailableError extends Error {
    readonly reason: "moving" | "unreadable";
    constructor(reason: "moving" | "unreadable");
}
export declare class Session {
    private readonly client;
    private readonly events;
    readonly documents: Map<string, MutableDocument>;
    private readonly slots;
    private readonly chains;
    /** One `GET document` per key per session, plus `documentForPublish`; replaced by every write's returned document. */
    private readonly fetched;
    private readonly reviews;
    /** Bumped per key whenever the session takes a document as the latest, so a read can tell one landed meanwhile. */
    private readonly writes;
    /** The newest `documentForPublish` per key: an older one still in flight touches nothing. */
    private readonly reads;
    private readonly storageKey;
    constructor(client: ContentClient, events: SessionEvents, base: string);
    /**
     * Reads the summaries after every write already queued for these documents. A write can still land during the read,
     * so a summary older than what the session holds changes only `access`.
     */
    load(keys: readonly string[]): Promise<void>;
    /**
     * The document's draft view, fetched once per session and replaced by whatever each write returns. A failed fetch
     * is not cached, so the next call retries.
     */
    document(key: string): Promise<WireDocument>;
    /**
     * A fresh read for the publish sheet, past the cache and after the document's queued writes. The document and
     * `publishedPayload` it returns always come from one response: if a write lands during the read, it reads again, up
     * to `MAX_PUBLISH_READS` times, then rejects. The version it returns becomes the version of the document's open review,
     * if it has one, and refreshes the cached document. A rejection, or a newer read of the same document, does neither.
     */
    documentForPublish(key: string): Promise<DocumentForPublishResponse>;
    /**
     * Runs a lifecycle write (publish, discard, unpublish, restore a revision) on the document's write chain, after
     * every field write queued before it. `task` applies its own result before it returns, because the chain releases when
     * it settles: a field save queued behind it reads `version` the moment it does. A failure is the caller's; it does not
     * stall the chain.
     */
    run<Result>(key: string, task: () => Promise<Result>): Promise<Result>;
    /**
     * Marks a document as changed this session, for writes that are not field saves. `paths` may be empty: an unpublish
     * changes no path, and a restore may leave the draft as it was, but either still leaves something to publish.
     */
    touch(key: string, paths?: readonly string[]): void;
    /** Opens the document's review, replacing any earlier one. */
    startReview(key: string): Review;
    endReview(key: string, review: Review): void;
    /**
     * What a publish sends: the review's version, else the version this session knows. A publish from a sheet passes its
     * own review, because that sheet may have closed and another opened by the time the publish reaches the chain.
     */
    publishVersion(key: string, review?: Review | undefined): number | undefined;
    /**
     * The newest value the editor has committed for a path that is not yet in the stored document: queued, on the wire,
     * or failed. A widget starts from this, because the cached payload does not have it yet.
     */
    committedValue(key: string, path: string): {
        value: unknown;
    } | undefined;
    /** The document's content was just replaced, so its failed saves are gone: nothing to retry or resend. */
    clearFailed(key: string): void;
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
    /**
     * Takes the result of a write this session sent with `expected`. The server accepted that version, so nothing else
     * landed between it and the result: a review standing at `expected` moves forward with it. A write from any other
     * version leaves the review behind, and the publish then conflicts, because something unreviewed lies between them.
     */
    applyWrite(expected: number | undefined, document: WireDocument): void;
    /** Resolves once every write queued so far for the document has finished. */
    pending(key: string): Promise<void>;
    private noteWrite;
    private enqueue;
    private flush;
    private markTouched;
    private setState;
    private readTouched;
    private writeTouched;
}
export {};
//# sourceMappingURL=session.d.ts.map