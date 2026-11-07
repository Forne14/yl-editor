// Test-only routes under /__test/*. The server mounts them only with DEMO_TEST_HOOKS=1 and binds 127.0.0.1. They live
// in examples/demo and never in src/, so no consumer of the package can reach them. Each acts on the tenant named by
// the request's `demo-tenant` cookie. See e2e/fixtures.ts for the typed helpers that call them.
import { z } from "zod";
import { ROLES, isRole } from "./content.ts";
import { consoleErrorPage, consoleErrorScript, cspViolationPage } from "./render.ts";
import { deleteRaw, dropTenant, readRaw, resetTenant, seedRaw, tenantFor } from "./tenants.ts";
import { ROLE_COOKIE, html, json, notFound, sessionOf } from "./web.ts";

const text = z.string();
const nullableText = z.string().nullable().optional();

const SeedSchema = z.object({
  documents: z.array(
    z.object({
      key: text,
      type: text.optional(),
      draftPayload: nullableText,
      publishedPayload: nullableText,
      publishedAt: nullableText,
      draftUpdatedAt: nullableText,
      scheduledAt: nullableText,
      retiredAt: nullableText,
      previousSlugs: z.array(text).optional(),
      version: z.number().int().optional(),
      payloadVersion: z.number().int().optional(),
      revisions: z
        .array(
          z.object({
            action: text,
            payload: text,
            slug: text.optional(),
            actor: nullableText,
            createdAt: text.optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const ResetSchema = z.object({ empty: z.boolean().optional() });
const RoleSchema = z.object({ role: z.enum(ROLES) });
const DeleteSchema = z.object({ keys: z.array(text) });
const ClockSchema = z.object({ now: z.iso.datetime({ offset: true }).nullable() });

const roleCookie = (role: string) => `${ROLE_COOKIE}=${role}; Path=/; HttpOnly; SameSite=Lax`;

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown = {};
  const textBody = await request.text();
  if (textBody !== "") {
    try {
      raw = JSON.parse(textBody);
    } catch {
      return json({ error: "Body is not JSON" }, 400);
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : json({ error: "Bad body", issues: parsed.error.issues }, 400);
}

export async function handleTestHook(request: Request, tenantId: string): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.slice("/__test/".length)}`;

  switch (route) {
    case "POST reset": {
      const input = await body(request, ResetSchema);
      if (input instanceof Response) return input;
      await resetTenant(tenantId, sessionOf, input.empty === true);
      return json({ tenant: tenantId });
    }
    case "POST drop":
      return json({ dropped: dropTenant(tenantId) });
    case "POST role": {
      const input = await body(request, RoleSchema);
      if (input instanceof Response) return input;
      return json({ role: input.role }, 200, { "set-cookie": roleCookie(input.role) });
    }
    case "GET sign-in": {
      // For trying the demo by hand: /__test/sign-in?role=editor signs in and opens the editor.
      const role = url.searchParams.get("role");
      if (!isRole(role)) return json({ error: `role must be one of ${ROLES.join(", ")}` }, 400);
      return new Response(null, { status: 303, headers: { location: "/?edit=1", "set-cookie": roleCookie(role) } });
    }
    case "GET whoami":
      return json({ tenant: tenantId, role: sessionOf(request).role });
    case "POST seed": {
      const input = await body(request, SeedSchema);
      if (input instanceof Response) return input;
      const tenant = await tenantFor(tenantId, sessionOf);
      try {
        return json({ documents: seedRaw(tenant, input.documents) });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    case "POST delete": {
      const input = await body(request, DeleteSchema);
      if (input instanceof Response) return input;
      return json({ deleted: deleteRaw(await tenantFor(tenantId, sessionOf), input.keys) });
    }
    case "GET doc": {
      const key = url.searchParams.get("key");
      if (key === null) return json({ error: "key is required" }, 400);
      const document = readRaw(await tenantFor(tenantId, sessionOf), key);
      return document ? json({ document }) : json({ document: null }, 404);
    }
    case "GET csp-reports":
      return json({ reports: (await tenantFor(tenantId, sessionOf)).cspReports });
    case "GET changes":
      return json({ changes: (await tenantFor(tenantId, sessionOf)).changes });
    case "POST clock": {
      const input = await body(request, ClockSchema);
      if (input instanceof Response) return input;
      (await tenantFor(tenantId, sessionOf)).now = input.now === null ? null : new Date(input.now);
      return json({ now: input.now });
    }
    case "GET csp-violation":
      return html(cspViolationPage);
    case "GET console-error":
      return html(consoleErrorPage);
    case "GET console-error.js":
      return new Response(consoleErrorScript, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    default:
      return notFound();
  }
}
