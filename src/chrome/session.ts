// Per-document state and the save queue.
//
// WRITES ARE SERIALISED PER DOCUMENT, not per field: every write sends `expectedVersion` and bumps the version, so
// two fields of one document saved in parallel would make the second conflict with the first. Within a field,
// values coalesce: if three commits land while one is in flight, only the latest is sent next.
import { ContentRequestError, type ContentClient } from "../http/client.ts";
import type { DocumentForPublishResponse, DocumentState, DocumentSummary, WireDocument } from "./types.ts";

export type SaveState = "idle" | "saving" | "saved" | "failed";

export interface SaveSlot {
  readonly id: string;
  readonly key: string;
  readonly path: string;
  state: SaveState;
  /** The value that failed to save, kept for Retry and Keep mine. */
  failedValue?: unknown;
  /** Set when the last failure was a version conflict. */
  conflict?: WireDocument;
  pending?: { value: unknown };
  /** The value of the request on the wire now. */
  sending?: { value: unknown };
  scheduled?: Promise<void>;
}

/**
 * The publish sheet's look at one document. `version` is what a publish from that sheet sends as `expectedVersion`:
 * the version whose diff the sheet showed, moved forward by the editor's own writes (see `applyWrite`). Unset until the
 * diff has loaded.
 */
export interface Review {
  version?: number;
}

export interface SessionEvents {
  stateChanged(slot: SaveSlot): void;
  saved(slot: SaveSlot, value: unknown, document: WireDocument): void;
  /** `error` is a `ContentRequestError`, or whatever `fetch` threw when the server was unreachable. */
  failed(slot: SaveSlot, error: unknown): void;
  conflicted(slot: SaveSlot, current: WireDocument): void;
}

interface MutableDocument extends DocumentState {
  touched: boolean;
  touchedPaths: Set<string>;
}

const STORAGE_PREFIX = "yl-editor:touched:";

/** How many times one look at a document re-reads because a write landed during the read. */
const MAX_PUBLISH_READS = 3;

/** The publish sheet has nothing it can honestly compare: writes kept landing, or the published payload is unreadable. */
export class ChangesUnavailableError extends Error {
  constructor(readonly reason: "moving" | "unreadable") {
    super(`Changes unavailable: ${reason}`);
    this.name = "ChangesUnavailableError";
  }
}

export class Session {
  readonly documents = new Map<string, MutableDocument>();
  private readonly slots = new Map<string, SaveSlot>();
  private readonly chains = new Map<string, Promise<void>>();
  /** One `GET document` per key per session, plus `documentForPublish`; replaced by every write's returned document. */
  private readonly fetched = new Map<string, Promise<WireDocument>>();
  private readonly reviews = new Map<string, Review>();
  /** Bumped per key whenever the session takes a document as the latest, so a read can tell one landed meanwhile. */
  private readonly writes = new Map<string, number>();
  /** The newest `documentForPublish` per key: an older one still in flight touches nothing. */
  private readonly reads = new Map<string, number>();
  private readonly storageKey: string;

  constructor(
    private readonly client: ContentClient,
    private readonly events: SessionEvents,
    base: string,
  ) {
    this.storageKey = STORAGE_PREFIX + base;
  }

  /**
   * Reads the summaries after every write already queued for these documents. A write can still land during the read,
   * so a summary older than what the session holds changes only `access`.
   */
  async load(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.pending(key)));
    const summaries = await this.client.documents([...keys]);
    const remembered = this.readTouched();
    for (const key of keys) {
      const summary: DocumentSummary | undefined = summaries[key];
      if (!summary) {
        this.documents.delete(key);
        continue;
      }
      let existing = this.documents.get(key);
      if (existing && summary.version < existing.version) {
        existing.access = { edit: summary.access.edit === true, publish: summary.access.publish === true };
        continue;
      }
      if (existing && existing.version !== summary.version) {
        // Someone wrote since we last looked: what we cached is stale.
        this.fetched.delete(key);
        existing = { ...existing, payload: undefined, scheduledAt: null };
      }
      const rememberedPaths = summary.isDraft ? remembered[key] : undefined;
      const touchedPaths = new Set([...(existing?.touchedPaths ?? []), ...(rememberedPaths ?? [])]);
      this.documents.set(key, {
        key,
        type: summary.type,
        version: summary.version,
        isDraft: summary.isDraft,
        access: { edit: summary.access.edit === true, publish: summary.access.publish === true },
        publishedAt: summary.publishedAt,
        scheduledAt: existing?.scheduledAt ?? null,
        payload: existing?.payload,
        // Not `touchedPaths.size`: an unpublish changes a document without changing a path.
        touched: existing?.touched === true || rememberedPaths !== undefined,
        touchedPaths,
      });
    }
    this.writeTouched();
  }

  /**
   * The document's draft view, fetched once per session and replaced by whatever each write returns. A failed fetch
   * is not cached, so the next call retries.
   */
  document(key: string): Promise<WireDocument> {
    const cached = this.fetched.get(key);
    if (cached) return cached;
    const request: Promise<WireDocument> = this.client.document(key).then(
      (document) => {
        // A write landed while this was in flight; its document is newer than ours.
        const current = this.fetched.get(key);
        if (current !== request) return current ?? document;
        const state = this.documents.get(key);
        if (state) {
          // Keep our version: if the server's is newer, the next write conflicts and the editor chooses.
          state.payload = document.payload;
          state.publishedAt = document.publishedAt;
          state.scheduledAt = document.scheduledAt;
        }
        return document;
      },
      (error: unknown) => {
        if (this.fetched.get(key) === request) this.fetched.delete(key);
        throw error;
      },
    );
    this.fetched.set(key, request);
    return request;
  }

  /**
   * A fresh read for the publish sheet, past the cache and after the document's queued writes. The document and
   * `publishedPayload` it returns always come from one response: if a write lands during the read, it reads again, up
   * to `MAX_PUBLISH_READS` times, then rejects. The version it returns becomes the version of the document's open review,
   * if it has one, and refreshes the cached document. A rejection, or a newer read of the same document, does neither.
   */
  async documentForPublish(key: string): Promise<DocumentForPublishResponse> {
    const read = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, read);
    const review = this.reviews.get(key);
    if (review) review.version = undefined;
    for (let attempt = 0; attempt < MAX_PUBLISH_READS; attempt += 1) {
      await this.pending(key);
      const writes = this.writes.get(key) ?? 0;
      const response = await this.client.documentForPublish(key);
      if (this.reads.get(key) !== read) return response;
      if ((this.writes.get(key) ?? 0) !== writes) continue;
      const { document, publishedPayload } = response;
      // A string is the stored text of an unparseable published column (schemas are objects). Live with no published
      // payload is the same thing from a server that sends null. Neither compares, and neither is a first publish.
      if (typeof publishedPayload === "string" || (publishedPayload === null && document.publishedAt !== null)) {
        throw new ChangesUnavailableError("unreadable");
      }
      if (review) review.version = document.version;
      this.fetched.set(key, Promise.resolve(document));
      const state = this.documents.get(key);
      if (state) {
        // Keep our version, as `document` does: another editor's change must still conflict with our next write.
        state.isDraft = document.isDraft;
        state.payload = document.payload;
        state.publishedAt = document.publishedAt;
        state.scheduledAt = document.scheduledAt;
      }
      return response;
    }
    throw new ChangesUnavailableError("moving");
  }

  /**
   * Runs a lifecycle write (publish, discard, unpublish, restore a revision) on the document's write chain, after
   * every field write queued before it. `task` applies its own result before it returns, because the chain releases when
   * it settles: a field save queued behind it reads `version` the moment it does. A failure is the caller's; it does not
   * stall the chain.
   */
  run<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    this.chains.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /**
   * Marks a document as changed this session, for writes that are not field saves. `paths` may be empty: an unpublish
   * changes no path, and a restore may leave the draft as it was, but either still leaves something to publish.
   */
  touch(key: string, paths: readonly string[] = []): void {
    const state = this.documents.get(key);
    if (!state) return;
    state.touched = true;
    for (const path of paths) state.touchedPaths.add(path);
    this.writeTouched();
  }

  /** Opens the document's review, replacing any earlier one. */
  startReview(key: string): Review {
    const review: Review = {};
    this.reviews.set(key, review);
    return review;
  }

  endReview(key: string, review: Review): void {
    if (this.reviews.get(key) === review) this.reviews.delete(key);
  }

  /**
   * What a publish sends: the review's version, else the version this session knows. A publish from a sheet passes its
   * own review, because that sheet may have closed and another opened by the time the publish reaches the chain.
   */
  publishVersion(key: string, review = this.reviews.get(key)): number | undefined {
    return review?.version ?? this.documents.get(key)?.version;
  }

  /**
   * The newest value the editor has committed for a path that is not yet in the stored document: queued, on the wire,
   * or failed. A widget starts from this, because the cached payload does not have it yet.
   */
  committedValue(key: string, path: string): { value: unknown } | undefined {
    const slot = this.slots.get(`${key}:${path}`);
    if (!slot) return undefined;
    if (slot.pending || slot.sending) return slot.pending ?? slot.sending;
    return slot.state === "failed" ? { value: slot.failedValue } : undefined;
  }

  /** The document's content was just replaced, so its failed saves are gone: nothing to retry or resend. */
  clearFailed(key: string): void {
    for (const slot of this.slots.values()) {
      if (slot.key !== key || slot.state !== "failed") continue;
      slot.failedValue = undefined;
      slot.conflict = undefined;
      this.setState(slot, "idle");
    }
  }

  /**
   * Drops the values at the paths `only` accepts, because each path now names something else: a failed value, and a
   * save queued but not yet sent (one already on the wire went out before the change and is left alone).
   */
  dropSaves(key: string, only: (path: string) => boolean): string[] {
    const dropped: string[] = [];
    for (const slot of this.slots.values()) {
      if (slot.key !== key || !only(slot.path)) continue;
      if (slot.state === "failed") {
        slot.failedValue = undefined;
        slot.conflict = undefined;
      } else if (slot.pending && !slot.sending) {
        slot.pending = undefined;
      } else continue;
      dropped.push(slot.path);
      this.setState(slot, "idle");
    }
    return dropped;
  }

  slot(key: string, path: string): SaveSlot {
    const id = `${key}:${path}`;
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { id, key, path, state: "idle" };
      this.slots.set(id, slot);
    }
    return slot;
  }

  save(key: string, path: string, value: unknown): Promise<void> {
    const slot = this.slot(key, path);
    slot.pending = { value };
    slot.conflict = undefined;
    this.setState(slot, "saving");
    if (!slot.scheduled) slot.scheduled = this.enqueue(key, () => this.flush(slot));
    return slot.scheduled;
  }

  /** Resends a failed value. A button still showing for a value since dropped (see `dropSaves`) does nothing. */
  retry(slot: SaveSlot): Promise<void> {
    if (slot.state !== "failed") return Promise.resolve();
    return this.save(slot.key, slot.path, slot.failedValue);
  }

  /** Overwrite: adopt the server's version so the next write is accepted, then resend our value. */
  keepMine(slot: SaveSlot): Promise<void> {
    if (slot.state !== "failed") return Promise.resolve();
    if (slot.conflict) this.adopt(slot.conflict);
    return this.retry(slot);
  }

  /** Accept the other edit. Returns the server's value for the field so the caller can repaint it. */
  takeTheirs(slot: SaveSlot): unknown {
    const current = slot.conflict;
    slot.conflict = undefined;
    slot.failedValue = undefined;
    this.setState(slot, "idle");
    if (!current) return undefined;
    this.adopt(current);
    return current.payload;
  }

  /** Publish or discard finished: the document is no longer this session's change. */
  settle(key: string, document: WireDocument | null): void {
    this.reviews.delete(key);
    const state = this.documents.get(key);
    if (!state) return;
    if (document) this.adopt(document);
    else {
      state.isDraft = false;
      state.payload = undefined;
      state.publishedAt = null;
      state.scheduledAt = null;
      this.fetched.delete(key);
      this.noteWrite(key);
    }
    state.touched = false;
    state.touchedPaths.clear();
    this.writeTouched();
  }

  /** Takes a document the server returned as the latest: version, payload, lifecycle dates and the fetch cache. */
  adopt(document: WireDocument): void {
    this.noteWrite(document.key);
    this.fetched.set(document.key, Promise.resolve(document));
    const state = this.documents.get(document.key);
    if (!state) return;
    state.version = document.version;
    state.isDraft = document.isDraft;
    state.payload = document.payload;
    state.publishedAt = document.publishedAt;
    state.scheduledAt = document.scheduledAt;
  }

  /**
   * Takes the result of a write this session sent with `expected`. The server accepted that version, so nothing else
   * landed between it and the result: a review standing at `expected` moves forward with it. A write from any other
   * version leaves the review behind, and the publish then conflicts, because something unreviewed lies between them.
   */
  applyWrite(expected: number | undefined, document: WireDocument): void {
    const review = this.reviews.get(document.key);
    if (review && expected !== undefined && review.version === expected) review.version = document.version;
    this.adopt(document);
  }

  /** Whether a field save of the document is queued or on the wire. Its document may not be `touched` yet. */
  isSaving(key: string): boolean {
    for (const slot of this.slots.values()) if (slot.key === key && (slot.pending || slot.sending)) return true;
    return false;
  }

  /** Resolves once every write queued so far for the document has finished. */
  pending(key: string): Promise<void> {
    return this.chains.get(key) ?? Promise.resolve();
  }

  private noteWrite(key: string): void {
    this.writes.set(key, (this.writes.get(key) ?? 0) + 1);
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    this.chains.set(key, next);
    return next;
  }

  private async flush(slot: SaveSlot): Promise<void> {
    try {
      while (slot.pending) {
        const { value } = slot.pending;
        slot.pending = undefined;
        slot.sending = { value };
        try {
          const expected = this.documents.get(slot.key)?.version;
          const document = await this.client.field(slot.key, slot.path, value, expected);
          slot.sending = undefined;
          this.applyWrite(expected, document);
          this.markTouched(slot);
          if (!slot.pending) this.setState(slot, "saved");
          this.events.saved(slot, value, document);
        } catch (error) {
          slot.sending = undefined;
          // A newer commit may have arrived while this one was in flight; that is the one worth retrying.
          const newer = slot.pending as { value: unknown } | undefined;
          slot.failedValue = newer ? newer.value : value;
          slot.pending = undefined;
          this.setState(slot, "failed");
          if (error instanceof ContentRequestError && error.code === "conflict" && error.current) {
            slot.conflict = error.current;
            this.events.conflicted(slot, error.current);
          } else {
            this.events.failed(slot, error);
          }
        }
      }
    } finally {
      slot.scheduled = undefined;
    }
  }

  private markTouched(slot: SaveSlot): void {
    const state = this.documents.get(slot.key);
    if (!state) return;
    state.touched = true;
    state.touchedPaths.add(slot.path);
    this.writeTouched();
  }

  private setState(slot: SaveSlot, state: SaveState): void {
    slot.state = state;
    this.events.stateChanged(slot);
  }

  // Session storage so a reload mid-edit still lists what was changed. Private windows and blocked storage throw;
  // the chrome then simply forgets on reload.
  private readTouched(): Record<string, string[]> {
    try {
      const raw = globalThis.sessionStorage?.getItem(this.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed === null || typeof parsed !== "object") return {};
      const valid: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && value.every((path) => typeof path === "string")) valid[key] = value as string[];
      }
      return valid;
    } catch {
      return {};
    }
  }

  private writeTouched(): void {
    const record: Record<string, string[]> = {};
    for (const [key, state] of this.documents) if (state.touched) record[key] = [...state.touchedPaths];
    try {
      globalThis.sessionStorage?.setItem(this.storageKey, JSON.stringify(record));
    } catch {
      // See readTouched.
    }
  }
}
