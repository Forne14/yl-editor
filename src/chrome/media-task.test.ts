import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContentRequestError, type MediaUploadOptions } from "../http/client.ts";
import type { MediaJobResponse, MediaUploadResult, WireMedia } from "../http/wire-types.ts";
import {
  startMediaTask,
  type MediaTask,
  type MediaTaskEnvironment,
  type MediaTaskOptions,
  type MediaTaskState,
} from "./media-task.ts";

const field = { key: "pages/home", path: "hero" };
const file = new File([new Uint8Array(100) as BlobPart], "buns.jpg", { type: "image/jpeg" });
const media: WireMedia = { id: "m1", render: { kind: "image", src: "/m/1", width: 2, height: 1 } };

interface PendingUpload {
  options: MediaUploadOptions;
  resolve: (result: MediaUploadResult) => void;
  reject: (error: unknown) => void;
}
interface PendingPoll {
  at: number;
  job: string;
  signal: AbortSignal | undefined;
  resolve: (answer: MediaJobResponse) => void;
  reject: (error: unknown) => void;
}

/** A client whose answers each test gives by hand, recording every request with its time. */
function scriptedClient() {
  const uploads: PendingUpload[] = [];
  const polls: PendingPoll[] = [];
  const cancels: string[] = [];
  /** When set, every poll is answered at once with what it returns (or throws). */
  let responder: ((poll: PendingPoll, index: number) => MediaJobResponse) | null = null;
  const client: MediaTaskOptions["client"] = {
    uploadMedia: (_field, _file, options = {}) =>
      new Promise((resolve, reject) => {
        uploads.push({ options, resolve, reject });
      }),
    mediaJob: (_field, job, { signal } = {}) =>
      new Promise((resolve, reject) => {
        const poll = { at: Date.now(), job, signal, resolve, reject };
        polls.push(poll);
        if (!responder) return;
        try {
          resolve(responder(poll, polls.length - 1));
        } catch (error) {
          reject(error);
        }
      }),
    cancelMediaJob: async (_field, job) => {
      cancels.push(job);
    },
  };
  return {
    client,
    uploads,
    polls,
    cancels,
    respond: (next: typeof responder) => {
      responder = next;
    },
    lastUpload: () => {
      const upload = uploads.at(-1);
      if (!upload) throw new Error("no upload sent");
      return upload;
    },
    lastPoll: () => {
      const poll = polls.at(-1);
      if (!poll) throw new Error("no poll sent");
      return poll;
    },
  };
}

/** Fake visibility and network; time is vitest's fake clock. */
function fakeEnvironment() {
  const listeners = { visible: new Set<() => void>(), online: new Set<() => void>(), restore: new Set<() => void>() };
  const flags = { hidden: false, online: true };
  const subscribe = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const environment: MediaTaskEnvironment = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    isHidden: () => flags.hidden,
    isOnline: () => flags.online,
    onVisible: subscribe(listeners.visible),
    onOnline: subscribe(listeners.online),
    onRestore: subscribe(listeners.restore),
  };
  return {
    environment,
    flags,
    listeners,
    becomeVisible: () => {
      flags.hidden = false;
      for (const listener of [...listeners.visible]) listener();
    },
    comeOnline: () => {
      flags.online = true;
      for (const listener of [...listeners.online]) listener();
    },
    restoreFromCache: () => {
      for (const listener of [...listeners.restore]) listener();
    },
  };
}

let scripted: ReturnType<typeof scriptedClient>;
let env: ReturnType<typeof fakeEnvironment>;
let states: MediaTaskState[];
let task: MediaTask;

const start = (overrides: Partial<MediaTaskOptions> = {}) => {
  task = startMediaTask({
    client: scripted.client,
    field,
    file,
    environment: env.environment,
    onState: (state) => states.push(state),
    ...overrides,
  });
  // A test that never awaits done must not leave an unhandled rejection behind.
  task.done.catch(() => {});
  return task;
};

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const phase = () => task.state.phase;
const failure = () => (task.state.phase === "failed" ? task.state.failure : undefined);
const processing = (progress?: number): MediaJobResponse =>
  progress === undefined ? { status: "processing" } : { status: "processing", progress };
const requestError = (status: number, code: ContentRequestError["code"], details = {}) =>
  new ContentRequestError(status, code, `${code} message`, undefined, undefined, details);

/** Starts a task whose upload answers 202 with job "j1". */
async function startProcessing(retryAfterMs?: number, overrides: Partial<MediaTaskOptions> = {}) {
  start(overrides);
  scripted.lastUpload().resolve({ status: "processing", job: "j1", ...(retryAfterMs ? { retryAfterMs } : {}) });
  await flush();
}

/** Times of every poll sent, relative to `origin`. */
const pollTimes = (origin: number) => scripted.polls.map((poll) => poll.at - origin);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  scripted = scriptedClient();
  env = fakeEnvironment();
  states = [];
});

afterEach(() => {
  task?.abort();
  vi.useRealTimers();
});

describe("the send", () => {
  test("sends the file for the field, then ready resolves done", async () => {
    start();
    expect(phase()).toBe("uploading");
    expect(scripted.uploads).toHaveLength(1);
    scripted.lastUpload().resolve({ status: "ready", media });
    await expect(task.done).resolves.toEqual(media);
    expect(task.state).toEqual({ phase: "ready", media });
    expect(states.map((state) => state.phase)).toEqual(["uploading", "ready"]);
  });

  test("progress updates uploading, and every byte sent is finishing", async () => {
    start();
    expect(task.state).toEqual({ phase: "uploading", loaded: 0, total: 100 });
    scripted.lastUpload().options.onProgress?.({ loaded: 40, total: 100 });
    expect(task.state).toEqual({ phase: "uploading", loaded: 40, total: 100 });
    scripted.lastUpload().options.onProgress?.({ loaded: 60, total: null });
    expect(task.state).toEqual({ phase: "uploading", loaded: 60, total: null });
    scripted.lastUpload().options.onSent?.();
    expect(task.state).toEqual({ phase: "finishing" });
  });

  test("offline when a send would start: nothing is sent, it fails as a network error", async () => {
    env.flags.online = false;
    start();
    expect(scripted.uploads).toHaveLength(0);
    expect(failure()).toEqual({ kind: "network", stalled: false });
  });

  test.each([
    ["a TypeError", new TypeError("Network error"), { kind: "network", stalled: false }],
    [
      "413",
      requestError(413, "too_large", { limit: 40 }),
      { kind: "refused", code: "too_large", message: "too_large message", limit: 40 },
    ],
    ["415", requestError(415, "unsupported"), { kind: "refused", code: "unsupported", message: "unsupported message" }],
    ["400", requestError(400, "bad_request"), { kind: "refused", code: "invalid", message: "bad_request message" }],
    ["403", requestError(403, "forbidden"), { kind: "forbidden", message: "forbidden message" }],
    ["404", requestError(404, "not_found"), { kind: "document-gone" }],
    ["500", requestError(500, "internal"), { kind: "server" }],
    ["an unknown error", new Error("boom"), { kind: "server" }],
  ])("a send that fails with %s is failed with its kind", async (_label, error, expected) => {
    start();
    scripted.lastUpload().reject(error);
    await flush();
    expect(failure()).toEqual(expected);
  });

  test("retry() from failed sends the file again from the start", async () => {
    start();
    scripted.lastUpload().reject(new TypeError("Network error"));
    await flush();
    task.retry();
    expect(scripted.uploads).toHaveLength(2);
    expect(task.state).toEqual({ phase: "uploading", loaded: 0, total: 100 });
    scripted.lastUpload().resolve({ status: "ready", media });
    await expect(task.done).resolves.toEqual(media);
  });

  test("retry() does nothing unless failed", async () => {
    start();
    task.retry();
    expect(scripted.uploads).toHaveLength(1);
  });
});

describe("the stall timer", () => {
  test("does not run before the first progress event", async () => {
    start();
    await advance(5 * 60_000);
    expect(phase()).toBe("uploading");
  });

  test("60 s without progress after the first one aborts the send as a stalled network error", async () => {
    start();
    const upload = scripted.lastUpload();
    upload.options.onProgress?.({ loaded: 1, total: 100 });
    await advance(59_999);
    expect(phase()).toBe("uploading");
    await advance(1);
    expect(failure()).toEqual({ kind: "network", stalled: true });
    expect(upload.options.signal?.aborted).toBe(true);
  });

  test("each progress event restarts it", async () => {
    start();
    const { options } = scripted.lastUpload();
    options.onProgress?.({ loaded: 1, total: 100 });
    await advance(50_000);
    options.onProgress?.({ loaded: 2, total: 100 });
    await advance(50_000);
    expect(phase()).toBe("uploading");
    await advance(10_000);
    expect(failure()).toEqual({ kind: "network", stalled: true });
  });

  test("stops once every byte is sent: a late answer is never killed", async () => {
    start();
    const upload = scripted.lastUpload();
    upload.options.onProgress?.({ loaded: 100, total: 100 });
    upload.options.onSent?.();
    await advance(10 * 60_000);
    expect(phase()).toBe("finishing");
    upload.resolve({ status: "ready", media });
    await flush();
    expect(phase()).toBe("ready");
  });

  test("the stalled send's late answer is ignored", async () => {
    start();
    const upload = scripted.lastUpload();
    upload.options.onProgress?.({ loaded: 1, total: 100 });
    await advance(60_000);
    const epoch = task.epoch;
    upload.resolve({ status: "ready", media });
    upload.options.onProgress?.({ loaded: 50, total: 100 });
    await flush();
    expect(failure()).toEqual({ kind: "network", stalled: true });
    expect(task.epoch).toBe(epoch);
  });
});

describe("503 busy on the send", () => {
  test("waits its Retry-After, then sends again, showing busy meanwhile", async () => {
    start();
    scripted.lastUpload().reject(requestError(503, "busy", { retryAfterMs: 20_000 }));
    await flush();
    expect(task.state).toEqual({ phase: "busy", retryInMs: 20_000, resend: 1 });
    await advance(19_999);
    expect(scripted.uploads).toHaveLength(1);
    await advance(1);
    expect(scripted.uploads).toHaveLength(2);
    expect(phase()).toBe("uploading");
  });

  test.each([
    [200, 1000],
    [300_000, 60_000],
    [undefined, 5000],
  ])("a Retry-After of %s ms waits %i ms", async (retryAfterMs, wait) => {
    start();
    scripted.lastUpload().reject(requestError(503, "busy", retryAfterMs === undefined ? {} : { retryAfterMs }));
    await flush();
    expect(task.state).toMatchObject({ phase: "busy", retryInMs: wait });
    await advance(wait - 1);
    expect(scripted.uploads).toHaveLength(1);
    await advance(1);
    expect(scripted.uploads).toHaveLength(2);
  });

  const busyAgain = async () => {
    scripted.lastUpload().reject(requestError(503, "busy", { retryAfterMs: 1000 }));
    await flush();
    await advance(1000);
  };

  test("at most 3 automatic resends per task, then failed busy; retry() resets the count", async () => {
    start();
    for (let resend = 0; resend < 3; resend++) await busyAgain();
    expect(scripted.uploads).toHaveLength(4);
    scripted.lastUpload().reject(requestError(503, "busy", { retryAfterMs: 1000 }));
    await flush();
    expect(failure()).toEqual({ kind: "busy" });
    await advance(60_000);
    expect(scripted.uploads).toHaveLength(4);

    task.retry();
    expect(scripted.uploads).toHaveLength(5);
    for (let resend = 0; resend < 3; resend++) await busyAgain();
    expect(scripted.uploads).toHaveLength(8);
  });

  test("abort() during the wait cancels the countdown", async () => {
    start();
    scripted.lastUpload().reject(requestError(503, "busy", { retryAfterMs: 5000 }));
    await flush();
    task.abort();
    await advance(60_000);
    expect(scripted.uploads).toHaveLength(1);
  });
});

describe("the poll", () => {
  test("a 202 is processing, and polls at 1, 2, 4, 8 s, then every 15 s", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    expect(task.state).toEqual({ phase: "processing", job: "j1", progress: null });
    await advance(60_000);
    expect(pollTimes(0)).toEqual([1000, 3000, 7000, 15_000, 30_000, 45_000, 60_000]);
    expect(scripted.polls.every((poll) => poll.job === "j1")).toBe(true);
  });

  test("a job's progress makes the state determinate", async () => {
    scripted.respond(() => processing(0.4));
    await startProcessing();
    await advance(1000);
    expect(task.state).toEqual({ phase: "processing", job: "j1", progress: 0.4 });
  });

  test("retryAfterMs on the 202 sets the first wait, clamped to 1-60 s", async () => {
    scripted.respond(() => processing());
    await startProcessing(200);
    await advance(999);
    expect(scripted.polls).toHaveLength(0);
    await advance(1);
    expect(scripted.polls).toHaveLength(1);
  });

  test("a retryAfterMs past 60 s waits 60 s", async () => {
    scripted.respond(() => processing());
    await startProcessing(10 * 60_000);
    await advance(59_999);
    expect(scripted.polls).toHaveLength(0);
    await advance(1);
    expect(scripted.polls).toHaveLength(1);
  });

  test("a processing answer's retryAfterMs sets the next wait; the backoff steps on underneath", async () => {
    scripted.respond((_poll, index) => (index === 1 ? { status: "processing", retryAfterMs: 30_000 } : processing()));
    await startProcessing();
    await advance(60_000);
    // 1 s, 2 s, then the 30 s the store asked for, then the step after 4 s: 8 s.
    expect(pollTimes(0).slice(0, 4)).toEqual([1000, 3000, 33_000, 41_000]);
  });

  test("ready ends it: done resolves and nothing more is polled", async () => {
    scripted.respond((_poll, index) => (index < 2 ? processing() : { status: "ready", media }));
    await startProcessing();
    await advance(7000);
    await expect(task.done).resolves.toEqual(media);
    await advance(60_000);
    expect(scripted.polls).toHaveLength(3);
  });

  test.each([
    [
      "failed",
      () => ({ status: "failed", reason: "too tall", message: "Too tall" }) as MediaJobResponse,
      { kind: "job-failed", reason: "too tall", message: "Too tall" },
    ],
    [
      "job_not_found",
      () => {
        throw requestError(404, "job_not_found");
      },
      { kind: "job-gone" },
    ],
    [
      "403",
      () => {
        throw requestError(403, "forbidden");
      },
      { kind: "forbidden", message: "forbidden message" },
    ],
    [
      "not_found",
      () => {
        throw requestError(404, "not_found");
      },
      { kind: "document-gone" },
    ],
  ])("%s is terminal at once", async (_label, answer, expected) => {
    scripted.respond(answer);
    await startProcessing();
    await advance(1000);
    expect(failure()).toEqual(expected);
    await advance(10 * 60_000);
    expect(scripted.polls).toHaveLength(1);
  });

  test("one request in flight at a time: an unanswered poll schedules nothing", async () => {
    await startProcessing();
    await advance(10 * 60_000);
    expect(scripted.polls).toHaveLength(1);
  });
});

describe("failed polls and give-up", () => {
  test("6 failed polls in a row give up", async () => {
    scripted.respond(() => {
      throw new TypeError("Network error");
    });
    await startProcessing();
    await advance(1000 + 2000 + 4000 + 8000 + 15_000);
    expect(scripted.polls).toHaveLength(5);
    expect(phase()).toBe("processing");
    await advance(15_000);
    expect(scripted.polls).toHaveLength(6);
    expect(task.state).toEqual({ phase: "gave-up", job: "j1" });
    await advance(10 * 60_000);
    expect(scripted.polls).toHaveLength(6);
  });

  test("a readable processing answer resets the failure count", async () => {
    scripted.respond((_poll, index) => {
      if (index === 5) return processing();
      throw requestError(500, "internal");
    });
    await startProcessing();
    await advance(1000 + 2000 + 4000 + 8000 + 15_000 * 3);
    expect(scripted.polls).toHaveLength(7);
    // Five failures, one answer at 45 s, then five more failures by 120 s: never six in a row.
    await advance(60_000);
    expect(scripted.polls).toHaveLength(11);
    expect(phase()).toBe("processing");
    await advance(15_000);
    expect(phase()).toBe("gave-up");
  });

  test("a 503 on a poll counts as a failure and its Retry-After sets the next wait", async () => {
    scripted.respond((_poll, index) => {
      if (index === 0) throw requestError(503, "busy", { retryAfterMs: 40_000 });
      return processing();
    });
    await startProcessing();
    await advance(1000 + 40_000);
    expect(pollTimes(0)).toEqual([1000, 41_000]);
  });

  test("gives up only after an answer to a poll sent at or after the deadline", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 10_000 });
    await advance(10_000);
    // Polls at 1, 3 and 7 s were sent before the deadline; their answers don't give up.
    expect(phase()).toBe("processing");
    await advance(5000);
    expect(pollTimes(0)).toEqual([1000, 3000, 7000, 15_000]);
    expect(task.state).toEqual({ phase: "gave-up", job: "j1" });
  });

  test("an answer that arrives after the deadline to a poll sent before it doesn't give up", async () => {
    await startProcessing(undefined, { jobTimeoutMs: 10_000 });
    await advance(7000);
    await advance(5000);
    scripted.lastPoll().resolve(processing());
    await flush();
    expect(phase()).toBe("processing");
    scripted.respond(() => processing());
    await advance(8000);
    expect(phase()).toBe("gave-up");
  });

  test("the default bound is 10 minutes", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    await advance(600_000 - 1);
    expect(phase()).toBe("processing");
    await advance(15_000);
    expect(phase()).toBe("gave-up");
  });

  test("keepWaiting() restarts the bound: new deadline, failures 0, next wait 1 s", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 10_000 });
    await advance(15_000);
    expect(phase()).toBe("gave-up");
    const origin = Date.now();
    const before = scripted.polls.length;
    task.keepWaiting();
    expect(task.state).toEqual({ phase: "processing", job: "j1", progress: null });
    await advance(9999);
    expect(pollTimes(origin).slice(before)).toEqual([1000, 3000, 7000]);
    expect(phase()).toBe("processing");
    await advance(15_000);
    expect(phase()).toBe("gave-up");
  });

  test("keepWaiting() resets the failure count", async () => {
    scripted.respond(() => {
      throw new TypeError("Network error");
    });
    await startProcessing();
    await advance(45_000);
    expect(phase()).toBe("gave-up");
    task.keepWaiting();
    await advance(1000 + 2000 + 4000 + 8000 + 15_000);
    expect(phase()).toBe("processing");
    await advance(15_000);
    expect(phase()).toBe("gave-up");
  });

  test("keepWaiting() does nothing unless gave-up", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    task.keepWaiting();
    await advance(1000);
    expect(scripted.polls).toHaveLength(1);
  });
});

describe("hidden tabs", () => {
  test("never gives up while hidden; becoming visible polls at once, and that answer gives up", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 10_000 });
    env.flags.hidden = true;
    await advance(60_000);
    expect(phase()).toBe("processing");
    const sent = scripted.polls.length;
    env.becomeVisible();
    await flush();
    expect(scripted.polls).toHaveLength(sent + 1);
    expect(phase()).toBe("gave-up");
  });

  test("six failed polls while hidden wait for the tab to come back", async () => {
    scripted.respond(() => {
      throw new TypeError("Network error");
    });
    await startProcessing();
    env.flags.hidden = true;
    await advance(5 * 60_000);
    expect(phase()).toBe("processing");
    env.becomeVisible();
    await flush();
    expect(phase()).toBe("gave-up");
  });

  test("becoming visible polls once at once and changes nothing else", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    await advance(500);
    env.becomeVisible();
    await flush();
    expect(pollTimes(0)).toEqual([500]);
    await advance(10_000);
    // The early poll took the place of the 1 s one: 2 s and 4 s waits follow.
    expect(pollTimes(0)).toEqual([500, 2500, 6500]);
  });

  test("becoming visible adds no second request while one is in flight", async () => {
    await startProcessing();
    await advance(1000);
    env.becomeVisible();
    await flush();
    expect(scripted.polls).toHaveLength(1);
  });

  test("becoming visible doesn't poll during a 503's Retry-After wait", async () => {
    scripted.respond((_poll, index) => {
      if (index === 0) throw requestError(503, "busy", { retryAfterMs: 30_000 });
      return processing();
    });
    await startProcessing();
    await advance(1000);
    env.becomeVisible();
    await flush();
    expect(scripted.polls).toHaveLength(1);
  });

  test("becoming visible after give-up polls nothing", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 1000 });
    await advance(3000);
    expect(phase()).toBe("gave-up");
    const sent = scripted.polls.length;
    env.becomeVisible();
    await flush();
    expect(scripted.polls).toHaveLength(sent);
  });

  test("becoming visible during the send changes nothing", async () => {
    start();
    env.becomeVisible();
    await flush();
    expect(scripted.uploads).toHaveLength(1);
    expect(scripted.polls).toHaveLength(0);
  });
});

describe("offline", () => {
  test("a poll due while offline is not sent and counts for nothing; coming online polls at once", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 10_000 });
    env.flags.online = false;
    await advance(20 * 60_000);
    expect(scripted.polls).toHaveLength(0);
    expect(phase()).toBe("processing");
    env.comeOnline();
    await flush();
    expect(scripted.polls).toHaveLength(1);
    // Sent after the deadline: its answer gives up, as any poll's would.
    expect(phase()).toBe("gave-up");
  });

  test("failures don't build up offline", async () => {
    scripted.respond(() => {
      throw new TypeError("Network error");
    });
    await startProcessing();
    await advance(1000 + 2000 + 4000 + 8000 + 15_000);
    expect(scripted.polls).toHaveLength(5);
    env.flags.online = false;
    await advance(5 * 60_000);
    expect(phase()).toBe("processing");
    expect(scripted.polls).toHaveLength(5);
  });

  test("coming online during an in-flight poll adds no second request", async () => {
    await startProcessing();
    await advance(1000);
    env.comeOnline();
    await flush();
    expect(scripted.polls).toHaveLength(1);
  });
});

describe("abort and the epoch", () => {
  test("abort() during the send aborts the request, writes no state, and done rejects with an AbortError", async () => {
    start();
    const upload = scripted.lastUpload();
    const seen = states.length;
    task.abort();
    expect(upload.options.signal?.aborted).toBe(true);
    await expect(task.done).rejects.toMatchObject({ name: "AbortError" });
    expect(task.state).toEqual({ phase: "aborted" });
    upload.options.onProgress?.({ loaded: 10, total: 100 });
    upload.resolve({ status: "ready", media });
    await flush();
    expect(task.state).toEqual({ phase: "aborted" });
    expect(states).toHaveLength(seen);
  });

  test("abort() bumps the epoch", async () => {
    start();
    const before = task.epoch;
    task.abort();
    expect(task.epoch).toBeGreaterThan(before);
  });

  test("abort() while processing aborts the poll in flight and cancels the job, once", async () => {
    await startProcessing();
    await advance(1000);
    const poll = scripted.lastPoll();
    task.abort();
    task.abort();
    expect(poll.signal?.aborted).toBe(true);
    expect(scripted.cancels).toEqual(["j1"]);
    poll.resolve({ status: "ready", media });
    await flush();
    expect(task.state).toEqual({ phase: "aborted" });
  });

  test("abort() between polls stops the timer", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    task.abort();
    await advance(10 * 60_000);
    expect(scripted.polls).toHaveLength(0);
    expect(scripted.cancels).toEqual(["j1"]);
  });

  test("abort() after give-up cancels the job", async () => {
    scripted.respond(() => processing());
    await startProcessing(undefined, { jobTimeoutMs: 1000 });
    await advance(3000);
    task.abort();
    expect(scripted.cancels).toEqual(["j1"]);
  });

  test("abort() during the send cancels no job", async () => {
    start();
    task.abort();
    expect(scripted.cancels).toEqual([]);
  });

  test("a failing cancelJob is swallowed", async () => {
    scripted.client.cancelMediaJob = async () => {
      throw new TypeError("Network error");
    };
    scripted.respond(() => processing());
    await startProcessing();
    task.abort();
    await flush();
    expect(task.state).toEqual({ phase: "aborted" });
  });

  test("retry() after a failure bumps the epoch, so the old send's late events do nothing", async () => {
    start();
    const first = scripted.lastUpload();
    first.reject(new TypeError("Network error"));
    await flush();
    const before = task.epoch;
    task.retry();
    expect(task.epoch).toBeGreaterThan(before);
    first.options.onProgress?.({ loaded: 99, total: 100 });
    first.options.onSent?.();
    expect(task.state).toEqual({ phase: "uploading", loaded: 0, total: 100 });
  });

  test("abort() unsubscribes every environment listener; so does ready", async () => {
    start();
    expect(env.listeners.visible.size + env.listeners.online.size + env.listeners.restore.size).toBe(3);
    task.abort();
    expect(env.listeners.visible.size + env.listeners.online.size + env.listeners.restore.size).toBe(0);

    start();
    scripted.lastUpload().resolve({ status: "ready", media });
    await flush();
    expect(env.listeners.visible.size + env.listeners.online.size + env.listeners.restore.size).toBe(0);
  });
});

describe("back/forward cache", () => {
  test("restored while sending: the send fails as a network error with Retry", async () => {
    start();
    const upload = scripted.lastUpload();
    env.restoreFromCache();
    expect(upload.options.signal?.aborted).toBe(true);
    expect(failure()).toEqual({ kind: "network", stalled: false });
    upload.resolve({ status: "ready", media });
    await flush();
    expect(phase()).toBe("failed");
  });

  test("restored while finishing: the same", async () => {
    start();
    scripted.lastUpload().options.onSent?.();
    env.restoreFromCache();
    expect(failure()).toEqual({ kind: "network", stalled: false });
  });

  test("restored while processing changes nothing", async () => {
    scripted.respond(() => processing());
    await startProcessing();
    env.restoreFromCache();
    expect(phase()).toBe("processing");
  });
});
