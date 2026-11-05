import { z } from "zod";

export type PathSegment = string | number;

const index = z.number().int().nonnegative();

export const ArrayOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"), index, value: z.unknown() }),
  z.object({ kind: z.literal("move"), from: index, to: index }),
  z.object({ kind: z.literal("remove"), index }),
]);
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
  /**
   * Every registered entry. Optional: nothing in the library calls it; it exists for back-office listing (see #7).
   */
  entries?(): readonly RegistryEntry[];
}

/** The smallest description of a document an access check needs. */
export interface DocumentRef {
  type: string;
  key: string;
}

export type AccessVerdict = { allowed: true } | { allowed: false; reason: string };

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

export const RevisionSchema = z.object({
  id: z.number().int(),
  action: z.enum(["publish", "retire", "restore", "rename", "restore_revision", "unpublish"]),
  slug: z.string(),
  payload: z.unknown(),
  createdAt: z.string(),
  actor: z.string().nullable(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export interface ReadOptions {
  /** Return the draft when one exists (editor reads). Default: published only. */
  draft?: boolean;
  includeRetired?: boolean;
  /**
   * Return the requested view as stored: no schema validation, nothing reported through `onReadIssue`, and a `migrate`
   * that throws leaves the stored payload instead of failing the read. For reading a document's identity (access
   * checks, summaries, repairs); never for rendering, since the payload may not match its schema.
   */
  unvalidated?: boolean;
}

/** Trailing argument of `publishDue`. */
export interface PublishDueContext extends WriteContext {
  /**
   * Called for each due document that could not be published; it stays scheduled and is retried on the next run.
   * Without it the store logs with `console.warn`.
   */
  onFailure?: (key: string, error: unknown) => void;
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
  publish(key: string, context?: WriteContext & { at?: string }): Promise<StoredDocument>;
  /**
   * Publishes every document whose `scheduledAt` is at or before `now` (default: the store clock), each on its own, and
   * returns the ones published. One that fails stays scheduled and is reported through `context.onFailure`; the others
   * still publish.
   */
  publishDue(now?: string, context?: PublishDueContext): Promise<StoredDocument[]>;
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

export const MediaVariantSchema = z.object({
  width: z.number().int().positive(),
  format: z.enum(["avif", "webp", "png", "mp4"]),
  url: z.string(),
});
export type MediaVariant = z.infer<typeof MediaVariantSchema>;

export interface MediaStore {
  upload(file: Uint8Array, meta: { role: string; filename: string; alt: string }): Promise<{ id: string }>;
  resolve(id: string): Promise<MediaVariant[] | null>;
}

export type OnPublish = (doc: StoredDocument) => Promise<void> | void;

export class ContentValidationError extends Error {
  constructor(
    readonly key: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `Document ${key} does not match its schema: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    this.name = "ContentValidationError";
  }
}

export class PathError extends Error {
  override name = "PathError";
}

export class DocumentNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`No document ${key}`);
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentStateError extends Error {
  override name = "DocumentStateError";
}

/** A write carried an `expectedVersion` that no longer matches the stored document. */
export class ConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Document ${key} is at version ${actual}, not the expected ${expected}`);
    this.name = "ConflictError";
  }
}

/** A slug that is not lower-case words joined by single hyphens. */
export class SlugError extends Error {
  constructor(readonly slug: string) {
    super(`Invalid slug ${JSON.stringify(slug)}: use lower-case letters and digits joined by single hyphens`);
    this.name = "SlugError";
  }
}
