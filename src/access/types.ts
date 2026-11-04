/**
 * Shared contract types. These mirror the definitions the package root is gaining in `src/types.ts`; they live here
 * so this subpath type-checks on its own, and are deduplicated against the root at integration.
 */

export interface DocumentRef {
  type: string;
  key: string;
}

export type AccessVerdict = { allowed: true } | { allowed: false; reason: string };

export type MaybePromise<T> = T | Promise<T>;

export interface Access {
  canEdit(locals: unknown, doc: DocumentRef): MaybePromise<AccessVerdict>;
  canPublish(locals: unknown, doc: DocumentRef): MaybePromise<AccessVerdict>;
}
