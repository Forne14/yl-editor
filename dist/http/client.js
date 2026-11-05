import { DEFAULT_BASE, isErrorEnvelope, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, } from "./wire-types.js";
/** A non-2xx response from the content handlers, decoded from its error envelope. */
export class ContentRequestError extends Error {
    status;
    code;
    issues;
    current;
    constructor(status, code, message, issues, current) {
        super(message);
        this.status = status;
        this.code = code;
        this.issues = issues;
        this.current = current;
        this.name = "ContentRequestError";
    }
}
async function decodeError(response) {
    const body = await response.json().catch(() => undefined);
    if (!isErrorEnvelope(body))
        return new ContentRequestError(response.status, "internal", `Request failed with status ${response.status}`);
    const { code, message, issues, current } = body.error;
    return new ContentRequestError(response.status, code, message, issues, current);
}
export function createContentClient(options = {}) {
    const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");
    const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const send = async (method, route, body) => {
        const headers = {
            [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
            Accept: "application/json",
        };
        if (body !== undefined)
            headers["Content-Type"] = "application/json";
        const response = await fetcher(`${base}/${route}`, {
            method,
            headers,
            credentials: "same-origin",
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok)
            throw await decodeError(response);
        return (await response.json());
    };
    const post = async (route, body) => (await send("POST", route, body)).document;
    const read = (key) => send("GET", `document?${new URLSearchParams({ key })}`);
    return {
        documents: async (keys) => {
            if (keys.length === 0)
                return {};
            const query = new URLSearchParams({ keys: keys.join(",") });
            return (await send("GET", `documents?${query}`)).documents;
        },
        field: (key, path, value, expectedVersion) => post("field", { key, path, value, expectedVersion }),
        array: (key, path, op, expectedVersion) => post("array", { key, path, op, expectedVersion }),
        document: async (key) => (await read(key)).document,
        documentForPublish: read,
        publish: (key, publishOptions) => post("publish", publishOptions?.at !== undefined ? { key, at: publishOptions.at } : { key }),
        unpublish: (key) => post("unpublish", { key }),
        restoreRevision: (key, revisionId) => post("restore-revision", { key, revisionId }),
        publishDue: async (now) => (await send("POST", "publish-due", now !== undefined ? { now } : {})).documents,
        discard: async (key) => (await send("POST", "discard", { key })).document,
        retire: (key) => post("retire", { key }),
        restore: (key) => post("restore", { key }),
        rename: (key, slug) => post("rename", { key, slug }),
        revisions: async (key) => (await send("GET", `revisions?${new URLSearchParams({ key })}`)).revisions,
        create: (type, slug, payload) => post("create", { type, slug, payload }),
    };
}
//# sourceMappingURL=client.js.map