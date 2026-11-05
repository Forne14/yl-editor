import { z } from "zod";
import { ArrayOpSchema } from "../types.js";
import { ERROR_STATUS } from "./wire-types.js";
/** Every wire type and constant, so server code can import the whole contract from one module. */
export * from "./wire-types.js";
const key = z.string().min(1);
const expectedVersion = z.number().int().nonnegative().optional();
export const FieldRequestSchema = z.object({ key, path: z.string(), value: z.unknown(), expectedVersion });
export const ArrayRequestSchema = z.object({ key, path: z.string(), op: ArrayOpSchema, expectedVersion });
/** An ISO 8601 datetime with a `Z` or a numeric offset, as `publish.at` and `publish-due.now` take it. */
const isoDateTime = z.iso.datetime({ offset: true });
/** Body of `retire` and `restore`. */
export const KeyRequestSchema = z.object({ key });
/** Body of `publish`. With `at`, the draft is scheduled instead of published now. */
export const PublishRequestSchema = z.object({ key, at: isoDateTime.optional(), expectedVersion });
/** Body of `unpublish`. */
export const UnpublishRequestSchema = z.object({ key, expectedVersion });
/** Body of `discard`. */
export const DiscardRequestSchema = z.object({ key, expectedVersion });
/** Body of `restore-revision`: copies that revision's payload into the draft. */
export const RestoreRevisionRequestSchema = z.object({
    key,
    revisionId: z.number().int().nonnegative(),
    expectedVersion,
});
/** Body of `publish-due`. Without `now`, the store's clock decides what is due. */
export const PublishDueRequestSchema = z.object({ now: isoDateTime.optional() });
export const RenameRequestSchema = z.object({ key, slug: z.string() });
export const CreateRequestSchema = z.object({ type: z.string().min(1), slug: z.string(), payload: z.unknown() });
/** Query of `GET documents`: `keys` is a comma-separated list. */
export const DocumentsQuerySchema = z.object({ keys: z.string() });
/** Query of `GET revisions`. */
export const RevisionsQuerySchema = z.object({ key });
/** Query of `GET document`. */
export const DocumentQuerySchema = z.object({ key });
const errorCodes = Object.keys(ERROR_STATUS);
export const ErrorEnvelopeSchema = z.object({
    error: z.object({
        code: z.enum(errorCodes),
        message: z.string(),
        issues: z.unknown().optional(),
        current: z.custom((value) => typeof value === "object" && value !== null).optional(),
    }),
});
const wireMatchesCore = [true, true];
void wireMatchesCore;
//# sourceMappingURL=wire.js.map