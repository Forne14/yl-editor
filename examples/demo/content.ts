// The demo site's content model: two document types, their schemas, the default seed, and who may do what.
import { createAccessEngine, documentAccess, type Catalogue } from "@yl/editor/access";
import type { RegistryEntry, SchemaRegistry } from "@yl/editor";
import { z } from "zod";

export const STATUS_OPTIONS = ["draft", "live", "archived"] as const;

/** Lenient on purpose: every value a default widget can commit validates, so only raw seeds make invalid drafts. */
export const pageSchema = z.object({
  title: z.string(),
  lede: z.string().optional(),
  live: z.boolean().optional(),
  status: z.enum(STATUS_OPTIONS).optional(),
  price: z.number().nullable().optional(),
  tags: z.array(z.string()).optional(),
  date: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  body: z.string().optional(),
});

export const settingsSchema = z.object({ footer: z.string() });

const entries: RegistryEntry[] = [
  { type: "page", collection: "pages", schema: pageSchema },
  { type: "settings", collection: "settings", schema: settingsSchema },
];

export const registry: SchemaRegistry = {
  entry: (type) => entries.find((entry) => entry.type === type),
  byCollection: (collection) => entries.find((entry) => entry.collection === collection),
  entries: () => entries,
};

export interface SeedContent {
  type: string;
  slug: string;
  payload: Record<string, unknown>;
}

/** What every new or reset tenant starts with. Each document is created and then published. */
export const defaultSeed: readonly SeedContent[] = [
  {
    type: "page",
    slug: "home",
    payload: {
      title: "Welcome to the demo",
      lede: "<p>Fresh bread <strong>every morning</strong>.</p>",
      live: true,
      status: "live",
      price: 12,
      tags: ["bakery", "local"],
      date: "2026-11-14",
      link: "https://example.com/menu",
    },
  },
  { type: "page", slug: "about", payload: { title: "About us", body: "A small bakery on the corner." } },
  { type: "settings", slug: "site", payload: { footer: "Demo Bakery Ltd" } },
];

// `anonymous` is nobody signed in; `cron` is the scheduler, which may only run publish-due.
export const ROLES = ["anonymous", "contributor", "editor", "owner", "cron"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  anonymous: "Visitor",
  contributor: "Contributor",
  editor: "Editor",
  owner: "Owner",
  cron: "Scheduler",
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && ROLES.includes(value as Role);

const atom = (name: string, label: string) => ({ atom: name, label, family: name.split(".")[0] ?? name });

const catalogue: Catalogue = {
  atoms: [
    atom("pages.edit", "Change page copy as a draft"),
    atom("pages.publish", "Put page changes live"),
    atom("settings.manage", "Change site settings"),
    atom("owner.transfer", "Transfer ownership"),
  ],
  ownerReserved: ["owner.transfer"],
  ownerRoleId: "owner",
  roles: [
    { id: "owner", label: "Owner", line: "Everything", atoms: ["*"], builtin: true },
    { id: "editor", label: "Editor", line: "Edits and publishes pages", atoms: ["pages.*"], builtin: true },
    { id: "contributor", label: "Contributor", line: "Edits pages", atoms: ["pages.edit"], builtin: true },
    { id: "cron", label: "Scheduler", line: "Runs scheduled publishes", atoms: [], builtin: true },
  ],
};

const engine = createAccessEngine(catalogue);

export interface Session {
  role: Role;
  /** Resolved once per request, as a host would at sign-in. Null for nobody signed in. */
  atoms: ReadonlySet<string> | null;
  actor: string | undefined;
}

export function sessionFor(role: Role): Session {
  if (role === "anonymous") return { role, atoms: null, actor: undefined };
  return { role, atoms: engine.atomsOfRole(role), actor: `${ROLE_LABELS[role]} (demo)` };
}

/** True when the role may edit at least one document type, so `?edit=1` renders the editor. */
export function canEditAnything(session: Session): boolean {
  if (session.atoms === null) return false;
  return engine.can(session.atoms, "pages.edit") || engine.can(session.atoms, "settings.manage");
}

export const access = documentAccess({
  atomsOf: (locals) => (locals as Session | null)?.atoms ?? null,
  map: {
    page: { edit: "pages.edit", publish: "pages.publish" },
    settings: { edit: "settings.manage", publish: "settings.manage" },
  },
});
