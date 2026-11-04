import { type Access, type ContentStore, type MaybePromise, type SchemaRegistry, type StoredDocument } from "../types.ts";
export type ChangeAction = "create" | "field" | "array" | "publish" | "discard" | "retire" | "restore" | "rename";
export interface ChangeEvent {
    action: ChangeAction;
    key: string;
    document: StoredDocument | null;
    actor?: string;
}
export interface ContentHandlerOptions {
    store: ContentStore;
    registry: SchemaRegistry;
    access: Access;
    /** Resolves the host's session for a request. The package passes it to `access` untouched. */
    locals: (request: Request) => MaybePromise<unknown>;
    /** Names the actor recorded on revisions (`WriteContext.actor`). */
    actor?: (locals: unknown) => string | undefined;
    /** Path prefix the routes live under, matched against the request URL's pathname. Default `/api/content`. */
    base?: string;
    /** Refuse requests whose `Origin` or `Sec-Fetch-Site` shows a cross-site caller. Default true. */
    sameOrigin?: boolean;
    /** Called after every successful write: the activity-log seam. Errors are logged, never surfaced. */
    onChange?: (event: ChangeEvent) => MaybePromise<void>;
}
export interface ContentHandlers {
    /** Routes by pathname and method. Always resolves; never throws. */
    handle(request: Request): Promise<Response>;
    /** Every route as `"METHOD name"`. */
    routes: readonly string[];
}
export declare function createContentHandlers(options: ContentHandlerOptions): ContentHandlers;
//# sourceMappingURL=handlers.d.ts.map