// The only module that speaks HTTP. Every request follows the wire contract in docs/chrome.md: same-origin
// credentials, JSON bodies, and the `X-Requested-With` header the server uses as a cheap CSRF guard.
import type { DocumentSummary, ErrorCode, WireDocument, WireRevision } from "./types.ts";

export type ArrayOperation =
  | { kind: "insert"; index: number; value: unknown }
  | { kind: "move"; from: number; to: number }
  | { kind: "remove"; index: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly current?: WireDocument,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: { code?: ErrorCode; message?: string; issues?: unknown; current?: WireDocument };
}

export interface ContentClient {
  documents(keys: readonly string[]): Promise<Record<string, DocumentSummary>>;
  writeField(key: string, path: string, value: unknown, expectedVersion?: number): Promise<WireDocument>;
  arrayOp(key: string, path: string, op: ArrayOperation, expectedVersion?: number): Promise<WireDocument>;
  publish(key: string): Promise<WireDocument>;
  discard(key: string): Promise<WireDocument | null>;
  retire(key: string): Promise<WireDocument>;
  restore(key: string): Promise<WireDocument>;
  rename(key: string, slug: string): Promise<WireDocument>;
  revisions(key: string): Promise<WireRevision[]>;
}

export function createClient(base = "/api/content"): ContentClient {
  const root = base.replace(/\/+$/, "");

  async function request<Result>(method: "GET" | "POST", route: string, body?: unknown): Promise<Result> {
    let response: Response;
    try {
      response = await fetch(`${root}${route}`, {
        method,
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "yl-editor" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError(0, "network", cause instanceof Error ? cause.message : "Network error");
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = (parsed as ErrorBody | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "bad_request",
        error?.message ?? `HTTP ${response.status}`,
        error?.current,
        error?.issues,
      );
    }
    return parsed as Result;
  }

  const post = <Result>(route: string, body: unknown) => request<Result>("POST", route, body);
  const documentOf = async (route: string, body: unknown) =>
    (await post<{ document: WireDocument }>(route, body)).document;

  return {
    async documents(keys) {
      const query = keys.map(encodeURIComponent).join(",");
      return (await request<{ documents: Record<string, DocumentSummary> }>("GET", `/documents?keys=${query}`))
        .documents;
    },
    writeField: (key, path, value, expectedVersion) => documentOf("/field", { key, path, value, expectedVersion }),
    arrayOp: (key, path, op, expectedVersion) => documentOf("/array", { key, path, op, expectedVersion }),
    publish: (key) => documentOf("/publish", { key }),
    async discard(key) {
      return (await post<{ document: WireDocument | null }>("/discard", { key })).document;
    },
    retire: (key) => documentOf("/retire", { key }),
    restore: (key) => documentOf("/restore", { key }),
    rename: (key, slug) => documentOf("/rename", { key, slug }),
    async revisions(key) {
      return (await request<{ revisions: WireRevision[] }>("GET", `/revisions?key=${encodeURIComponent(key)}`))
        .revisions;
    },
  };
}
