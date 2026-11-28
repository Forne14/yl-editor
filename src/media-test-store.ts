// A small in-memory MediaStore for the package's tests and the demo site. Not part of the published API.
//
// Type-only imports: the demo runs this file straight from src/ under Node's type stripping while its handlers come
// from dist/, so the store is handed the MediaRefusal class the handlers check with `instanceof`.
import type { MediaRefusal, MediaStore, MediaUploadAnswer } from "./types.ts";

/** The host-shaped variants this store keeps beside each render. The package never reads them. */
export interface TestMediaVariants {
  original: { type: string; bytes: number };
}

/** Switches a test or the demo flips to drive the editor through each path. */
export interface TestMediaMode {
  /** `async`: upload answers 202 with a job that becomes ready after `readyAfterPolls` polls. Default `sync`. */
  process: "sync" | "async";
  /** Polls a job answers `processing` to before it settles. Default 2. */
  readyAfterPolls: number;
  /** When set, a job settles as `failed` with this reason instead of ready. */
  fail: string | null;
  /** Uploads still to refuse as `busy` before one goes through. Default 0. */
  busy: number;
  /** `retryAfterMs` on a busy refusal and on a 202. Default 1000. */
  retryAfterMs: number;
}

export interface TestMediaStoreOptions {
  /** The `MediaRefusal` class the handlers in use check against. */
  MediaRefusal: typeof MediaRefusal;
  /** Largest body it stores. Default 40 MB. */
  maxBytes?: number;
  /** Where render URLs point: `${mediaBase}${id}`. Default `/media/`. */
  mediaBase?: string;
}

export interface TestMediaStore extends MediaStore<TestMediaVariants> {
  accept: NonNullable<MediaStore<TestMediaVariants>["accept"]>;
  job: NonNullable<MediaStore<TestMediaVariants>["job"]>;
  cancelJob: NonNullable<MediaStore<TestMediaVariants>["cancelJob"]>;
  mode: TestMediaMode;
  /** The stored bytes and type of a media id, for serving it. */
  file(id: string): { bytes: Uint8Array; type: string } | undefined;
  /** How many media items are stored. */
  count(): number;
}

/** A 2x1 PNG (one red, one blue pixel), the smallest real image the tests send. */
export const SAMPLE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0xf4, 0x22, 0x7f, 0x8a, 0x00, 0x00, 0x00, 0x0e, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x42, 0xff, 0x01, 0x0f, 0xf9, 0x03, 0xfd, 0x85, 0x11,
  0x99, 0x76, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function createTestMediaStore(options: TestMediaStoreOptions): TestMediaStore {
  void options;
  const notImplemented = (): never => {
    throw new Error("not implemented");
  };
  return {
    mode: { process: "sync", readyAfterPolls: 2, fail: null, busy: 0, retryAfterMs: 1000 },
    file: notImplemented,
    count: notImplemented,
    accept: notImplemented,
    upload: async (): Promise<MediaUploadAnswer<TestMediaVariants>> => notImplemented(),
    job: async () => notImplemented(),
    cancelJob: async () => notImplemented(),
    resolve: async () => notImplemented(),
  };
}
