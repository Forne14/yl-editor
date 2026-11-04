import { z } from "zod";
export type PathSegment = string | number;
export declare const ArrayOpSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"insert">;
    index: z.ZodNumber;
    value: z.ZodUnknown;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"move">;
    from: z.ZodNumber;
    to: z.ZodNumber;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"remove">;
    index: z.ZodNumber;
}, z.core.$strip>], "kind">;
export type ArrayOp = z.infer<typeof ArrayOpSchema>;
export interface RegistryEntry {
    type: string;
    collection: string;
    schema: z.ZodType;
    /** The payload shape version this entry's schema describes. Defaults to 1. Bump it when the schema changes shape. */
    version?: number;
    /**
     * Upgrades a payload stored under an older version to the current one. Runs on read before validation, and on the
     * next draft write before the migrated payload is persisted. Must be pure; it may be called many times per document.
     */
    migrate?(fromVersion: number, payload: unknown): unknown;
}
export interface SchemaRegistry {
    entry(type: string): RegistryEntry | undefined;
    byCollection(collection: string): RegistryEntry | undefined;
    entries(): readonly RegistryEntry[];
}
/** The smallest description of a document an access check needs. */
export interface DocumentRef {
    type: string;
    key: string;
}
export type AccessVerdict = {
    allowed: true;
} | {
    allowed: false;
    reason: string;
};
export type MaybePromise<T> = T | Promise<T>;
/** Trailing argument on every write. */
export interface WriteContext {
    /** Who made the change, as the host names them. Recorded on lifecycle revisions; null when absent. */
    actor?: string;
    /** The version the caller last read. When present and stale, the write throws ConflictError and changes nothing. */
    expectedVersion?: number;
}
export interface StoredDocument {
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
    /** Starts at 1 on create; increments on every draft write, publish, discard, retire, restore and rename. */
    version: number;
    /** ISO time the draft is scheduled to publish at, or null. Cleared by publish, discardDraft and unpublish. */
    scheduledAt: string | null;
}
export declare const RevisionSchema: z.ZodObject<{
    id: z.ZodNumber;
    action: z.ZodEnum<{
        publish: "publish";
        retire: "retire";
        restore: "restore";
        rename: "rename";
        restore_revision: "restore_revision";
        unpublish: "unpublish";
    }>;
    slug: z.ZodString;
    payload: z.ZodUnknown;
    createdAt: z.ZodString;
    actor: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type Revision = z.infer<typeof RevisionSchema>;
export interface ReadOptions {
    /** Return the draft when one exists (editor reads). Default: published only. */
    draft?: boolean;
    includeRetired?: boolean;
}
export interface ContentStore {
    create(type: string, slug: string, payload: unknown, context?: WriteContext): Promise<StoredDocument>;
    get(key: string, opts?: ReadOptions): Promise<StoredDocument | null>;
    list(type: string, opts?: ReadOptions): Promise<StoredDocument[]>;
    writeField(key: string, path: string, value: unknown, context?: WriteContext): Promise<StoredDocument>;
    arrayOp(key: string, path: string, op: ArrayOp, context?: WriteContext): Promise<StoredDocument>;
    /**
     * Promotes the draft. With `at` (ISO string) nothing is published yet: the time is stored, the version bumps, no
     * revision is written and the draft document is returned. `publishDue` does the promotion later.
     */
    publish(key: string, context?: WriteContext & {
        at?: string;
    }): Promise<StoredDocument>;
    /** Publishes every document whose `scheduledAt` is at or before `now` (default: the store clock). */
    publishDue(now?: string, context?: WriteContext): Promise<StoredDocument[]>;
    /**
     * Published to draft-only, without retiring. Throws DocumentStateError when never published. Keeps an existing
     * draft, otherwise the published payload becomes the draft.
     */
    unpublish(key: string, context?: WriteContext): Promise<StoredDocument>;
    /**
     * Copies a revision's payload into the draft (never the published payload). A revisionId that does not exist, or
     * belongs to another document, throws DocumentNotFoundError for `key`.
     */
    restoreRevision(key: string, revisionId: number, context?: WriteContext): Promise<StoredDocument>;
    discardDraft(key: string, context?: WriteContext): Promise<StoredDocument | null>;
    retire(key: string, context?: WriteContext): Promise<StoredDocument>;
    restore(key: string, context?: WriteContext): Promise<StoredDocument>;
    rename(key: string, newSlug: string, context?: WriteContext): Promise<StoredDocument>;
    revisions(key: string): Promise<Revision[]>;
    findByPreviousSlug(collection: string, slug: string): Promise<string | null>;
}
/** Host-supplied permission checks. `locals` stays opaque: the package never learns the host's user shape. */
export interface Access {
    canEdit(locals: unknown, doc: DocumentRef): MaybePromise<AccessVerdict>;
    canPublish(locals: unknown, doc: DocumentRef): MaybePromise<AccessVerdict>;
}
export declare const MediaVariantSchema: z.ZodObject<{
    width: z.ZodNumber;
    format: z.ZodEnum<{
        avif: "avif";
        webp: "webp";
        png: "png";
        mp4: "mp4";
    }>;
    url: z.ZodString;
}, z.core.$strip>;
export type MediaVariant = z.infer<typeof MediaVariantSchema>;
export interface MediaStore {
    upload(file: Uint8Array, meta: {
        role: string;
        filename: string;
        alt: string;
    }): Promise<{
        id: string;
    }>;
    resolve(id: string): Promise<MediaVariant[] | null>;
}
export type OnPublish = (doc: StoredDocument) => Promise<void> | void;
export declare class ContentValidationError extends Error {
    readonly key: string;
    readonly issues: z.core.$ZodIssue[];
    constructor(key: string, issues: z.core.$ZodIssue[]);
}
export declare class PathError extends Error {
    name: string;
}
export declare class DocumentNotFoundError extends Error {
    readonly key: string;
    constructor(key: string);
}
export declare class DocumentStateError extends Error {
    name: string;
}
/** A write carried an `expectedVersion` that no longer matches the stored document. */
export declare class ConflictError extends Error {
    readonly key: string;
    readonly expected: number;
    readonly actual: number;
    constructor(key: string, expected: number, actual: number);
}
/** A slug that is not lower-case words joined by single hyphens. */
export declare class SlugError extends Error {
    readonly slug: string;
    constructor(slug: string);
}
//# sourceMappingURL=types.d.ts.map