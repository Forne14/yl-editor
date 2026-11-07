// Request helpers shared by the server and the test hooks: cookies, the demo session, the CSP and response builders.
import type { IncomingMessage } from "node:http";
import { isRole, sessionFor, type Session } from "./content.ts";
import { DEFAULT_TENANT, TENANT_ID } from "./tenants.ts";

export const TENANT_COOKIE = "demo-tenant";
/** The demo's whole sign-in: which role this browser plays. */
export const ROLE_COOKIE = "demo-role";

export function cookies(request: Request | IncomingMessage): Map<string, string> {
  const header = request instanceof Request ? request.headers.get("cookie") : request.headers.cookie;
  const jar = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      jar.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // A malformed cookie is ignored, like a missing one.
    }
  }
  return jar;
}

export function sessionOf(request: Request): Session {
  const role = cookies(request).get(ROLE_COOKIE);
  return sessionFor(isRole(role) ? role : "anonymous");
}

export function tenantIdOf(request: Request | IncomingMessage): string {
  const id = cookies(request).get(TENANT_COOKIE);
  return id !== undefined && TENANT_ID.test(id) ? id : DEFAULT_TENANT;
}

/** The strict policy every response carries. Reports go to a per-tenant endpoint so tests can read their own. */
export function contentSecurityPolicy(tenantId: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `report-uri /__csp-report?tenant=${encodeURIComponent(tenantId)}`,
  ].join("; ");
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const notFound = (): Response =>
  new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
