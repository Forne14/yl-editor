import {
  DEFAULT_BASE,
  isErrorEnvelope,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  type DocumentsResponse,
  type DocumentSummary,
  type ErrorCode,
  type WireArrayOp,
  type WireDocument,
  type WireRevision,
} from "./wire-types.ts";

/** A non-2xx response from the content handlers, decoded from its error envelope. */
export class ContentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: unknown,
    readonly current?: WireDocument,
  ) {
    super(message);
    this.name = "ContentRequestError";
  }
}

export interface ContentClientOptions {
  /** Where the handlers are mounted. Default `/api/content`. */
  base?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export interface ContentClient {
  documents(keys: string[]): Promise<Record<string, DocumentSummary>>;
  field(key: string, path: string, value: unknown, expectedVersion?: number): Promise<WireDocument>;
  array(key: string, path: string, op: WireArrayOp, expectedVersion?: number): Promise<WireDocument>;
  publish(key: string): Promise<WireDocument>;
  discard(key: string): Promise<WireDocument | null>;
  retire(key: string): Promise<WireDocument>;
  restore(key: string): Promise<WireDocument>;
  rename(key: string, slug: string): Promise<WireDocument>;
  revisions(key: string): Promise<WireRevision[]>;
  create(type: string, slug: string, payload: unknown): Promise<WireDocument>;
}

async function decodeError(response: Response): Promise<ContentRequestError> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!isErrorEnvelope(body))
    return new ContentRequestError(response.status, "internal", `Request failed with status ${response.status}`);
  const { code, message, issues, current } = body.error;
  return new ContentRequestError(response.status, code, message, issues, current);
}

export function createContentClient(options: ContentClientOptions = {}): ContentClient {
  const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const send = async <Result>(method: "GET" | "POST", route: string, body?: unknown): Promise<Result> => {
    const headers: Record<string, string> = {
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetcher(`${base}/${route}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw await decodeError(response);
    return (await response.json()) as Result;
  };

  const post = async (route: string, body: unknown) =>
    (await send<{ document: WireDocument }>("POST", route, body)).document;

  return {
    documents: async (keys) => {
      if (keys.length === 0) return {};
      const query = new URLSearchParams({ keys: keys.join(",") });
      return (await send<DocumentsResponse>("GET", `documents?${query}`)).documents;
    },
    field: (key, path, value, expectedVersion) => post("field", { key, path, value, expectedVersion }),
    array: (key, path, op, expectedVersion) => post("array", { key, path, op, expectedVersion }),
    publish: (key) => post("publish", { key }),
    discard: async (key) => (await send<{ document: WireDocument | null }>("POST", "discard", { key })).document,
    retire: (key) => post("retire", { key }),
    restore: (key) => post("restore", { key }),
    rename: (key, slug) => post("rename", { key, slug }),
    revisions: async (key) =>
      (await send<{ revisions: WireRevision[] }>("GET", `revisions?${new URLSearchParams({ key })}`)).revisions,
    create: (type, slug, payload) => post("create", { type, slug, payload }),
  };
}
