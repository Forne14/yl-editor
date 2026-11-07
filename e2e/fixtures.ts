// The real-browser harness. Import `test` and `expect` from here, never from @playwright/test, so every test gets:
//
// - its own tenant: a fresh in-memory database with the default seed, behind the `demo-tenant` cookie;
// - a signed-in role (`test.use({ role: "contributor" })`; default "editor");
// - `demo`, typed helpers over the demo's /__test hooks and content API;
// - `guard`, which fails the test on any console error, page error or CSP violation, in the browser or reported to
//   the server, unless the test allowlisted it.
//
// Contexts opened with `demo.newContext()` share the tenant and are guarded too; never use `browser.newContext()`
// for pages under test, and never `bypassCSP`.
import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { ErrorEnvelope, PublishDueResponse } from "@yl/editor/http";
import type { Role } from "../examples/demo/content.ts";
import type { RawDocument, RawSeedDocument } from "../examples/demo/tenants.ts";

export { expect };
export type { Role, RawDocument };

export const TENANT_COOKIE = "demo-tenant";
const REQUESTED_WITH = { "x-requested-with": "yl-editor" };

/** A document to seed. `draft`/`published` are JSON-encoded; `draftPayload`/`publishedPayload` are stored as written. */
export interface SeedDocument extends RawSeedDocument {
  draft?: unknown;
  published?: unknown;
}

/** A row as stored, plus its payload columns parsed (`undefined` when the column is null or not valid JSON). */
export interface StoredRow extends RawDocument {
  draft: unknown;
  published: unknown;
}

export interface ContentResponse<T = unknown> {
  status: number;
  body: T | ErrorEnvelope;
}

/** One thing the guard caught. */
export interface GuardProblem {
  kind: "console" | "pageerror" | "csp" | "csp-report";
  text: string;
}

/**
 * Collects console errors, uncaught page errors and CSP violations from every context attached to it. `problems()`
 * is the detection function: everything caught minus the allowlisted console errors.
 */
export class Guard {
  private readonly caught: GuardProblem[] = [];
  private readonly allowed: (string | RegExp)[] = [];

  /** Expect a console error matching `pattern` (substring or RegExp). Page errors and CSP violations can't be allowed. */
  allowConsoleError(pattern: string | RegExp): void {
    this.allowed.push(pattern);
  }

  /** Browsers log a failed (4xx/5xx) request as a console error; allow that for a test that provokes one. */
  allowFailedRequests(): void {
    this.allowConsoleError(/Failed to load resource|the server responded with a status of \d{3}/);
  }

  record(problem: GuardProblem): void {
    this.caught.push(problem);
  }

  problems(): GuardProblem[] {
    return this.caught.filter(
      (problem) =>
        problem.kind !== "console" ||
        !this.allowed.some((pattern) =>
          typeof pattern === "string" ? problem.text.includes(pattern) : pattern.test(problem.text),
        ),
    );
  }

  async attach(context: BrowserContext): Promise<void> {
    context.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      this.record({ kind: "console", text: `${message.text()}${location.url ? ` (${location.url})` : ""}` });
    });
    context.on("weberror", (error) => {
      this.record({ kind: "pageerror", text: error.error().stack ?? error.error().message });
    });
    await context.exposeBinding("__demoCspViolation", (_source, violation: string) => {
      this.record({ kind: "csp", text: violation });
    });
    await context.addInitScript(() => {
      document.addEventListener(
        "securitypolicyviolation",
        (event) => {
          const report = (window as unknown as { __demoCspViolation?: (text: string) => void }).__demoCspViolation;
          report?.(
            `${event.effectiveDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile}:${event.lineNumber}`,
          );
        },
        true,
      );
    });
  }
}

const tenantId = (testId: string): string => `t-${testId}-${Math.random().toString(36).slice(2, 10)}`;

export interface Demo {
  /** This test's tenant id, the value of the `demo-tenant` cookie. */
  readonly tenant: string;
  /** Back to the default seed, or an empty database. Also clears CSP reports, recorded changes and the clock. */
  resetTenant(options?: { empty?: boolean }): Promise<void>;
  /** Signs `context` (default: the test's) in as `role` through `/__test/role`. Reload a page to see it. */
  setRole(role: Role, context?: BrowserContext): Promise<void>;
  /** Upserts documents with raw SQL (schema and CHECK constraints bypassed). Returns the rows as stored. */
  seed(...documents: SeedDocument[]): Promise<StoredRow[]>;
  /** Deletes documents by key, with their revisions. */
  deleteDocs(...keys: string[]): Promise<void>;
  /** The row as stored, with its revisions, or null when there is none. */
  readDoc(key: string): Promise<StoredRow | null>;
  /** `POST /api/content/publish-due` as `role` (default "cron"), with `now` in the body when given. */
  publishDue(options?: { now?: string; role?: Role }): Promise<ContentResponse<PublishDueResponse>>;
  /**
   * Any content API call, as `role` in this tenant, from outside the browser: e.g. another editor writing a field.
   * `route` is the part after /api/content/ (`"field"`, `"document?key=pages/home"`).
   */
  content<T = unknown>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options?: { role?: Role },
  ): Promise<ContentResponse<T>>;
  /** Fixes the store clock (ISO), or `null` for real time. The browser clock is Playwright's `page.clock`. */
  setClock(now: string | null): Promise<void>;
  /** CSP reports the server recorded for this tenant. */
  cspReports(): Promise<unknown[]>;
  /** Successful writes recorded through the handlers' `onChange`, oldest first. */
  changes(): Promise<{ action: string; key: string; actor?: string }[]>;
  /** A new guarded context in this tenant, signed in as `role` (default: the test's role). */
  newContext(options?: { role?: Role }): Promise<BrowserContext>;
  /** Opens the visitor page `/` on `page` (default: the test's page). */
  openVisitor(page?: Page): Promise<Page>;
  /**
   * Opens `/?edit=1` (with `scheduling=1` when asked) and waits until the chrome has mounted and its first load has
   * finished. On a new page of `context` when one is given.
   */
  openEditor(options?: { page?: Page; context?: BrowserContext; scheduling?: boolean }): Promise<Page>;
}

/** Waits for the island's `ready` (it sets `data-editor-ready` on <html>) and the bar. */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-editor-ready", "true");
  await expect(page.locator(".cms-bar")).toBeVisible();
}

const parse = (raw: string | null): unknown => {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

const withParsed = (row: RawDocument): StoredRow => ({
  ...row,
  draft: parse(row.draftPayload),
  published: parse(row.publishedPayload),
});

async function ok(response: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<unknown> {
  if (!response.ok()) throw new Error(`${what} failed: ${response.status()} ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

interface Internal {
  demo: Demo;
  dispose(): Promise<void>;
}

async function createDemo(
  browser: Browser,
  context: BrowserContext,
  page: Page,
  guard: Guard,
  tenant: string,
  defaultRole: Role,
  baseURL: string,
): Promise<Internal> {
  const hooks = context.request;
  const extraContexts: BrowserContext[] = [];
  const requestContexts: APIRequestContext[] = [];

  const asRole = async (role: Role): Promise<APIRequestContext> => {
    const api = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${TENANT_COOKIE}=${tenant}; demo-role=${role}`, ...REQUESTED_WITH },
    });
    requestContexts.push(api);
    return api;
  };

  const setRole = async (role: Role, target: BrowserContext = context): Promise<void> => {
    await ok(await target.request.post("/__test/role", { data: { role } }), "setRole");
  };

  const content = async <T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options: { role?: Role } = {},
  ): Promise<ContentResponse<T>> => {
    const api = await asRole(options.role ?? defaultRole);
    const url = `/api/content/${route}`;
    const response = method === "GET" ? await api.get(url) : await api.post(url, { data: body ?? {} });
    return { status: response.status(), body: (await response.json()) as T | ErrorEnvelope };
  };

  const demo: Demo = {
    tenant,
    async resetTenant(options = {}) {
      await ok(await hooks.post("/__test/reset", { data: { empty: options.empty === true } }), "resetTenant");
    },
    setRole,
    async seed(...documents) {
      const raw: RawSeedDocument[] = documents.map(({ draft, published, ...rest }) => ({
        ...rest,
        ...(draft !== undefined && rest.draftPayload === undefined ? { draftPayload: JSON.stringify(draft) } : {}),
        ...(published !== undefined && rest.publishedPayload === undefined
          ? { publishedPayload: JSON.stringify(published) }
          : {}),
      }));
      const result = (await ok(await hooks.post("/__test/seed", { data: { documents: raw } }), "seed")) as {
        documents: RawDocument[];
      };
      return result.documents.map(withParsed);
    },
    async deleteDocs(...keys) {
      await ok(await hooks.post("/__test/delete", { data: { keys } }), "deleteDocs");
    },
    async readDoc(key) {
      const response = await hooks.get(`/__test/doc?key=${encodeURIComponent(key)}`);
      if (response.status() === 404) return null;
      const { document } = (await ok(response, "readDoc")) as { document: RawDocument };
      return withParsed(document);
    },
    async publishDue(options = {}) {
      const body = options.now === undefined ? {} : { now: options.now };
      return content<PublishDueResponse>("POST", "publish-due", body, { role: options.role ?? "cron" });
    },
    content,
    async setClock(now) {
      await ok(await hooks.post("/__test/clock", { data: { now } }), "setClock");
    },
    async cspReports() {
      return ((await ok(await hooks.get("/__test/csp-reports"), "cspReports")) as { reports: unknown[] }).reports;
    },
    async changes() {
      return ((await ok(await hooks.get("/__test/changes"), "changes")) as { changes: [] }).changes;
    },
    async newContext(options = {}) {
      const extra = await browser.newContext({ baseURL });
      extraContexts.push(extra);
      await extra.addCookies([{ name: TENANT_COOKIE, value: tenant, url: baseURL }]);
      await guard.attach(extra);
      await setRole(options.role ?? defaultRole, extra);
      return extra;
    },
    async openVisitor(target = page) {
      await target.goto("/");
      return target;
    },
    async openEditor(options = {}) {
      const target = options.page ?? (options.context ? await options.context.newPage() : page);
      await target.goto(options.scheduling ? "/?edit=1&scheduling=1" : "/?edit=1");
      await waitForEditor(target);
      return target;
    },
  };

  return {
    demo,
    async dispose() {
      for (const api of requestContexts) await api.dispose();
      for (const extra of extraContexts) await extra.close();
    },
  };
}

interface Fixtures {
  /** The role the test's context is signed in as. Default "editor"; "anonymous" for nobody. */
  role: Role;
  guard: Guard;
  demo: Demo;
}

export const test = base.extend<Fixtures>({
  role: ["editor", { option: true }],

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
  guard: async ({}, use) => {
    await use(new Guard());
  },

  context: async ({ context, guard }, use) => {
    await guard.attach(context);
    await use(context);
  },

  // Automatic, so every test runs in its own tenant and under the guard even when it never names `demo`.
  demo: [
    async ({ browser, context, page, guard, role, baseURL }, use, testInfo) => {
      if (!baseURL) throw new Error("baseURL must be set in playwright.config.ts");
      const tenant = tenantId(testInfo.testId);
      await context.addCookies([{ name: TENANT_COOKIE, value: tenant, url: baseURL }]);
      const internal = await createDemo(browser, context, page, guard, tenant, role, baseURL);
      await internal.demo.resetTenant();
      await internal.demo.setRole(role);

      await use(internal.demo);

      // The browser-side listener sees violations at once; the server's reports are a second net for anything it missed.
      for (const report of await internal.demo.cspReports()) {
        guard.record({ kind: "csp-report", text: JSON.stringify(report) });
      }
      await context.request.post("/__test/drop");
      await internal.dispose();
      const problems = guard.problems();
      if (problems.length > 0) {
        throw new Error(
          `The guard caught ${problems.length} problem(s):\n${problems.map((p) => `  [${p.kind}] ${p.text}`).join("\n")}`,
        );
      }
    },
    { auto: true },
  ],
});
