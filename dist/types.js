import { z } from "zod";
const index = z.number().int().nonnegative();
export const ArrayOpSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("insert"), index, value: z.unknown() }),
    z.object({ kind: z.literal("move"), from: index, to: index }),
    z.object({ kind: z.literal("remove"), index }),
]);
export const RevisionSchema = z.object({
    id: z.number().int(),
    action: z.enum(["publish", "retire", "restore", "rename", "restore_revision", "unpublish"]),
    slug: z.string(),
    payload: z.unknown(),
    createdAt: z.string(),
    actor: z.string().nullable(),
});
export const MediaVariantSchema = z.object({
    width: z.number().int().positive(),
    format: z.enum(["avif", "webp", "png", "mp4"]),
    url: z.string(),
});
export class ContentValidationError extends Error {
    key;
    issues;
    constructor(key, issues) {
        super(`Document ${key} does not match its schema: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        this.key = key;
        this.issues = issues;
        this.name = "ContentValidationError";
    }
}
export class PathError extends Error {
    name = "PathError";
}
export class DocumentNotFoundError extends Error {
    key;
    constructor(key) {
        super(`No document ${key}`);
        this.key = key;
        this.name = "DocumentNotFoundError";
    }
}
export class DocumentStateError extends Error {
    name = "DocumentStateError";
}
/** A write carried an `expectedVersion` that no longer matches the stored document. */
export class ConflictError extends Error {
    key;
    expected;
    actual;
    constructor(key, expected, actual) {
        super(`Document ${key} is at version ${actual}, not the expected ${expected}`);
        this.key = key;
        this.expected = expected;
        this.actual = actual;
        this.name = "ConflictError";
    }
}
/** A slug that is not lower-case words joined by single hyphens. */
export class SlugError extends Error {
    slug;
    constructor(slug) {
        super(`Invalid slug ${JSON.stringify(slug)}: use lower-case letters and digits joined by single hyphens`);
        this.slug = slug;
        this.name = "SlugError";
    }
}
//# sourceMappingURL=types.js.map