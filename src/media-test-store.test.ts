import { describe, expect, test } from "vitest";
import { runMediaStoreContract } from "./contract.ts";
import { createTestMediaStore, SAMPLE_PNG, type TestMediaStore } from "./media-test-store.ts";
import { MediaRefusal } from "./types.ts";

const sample = { bytes: SAMPLE_PNG, type: "image/png", filename: "dot.png" };
const MAX_BYTES = 4096;

let current: TestMediaStore;
const make = (process: "sync" | "async") => () => {
  current = createTestMediaStore({ MediaRefusal, maxBytes: MAX_BYTES });
  current.mode.process = process;
  return current;
};

runMediaStoreContract("test store, sync", make("sync"), { sample, maxBytes: MAX_BYTES, count: () => current.count() });
runMediaStoreContract("test store, async", make("async"), {
  sample,
  processesAsync: true,
  maxBytes: MAX_BYTES,
  count: () => current.count(),
  pollIntervalMs: 0,
});

const field = { key: "pages/home", path: "hero" };
const live = () => ({ signal: new AbortController().signal });
const body = (bytes: Uint8Array = SAMPLE_PNG) => new Blob([bytes as BlobPart]).stream();
const file = { filename: "dot.png", type: "image/png", size: SAMPLE_PNG.byteLength };

describe("test media store switches", () => {
  test("sync: answers ready with the PNG's size, a URL under mediaBase and the bytes to serve", async () => {
    const store = createTestMediaStore({ MediaRefusal, mediaBase: "/files/" });
    const answer = await store.upload(body(), file, field, live());
    if (answer.status !== "ready") throw new Error("expected ready");
    expect(answer.media.render).toEqual({
      kind: "image",
      src: `/files/${answer.media.id}`,
      width: 2,
      height: 1,
      filename: "dot.png",
    });
    expect(answer.media.variants).toEqual({ original: { type: "image/png", bytes: SAMPLE_PNG.byteLength } });
    expect(store.file(answer.media.id)).toEqual({ bytes: SAMPLE_PNG, type: "image/png" });
    expect(store.count()).toBe(1);
  });

  test("async: processing with retryAfterMs, then ready after readyAfterPolls polls with progress", async () => {
    const store = createTestMediaStore({ MediaRefusal });
    store.mode.process = "async";
    store.mode.readyAfterPolls = 3;
    store.mode.retryAfterMs = 500;
    const answer = await store.upload(body(), file, field, live());
    if (answer.status !== "processing") throw new Error("expected processing");
    expect(answer.retryAfterMs).toBe(500);
    expect(store.count()).toBe(0);
    expect(await store.job(answer.job, field)).toEqual({ status: "processing", progress: 1 / 3 });
    expect(await store.job(answer.job, field)).toEqual({ status: "processing", progress: 2 / 3 });
    const ready = await store.job(answer.job, field);
    expect(ready?.status).toBe("ready");
    expect(store.count()).toBe(1);
  });

  test("fail: the job settles as failed with the reason", async () => {
    const store = createTestMediaStore({ MediaRefusal });
    store.mode.process = "async";
    store.mode.readyAfterPolls = 1;
    store.mode.fail = "the image is too tall";
    const answer = await store.upload(body(), file, field, live());
    if (answer.status !== "processing") throw new Error("expected processing");
    expect(await store.job(answer.job, field)).toEqual({
      status: "failed",
      reason: "the image is too tall",
      message: "The server couldn't process dot.png: the image is too tall.",
    });
    expect(store.count()).toBe(0);
  });

  test("busy: refuses that many uploads as busy with retryAfterMs, then takes the next", async () => {
    const store = createTestMediaStore({ MediaRefusal });
    store.mode.busy = 2;
    store.mode.retryAfterMs = 20_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await store.upload(body(), file, field, live()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MediaRefusal);
      expect(failure).toMatchObject({ code: "busy", detail: { retryAfterMs: 20_000 } });
    }
    expect((await store.upload(body(), file, field, live())).status).toBe("ready");
    expect(store.mode.busy).toBe(0);
  });

  test("accept refuses a declared size past maxBytes and a type that is not an image", async () => {
    const store = createTestMediaStore({ MediaRefusal, maxBytes: 10 });
    expect(() => store.accept?.(field, { ...file, size: 11 }, {})).toThrow(MediaRefusal);
    const refusedType = (type: string) => {
      try {
        store.accept(field, { ...file, type, size: 1 }, {});
      } catch (error) {
        return (error as MediaRefusal).code;
      }
      return "accepted";
    };
    expect(refusedType("application/pdf")).toBe("unsupported");
    expect(refusedType("image/svg+xml")).toBe("unsupported");
    expect(refusedType("IMAGE/PNG; charset=binary")).toBe("accepted");
    expect(() => store.accept?.(field, { ...file, size: 10 }, {})).not.toThrow();
    expect(() => store.accept?.(field, { ...file, type: "", size: null }, {})).not.toThrow();
  });

  test("an image with no declared type is stored with the type its bytes show", async () => {
    const store = createTestMediaStore({ MediaRefusal });
    const answer = await store.upload(body(), { ...file, type: "" }, field, live());
    if (answer.status !== "ready") throw new Error("expected ready");
    expect(store.file(answer.media.id)?.type).toBe("image/png");
  });

  test("a filename is reduced to its last segment, without control characters", async () => {
    const store = createTestMediaStore({ MediaRefusal });
    const answer = await store.upload(body(), { ...file, filename: "a/b\\..\\c\u0007.png" }, field, live());
    if (answer.status !== "ready") throw new Error("expected ready");
    expect(answer.media.render.filename).toBe("c.png");
  });
});
