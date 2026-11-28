// One media upload, from the first byte to a stored, ready media item: the send, the 202 job and its poll. The default
// media widget (and any host widget, through ctx.continueInBackground) drives it. No DOM and no zod: time, visibility
// and the network state come in through MediaTaskEnvironment, so every rule below is tested with fake timers.
//
// Policy (spec docs/specs/artefacts/2026-11-media-widget.html, §5.3 and §8.9; §8 wins where they differ)
//
// The send
// - The File itself is the XHR body (client.uploadMedia). No overall timeout: large files take as long as they take.
// - Stall: no upload progress event for STALL_MS (60 s) aborts the send as a network error. The stall timer runs only
//   between the first progress event and the upload's load (every byte sent); a store that answers late is never
//   killed by it. Each progress event restarts it.
// - 503 busy: sent again after its Retry-After (clamped 1-60 s; BUSY_DEFAULT_WAIT_MS when the answer has none), at most
//   MAX_BUSY_RESENDS (3) times per task, then failed with Retry. Retry resets the count. No other automatic resend.
// - Offline (environment.isOnline() false) when a send would start: nothing is sent; it fails as a network error.
// - Restored from the back/forward cache while sending: the send fails as a network error (Retry resends).
//
// The poll (after a 202)
// - Waits POLL_BACKOFF_MS: 1, 2, 4, 8 s, then every 15 s. A retryAfterMs from the store, or a Retry-After header (the
//   client lets the header win), sets the next wait instead, clamped 1-60 s; the backoff step advances either way.
// - One request in flight per task, at most one timer pending.
// - A readable processing answer sets the failure count back to 0. It moves neither the deadline nor the backoff.
// - A failed poll (network error, 5xx, 503, unreadable body) adds 1 to the failure count. A 503's Retry-After sets the
//   next wait.
// - Give-up: only after a poll answer, never while the tab is hidden. Either MAX_FAILED_POLLS (6) failures in a row, or
//   the answer is to a poll sent at or after the deadline (202 + jobTimeoutMs, default 600 000): when the deadline
//   passes, the next poll is the last one.
// - Hidden: polls go on as scheduled; a give-up they would cause waits. Becoming visible polls once at once, unless a
//   request is in flight, a 503's Retry-After wait is pending, or the task gave up; it changes nothing else.
// - Offline: a poll that comes due while offline is not sent and counts for nothing. Coming online polls at once
//   (same guard as becoming visible).
// - Terminal at once: ready, failed (job-failed), job_not_found (job-gone), 403 (forbidden), not_found (document-gone).
// - Keep waiting (from gave-up only): new deadline, failure count 0, backoff from the start (next wait 1 s).
//
// Invariants
// - Epoch: every abandoned operation bumps `epoch` (abort, a new send on Retry or a busy resend, a stall, a bfcache
//   restore while sending). Every continuation (XHR progress, sent, load or error; a poll answer; the busy wait; a poll
//   timer) captured the epoch it started under and does nothing when it has moved: no state, no timer, no request.
// - Claims: `inFlight` holds the one request's AbortController; `timer` the one pending timer (poll wait or busy wait);
//   `stallTimer` the stall timer. Each is released (cleared or aborted, then set to null) when its continuation runs, on
//   every epoch bump, and on ready. After abort() nothing is pending and no listener is subscribed.
// - Counters: `resends` (automatic 503 resends) counts up to MAX_BUSY_RESENDS and resets only on retry(). `failures`
//   (failed polls in a row) resets on a readable processing answer and on keepWaiting(). `pollIndex` (backoff step)
//   resets when polling starts and on keepWaiting().
// - Bounds: a job costs about 4 + 40 polls over its 10 minutes, plus one per visible/online event; a send costs at most
//   1 + 3 requests per retry(). cancelJob is fire-and-forget, sent once, only on abort() while a job is known.
// - done settles once: resolves on ready, rejects with an AbortError on abort(). Failed and gave-up are not terminal:
//   retry() and keepWaiting() leave them.
// - onState is never called after abort(), and never with a state from a stale epoch.
import { ContentRequestError, type ContentClient, type MediaUploadFile } from "../http/client.ts";
import type { WireMedia, WireMediaField } from "../http/wire-types.ts";

export const POLL_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15_000];
export const MIN_RETRY_AFTER_MS = 1000;
export const MAX_RETRY_AFTER_MS = 60_000;
export const STALL_MS = 60_000;
export const MAX_BUSY_RESENDS = 3;
export const BUSY_DEFAULT_WAIT_MS = 5000;
export const MAX_FAILED_POLLS = 6;
export const DEFAULT_JOB_TIMEOUT_MS = 600_000;

/** Why a task stopped short of ready. */
export type MediaTaskFailure =
  | { kind: "network"; stalled: boolean }
  | { kind: "refused"; code: "too_large" | "unsupported" | "invalid"; message: string; limit?: number }
  | { kind: "busy" }
  | { kind: "server" }
  | { kind: "job-failed"; reason: string; message?: string }
  | { kind: "job-gone" }
  | { kind: "forbidden"; message: string }
  | { kind: "document-gone" };

export type MediaTaskState =
  | { phase: "uploading"; loaded: number; total: number | null }
  | { phase: "finishing" }
  | { phase: "busy"; retryInMs: number; resend: number }
  | { phase: "processing"; job: string; progress: number | null }
  | { phase: "ready"; media: WireMedia }
  | { phase: "failed"; failure: MediaTaskFailure }
  | { phase: "gave-up"; job: string }
  | { phase: "aborted" };

/** Time, visibility and the network, injected so the policy is testable. */
export interface MediaTaskEnvironment {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isHidden(): boolean;
  isOnline(): boolean;
  /** Calls `listener` when the page becomes visible. Returns a function that stops listening. */
  onVisible(listener: () => void): () => void;
  /** Calls `listener` when the browser comes back online. */
  onOnline(listener: () => void): () => void;
  /** Calls `listener` when the page is restored from the back/forward cache. */
  onRestore(listener: () => void): () => void;
}

export interface MediaTaskOptions {
  client: Pick<ContentClient, "uploadMedia" | "mediaJob" | "cancelMediaJob">;
  field: WireMediaField;
  file: MediaUploadFile;
  /** Give up on a job this long after its 202 (and after Keep waiting). Default 600 000 (10 minutes). */
  jobTimeoutMs?: number;
  /** Every state change, in order. The first call, `uploading`, happens inside `startMediaTask`. */
  onState?: (state: MediaTaskState) => void;
  /** Default: `browserMediaTaskEnvironment()`. */
  environment?: MediaTaskEnvironment;
}

export interface MediaTask {
  readonly state: MediaTaskState;
  /** Bumped by every abandoned operation; a continuation from an older epoch does nothing. */
  readonly epoch: number;
  /** Resolves with the media on ready; rejects with an AbortError on abort(). */
  readonly done: Promise<WireMedia>;
  /** From failed: send the file again from the start. Resets the automatic 503 resends. */
  retry(): void;
  /** From gave-up: poll again with a fresh bound. */
  keepWaiting(): void;
  /** Stops the send or the poll (and cancels a known job, fire-and-forget). Writes nothing. Idempotent. */
  abort(): void;
}

/** The browser's clock, timers, `document.visibilityState`, `navigator.onLine` and `pageshow`, each guarded. */
export function browserMediaTaskEnvironment(): MediaTaskEnvironment {
  const page = typeof document === "undefined" ? undefined : document;
  const view = typeof window === "undefined" ? undefined : window;
  const listen = (target: EventTarget | undefined, type: string, handler: (event: Event) => void) => {
    if (!target) return () => {};
    target.addEventListener(type, handler);
    return () => target.removeEventListener(type, handler);
  };
  return {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
    isHidden: () => page?.visibilityState === "hidden",
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    onVisible: (listener) =>
      listen(page, "visibilitychange", () => {
        if (page?.visibilityState === "visible") listener();
      }),
    onOnline: (listener) => listen(view, "online", () => listener()),
    onRestore: (listener) =>
      listen(view, "pageshow", (event) => {
        if ((event as Event & { persisted?: boolean }).persisted) listener();
      }),
  };
}

const clampRetryAfter = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));

/** What a failed send becomes. */
function sendFailure(error: unknown): MediaTaskFailure {
  if (error instanceof TypeError) return { kind: "network", stalled: false };
  if (!(error instanceof ContentRequestError)) return { kind: "server" };
  switch (error.code) {
    case "too_large":
    case "unsupported":
      return {
        kind: "refused",
        code: error.code,
        message: error.message,
        ...(error.limit !== undefined ? { limit: error.limit } : {}),
      };
    case "bad_request":
      return { kind: "refused", code: "invalid", message: error.message };
    case "forbidden":
      return { kind: "forbidden", message: error.message };
    case "not_found":
      return { kind: "document-gone" };
    default:
      return { kind: "server" };
  }
}

/** A poll error that ends the job at once, or undefined when it only counts as a failed poll. */
function terminalPollFailure(error: unknown): MediaTaskFailure | undefined {
  if (!(error instanceof ContentRequestError)) return undefined;
  if (error.code === "job_not_found") return { kind: "job-gone" };
  if (error.code === "forbidden") return { kind: "forbidden", message: error.message };
  if (error.code === "not_found") return { kind: "document-gone" };
  return undefined;
}

export function startMediaTask(options: MediaTaskOptions): MediaTask {
  const { client, field, file } = options;
  const environment = options.environment ?? browserMediaTaskEnvironment();
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  let state: MediaTaskState = { phase: "uploading", loaded: 0, total: file.size };
  let epoch = 0;
  // Claims: the one request in flight, the one pending timer, the stall timer.
  let inFlight: AbortController | null = null;
  let timer: unknown = null;
  let stallTimer: unknown = null;
  /** The pending timer is a 503's Retry-After wait, which a visible or online poll must not cut short. */
  let busyWait = false;
  // Counters.
  let resends = 0;
  let failures = 0;
  let pollIndex = 0;
  // The job, once the upload answered 202.
  let job: string | null = null;
  let deadline = 0;

  let resolveDone: (media: WireMedia) => void = () => {};
  let rejectDone: (reason: unknown) => void = () => {};
  const done = new Promise<WireMedia>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const set = (next: MediaTaskState) => {
    state = next;
    options.onState?.(next);
  };

  const clearTimer = () => {
    if (timer !== null) environment.clearTimeout(timer);
    timer = null;
    busyWait = false;
  };
  const clearStall = () => {
    if (stallTimer !== null) environment.clearTimeout(stallTimer);
    stallTimer = null;
  };
  /** Abandons whatever is pending: every continuation started before this does nothing. */
  const bump = () => {
    epoch++;
    clearTimer();
    clearStall();
    inFlight?.abort();
    inFlight = null;
  };

  /** Runs `callback` after `ms`, unless the epoch moves first. */
  const later = (ms: number, callback: () => void) => {
    const startedIn = epoch;
    timer = environment.setTimeout(() => {
      if (startedIn !== epoch) return;
      timer = null;
      busyWait = false;
      callback();
    }, ms);
  };

  const unsubscribe: (() => void)[] = [];
  const stopListening = () => {
    for (const stop of unsubscribe.splice(0)) stop();
  };

  const finishReady = (media: WireMedia) => {
    stopListening();
    set({ phase: "ready", media });
    resolveDone(media);
  };

  const fail = (failure: MediaTaskFailure) => set({ phase: "failed", failure });

  const send = () => {
    bump();
    job = null;
    if (!environment.isOnline()) return fail({ kind: "network", stalled: false });
    const startedIn = epoch;
    const current = () => startedIn === epoch;
    const controller = new AbortController();
    inFlight = controller;
    set({ phase: "uploading", loaded: 0, total: file.size });
    const armStall = () => {
      clearStall();
      stallTimer = environment.setTimeout(() => {
        if (!current()) return;
        stallTimer = null;
        bump();
        fail({ kind: "network", stalled: true });
      }, STALL_MS);
    };
    client
      .uploadMedia(field, file, {
        signal: controller.signal,
        onProgress: ({ loaded, total }) => {
          if (!current()) return;
          armStall();
          set({ phase: "uploading", loaded, total });
        },
        onSent: () => {
          if (!current()) return;
          clearStall();
          set({ phase: "finishing" });
        },
      })
      .then(
        (answer) => {
          if (!current()) return;
          inFlight = null;
          clearStall();
          if (answer.status === "ready") finishReady(answer.media);
          else startPolling(answer.job, answer.retryAfterMs);
        },
        (error: unknown) => {
          if (!current()) return;
          inFlight = null;
          clearStall();
          if (error instanceof ContentRequestError && error.code === "busy") return busy(error.retryAfterMs);
          fail(sendFailure(error));
        },
      );
  };

  const busy = (retryAfterMs: number | undefined) => {
    if (resends >= MAX_BUSY_RESENDS) return fail({ kind: "busy" });
    resends++;
    const wait = clampRetryAfter(retryAfterMs ?? BUSY_DEFAULT_WAIT_MS);
    set({ phase: "busy", retryInMs: wait, resend: resends });
    later(wait, send);
  };

  const startPolling = (id: string, retryAfterMs: number | undefined) => {
    job = id;
    deadline = environment.now() + jobTimeoutMs;
    failures = 0;
    pollIndex = 0;
    set({ phase: "processing", job: id, progress: null });
    schedulePoll(retryAfterMs, false);
  };

  /** The next poll: the backoff step, or the server's wait instead. The step advances either way. */
  const schedulePoll = (retryAfterMs: number | undefined, fromBusy: boolean) => {
    const step = POLL_BACKOFF_MS[Math.min(pollIndex, POLL_BACKOFF_MS.length - 1)] ?? MAX_RETRY_AFTER_MS;
    pollIndex++;
    later(retryAfterMs !== undefined ? clampRetryAfter(retryAfterMs) : step, poll);
    busyWait = fromBusy;
  };

  const poll = () => {
    const id = job;
    if (id === null) return;
    // Offline: nothing is sent and nothing counts; coming online polls again.
    if (!environment.isOnline()) return;
    const startedIn = epoch;
    const sentAt = environment.now();
    const controller = new AbortController();
    inFlight = controller;
    client.mediaJob(field, id, { signal: controller.signal }).then(
      (answer) => {
        if (startedIn !== epoch) return;
        inFlight = null;
        if (answer.status === "ready") return finishReady(answer.media);
        if (answer.status === "failed")
          return fail({
            kind: "job-failed",
            reason: answer.reason,
            ...(answer.message !== undefined ? { message: answer.message } : {}),
          });
        failures = 0;
        set({ phase: "processing", job: id, progress: answer.progress ?? null });
        afterAnswer(sentAt, answer.retryAfterMs, false);
      },
      (error: unknown) => {
        if (startedIn !== epoch) return;
        inFlight = null;
        const terminal = terminalPollFailure(error);
        if (terminal) return fail(terminal);
        failures++;
        const isBusy = error instanceof ContentRequestError && error.code === "busy";
        afterAnswer(sentAt, isBusy ? (error as ContentRequestError).retryAfterMs : undefined, isBusy);
      },
    );
  };

  /** After every poll answer: give up when the bound is spent and the tab is visible, else poll again. */
  const afterAnswer = (sentAt: number, retryAfterMs: number | undefined, fromBusy: boolean) => {
    const spent = failures >= MAX_FAILED_POLLS || sentAt >= deadline;
    if (spent && !environment.isHidden() && job !== null) return set({ phase: "gave-up", job });
    schedulePoll(retryAfterMs, fromBusy);
  };

  /** A visible or online event: one poll now, unless one is in flight, a 503 wait is pending, or polling is over. */
  const pollNow = () => {
    if (state.phase !== "processing" || inFlight !== null || busyWait) return;
    clearTimer();
    poll();
  };

  unsubscribe.push(
    environment.onVisible(pollNow),
    environment.onOnline(pollNow),
    environment.onRestore(() => {
      if (state.phase !== "uploading" && state.phase !== "finishing") return;
      bump();
      fail({ kind: "network", stalled: false });
    }),
  );

  send();

  return {
    get state() {
      return state;
    },
    get epoch() {
      return epoch;
    },
    done,
    retry: () => {
      if (state.phase !== "failed") return;
      resends = 0;
      send();
    },
    keepWaiting: () => {
      if (state.phase !== "gave-up" || job === null) return;
      deadline = environment.now() + jobTimeoutMs;
      failures = 0;
      pollIndex = 0;
      set({ phase: "processing", job, progress: null });
      schedulePoll(undefined, false);
    },
    abort: () => {
      // Ready is settled: nothing is pending, and done has resolved.
      if (state.phase === "aborted" || state.phase === "ready") return;
      const cancel = job !== null && (state.phase === "processing" || state.phase === "gave-up") ? job : null;
      bump();
      stopListening();
      state = { phase: "aborted" };
      if (cancel !== null) client.cancelMediaJob(field, cancel).catch(() => {});
      rejectDone(new DOMException("The media task was aborted", "AbortError"));
    },
  };
}
