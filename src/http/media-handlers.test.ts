import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { contractRegistry } from "../contract.ts";
import { createTestMediaStore, SAMPLE_PNG, type TestMediaStore } from "../media-test-store.ts";
import { createSqliteContentStore } from "../sqlite-store.ts";
import { makeTestDb } from "../test-support.ts";
import {
  MediaRefusal,
  type AccessVerdict,
  type ContentStore,
  type DocumentRef,
  type MediaFileInfo,
  type MediaStore,
} from "../types.ts";
import { createContentHandlers, type ChangeEvent, type ContentHandlers } from "./handlers.ts";

const baseHeaders = { "X-Requested-With": "yl-editor" };
const note = { title: "A", tags: [] as string[] };
const MAX_BYTES = 1000;

let content: ContentStore;
let media: TestMediaStore;
let editVerdict: (ref: DocumentRef) => AccessVerdict;
let editCalls: DocumentRef[];
let events: ChangeEvent[];

const handlersWith = (store: MediaStore | undefined, maxBytes = MAX_BYTES): ContentHandlers =>
  createContentHandlers({
    store: content,
    registry: contractRegistry,
    access: {
      canEdit: (_locals, ref) => {
        editCalls.push(ref);
        return editVerdict(ref);
      },
      canPublish: () => ({ allowed: true }),
    },
    locals: () => ({ user: "ada" }),
    onChange: (event) => {
      events.push(event);
    },
    ...(store ? { media: { store, maxBytes } } : {}),
  });

let handlers: ContentHandlers;

beforeEach(async () => {
  content = createSqliteContentStore(makeTestDb(), contractRegistry);
  await content.create("note", "first", note);
  media = createTestMediaStore({ MediaRefusal, maxBytes: 10_000 });
  editVerdict = () => ({ allowed: true });
  editCalls = [];
  events = [];
  handlers = handlersWith(media);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const url = (route: string, query: Record<string, string | string[]>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query))
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, item);
  return `http://host/api/content/${route}?${search}`;
};

const field = { key: "notes/first", path: "hero" };

/** A POST media request. `body` may be bytes or a stream; `length` is the declared Content-Length, if any. */
function upload(
  body: Uint8Array | ReadableStream<Uint8Array> = SAMPLE_PNG,
  options: { query?: Record<string, string>; headers?: Record<string, string>; length?: number | null } = {},
) {
  const length = options.length === undefined ? (body instanceof Uint8Array ? body.byteLength : null) : options.length;
  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Type": "image/png",
    "X-Upload-Filename": "dot.png",
    ...(length !== null ? { "Content-Length": String(length) } : {}),
    ...options.headers,
  };
  return new Request(url("media", options.query ?? field), {
    method: "POST",
    headers,
    body: body instanceof Uint8Array ? (body as BlobPart) : body,
    duplex: "half",
  } as RequestInit);
}

const getJob = (job: string, query: Record<string, string> = field) =>
  new Request(url("media-job", { ...query, job }), { headers: baseHeaders });
const deleteJob = (job: string) =>
  new Request(url("media-job", { ...field, job }), { method: "DELETE", headers: baseHeaders });
const getMedia = (ids: string[], key = field.key) =>
  new Request(url("media", { key, id: ids }), { headers: baseHeaders });

async function call(request: Request, on: ContentHandlers = handlers) {
  const response = await on.handle(request);
  const text = await response.text();
  // Bodies are asserted structurally; a loose type keeps the assertions readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (text.length > 0 ? JSON.parse(text) : undefined) as Record<string, any>;
  return { response, status: response.status, text, body };
}

/** A stream that records whether anything read from it. No queue, so only a read pulls. */
function watchedStream(bytes: Uint8Array) {
  const seen = { pulled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulled = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

/** `size` zero bytes in 100-byte chunks. */
function zeros(size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = Math.min(left, 100);
      left -= chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

/** A store that records what upload saw and answers ready without storing anything. */
function spyStore(overrides: Partial<MediaStore> = {}) {
  const seen: { file?: MediaFileInfo; accepted?: MediaFileInfo; bytes?: number; signal?: AbortSignal } = {};
  const store: MediaStore = {
    accept: (_field, file) => {
      seen.accepted = file;
    },
    upload: async (body, file, _field, context) => {
      seen.file = file;
      seen.signal = context.signal;
      seen.bytes = (await new Response(body).arrayBuffer()).byteLength;
      return {
        status: "ready",
        media: { id: "m_spy", render: { kind: "image", src: "/m/spy", width: 1, height: 1 }, variants: null },
      };
    },
    resolve: async () => new Map(),
    ...overrides,
  };
  return { store, seen };
}

describe("routes", () => {
  test("the media option adds four routes, two names with two methods each", () => {
    expect(handlers.routes.slice(-4)).toEqual(["GET media", "POST media", "GET media-job", "DELETE media-job"]);
    expect(handlersWith(undefined).routes).not.toContain("POST media");
  });

  test("without the option the media routes are 404, with one console.warn for the developer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = handlersWith(undefined);
    const first = await call(upload(), off);
    const second = await call(getJob("j1"), off);
    expect([first.status, second.status]).toEqual([404, 404]);
    expect(first.body.error.code).toBe("not_found");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/media/);
  });

  test("a method a route doesn't take is 405 with every method it does take in Allow", async () => {
    const put = await call(new Request(url("media", field), { method: "PUT", headers: baseHeaders }));
    expect(put.status).toBe(405);
    expect(put.response.headers.get("Allow")).toBe("GET, POST");
    const post = await call(
      new Request(url("media-job", { ...field, job: "j" }), { method: "POST", headers: baseHeaders }),
    );
    expect(post.response.headers.get("Allow")).toBe("GET, DELETE");
  });

  test("media routes need the X-Requested-With header", async () => {
    const { status, body } = await call(new Request(url("media", { key: field.key, id: "m1" })));
    expect(status).toBe(403);
    expect(body.error.code).toBe("forbidden");
  });
});

describe("POST media", () => {
  test("a store that answers ready gives 201 with the id and render, gated by canEdit on the stored row", async () => {
    const { status, body, response } = await call(upload());
    expect(status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      media: { id: "m1", render: { kind: "image", src: "/media/m1", width: 2, height: 1, filename: "dot.png" } },
    });
    expect(editCalls).toEqual([{ type: "note", key: "notes/first" }]);
  });

  test("fires no onChange: nothing in content changed", async () => {
    await call(upload());
    expect(events).toEqual([]);
  });

  test("a store that answers processing gives 202 with the job and retryAfterMs", async () => {
    media.mode.process = "async";
    media.mode.retryAfterMs = 1500;
    const { status, body } = await call(upload());
    expect(status).toBe(202);
    expect(body).toEqual({ job: expect.any(String), retryAfterMs: 1500 });
  });

  test("passes the decoded filename, the bare type and the declared size to accept and upload", async () => {
    const { store, seen } = spyStore();
    const spied = handlersWith(store);
    const name = encodeURIComponent("café 1.png");
    const { status } = await call(
      upload(SAMPLE_PNG, { headers: { "X-Upload-Filename": name, "Content-Type": "Image/PNG; charset=binary" } }),
      spied,
    );
    expect(status).toBe(201);
    const expected = { filename: "café 1.png", type: "image/png", size: SAMPLE_PNG.byteLength };
    expect(seen.accepted).toEqual(expected);
    expect(seen.file).toEqual(expected);
    expect(seen.bytes).toBe(SAMPLE_PNG.byteLength);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  test("with no Content-Length the size is null and the counter enforces the limit", async () => {
    const { store, seen } = spyStore();
    const spied = handlersWith(store);
    expect((await call(upload(zeros(MAX_BYTES), { length: null }), spied)).status).toBe(201);
    expect(seen.file?.size).toBeNull();
    const over = await call(upload(zeros(MAX_BYTES + 1), { length: null }), spied);
    expect(over.status).toBe(413);
    expect(over.body.error).toMatchObject({ code: "too_large", limit: MAX_BYTES });
  });

  test("a file at the limit goes through", async () => {
    const { store } = spyStore();
    expect((await call(upload(new Uint8Array(MAX_BYTES)), handlersWith(store))).status).toBe(201);
  });

  test("a declared length past maxBytes is 413 before accept, upload or the body", async () => {
    const { store, seen } = spyStore();
    const watched = watchedStream(SAMPLE_PNG);
    const { status, body } = await call(upload(watched.stream, { length: MAX_BYTES + 1 }), handlersWith(store));
    expect(status).toBe(413);
    expect(body.error).toMatchObject({ code: "too_large", limit: MAX_BYTES });
    expect(seen.accepted).toBeUndefined();
    expect(seen.file).toBeUndefined();
    expect(watched.seen.pulled).toBe(false);
  });

  test("a refusal from accept answers before the body is read: unsupported is 415", async () => {
    const { store, seen } = spyStore({
      accept: () => {
        throw new MediaRefusal("unsupported", "Use a JPEG or PNG");
      },
    });
    const watched = watchedStream(SAMPLE_PNG);
    const { status, body } = await call(upload(watched.stream, { length: SAMPLE_PNG.byteLength }), handlersWith(store));
    expect(status).toBe(415);
    expect(body.error).toEqual({ code: "unsupported", message: "Use a JPEG or PNG" });
    expect(seen.file).toBeUndefined();
    expect(watched.seen.pulled).toBe(false);
  });

  test("a body longer than its Content-Length is refused and nothing is stored", async () => {
    const { status, body } = await call(upload(zeros(500), { length: 10 }));
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(media.count()).toBe(0);
  });

  test("the counter's verdict wins over a store that swallows the stream error", async () => {
    const { store } = spyStore({
      upload: async (body) => {
        await new Response(body).arrayBuffer().catch(() => undefined);
        return {
          status: "ready",
          media: { id: "m_bad", render: { kind: "image", src: "/m/bad", width: 1, height: 1 }, variants: null },
        };
      },
    });
    const { status } = await call(upload(zeros(MAX_BYTES + 1), { length: null }), handlersWith(store));
    expect(status).toBe(413);
  });

  test("the signal aborts when the counter cuts the body off", async () => {
    const { store, seen } = spyStore({
      upload: async (body, _file, _field, context) => {
        seen.signal = context.signal;
        await new Response(body).arrayBuffer().catch(() => undefined);
        throw new Error("read failed");
      },
    });
    await call(upload(zeros(MAX_BYTES + 1), { length: null }), handlersWith(store));
    expect(seen.signal?.aborted).toBe(true);
  });

  test("busy is 503 with Retry-After in whole seconds", async () => {
    media.mode.busy = 1;
    media.mode.retryAfterMs = 19_200;
    const { status, body, response } = await call(upload());
    expect(status).toBe(503);
    expect(body.error.code).toBe("busy");
    expect(response.headers.get("Retry-After")).toBe("20");
  });

  test("busy without retryAfterMs still carries a Retry-After", async () => {
    const { store } = spyStore({
      upload: async () => {
        throw new MediaRefusal("busy", "Busy");
      },
    });
    const { response } = await call(upload(), handlersWith(store));
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  test("an invalid refusal is 400 bad_request with the store's message", async () => {
    const { store } = spyStore({
      upload: async () => {
        throw new MediaRefusal("invalid", "the image is empty");
      },
    });
    const { status, body } = await call(upload(), handlersWith(store));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: "bad_request", message: "the image is empty" });
  });

  test("a too_large refusal from the store is 413 with its limit", async () => {
    const { store } = spyStore({
      upload: async () => {
        throw new MediaRefusal("too_large", "Over 500 bytes", { limit: 500 });
      },
    });
    const { status, body } = await call(upload(), handlersWith(store));
    expect(status).toBe(413);
    expect(body.error).toEqual({ code: "too_large", message: "Over 500 bytes", limit: 500 });
  });

  test("an unexpected store error is 500 internal and its message does not leak", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store } = spyStore({
      upload: async () => {
        throw new Error("disk /var/secret full");
      },
    });
    const { status, text } = await call(upload(), handlersWith(store));
    expect(status).toBe(500);
    expect(text).not.toMatch(/secret/);
  });

  test("a missing or undecodable X-Upload-Filename is 400 bad_request", async () => {
    const missing = await call(upload(SAMPLE_PNG, { headers: { "X-Upload-Filename": "" } }));
    expect(missing.status).toBe(400);
    const malformed = await call(upload(SAMPLE_PNG, { headers: { "X-Upload-Filename": "%E0%A4%A" } }));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("bad_request");
    expect(media.count()).toBe(0);
  });

  test("a missing key or path is 400", async () => {
    expect((await call(upload(SAMPLE_PNG, { query: { key: field.key } }))).status).toBe(400);
    expect((await call(upload(SAMPLE_PNG, { query: { path: "hero" } }))).status).toBe(400);
  });

  test("a missing document is 404 not_found and nothing is stored", async () => {
    const { status, body } = await call(upload(SAMPLE_PNG, { query: { key: "notes/none", path: "hero" } }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(media.count()).toBe(0);
  });

  test("a denying canEdit is 403 with its reason and nothing is stored", async () => {
    editVerdict = () => ({ allowed: false, reason: "Not yours" });
    const { status, body } = await call(upload());
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "forbidden", message: "Not yours" });
    expect(media.count()).toBe(0);
  });
});

describe("variants never leave the server", () => {
  const leaky: MediaStore = {
    upload: async (body) => {
      await body.cancel();
      return { status: "processing", job: "j_leak" };
    },
    job: async () => ({
      status: "ready",
      media: {
        id: "m_leak",
        render: { kind: "image", src: "/m/leak", width: 3, height: 2, secret: "s3://bucket/raw" } as never,
        variants: { bucketKey: "s3://bucket/raw" },
      },
    }),
    resolve: async (ids) =>
      new Map(
        ids.map((id) => [
          id,
          {
            id,
            render: { kind: "image", src: `/m/${id}`, width: 3, height: 2, srcset: "/m/a 1x", secret: "raw" } as never,
            variants: { bucketKey: "s3://bucket/raw" },
          },
        ]),
      ),
  };

  test("not from POST media, GET media-job or GET media, nor any extra render key", async () => {
    const on = handlersWith(leaky);
    const texts = [
      (await call(upload(), on)).text,
      (await call(getJob("j_leak"), on)).text,
      (await call(getMedia(["a"]), on)).text,
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/bucket|variants|secret|raw"/);
    }
    expect((await call(getMedia(["a"]), on)).body).toEqual({
      media: { a: { kind: "image", src: "/m/a", width: 3, height: 2, srcset: "/m/a 1x" } },
    });
  });
});

describe("GET media-job", () => {
  const startJob = async (readyAfterPolls = 2) => {
    media.mode.process = "async";
    media.mode.readyAfterPolls = readyAfterPolls;
    return (await call(upload())).body.job as string;
  };

  test("answers processing with progress, then ready with the media", async () => {
    const job = await startJob(2);
    expect((await call(getJob(job))).body).toEqual({ status: "processing", progress: 0.5 });
    const ready = await call(getJob(job));
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      status: "ready",
      media: { id: expect.any(String), render: expect.objectContaining({ src: expect.any(String) }) },
    });
  });

  test("answers failed with the reason and message", async () => {
    media.mode.fail = "the image is too tall";
    const job = await startJob(1);
    expect((await call(getJob(job))).body).toEqual({
      status: "failed",
      reason: "the image is too tall",
      message: expect.any(String),
    });
  });

  test("an unknown job, or another field's, is 404 job_not_found", async () => {
    const job = await startJob();
    const unknown = await call(getJob("j_none"));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("job_not_found");
    expect((await call(getJob(job, { key: field.key, path: "other" }))).body.error.code).toBe("job_not_found");
  });

  test("a store without job() answers job_not_found", async () => {
    const { store } = spyStore();
    expect((await call(getJob("j1"), handlersWith(store))).body.error.code).toBe("job_not_found");
  });

  test("a missing document is not_found, not job_not_found", async () => {
    const { body } = await call(getJob("j1", { key: "notes/none", path: "hero" }));
    expect(body.error.code).toBe("not_found");
  });

  test("a denying canEdit is 403", async () => {
    const job = await startJob();
    editVerdict = () => ({ allowed: false, reason: "Access lost" });
    expect((await call(getJob(job))).status).toBe(403);
  });

  test("a missing job parameter is 400", async () => {
    expect((await call(new Request(url("media-job", field), { headers: baseHeaders }))).status).toBe(400);
  });
});

describe("DELETE media-job", () => {
  test("cancels the job and answers 204 with no body", async () => {
    media.mode.process = "async";
    const job = (await call(upload())).body.job as string;
    const { status, text } = await call(deleteJob(job));
    expect(status).toBe(204);
    expect(text).toBe("");
    expect((await call(getJob(job))).body.error.code).toBe("job_not_found");
  });

  test("a store without cancelJob answers 204: nothing to cancel", async () => {
    const { store } = spyStore();
    expect((await call(deleteJob("j1"), handlersWith(store))).status).toBe(204);
  });

  test("a denying canEdit is 403 and the job keeps running", async () => {
    media.mode.process = "async";
    const job = (await call(upload())).body.job as string;
    editVerdict = () => ({ allowed: false, reason: "No" });
    expect((await call(deleteJob(job))).status).toBe(403);
    editVerdict = () => ({ allowed: true });
    expect((await call(getJob(job))).status).toBe(200);
  });
});

describe("GET media", () => {
  test("answers the render of each known id, leaving unknown ids out", async () => {
    const id = (await call(upload())).body.media.id as string;
    const { status, body } = await call(getMedia([id, "m_none"]));
    expect(status).toBe(200);
    expect(body).toEqual({
      media: { [id]: { kind: "image", src: `/media/${id}`, width: 2, height: 1, filename: "dot.png" } },
    });
    expect(editCalls.at(-1)).toEqual({ type: "note", key: "notes/first" });
  });

  test("takes repeated id params, not a comma list", async () => {
    const resolve = vi.fn(async (ids: readonly string[]) => {
      void ids;
      return new Map();
    });
    const { store } = spyStore({ resolve });
    await call(getMedia(["a,b", "c", "c"]), handlersWith(store));
    expect(resolve).toHaveBeenCalledWith(["a,b", "c"]);
  });

  test("no ids answers an empty map without asking the store", async () => {
    const resolve = vi.fn(async () => new Map());
    const { store } = spyStore({ resolve });
    expect((await call(getMedia([]), handlersWith(store))).body).toEqual({ media: {} });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("more than 100 distinct ids is 400", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `m${index}`);
    expect((await call(getMedia(ids))).status).toBe(400);
    expect((await call(getMedia([...ids.slice(0, 100), "m0"]))).status).toBe(200);
  });

  test("an id named __proto__ is an ordinary key", async () => {
    const { store } = spyStore({
      resolve: async (ids) =>
        new Map(
          ids.map((id) => [id, { id, render: { kind: "image", src: "/x", width: 1, height: 1 }, variants: null }]),
        ),
    });
    const { text } = await call(getMedia(["__proto__"]), handlersWith(store));
    expect(Object.keys(JSON.parse(text).media)).toEqual(["__proto__"]);
  });

  test("an id the store answers but nobody asked for is left out", async () => {
    const { store } = spyStore({
      resolve: async () =>
        new Map([
          ["other", { id: "other", render: { kind: "image", src: "/x", width: 1, height: 1 }, variants: null }],
        ]),
    });
    expect((await call(getMedia(["a"]), handlersWith(store))).body).toEqual({ media: {} });
  });

  test("needs a key, and canEdit on it", async () => {
    expect((await call(new Request(url("media", { id: "a" }), { headers: baseHeaders }))).status).toBe(400);
    editVerdict = () => ({ allowed: false, reason: "No" });
    expect((await call(getMedia(["a"]))).status).toBe(403);
    expect((await call(getMedia(["a"], "notes/none"))).status).toBe(404);
  });
});
