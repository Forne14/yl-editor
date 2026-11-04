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
/** Body of `publish`, `discard`, `retire` and `restore`. */
export declare const KeyRequestSchema: z.ZodObject<{
    key: z.ZodString;
}, z.core.$strip>;
export type KeyRequest = z.infer<typeof KeyRequestSchema>;
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
export declare const ErrorEnvelopeSchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            slug: "slug";
            path: "path";
            forbidden: "forbidden";
            not_found: "not_found";
            conflict: "conflict";
            validation: "validation";
            state: "state";
            bad_request: "bad_request";
            internal: "internal";
        }>;
        message: z.ZodString;
        issues: z.ZodOptional<z.ZodUnknown>;
        current: z.ZodOptional<z.ZodCustom<WireDocument, WireDocument>>;
    }, z.core.$strip>;
}, z.core.$strip>;
//# sourceMappingURL=wire.d.ts.map