// One in-memory SQLite database per tenant, so parallel tests never share state unless they share the cookie.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ContentStore } from "@yl/editor";
import { createContentHandlers } from "@yl/editor/http";
import { createSqliteContentStore } from "@yl/editor/sqlite";
import { access, defaultSeed, registry, type Session } from "./content.ts";

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

const migrations = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort()
  .map((fileName) => readFileSync(`${migrationsDirectory}${fileName}`, "utf8"));

export const TENANT_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const DEFAULT_TENANT = "default";

/** When the request carries no session (`locals` resolves it from the request). */
export type SessionOf = (request: Request) => Session;

export interface Tenant {
  id: string;
  db: Database.Database;
  store: ContentStore;
  handlers: ReturnType<typeof createContentHandlers>;
  /** CSP violation reports the browser sent for pages served to this tenant. */
  cspReports: unknown[];
  /** Every successful write, from the handlers' `onChange`. */
  changes: { action: string; key: string; actor: string | undefined }[];
  /** A fixed store clock set by `/__test/clock`, or null for the real time. */
  now: Date | null;
}

const tenants = new Map<string, Tenant>();

function openDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations) db.exec(migration);
  return db;
}

async function seedDefaults(store: ContentStore): Promise<void> {
  for (const document of defaultSeed) {
    const created = await store.create(document.type, document.slug, document.payload, { actor: "seed" });
    await store.publish(created.key, { actor: "seed" });
  }
}

async function createTenant(id: string, sessionOf: SessionOf, seed: boolean): Promise<Tenant> {
  const db = openDatabase();
  const tenant: Tenant = {
    id,
    db,
    store: undefined as unknown as ContentStore,
    handlers: undefined as unknown as Tenant["handlers"],
    cspReports: [],
    changes: [],
    now: null,
  };
  tenant.store = createSqliteContentStore(db, registry, () => tenant.now ?? new Date());
  tenant.handlers = createContentHandlers({
    store: tenant.store,
    registry,
    access,
    locals: (request) => sessionOf(request),
    actor: (locals) => (locals as Session).actor,
    onChange: (event) => {
      tenant.changes.push({ action: event.action, key: event.key, actor: event.actor });
    },
    publishDue: {
      authorize: (locals) =>
        (locals as Session).role === "cron" ? { allowed: true } : { allowed: false, reason: "Scheduler only" },
    },
  });
  if (seed) await seedDefaults(tenant.store);
  return tenant;
}

const pending = new Map<string, Promise<Tenant>>();

/** The tenant's state, created with the default seed on first use. */
export async function tenantFor(id: string, sessionOf: SessionOf): Promise<Tenant> {
  const existing = tenants.get(id);
  if (existing) return existing;
  let creating = pending.get(id);
  if (!creating) {
    creating = createTenant(id, sessionOf, true).then((tenant) => {
      tenants.set(id, tenant);
      pending.delete(id);
      return tenant;
    });
    pending.set(id, creating);
  }
  return creating;
}

/** Replaces the tenant with a fresh database: the default seed, or nothing at all with `empty`. */
export async function resetTenant(id: string, sessionOf: SessionOf, empty: boolean): Promise<Tenant> {
  await pending.get(id);
  tenants.get(id)?.db.close();
  const tenant = await createTenant(id, sessionOf, !empty);
  tenants.set(id, tenant);
  return tenant;
}

export function dropTenant(id: string): boolean {
  const tenant = tenants.get(id);
  if (!tenant) return false;
  tenant.db.close();
  tenants.delete(id);
  return true;
}

/** The tenant only if it already exists; CSP reports for an unknown tenant start it. */
export const existingTenant = (id: string): Tenant | undefined => tenants.get(id);

// Raw rows, for the test hooks. Payload columns are carried as the stored text so tests can see exactly what is there.

export interface RawRevision {
  id: number;
  action: string;
  slug: string;
  payload: string;
  actor: string | null;
  createdAt: string;
}

export interface RawDocument {
  id: number;
  key: string;
  type: string;
  slug: string;
  draftPayload: string | null;
  publishedPayload: string | null;
  publishedAt: string | null;
  draftUpdatedAt: string | null;
  previousSlugs: string;
  retiredAt: string | null;
  createdAt: string;
  version: number;
  payloadVersion: number;
  scheduledAt: string | null;
  revisions: RawRevision[];
}

export interface RawSeedRevision {
  action: string;
  payload: string;
  slug?: string;
  actor?: string | null;
  createdAt?: string;
}

/** One document as `/__test/seed` takes it. Anything left out gets the default named beside it. */
export interface RawSeedDocument {
  /** `<collection>/<slug>`. */
  key: string;
  /** Default: the registry type of the key's collection. */
  type?: string;
  /** Stored as written, even when it is not valid JSON. Default null. */
  draftPayload?: string | null;
  publishedPayload?: string | null;
  /** Default: now when a published payload is given, else null. */
  publishedAt?: string | null;
  /** Default: now when a draft payload is given, else null. */
  draftUpdatedAt?: string | null;
  scheduledAt?: string | null;
  retiredAt?: string | null;
  previousSlugs?: string[];
  /** Default 1. */
  version?: number;
  /** Default 1. */
  payloadVersion?: number;
  /** Replace the document's revisions with these. Default: none (existing revisions are deleted). */
  revisions?: RawSeedRevision[];
}

interface DocumentRow {
  id: number;
  key: string;
  type: string;
  slug: string;
  draft_payload: string | null;
  published_payload: string | null;
  published_at: string | null;
  draft_updated_at: string | null;
  previous_slugs: string;
  retired_at: string | null;
  created_at: string;
  version: number;
  payload_version: number;
  scheduled_at: string | null;
}

interface RevisionRow {
  id: number;
  action: string;
  slug: string;
  payload: string;
  actor: string | null;
  created_at: string;
}

export function readRaw(tenant: Tenant, key: string): RawDocument | null {
  const row = tenant.db.prepare<[string], DocumentRow>("SELECT * FROM documents WHERE key = ?").get(key);
  if (!row) return null;
  const revisions = tenant.db
    .prepare<[number], RevisionRow>("SELECT * FROM revisions WHERE document_id = ? ORDER BY id")
    .all(row.id);
  return {
    id: row.id,
    key: row.key,
    type: row.type,
    slug: row.slug,
    draftPayload: row.draft_payload,
    publishedPayload: row.published_payload,
    publishedAt: row.published_at,
    draftUpdatedAt: row.draft_updated_at,
    previousSlugs: row.previous_slugs,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    version: row.version,
    payloadVersion: row.payload_version,
    scheduledAt: row.scheduled_at,
    revisions: revisions.map((revision) => ({
      id: revision.id,
      action: revision.action,
      slug: revision.slug,
      payload: revision.payload,
      actor: revision.actor,
      createdAt: revision.created_at,
    })),
  };
}

/**
 * Upserts documents with raw SQL, bypassing the store and the schema. CHECK constraints are switched off for the
 * write, so a payload may be malformed JSON and a row may have neither payload: tests use this to build the broken
 * states the editor must survive. The row keeps its id when the key exists.
 */
export function seedRaw(tenant: Tenant, documents: readonly RawSeedDocument[]): RawDocument[] {
  const { db } = tenant;
  const now = (tenant.now ?? new Date()).toISOString();
  const upsert = db.prepare(`
    INSERT INTO documents (key, type, slug, draft_payload, published_payload, published_at, draft_updated_at,
      previous_slugs, retired_at, created_at, version, payload_version, scheduled_at)
    VALUES (@key, @type, @slug, @draftPayload, @publishedPayload, @publishedAt, @draftUpdatedAt,
      @previousSlugs, @retiredAt, @createdAt, @version, @payloadVersion, @scheduledAt)
    ON CONFLICT (key) DO UPDATE SET type = excluded.type, slug = excluded.slug,
      draft_payload = excluded.draft_payload, published_payload = excluded.published_payload,
      published_at = excluded.published_at, draft_updated_at = excluded.draft_updated_at,
      previous_slugs = excluded.previous_slugs, retired_at = excluded.retired_at, version = excluded.version,
      payload_version = excluded.payload_version, scheduled_at = excluded.scheduled_at`);
  const idOf = db.prepare<[string], { id: number }>("SELECT id FROM documents WHERE key = ?");
  const clearRevisions = db.prepare<[number]>("DELETE FROM revisions WHERE document_id = ?");
  const insertRevision = db.prepare(`
    INSERT INTO revisions (document_id, action, slug, payload, created_at, actor)
    VALUES (@documentId, @action, @slug, @payload, @createdAt, @actor)`);

  const write = db.transaction((items: readonly RawSeedDocument[]) => {
    for (const item of items) {
      const separator = item.key.indexOf("/");
      if (separator <= 0 || separator === item.key.length - 1) throw new Error(`Bad key ${item.key}`);
      const collection = item.key.slice(0, separator);
      const slug = item.key.slice(separator + 1);
      const type = item.type ?? registry.byCollection(collection)?.type;
      if (!type) throw new Error(`No type for collection ${collection}; pass type`);
      const draftPayload = item.draftPayload ?? null;
      const publishedPayload = item.publishedPayload ?? null;
      upsert.run({
        key: item.key,
        type,
        slug,
        draftPayload,
        publishedPayload,
        publishedAt: item.publishedAt !== undefined ? item.publishedAt : publishedPayload === null ? null : now,
        draftUpdatedAt: item.draftUpdatedAt !== undefined ? item.draftUpdatedAt : draftPayload === null ? null : now,
        previousSlugs: JSON.stringify(item.previousSlugs ?? []),
        retiredAt: item.retiredAt ?? null,
        createdAt: now,
        version: item.version ?? 1,
        payloadVersion: item.payloadVersion ?? 1,
        scheduledAt: item.scheduledAt ?? null,
      });
      const id = idOf.get(item.key)!.id;
      clearRevisions.run(id);
      for (const revision of item.revisions ?? []) {
        insertRevision.run({
          documentId: id,
          action: revision.action,
          slug: revision.slug ?? slug,
          payload: revision.payload,
          createdAt: revision.createdAt ?? now,
          actor: revision.actor ?? null,
        });
      }
    }
  });

  db.pragma("ignore_check_constraints = ON");
  try {
    write(documents);
  } finally {
    db.pragma("ignore_check_constraints = OFF");
  }
  return documents.map((item) => readRaw(tenant, item.key)!);
}

/** Removes documents by key, with their revisions. */
export function deleteRaw(tenant: Tenant, keys: readonly string[]): number {
  const remove = tenant.db.prepare<[string]>("DELETE FROM documents WHERE key = ?");
  let removed = 0;
  for (const key of keys) removed += remove.run(key).changes;
  return removed;
}
