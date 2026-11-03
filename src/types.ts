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
}

export interface SchemaRegistry {
  entry(type: string): RegistryEntry | undefined;
  byCollection(collection: string): RegistryEntry | undefined;
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
}

export const RevisionSchema = z.object({
  id: z.number().int(),
  action: z.enum(["publish", "retire", "restore", "rename"]),
  slug: z.string(),
  payload: z.unknown(),
  createdAt: z.string(),
});
export type Revision = z.infer<typeof RevisionSchema>;

export interface ReadOptions {
  /** Return the draft when one exists (editor reads). Default: published only. */
  draft?: boolean;
  includeRetired?: boolean;
}

export interface ContentStore {
  create(type: string, slug: string, payload: unknown): StoredDocument;
  get(key: string, opts?: ReadOptions): StoredDocument | null;
  list(type: string, opts?: ReadOptions): StoredDocument[];
  writeField(key: string, path: string, value: unknown): StoredDocument;
  arrayOp(key: string, path: string, op: ArrayOp): StoredDocument;
  publish(key: string): StoredDocument;
  discardDraft(key: string): StoredDocument | null;
  retire(key: string): StoredDocument;
  restore(key: string): StoredDocument;
  rename(key: string, newSlug: string): StoredDocument;
  revisions(key: string): Revision[];
  findByPreviousSlug(collection: string, slug: string): string | null;
}

export interface Access {
  canEdit(locals: unknown): boolean;
  canPublish(locals: unknown): boolean;
}

export const MediaVariantSchema = z.object({
  width: z.number().int().positive(),
  format: z.enum(["avif", "webp", "png", "mp4"]),
  url: z.string(),
});
export type MediaVariant = z.infer<typeof MediaVariantSchema>;

export interface MediaStore {
  upload(file: Uint8Array, meta: { role: string; filename: string; alt: string }): Promise<{ id: string }>;
  resolve(id: string): MediaVariant[] | null;
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
