// A small in-memory MediaStore for the package's tests and the demo site. Not part of the published API.
//
// Type-only imports: the demo runs this file straight from src/ under Node's type stripping while its handlers come
// from dist/, so the store is handed the MediaRefusal class the handlers check with `instanceof`.
import type {
  MediaFieldRef,
  MediaFileInfo,
  MediaJobState,
  MediaRefusal,
  MediaStore,
  MediaUploadAnswer,
  ResolvedMedia,
} from "./types.ts";

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

/** The declared types `accept` takes. An empty type is let through: the bytes decide. */
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic"]);

const DEFAULT_MAX_BYTES = 40_000_000;

interface Probed {
  type: string;
  width: number;
  height: number;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);

/** The type and pixel size the bytes show, for PNG, GIF and JPEG. Null for anything else. */
function probe(bytes: Uint8Array): Probed | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 24 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.byteLength >= 10 && startsWith(bytes, [0x47, 0x49, 0x46, 0x38]))
    return { type: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.byteLength >= 4 && startsWith(bytes, [0xff, 0xd8])) {
    // Walk the JPEG segments to the first start-of-frame marker, which holds the size.
    let offset = 2;
    while (offset + 9 <= bytes.byteLength) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1] ?? 0;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { type: "image/jpeg", width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

/** The last path segment, without control characters: the filename is untrusted. */
function safeFilename(filename: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const name = (filename.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length > 0 ? name.slice(0, 200) : undefined;
}

interface Job {
  field: MediaFieldRef;
  polls: number;
  readyAfter: number;
  fail: string | null;
  filename: string;
  stage: () => ResolvedMedia<TestMediaVariants>;
  settled: MediaJobState<TestMediaVariants> | null;
}

export function createTestMediaStore(options: TestMediaStoreOptions): TestMediaStore {
  const { MediaRefusal } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const mediaBase = options.mediaBase ?? "/media/";
  const stored = new Map<string, { media: ResolvedMedia<TestMediaVariants>; bytes: Uint8Array }>();
  const jobs = new Map<string, Job>();
  let nextId = 0;

  const accept = (_field: MediaFieldRef, file: MediaFileInfo) => {
    if (file.size !== null && file.size > maxBytes)
      throw new MediaRefusal("too_large", `The file is over ${maxBytes} bytes`, { limit: maxBytes });
    const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "" && !ACCEPTED_TYPES.has(type))
      throw new MediaRefusal("unsupported", "Use a JPEG, PNG, GIF, WebP, AVIF or HEIC image");
  };

  /** Reads the whole body, refusing past the limit and stopping when the signal aborts. */
  const readBody = async (body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> => {
    const reader = body.getReader();
    const stop = () => void reader.cancel(signal.reason).catch(() => {});
    signal.addEventListener("abort", stop);
    // A listener added after the abort never fires.
    if (signal.aborted) stop();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new MediaRefusal("too_large", `The file is over ${maxBytes} bytes`, { limit: maxBytes });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };

  const store: TestMediaStore = {
    mode: { process: "sync", readyAfterPolls: 2, fail: null, busy: 0, retryAfterMs: 1000 },
    file: (id) => {
      const entry = stored.get(id);
      return entry ? { bytes: entry.bytes, type: entry.media.variants.original.type } : undefined;
    },
    count: () => stored.size,
    accept,
    upload: async (body, file, field, context): Promise<MediaUploadAnswer<TestMediaVariants>> => {
      const { signal } = context;
      if (signal.aborted) {
        await body.cancel().catch(() => {});
        throw signal.reason;
      }
      if (store.mode.busy > 0) {
        store.mode.busy--;
        await body.cancel().catch(() => {});
        throw new MediaRefusal("busy", "The media store is busy", { retryAfterMs: store.mode.retryAfterMs });
      }
      try {
        accept(field, file);
      } catch (error) {
        await body.cancel().catch(() => {});
        throw error;
      }
      const bytes = await readBody(body, signal);
      const probed = probe(bytes);
      if (!probed) throw new MediaRefusal("unsupported", "The file is not a PNG, GIF or JPEG image");
      if (probed.width === 0 || probed.height === 0) throw new MediaRefusal("invalid", "the image is empty");
      const filename = safeFilename(file.filename);
      const id = `m${++nextId}`;
      // Building the media does not store it: a job stores it only when it becomes ready.
      const stage = (): ResolvedMedia<TestMediaVariants> => {
        const media: ResolvedMedia<TestMediaVariants> = {
          id,
          render: {
            kind: "image",
            src: `${mediaBase}${id}`,
            width: probed.width,
            height: probed.height,
            ...(filename !== undefined ? { filename } : {}),
          },
          variants: { original: { type: probed.type, bytes: bytes.byteLength } },
        };
        stored.set(id, { media, bytes });
        return media;
      };
      if (store.mode.process === "sync") return { status: "ready", media: stage() };
      const job = `j${++nextId}`;
      jobs.set(job, {
        field: { key: field.key, path: field.path },
        polls: 0,
        readyAfter: Math.max(1, store.mode.readyAfterPolls),
        fail: store.mode.fail,
        filename: filename ?? "the file",
        stage,
        settled: null,
      });
      return { status: "processing", job, retryAfterMs: store.mode.retryAfterMs };
    },
    job: async (id, field) => {
      const job = jobs.get(id);
      if (!job || job.field.key !== field.key || job.field.path !== field.path) return null;
      // A settled job keeps answering the same, so a late or repeated poll still reads it.
      if (job.settled) return job.settled;
      job.polls++;
      if (job.polls < job.readyAfter) return { status: "processing", progress: job.polls / job.readyAfter };
      job.settled =
        job.fail !== null
          ? {
              status: "failed",
              reason: job.fail,
              message: `The server couldn't process ${job.filename}: ${job.fail}.`,
            }
          : { status: "ready", media: job.stage() };
      return job.settled;
    },
    cancelJob: async (id, field) => {
      const job = jobs.get(id);
      if (job && job.field.key === field.key && job.field.path === field.path && !job.settled) jobs.delete(id);
    },
    resolve: async (ids) => {
      const found = new Map<string, ResolvedMedia<TestMediaVariants>>();
      for (const id of ids) {
        const entry = stored.get(id);
        if (entry) found.set(id, entry.media);
      }
      return found;
    },
  };
  return store;
}
