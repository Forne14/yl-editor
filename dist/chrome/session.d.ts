import { type ContentClient } from "../http/client.ts";
import type { DocumentState, WireDocument } from "./types.ts";
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
    private readonly storageKey;
    constructor(client: ContentClient, events: SessionEvents, base: string);
    load(keys: readonly string[]): Promise<void>;
    slot(key: string, path: string): SaveSlot;
    save(key: string, path: string, value: unknown): Promise<void>;
    retry(slot: SaveSlot): Promise<void>;
    /** Overwrite: adopt the server's version so the next write is accepted, then resend our value. */
    keepMine(slot: SaveSlot): Promise<void>;
    /** Accept the other edit. Returns the server's value for the field so the caller can repaint it. */
    takeTheirs(slot: SaveSlot): unknown;
    /** Publish or discard finished: the document is no longer this session's change. */
    settle(key: string, document: WireDocument | null): void;
    private adopt;
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