import { z } from "zod";
import { type WireDocument } from "./wire-types.ts";
/** Every wire type and constant, so server code can import the whole contract from one module. */
export * from "./wire-types.ts";
export declare const FieldRequestSchema: z.ZodObject<{
    key: z.ZodString;
    path: z.ZodString;
    value: z.ZodUnknown;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type FieldRequest = z.infer<typeof FieldRequestSchema>;
export declare const ArrayRequestSchema: z.ZodObject<{
    key: z.ZodString;
    path: z.ZodString;
    op: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type ArrayRequest = z.infer<typeof ArrayRequestSchema>;
/** Body of `retire` and `restore`. */
export declare const KeyRequestSchema: z.ZodObject<{
    key: z.ZodString;
}, z.core.$strip>;
export type KeyRequest = z.infer<typeof KeyRequestSchema>;
/** Body of `publish`. With `at`, the draft is scheduled instead of published now. */
export declare const PublishRequestSchema: z.ZodObject<{
    key: z.ZodString;
    at: z.ZodOptional<z.ZodISODateTime>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type PublishRequest = z.infer<typeof PublishRequestSchema>;
/** Body of `unpublish`. */
export declare const UnpublishRequestSchema: z.ZodObject<{
    key: z.ZodString;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type UnpublishRequest = z.infer<typeof UnpublishRequestSchema>;
/** Body of `discard`. */
export declare const DiscardRequestSchema: z.ZodObject<{
    key: z.ZodString;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type DiscardRequest = z.infer<typeof DiscardRequestSchema>;
/** Body of `restore-revision`: copies that revision's payload into the draft. */
export declare const RestoreRevisionRequestSchema: z.ZodObject<{
    key: z.ZodString;
    revisionId: z.ZodNumber;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type RestoreRevisionRequest = z.infer<typeof RestoreRevisionRequestSchema>;
/** Body of `publish-due`. Without `now`, the store's clock decides what is due. */
export declare const PublishDueRequestSchema: z.ZodObject<{
    now: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strip>;
export type PublishDueRequest = z.infer<typeof PublishDueRequestSchema>;
export declare const RenameRequestSchema: z.ZodObject<{
    key: z.ZodString;
    slug: z.ZodString;
}, z.core.$strip>;
export type RenameRequest = z.infer<typeof RenameRequestSchema>;
export declare const CreateRequestSchema: z.ZodObject<{
    type: z.ZodString;
    slug: z.ZodString;
    payload: z.ZodUnknown;
}, z.core.$strip>;
export type CreateRequest = z.infer<typeof CreateRequestSchema>;
/** Query of `GET documents`: `keys` is a comma-separated list. */
export declare const DocumentsQuerySchema: z.ZodObject<{
    keys: z.ZodString;
}, z.core.$strip>;
/** Query of `GET revisions`. */
export declare const RevisionsQuerySchema: z.ZodObject<{
    key: z.ZodString;
}, z.core.$strip>;
/** Query of `GET document`. */
export declare const DocumentQuerySchema: z.ZodObject<{
    key: z.ZodString;
}, z.core.$strip>;
export declare const ErrorEnvelopeSchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            slug: "slug";
            path: "path";
            state: "state";
            forbidden: "forbidden";
            not_found: "not_found";
            conflict: "conflict";
            validation: "validation";
            bad_request: "bad_request";
            internal: "internal";
        }>;
        message: z.ZodString;
        issues: z.ZodOptional<z.ZodUnknown>;
        current: z.ZodOptional<z.ZodCustom<WireDocument, WireDocument>>;
    }, z.core.$strip>;
}, z.core.$strip>;
//# sourceMappingURL=wire.d.ts.map