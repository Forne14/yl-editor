import { z } from "zod";
import { ArrayOpSchema, type ArrayOp, type StoredDocument } from "../types.ts";
import { ERROR_STATUS, type ErrorCode, type WireArrayOp, type WireDocument } from "./wire-types.ts";

/** Every wire type and constant, so server code can import the whole contract from one module. */
export * from "./wire-types.ts";

const key = z.string().min(1);
const expectedVersion = z.number().int().nonnegative().optional();

export const FieldRequestSchema = z.object({ key, path: z.string(), value: z.unknown(), expectedVersion });
export type FieldRequest = z.infer<typeof FieldRequestSchema>;

export const ArrayRequestSchema = z.object({ key, path: z.string(), op: ArrayOpSchema, expectedVersion });
export type ArrayRequest = z.infer<typeof ArrayRequestSchema>;

/** An ISO 8601 datetime with a `Z` or a numeric offset, as `publish.at` and `publish-due.now` take it. */
const isoDateTime = z.iso.datetime({ offset: true });

/** Body of `retire` and `restore`. */
export const KeyRequestSchema = z.object({ key });
export type KeyRequest = z.infer<typeof KeyRequestSchema>;

/** Body of `publish`. With `at`, the draft is scheduled instead of published now. */
export const PublishRequestSchema = z.object({ key, at: isoDateTime.optional(), expectedVersion });
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** Body of `unpublish`. */
export const UnpublishRequestSchema = z.object({ key, expectedVersion });
export type UnpublishRequest = z.infer<typeof UnpublishRequestSchema>;

/** Body of `discard`. */
export const DiscardRequestSchema = z.object({ key, expectedVersion });
export type DiscardRequest = z.infer<typeof DiscardRequestSchema>;

/** Body of `restore-revision`: copies that revision's payload into the draft. */
export const RestoreRevisionRequestSchema = z.object({
  key,
  revisionId: z.number().int().nonnegative(),
  expectedVersion,
});
export type RestoreRevisionRequest = z.infer<typeof RestoreRevisionRequestSchema>;

/** Body of `publish-due`. Without `now`, the store's clock decides what is due. */
export const PublishDueRequestSchema = z.object({ now: isoDateTime.optional() });
export type PublishDueRequest = z.infer<typeof PublishDueRequestSchema>;

export const RenameRequestSchema = z.object({ key, slug: z.string() });
export type RenameRequest = z.infer<typeof RenameRequestSchema>;

export const CreateRequestSchema = z.object({ type: z.string().min(1), slug: z.string(), payload: z.unknown() });
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

/** Query of `GET documents`: `keys` is a comma-separated list. */
export const DocumentsQuerySchema = z.object({ keys: z.string() });

/** Query of `GET revisions`. */
export const RevisionsQuerySchema = z.object({ key });

/** Query of `GET document`. */
export const DocumentQuerySchema = z.object({ key });

const errorCodes = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(errorCodes),
    message: z.string(),
    issues: z.unknown().optional(),
    current: z.custom<WireDocument>((value) => typeof value === "object" && value !== null).optional(),
  }),
});

/** Compile-time guard: the dependency-free wire types must stay identical to the core types they mirror. */
type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
const wireMatchesCore: [Same<WireDocument, StoredDocument>, Same<WireArrayOp, ArrayOp>] = [true, true];
void wireMatchesCore;
