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
  throw new Error("not implemented");
}

export function startMediaTask(options: MediaTaskOptions): MediaTask {
  void options;
  void ContentRequestError;
  throw new Error("not implemented");
}
