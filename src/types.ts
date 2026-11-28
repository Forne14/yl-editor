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
   * When a database failure stops the run, it is also called with that error for every document not reached. Without
   * it the store logs with `console.warn`.
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
   * still publish, unless the database itself is failing, which stops the run and reports the rest as failed too.
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

/** The field an upload is for: the document key and the field's path in it. */
export interface MediaFieldRef {
  key: string;
  path: string;
}

/**
 * Everything the chrome reads about a media item, in HTML's own vocabulary. The host builds it from its own variants in
 * its store. It is also the wire shape (`WireMediaRender` in `@yl/editor/http`, kept identical by a check in `wire.ts`).
 */
export interface MediaRender {
  kind: "image" | "video";
  /** A URL the browser can show at once: the preview and `<img src>`. */
  src: string;
  /** For `<img srcset>`. */
  srcset?: string;
  /** For `<picture><source type>`, best first. */
  sources?: { type: string; srcset: string }[];
  /** Intrinsic size, for `width`/`height` and the aspect ratio. Positive. */
  width: number;
  height: number;
  /** Video only. */
  poster?: string;
  /** For the publish diff and the popover. */
  filename?: string;
}

/** A stored media item. `variants` is the host's own shape: the package never reads it and never sends it. */
export interface ResolvedMedia<V = unknown> {
  id: string;
  render: MediaRender;
  variants: V;
}

/** What `MediaStore.upload` answers: stored now, or still processing under a job id the editor polls. */
export type MediaUploadAnswer<V = unknown> =
  { status: "ready"; media: ResolvedMedia<V> } | { status: "processing"; job: string; retryAfterMs?: number };

/** What `MediaStore.job` answers for a job it knows. `progress` is 0..1. */
export type MediaJobState<V = unknown> =
  | { status: "processing"; progress?: number; retryAfterMs?: number }
  | { status: "ready"; media: ResolvedMedia<V> }
  | { status: "failed"; reason: string; message?: string };

export type MediaRefusalCode = "too_large" | "unsupported" | "invalid" | "busy";

/**
 * Thrown by `MediaStore.accept` or `upload` to refuse a file. The handlers map it to a status: `too_large` 413,
 * `unsupported` 415, `invalid` 400 (`bad_request`), `busy` 503 with `Retry-After`. The message reaches the editor.
 */
export class MediaRefusal extends Error {
  override name = "MediaRefusal";
  readonly code: MediaRefusalCode;
  readonly detail: { limit?: number; retryAfterMs?: number };
  constructor(code: MediaRefusalCode, message: string, detail: { limit?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * What the browser said about the file. All of it is untrusted: `filename` may hold path separators or control
 * characters, and `type` may claim anything (an SVG can carry script). `size` is the declared length, or null when the
 * request had none.
 */
export interface MediaFileInfo {
  filename: string;
  type: string;
  size: number | null;
}

/** The host's media storage. The package ships no implementation; `runMediaStoreContract` checks one. */
export interface MediaStore<V = unknown> {
  /** Before the body is read: refuse early on type or declared size by throwing `MediaRefusal`. Optional. */
  accept?(field: MediaFieldRef, file: MediaFileInfo, context: WriteContext): Promise<void> | void;
  /**
   * Reads `body` and stores it, or answers `processing` with a job id. When `signal` aborts, or the body stream
   * errors, it rejects and stores nothing.
   */
  upload(
    body: ReadableStream<Uint8Array>,
    file: MediaFileInfo,
    field: MediaFieldRef,
    context: WriteContext & { signal: AbortSignal },
  ): Promise<MediaUploadAnswer<V>>;
  /** Required when `upload` can answer `processing`. Null for an unknown job, or one that is another field's. */
  job?(job: string, field: MediaFieldRef): Promise<MediaJobState<V> | null>;
  cancelJob?(job: string, field: MediaFieldRef): Promise<void>;
  /** Batched. A missing id is left out of the map. */
  resolve(ids: readonly string[]): Promise<Map<string, ResolvedMedia<V>>>;
}

/** The stored value of a `media` field. `decorative: true` means the editor chose no alt text (`alt` is then ""). */
export interface MediaValue {
  id: string;
  alt: string;
  decorative?: boolean;
}

/**
 * The zod schema of a `media` field's value: `{ id, alt }`, or `{ id, alt: "", decorative: true }`. Alt text is
 * content, drafted and published with the page; the value never holds URLs or variants. Use `mediaValue().nullable()`
 * for a field that may be empty. Refuses `decorative: true` with alt text, and any other key.
 */
export function mediaValue(): z.ZodType<MediaValue> {
  throw new Error("not implemented");
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
