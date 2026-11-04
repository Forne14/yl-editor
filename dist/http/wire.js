import { z } from "zod";
import { ArrayOpSchema } from "../types.js";
import { ERROR_STATUS } from "./wire-types.js";
/** Every wire type and constant, so server code can import the whole contract from one module. */
export * from "./wire-types.js";
const key = z.string().min(1);
const expectedVersion = z.number().int().nonnegative().optional();
export const FieldRequestSchema = z.object({ key, path: z.string(), value: z.unknown(), expectedVersion });
export const ArrayRequestSchema = z.object({ key, path: z.string(), op: ArrayOpSchema, expectedVersion });
/** Body of `publish`, `discard`, `retire` and `restore`. */
export const KeyRequestSchema = z.object({ key });
export const RenameRequestSchema = z.object({ key, slug: z.string() });
export const CreateRequestSchema = z.object({ type: z.string().min(1), slug: z.string(), payload: z.unknown() });
/** Query of `GET documents`: `keys` is a comma-separated list. */
export const DocumentsQuerySchema = z.object({ keys: z.string() });
/** Query of `GET revisions`. */
export const RevisionsQuerySchema = z.object({ key });
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