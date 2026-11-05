// Per-document state and the save queue.
//
// WRITES ARE SERIALISED PER DOCUMENT, not per field: every write sends `expectedVersion` and bumps the version, so
// two fields of one document saved in parallel would make the second conflict with the first. Within a field,
// values coalesce: if three commits land while one is in flight, only the latest is sent next.
import { ContentRequestError } from "../http/client.js";
const STORAGE_PREFIX = "yl-editor:touched:";
export class Session {
    client;
    events;
    documents = new Map();
    slots = new Map();
    chains = new Map();
    /** One `GET document` per key per session, plus `documentForPublish`; replaced by every write's returned document. */
    fetched = new Map();
    storageKey;
    constructor(client, events, base) {
        this.client = client;
        this.events = events;
        this.storageKey = STORAGE_PREFIX + base;
    }
    async load(keys) {
        const summaries = await this.client.documents([...keys]);
        const remembered = this.readTouched();
        for (const key of keys) {
            const summary = summaries[key];
            if (!summary) {
                this.documents.delete(key);
                continue;
            }
            let existing = this.documents.get(key);
            if (existing && existing.version !== summary.version) {
                // Someone wrote since we last looked: what we cached is stale.
                this.fetched.delete(key);
                existing = { ...existing, payload: undefined, scheduledAt: null };
            }
            const rememberedPaths = summary.isDraft ? (remembered[key] ?? []) : [];
            const touchedPaths = new Set([...(existing?.touchedPaths ?? []), ...rememberedPaths]);
            this.documents.set(key, {
                key,
                type: summary.type,
                version: summary.version,
                isDraft: summary.isDraft,
                access: { edit: summary.access.edit === true, publish: summary.access.publish === true },
                publishedAt: summary.publishedAt,
                scheduledAt: existing?.scheduledAt ?? null,
                payload: existing?.payload,
                touched: touchedPaths.size > 0,
                touchedPaths,
            });
        }
        this.writeTouched();
    }
    /**
     * The document's draft view, fetched once per session and replaced by whatever each write returns. A failed fetch
     * is not cached, so the next call retries.
     */
    document(key) {
        const cached = this.fetched.get(key);
        if (cached)
            return cached;
        const request = this.client.document(key).then((document) => {
            // A write landed while this was in flight; its document is newer than ours.
            const current = this.fetched.get(key);
            if (current !== request)
                return current ?? document;
            const state = this.documents.get(key);
            if (state) {
                // Keep our version: if the server's is newer, the next write conflicts and the editor chooses.
                state.payload = document.payload;
                state.publishedAt = document.publishedAt;
                state.scheduledAt = document.scheduledAt;
            }
            return document;
        }, (error) => {
            if (this.fetched.get(key) === request)
                this.fetched.delete(key);
            throw error;
        });
        this.fetched.set(key, request);
        return request;
    }
    /**
     * A fresh read for the publish sheet, past the cache and after the document's queued writes. It refreshes the cached
     * document, unless a write landed while it was in flight. A failure leaves the cache as it was.
     */
    async documentForPublish(key) {
        await this.pending(key);
        const seen = this.fetched.get(key);
        const response = await this.client.documentForPublish(key);
        const { document, publishedPayload } = response;
        const current = this.fetched.get(key);
        if (current !== seen) {
            // A write landed while this was in flight; its document is newer than ours.
            return { document: (await current?.catch(() => undefined)) ?? document, publishedPayload };
        }
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
    /**
     * Runs a lifecycle write (publish, discard, unpublish, restore a revision) on the document's write chain, after
     * every field write queued before it. A failure is the caller's; it does not stall the chain.
     */
    run(key, task) {
        const previous = this.chains.get(key) ?? Promise.resolve();
        const result = previous.then(task);
        this.chains.set(key, result.then(() => undefined, () => undefined));
        return result;
    }
    /** Marks paths as changed this session, for writes that are not field saves (restoring a revision). */
    touch(key, paths) {
        const state = this.documents.get(key);
        if (!state || paths.length === 0)
            return;
        state.touched = true;
        for (const path of paths)
            state.touchedPaths.add(path);
        this.writeTouched();
    }
    slot(key, path) {
        const id = `${key}:${path}`;
        let slot = this.slots.get(id);
        if (!slot) {
            slot = { id, key, path, state: "idle" };
            this.slots.set(id, slot);
        }
        return slot;
    }
    save(key, path, value) {
        const slot = this.slot(key, path);
        slot.pending = { value };
        slot.conflict = undefined;
        this.setState(slot, "saving");
        if (!slot.scheduled)
            slot.scheduled = this.enqueue(key, () => this.flush(slot));
        return slot.scheduled;
    }
    retry(slot) {
        return this.save(slot.key, slot.path, slot.failedValue);
    }
    /** Overwrite: adopt the server's version so the next write is accepted, then resend our value. */
    keepMine(slot) {
        if (slot.conflict)
            this.adopt(slot.conflict);
        return this.retry(slot);
    }
    /** Accept the other edit. Returns the server's value for the field so the caller can repaint it. */
    takeTheirs(slot) {
        const current = slot.conflict;
        slot.conflict = undefined;
        slot.failedValue = undefined;
        this.setState(slot, "idle");
        if (!current)
            return undefined;
        this.adopt(current);
        return current.payload;
    }
    /** Publish or discard finished: the document is no longer this session's change. */
    settle(key, document) {
        const state = this.documents.get(key);
        if (!state)
            return;
        if (document)
            this.adopt(document);
        else {
            state.isDraft = false;
            state.payload = undefined;
            state.publishedAt = null;
            state.scheduledAt = null;
            this.fetched.delete(key);
        }
        state.touched = false;
        state.touchedPaths.clear();
        this.writeTouched();
    }
    /** Takes a document the server returned as the latest: version, payload, lifecycle dates and the fetch cache. */
    adopt(document) {
        this.fetched.set(document.key, Promise.resolve(document));
        const state = this.documents.get(document.key);
        if (!state)
            return;
        state.version = document.version;
        state.isDraft = document.isDraft;
        state.payload = document.payload;
        state.publishedAt = document.publishedAt;
        state.scheduledAt = document.scheduledAt;
    }
    /** Resolves once every write queued so far for the document has finished. */
    pending(key) {
        return this.chains.get(key) ?? Promise.resolve();
    }
    enqueue(key, task) {
        const previous = this.chains.get(key) ?? Promise.resolve();
        const next = previous.then(task);
        this.chains.set(key, next);
        return next;
    }
    async flush(slot) {
        try {
            while (slot.pending) {
                const { value } = slot.pending;
                slot.pending = undefined;
                try {
                    const document = await this.client.field(slot.key, slot.path, value, this.documents.get(slot.key)?.version);
                    this.adopt(document);
                    this.markTouched(slot);
                    if (!slot.pending)
                        this.setState(slot, "saved");
                    this.events.saved(slot, value, document);
                }
                catch (error) {
                    // A newer commit may have arrived while this one was in flight; that is the one worth retrying.
                    const newer = slot.pending;
                    slot.failedValue = newer ? newer.value : value;
                    slot.pending = undefined;
                    this.setState(slot, "failed");
                    if (error instanceof ContentRequestError && error.code === "conflict" && error.current) {
                        slot.conflict = error.current;
                        this.events.conflicted(slot, error.current);
                    }
                    else {
                        this.events.failed(slot, error);
                    }
                }
            }
        }
        finally {
            slot.scheduled = undefined;
        }
    }
    markTouched(slot) {
        const state = this.documents.get(slot.key);
        if (!state)
            return;
        state.touched = true;
        state.touchedPaths.add(slot.path);
        this.writeTouched();
    }
    setState(slot, state) {
        slot.state = state;
        this.events.stateChanged(slot);
    }
    // Session storage so a reload mid-edit still lists what was changed. Private windows and blocked storage throw;
    // the chrome then simply forgets on reload.
    readTouched() {
        try {
            const raw = globalThis.sessionStorage?.getItem(this.storageKey);
            const parsed = raw ? JSON.parse(raw) : {};
            if (parsed === null || typeof parsed !== "object")
                return {};
            const valid = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (Array.isArray(value) && value.every((path) => typeof path === "string"))
                    valid[key] = value;
            }
            return valid;
        }
        catch {
            return {};
        }
    }
    writeTouched() {
        const record = {};
        for (const [key, state] of this.documents)
            if (state.touched)
                record[key] = [...state.touchedPaths];
        try {
            globalThis.sessionStorage?.setItem(this.storageKey, JSON.stringify(record));
        }
        catch {
            // See readTouched.
        }
    }
}
//# sourceMappingURL=session.js.map