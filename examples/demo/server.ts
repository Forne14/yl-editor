// The demo site: a plain node:http server on the real SQLite store, content handlers and document access, imported
// by package self-reference so they resolve to dist/. Run `npm run build` first, then `node examples/demo/server.ts`.
// Test hooks under /__test/* exist only with DEMO_TEST_HOOKS=1; see test-hooks.ts.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canEditAnything } from "./content.ts";
import { renderPage } from "./render.ts";
import { TENANT_ID, existingTenant, tenantFor, type Tenant } from "./tenants.ts";
import { handleTestHook } from "./test-hooks.ts";
import { contentSecurityPolicy, html, notFound, sessionOf, tenantIdOf } from "./web.ts";

const PORT = Number(process.env["PORT"] ?? 4317);
// Loopback only: the test hooks can rewrite any tenant's database.
const HOST = "127.0.0.1";
const TEST_HOOKS = process.env["DEMO_TEST_HOOKS"] === "1";
const MAX_BODY = 1024 * 1024;

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
  const [home, about, settings] = await Promise.all([read("pages/home"), read("pages/about"), read("settings/site")]);
  const scheduling = url.searchParams.get("scheduling") === "1";
  return html(renderPage({ home, about, settings }, { session, editing, scheduling }));
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
  if (pathname.startsWith("/__test/")) return TEST_HOOKS ? handleTestHook(request, tenantId) : notFound();
  if (pathname.startsWith("/api/content/")) return (await tenantFor(tenantId, sessionOf)).handlers.handle(request);
  if (request.method !== "GET") return notFound();
  if (pathname === "/") return renderHome(request, await tenantFor(tenantId, sessionOf));
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

server.listen(PORT, HOST, () => {
  console.log(`Demo on http://${HOST}:${PORT}/${TEST_HOOKS ? " (test hooks on)" : ""}`);
});
