// The demo site: a plain node:http server on the real SQLite store, content handlers and document access, imported
// by package self-reference so they resolve to dist/. Run `npm run build` first, then `node examples/demo/server.ts`.
// Test hooks under /__test/* exist only with DEMO_TEST_HOOKS=1; see test-hooks.ts.
//
// Media: each tenant gets an in-memory test MediaStore (src/media-test-store.ts, run straight from src/: it has only
// type imports, and is handed dist's MediaRefusal). The media routes go to a second handlers instance with the
// `media` option; uploads stream in, everything else is buffered as before. Stored files are served at /media/<id>.
// POST /__test/media (test hooks only) flips the store's switches: { process: "sync" | "async", readyAfterPolls, fail,
// busy, retryAfterMs }, any subset; it answers the mode now in force.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { MediaRefusal } from "@yl/editor";
import { createContentHandlers, type ContentHandlers } from "@yl/editor/http";
import { createTestMediaStore, type TestMediaMode, type TestMediaStore } from "../../src/media-test-store.ts";
import { access, canEditAnything, registry, type Session } from "./content.ts";
import { renderPage } from "./render.ts";
import { richTextBundle } from "./richtext-bundle.ts";
import { TENANT_ID, existingTenant, tenantFor, type Tenant } from "./tenants.ts";
import { handleTestHook } from "./test-hooks.ts";
import { contentSecurityPolicy, html, json, notFound, sessionOf, tenantIdOf } from "./web.ts";

const PORT = Number(process.env["PORT"] ?? 4317);
// Loopback only: the test hooks can rewrite any tenant's database.
const HOST = "127.0.0.1";
const TEST_HOOKS = process.env["DEMO_TEST_HOOKS"] === "1";
const MAX_BODY = 1024 * 1024;
const MEDIA_MAX_BYTES = 40_000_000;
const MEDIA_ROUTES = new Set(["/api/content/media", "/api/content/media-job"]);

interface TenantMedia {
  store: TestMediaStore;
  handlers: ContentHandlers;
}

// Keyed by the tenant object, so a dropped or reset tenant starts with an empty media store too.
const tenantMedia = new WeakMap<Tenant, TenantMedia>();

function mediaFor(tenant: Tenant): TenantMedia {
  let media = tenantMedia.get(tenant);
  if (!media) {
    const store = createTestMediaStore({ MediaRefusal, maxBytes: MEDIA_MAX_BYTES });
    const handlers = createContentHandlers({
      store: tenant.store,
      registry,
      access,
      locals: (request) => sessionOf(request),
      actor: (locals) => (locals as Session).actor,
      media: { store, maxBytes: MEDIA_MAX_BYTES },
    });
    media = { store, handlers };
    tenantMedia.set(tenant, media);
  }
  return media;
}

const isMediaUpload = (method: string, url: string) =>
  method === "POST" && new URL(url).pathname === "/api/content/media";

async function setMediaMode(request: Request, tenant: Tenant): Promise<Response> {
  const { store } = mediaFor(tenant);
  const body = (await request.json().catch(() => ({}))) as Partial<TestMediaMode>;
  if (body.process === "sync" || body.process === "async") store.mode.process = body.process;
  if (typeof body.readyAfterPolls === "number") store.mode.readyAfterPolls = body.readyAfterPolls;
  if (typeof body.fail === "string" || body.fail === null) store.mode.fail = body.fail;
  if (typeof body.busy === "number") store.mode.busy = body.busy;
  if (typeof body.retryAfterMs === "number") store.mode.retryAfterMs = body.retryAfterMs;
  return json(store.mode);
}

function serveMedia(tenant: Tenant, id: string): Response {
  const file = mediaFor(tenant).store.file(id);
  if (!file) return notFound();
  return new Response(file.bytes as BlobPart, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
}

const publicDirectory = fileURLToPath(new URL("./public/", import.meta.url));
const distDirectory = fileURLToPath(new URL("../../dist/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function toRequest(message: IncomingMessage): Promise<Request> {
  const url = `http://${message.headers.host ?? `${HOST}:${PORT}`}${message.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = message.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  // An upload streams through to the handlers, which count its bytes against their own limit.
  if (isMediaUpload(method, url)) {
    const body = Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>;
    return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

async function send(response: Response, out: ServerResponse, tenantId: string): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  headers["content-security-policy"] = contentSecurityPolicy(tenantId);
  headers["x-content-type-options"] = "nosniff";
  headers["cache-control"] ??= "no-store";
  out.writeHead(response.status, headers);
  out.end(Buffer.from(await response.arrayBuffer()));
}

/** A file under `directory`, or null when the path escapes it or names nothing servable. */
async function staticFile(directory: string, relativePath: string): Promise<Response | null> {
  const type = CONTENT_TYPES[extname(relativePath)];
  if (!type) return null;
  const path = resolve(directory, relativePath);
  if (!path.startsWith(directory.endsWith(sep) ? directory : directory + sep)) return null;
  try {
    return new Response(await readFile(path), { headers: { "content-type": type, "cache-control": "no-cache" } });
  } catch {
    return null;
  }
}

async function renderHome(request: Request, tenant: Tenant): Promise<Response> {
  const url = new URL(request.url);
  const session = sessionOf(request);
  const editing = url.searchParams.get("edit") === "1" && canEditAnything(session);
  // Editors see drafts; visitors see what is live. Unvalidated, so a broken row renders instead of failing the page.
  const read = (key: string) => tenant.store.get(key, { draft: editing, unvalidated: true, includeRetired: editing });
  const lists = url.searchParams.get("lists") === "1";
  const rowlist = url.searchParams.get("rowlist") === "1";
  const groups = url.searchParams.get("groups") === "1";
  const [home, about, settings, team, crew] = await Promise.all([
    read("pages/home"),
    read("pages/about"),
    read("settings/site"),
    lists ? read("pages/team") : null,
    rowlist ? read("pages/crew") : null,
  ]);
  const scheduling = url.searchParams.get("scheduling") === "1";
  const richtextFallback = url.searchParams.get("richtext") === "fallback";
  return html(
    renderPage(
      { home, about, settings, team, crew },
      { session, editing, scheduling, richtextFallback, lists, rowlist, groups },
    ),
  );
}

async function recordCspReport(request: Request): Promise<Response> {
  const tenantId = new URL(request.url).searchParams.get("tenant") ?? "";
  let report: unknown;
  try {
    report = JSON.parse(await request.text());
  } catch {
    report = { unparsed: true };
  }
  const tenant = TENANT_ID.test(tenantId) ? existingTenant(tenantId) : undefined;
  if (tenant) tenant.cspReports.push(report);
  else console.warn(`[demo] CSP report for unknown tenant ${tenantId}: ${JSON.stringify(report)}`);
  return new Response(null, { status: 204 });
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const tenantId = tenantIdOf(request);

  if (pathname === "/healthz") return new Response("ok", { headers: { "content-type": "text/plain" } });
  if (pathname === "/__csp-report" && request.method === "POST") return recordCspReport(request);
  if (pathname === "/__test/media" && request.method === "POST")
    return TEST_HOOKS ? setMediaMode(request, await tenantFor(tenantId, sessionOf)) : notFound();
  if (pathname.startsWith("/__test/")) return TEST_HOOKS ? handleTestHook(request, tenantId) : notFound();
  if (MEDIA_ROUTES.has(pathname)) return mediaFor(await tenantFor(tenantId, sessionOf)).handlers.handle(request);
  if (pathname.startsWith("/api/content/")) return (await tenantFor(tenantId, sessionOf)).handlers.handle(request);
  if (request.method !== "GET") return notFound();
  if (pathname.startsWith("/media/"))
    return serveMedia(await tenantFor(tenantId, sessionOf), pathname.slice("/media/".length));
  if (pathname === "/") return renderHome(request, await tenantFor(tenantId, sessionOf));
  if (pathname === "/richtext.js") {
    return new Response(await richTextBundle(), {
      headers: { "content-type": CONTENT_TYPES[".js"] ?? "text/javascript", "cache-control": "no-cache" },
    });
  }
  if (pathname.startsWith("/pkg/")) {
    return (await staticFile(distDirectory, decodeURIComponent(pathname.slice("/pkg/".length)))) ?? notFound();
  }
  return (await staticFile(publicDirectory, decodeURIComponent(pathname.slice(1)))) ?? notFound();
}

const server = createServer((message, out) => {
  const tenantId = tenantIdOf(message);
  toRequest(message)
    .then(route)
    .catch((error: unknown) => {
      console.error("[demo]", error);
      return new Response("Internal error", { status: 500, headers: { "content-type": "text/plain" } });
    })
    .then((response) => send(response, out, tenantId))
    .catch((error: unknown) => {
      console.error("[demo] could not respond", error);
      out.destroy();
    });
});

// Node closes an idle keep-alive socket after 5s by default. A browser or Playwright request that reuses the socket just
// as it closes fails with ECONNRESET, and POSTs aren't retried: a pause of a few seconds mid-test (a slow step on a
// loaded machine) turned into a failed save. Outlast any one test's idle gaps instead.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 121_000;

server.listen(PORT, HOST, () => {
  console.log(`Demo on http://${HOST}:${PORT}/${TEST_HOOKS ? " (test hooks on)" : ""}`);
});
