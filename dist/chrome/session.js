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
            const existing = this.documents.get(key);
            const rememberedPaths = summary.isDraft ? (remembered[key] ?? []) : [];
            const touchedPaths = new Set([...(existing?.touchedPaths ?? []), ...rememberedPaths]);
            this.documents.set(key, {
                key,
                type: summary.type,
                version: summary.version,
                isDraft: summary.isDraft,
                access: { edit: summary.access.edit === true, publish: summary.access.publish === true },
                payload: existing?.payload,
                touched: touchedPaths.size > 0,
                touchedPaths,
            });
        }
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
        }
        state.touched = false;
        state.touchedPaths.clear();
        this.writeTouched();
    }
    adopt(document) {
        const state = this.documents.get(document.key);
        if (!state)
            return;
        state.version = document.version;
        state.isDraft = document.isDraft;
        state.payload = document.payload;
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