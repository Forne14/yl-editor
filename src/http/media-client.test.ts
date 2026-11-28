import { beforeEach, describe, expect, test } from "vitest";
import { contractRegistry } from "../contract.ts";
import { createTestMediaStore, SAMPLE_PNG, type TestMediaStore } from "../media-test-store.ts";
import { createSqliteContentStore } from "../sqlite-store.ts";
import { makeTestDb } from "../test-support.ts";
import { MediaRefusal, type AccessVerdict } from "../types.ts";
import { ContentRequestError, createContentClient, type ContentClient, type UploadXhr } from "./client.ts";
import { createContentHandlers, type ContentHandlers } from "./handlers.ts";
import { isErrorEnvelope, parseRetryAfter } from "./wire-types.ts";

type Listener = (event: { loaded: number; total: number; lengthComputable: boolean }) => void;

/** An XMLHttpRequest stand-in. A test drives it by hand, or `answerWith` routes the request to the handlers. */
class FakeXhr implements UploadXhr {
  static made: FakeXhr[] = [];
  static answerWith: ((request: Request) => Promise<Response>) | null = null;

  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: Blob | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  responseHeaders: Record<string, string> = {};
  private listeners = new Map<string, Listener[]>();
  private uploadListeners = new Map<string, Listener[]>();
  upload = {
    addEventListener: (type: string, listener: Listener) => {
      this.uploadListeners.set(type, [...(this.uploadListeners.get(type) ?? []), listener]);
    },
  };

  constructor() {
    FakeXhr.made.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  send(body: Blob) {
    this.body = body;
    const answer = FakeXhr.answerWith;
    if (!answer) return;
    void (async () => {
      const request = new Request(new URL(this.url, "http://host"), {
        method: this.method,
        headers: { ...this.headers, "Content-Length": String(body.size) },
        body: body,
      });
      this.progress(body.size, body.size);
      this.sent();
      const response = await answer(request);
      this.respond(response.status, await response.text(), Object.fromEntries(response.headers));
    })();
  }
  abort() {
    this.aborted = true;
    this.fire(this.listeners, "abort");
  }

  progress(loaded: number, total: number | null) {
    this.fire(this.uploadListeners, "progress", { loaded, total: total ?? 0, lengthComputable: total !== null });
  }
  sent() {
    this.fire(this.uploadListeners, "load");
  }
  respond(status: number, text: string, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = text;
    this.responseHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.fire(this.listeners, "load");
  }
  fail() {
    this.fire(this.listeners, "error");
  }

  private fire(map: Map<string, Listener[]>, type: string, event = { loaded: 0, total: 0, lengthComputable: false }) {
    for (const listener of map.get(type) ?? []) listener(event);
  }
}

let media: TestMediaStore;
let handlers: ContentHandlers;
let client: ContentClient;
let editVerdict: AccessVerdict;
let fetched: Request[];

const field = { key: "notes/first", path: "hero" };
const png = () => new File([SAMPLE_PNG as BlobPart], "dot é.png", { type: "image/png" });
const lastXhr = () => {
  const xhr = FakeXhr.made.at(-1);
  if (!xhr) throw new Error("no XHR made");
  return xhr;
};

beforeEach(async () => {
  const content = createSqliteContentStore(makeTestDb(), contractRegistry);
  await content.create("note", "first", { title: "A", tags: [] });
  media = createTestMediaStore({ MediaRefusal, maxBytes: 10_000 });
  editVerdict = { allowed: true };
  handlers = createContentHandlers({
    store: content,
    registry: contractRegistry,
    access: { canEdit: () => editVerdict, canPublish: () => ({ allowed: true }) },
    locals: () => null,
    media: { store: media, maxBytes: 10_000 },
  });
  FakeXhr.made = [];
  FakeXhr.answerWith = (request) => handlers.handle(request);
  fetched = [];
  client = createContentClient({
    base: "http://host/api/content",
    fetch: (input, init) => {
      const request = new Request(input, init);
      fetched.push(request);
      return handlers.handle(request);
    },
    xhr: () => new FakeXhr(),
  });
});

describe("parseRetryAfter", () => {
  test("reads delay-seconds and HTTP dates, never negative", () => {
    const now = Date.parse("2026-11-28T10:00:00Z");
    expect(parseRetryAfter("20", now)).toBe(20_000);
    expect(parseRetryAfter(" 0 ", now)).toBe(0);
    expect(parseRetryAfter("Sat, 28 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Sat, 28 Nov 2026 09:59:00 GMT", now)).toBe(0);
  });

  test("absent or unreadable is undefined", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter("-5", 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
  });
});

describe("isErrorEnvelope with media fields", () => {
  test("takes a numeric limit and the new codes, refuses a limit that is not a number", () => {
    expect(isErrorEnvelope({ error: { code: "too_large", message: "Big", limit: 10 } })).toBe(true);
    expect(isErrorEnvelope({ error: { code: "job_not_found", message: "No job" } })).toBe(true);
    expect(isErrorEnvelope({ error: { code: "too_large", message: "Big", limit: "10" } })).toBe(false);
  });
});

describe("uploadMedia", () => {
  test("sends the file itself as the body, with its type, encoded name and the CSRF header", async () => {
    const file = png();
    const result = await client.uploadMedia(field, file);
    const xhr = lastXhr();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("http://host/api/content/media?key=notes%2Ffirst&path=hero");
    expect(xhr.body).toBe(file);
    expect(xhr.headers).toEqual({
      "X-Requested-With": "yl-editor",
      Accept: "application/json",
      "Content-Type": "image/png",
      "X-Upload-Filename": encodeURIComponent("dot é.png"),
    });
    expect(result).toEqual({
      status: "ready",
      media: { id: "m1", render: { kind: "image", src: "/media/m1", width: 2, height: 1, filename: "dot é.png" } },
    });
  });

  test("a file with no type is sent without a Content-Type", async () => {
    const pending = client.uploadMedia(field, new File([SAMPLE_PNG as BlobPart], "x.png"));
    await pending;
    expect(lastXhr().headers["Content-Type"]).toBeUndefined();
  });

  test("a 202 answers processing with the job and retryAfterMs", async () => {
    media.mode.process = "async";
    media.mode.retryAfterMs = 1500;
    expect(await client.uploadMedia(field, png())).toEqual({
      status: "processing",
      job: expect.any(String),
      retryAfterMs: 1500,
    });
  });

  test("a Retry-After header on the 202 wins over the body's retryAfterMs", async () => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().respond(202, JSON.stringify({ job: "j1", retryAfterMs: 1500 }), { "Retry-After": "7" });
    expect(await pending).toEqual({ status: "processing", job: "j1", retryAfterMs: 7000 });
  });

  test("reports upload progress, null total when not computable, and when the bytes are all sent", async () => {
    FakeXhr.answerWith = null;
    const progress: { loaded: number; total: number | null }[] = [];
    let sent = 0;
    const pending = client.uploadMedia(field, png(), {
      onProgress: (step) => progress.push(step),
      onSent: () => sent++,
    });
    const xhr = lastXhr();
    xhr.progress(10, 71);
    xhr.progress(20, null);
    xhr.sent();
    xhr.respond(
      201,
      JSON.stringify({ media: { id: "m9", render: { kind: "image", src: "/m9", width: 1, height: 1 } } }),
    );
    await pending;
    expect(progress).toEqual([
      { loaded: 10, total: 71 },
      { loaded: 20, total: null },
    ]);
    expect(sent).toBe(1);
  });

  test("an abort aborts the XHR and rejects with an AbortError", async () => {
    FakeXhr.answerWith = null;
    const controller = new AbortController();
    const pending = client.uploadMedia(field, png(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(lastXhr().aborted).toBe(true);
  });

  test("an already aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client.uploadMedia(field, png(), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(FakeXhr.made).toEqual([]);
  });

  test("no progress or answer after an abort", async () => {
    FakeXhr.answerWith = null;
    const controller = new AbortController();
    const progress: unknown[] = [];
    const pending = client.uploadMedia(field, png(), {
      signal: controller.signal,
      onProgress: (p) => progress.push(p),
    });
    controller.abort();
    lastXhr().progress(5, 71);
    lastXhr().respond(201, "{}");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).toEqual([]);
  });

  test("a network error rejects with a TypeError, as fetch does", async () => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().fail();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  test("an abort the client didn't ask for is a network error", async () => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().abort();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  test("an error envelope becomes a ContentRequestError with its code, limit and Retry-After", async () => {
    media.mode.busy = 1;
    media.mode.retryAfterMs = 20_000;
    const busy = await client.uploadMedia(field, png()).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(ContentRequestError);
    expect(busy).toMatchObject({ status: 503, code: "busy", retryAfterMs: 20_000 });

    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().respond(413, JSON.stringify({ error: { code: "too_large", message: "Big", limit: 40_000_000 } }));
    expect(await pending.catch((error: unknown) => error)).toMatchObject({ code: "too_large", limit: 40_000_000 });
  });

  test.each([
    [413, "too_large"],
    [415, "unsupported"],
    [503, "busy"],
    [502, "internal"],
  ])("a %i without our envelope (a proxy's page) maps to %s by status", async (status, code) => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().respond(status, "<html>Request Entity Too Large</html>", { "Retry-After": "3" });
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentRequestError);
    expect(failure).toMatchObject({ status, code });
    if (code === "busy") expect(failure).toMatchObject({ retryAfterMs: 3000 });
  });

  test.each([
    ["not JSON", "<html>"],
    ["no media", JSON.stringify({})],
    ["a render without src", JSON.stringify({ media: { id: "m", render: { kind: "image", width: 1, height: 1 } } })],
    ["a zero width", JSON.stringify({ media: { id: "m", render: { kind: "image", src: "/m", width: 0, height: 1 } } })],
    [
      "a fractional height",
      JSON.stringify({ media: { id: "m", render: { kind: "image", src: "/m", width: 2, height: 1.5 } } }),
    ],
    [
      "an unknown kind",
      JSON.stringify({ media: { id: "m", render: { kind: "audio", src: "/m", width: 1, height: 1 } } }),
    ],
    [
      "bad sources",
      JSON.stringify({ media: { id: "m", render: { kind: "image", src: "/m", width: 1, height: 1, sources: [{}] } } }),
    ],
  ])("an unreadable 201 (%s) is a ContentRequestError internal", async (_label, text) => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().respond(201, text);
    expect(await pending.catch((error: unknown) => error)).toMatchObject({ code: "internal" });
  });

  test("a 202 without a job is unreadable", async () => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    lastXhr().respond(202, JSON.stringify({ retryAfterMs: 5 }));
    expect(await pending.catch((error: unknown) => error)).toMatchObject({ code: "internal" });
  });

  test("keeps only the render's own keys", async () => {
    FakeXhr.answerWith = null;
    const pending = client.uploadMedia(field, png());
    const render = { kind: "image", src: "/m", width: 1, height: 1, srcset: "/m 1x", extra: "x" };
    lastXhr().respond(201, JSON.stringify({ media: { id: "m", render } }));
    expect(await pending).toEqual({
      status: "ready",
      media: { id: "m", render: { kind: "image", src: "/m", width: 1, height: 1, srcset: "/m 1x" } },
    });
  });
});

describe("mediaJob", () => {
  const startJob = async (readyAfterPolls = 2) => {
    media.mode.process = "async";
    media.mode.readyAfterPolls = readyAfterPolls;
    const answer = await client.uploadMedia(field, png());
    if (answer.status !== "processing") throw new Error("expected processing");
    return answer.job;
  };

  test("reads processing, then ready", async () => {
    const job = await startJob(2);
    expect(await client.mediaJob(field, job)).toEqual({ status: "processing", progress: 0.5 });
    const ready = await client.mediaJob(field, job);
    expect(ready).toMatchObject({ status: "ready", media: { id: expect.any(String) } });
    expect(fetched.at(-1)?.url).toBe(`http://host/api/content/media-job?key=notes%2Ffirst&path=hero&job=${job}`);
  });

  test("reads failed with its reason and message", async () => {
    media.mode.fail = "too tall";
    const job = await startJob(1);
    expect(await client.mediaJob(field, job)).toEqual({
      status: "failed",
      reason: "too tall",
      message: expect.any(String),
    });
  });

  test("an unknown job is a ContentRequestError job_not_found", async () => {
    await expect(client.mediaJob(field, "j_none")).rejects.toMatchObject({ status: 404, code: "job_not_found" });
  });

  test("clamps progress to 0..1, drops a non-number, and lets Retry-After win", async () => {
    const answers: { body: unknown; headers: Record<string, string> }[] = [
      { body: { status: "processing", progress: 1.7 }, headers: {} },
      { body: { status: "processing", progress: -2, retryAfterMs: 900 }, headers: {} },
      { body: { status: "processing", progress: "half", retryAfterMs: 900 }, headers: { "Retry-After": "4" } },
    ];
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => {
        const next = answers.shift();
        return new Response(JSON.stringify(next?.body), { status: 200, headers: next?.headers });
      },
    });
    expect(await scripted.mediaJob(field, "j")).toEqual({ status: "processing", progress: 1 });
    expect(await scripted.mediaJob(field, "j")).toEqual({ status: "processing", progress: 0, retryAfterMs: 900 });
    expect(await scripted.mediaJob(field, "j")).toEqual({ status: "processing", retryAfterMs: 4000 });
  });

  test("an unreadable answer is a ContentRequestError internal", async () => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => new Response(JSON.stringify({ status: "done" }), { status: 200 }),
    });
    await expect(scripted.mediaJob(field, "j")).rejects.toMatchObject({ code: "internal" });
  });

  test("an infinite progress is left out, as the server does", async () => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => new Response('{"status":"processing","progress":1e999}', { status: 200 }),
    });
    expect(await scripted.mediaJob(field, "j")).toEqual({ status: "processing" });
  });

  test("a Retry-After of 0 counts as absent: the body's wait applies, else none", async () => {
    const answers = [
      { body: { status: "processing", retryAfterMs: 10_000 }, status: 200 },
      { body: { error: { code: "busy", message: "Busy" } }, status: 503 },
    ];
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => {
        const next = answers.shift();
        return new Response(JSON.stringify(next?.body), { status: next?.status, headers: { "Retry-After": "0" } });
      },
    });
    expect(await scripted.mediaJob(field, "j")).toEqual({ status: "processing", retryAfterMs: 10_000 });
    const busy = await scripted.mediaJob(field, "j").catch((error: unknown) => error);
    expect(busy).toMatchObject({ code: "busy" });
    expect((busy as ContentRequestError).retryAfterMs).toBeUndefined();
  });

  test.each([0, -1])("an envelope limit of %s is left out", async (limit) => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: "too_large", message: "Big", limit } }), { status: 413 }),
    });
    const failure = await scripted.mediaJob(field, "j").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "too_large" });
    expect((failure as ContentRequestError).limit).toBeUndefined();
  });

  test("an envelope-less 503 is busy with its Retry-After", async () => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => new Response("Service Unavailable", { status: 503, headers: { "Retry-After": "12" } }),
    });
    await expect(scripted.mediaJob(field, "j")).rejects.toMatchObject({ code: "busy", retryAfterMs: 12_000 });
  });

  test("passes the signal to fetch", async () => {
    let seen: AbortSignal | undefined;
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async (_input, init) => {
        seen = init?.signal ?? undefined;
        return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
      },
    });
    const controller = new AbortController();
    await scripted.mediaJob(field, "j", { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("cancelMediaJob", () => {
  test("sends DELETE and resolves on 204", async () => {
    media.mode.process = "async";
    const answer = await client.uploadMedia(field, png());
    if (answer.status !== "processing") throw new Error("expected processing");
    await expect(client.cancelMediaJob(field, answer.job)).resolves.toBeUndefined();
    expect(fetched.at(-1)?.method).toBe("DELETE");
    await expect(client.mediaJob(field, answer.job)).rejects.toMatchObject({ code: "job_not_found" });
  });

  test("a denial rejects", async () => {
    editVerdict = { allowed: false, reason: "No" };
    await expect(client.cancelMediaJob(field, "j")).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("media", () => {
  test("resolves ids to renders as a Map, unknown ids left out, with repeated id params", async () => {
    const uploaded = await client.uploadMedia(field, png());
    if (uploaded.status !== "ready") throw new Error("expected ready");
    const renders = await client.media("notes/first", [uploaded.media.id, "m_none", uploaded.media.id]);
    expect([...renders.entries()]).toEqual([[uploaded.media.id, uploaded.media.render]]);
    expect(new URL(fetched.at(-1)?.url ?? "").searchParams.getAll("id")).toEqual([uploaded.media.id, "m_none"]);
  });

  test("no ids is an empty Map without a request", async () => {
    expect((await client.media("notes/first", [])).size).toBe(0);
    expect(fetched).toEqual([]);
  });

  test("more than 100 ids go in several requests", async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `m${index}`);
    await client.media("notes/first", ids);
    expect(fetched.map((request) => new URL(request.url).searchParams.getAll("id").length)).toEqual([100, 100, 5]);
  });

  test("an id named __proto__ comes back as an ordinary entry", async () => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () =>
        new Response('{"media":{"__proto__":{"kind":"image","src":"/p","width":1,"height":1}}}', { status: 200 }),
    });
    const renders = await scripted.media("notes/first", ["__proto__"]);
    expect(renders.get("__proto__")).toEqual({ kind: "image", src: "/p", width: 1, height: 1 });
  });

  test("an unreadable render is left out; the readable ones in the same batch are kept", async () => {
    const good = { kind: "image", src: "/b", width: 1, height: 1 };
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () =>
        new Response(JSON.stringify({ media: { a: { kind: "image", src: 4 }, b: good, c: { ...good, width: 0.5 } } }), {
          status: 200,
        }),
    });
    const renders = await scripted.media("notes/first", ["a", "b", "c"]);
    expect([...renders.entries()]).toEqual([["b", good]]);
  });

  test("a body that is not a media map is still a ContentRequestError internal", async () => {
    const scripted = createContentClient({
      base: "http://host/api/content",
      fetch: async () => new Response(JSON.stringify({ media: "nope" }), { status: 200 }),
    });
    await expect(scripted.media("notes/first", ["a"])).rejects.toMatchObject({ code: "internal" });
  });
});
