import { z } from "zod";
import { ALL, type Atom, tryParseAtom } from "./atoms.ts";
import { CatalogueError } from "./errors.ts";

/** One gated action, with the plain-English label a role builder shows. */
export interface AtomDefinition {
  atom: Atom;
  label: string;
  family: string;
}

/** A named bundle of atoms. `line` is the one-line description a role picker shows. */
export interface RoleDefinition {
  id: string;
  label: string;
  line: string;
  atoms: readonly Atom[];
  builtin: boolean;
}

/**
 * A host's permission vocabulary: its atoms, the owner-reserved set, and its built-in roles. Code-defined reference
 * data; custom roles are stored by the host and passed to the engine as `RoleDefinition`s.
 */
export interface Catalogue {
  atoms: readonly AtomDefinition[];
  ownerReserved: readonly Atom[];
  ownerRoleId: string;
  roles: readonly RoleDefinition[];
}

const text = z.string().min(1);

/** The structural shape of a catalogue. `validateCatalogue` adds the cross-checks. */
export const CatalogueSchema: z.ZodType<Catalogue> = z.object({
  atoms: z.array(z.object({ atom: text, label: text, family: text })),
  ownerReserved: z.array(text),
  ownerRoleId: text,
  roles: z.array(z.object({ id: text, label: text, line: z.string(), atoms: z.array(text), builtin: z.boolean() })),
});

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) (seen.has(value) ? repeated : seen).add(value);
  return [...repeated];
}

/**
 * Parses and cross-checks a catalogue, throwing `CatalogueError` with every problem found. Beyond the shape:
 * atoms are well-formed, concrete (no wildcards) and unique, and their `family` matches their spelling; role ids
 * are unique; every role atom is a known atom or a wildcard over a known family; reserved atoms are known; no
 * non-owner role names a reserved atom; the owner role exists and holds `*`.
 */
export function validateCatalogue(input: unknown): Catalogue {
  const parsed = CatalogueSchema.safeParse(input);
  if (!parsed.success) {
    throw new CatalogueError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "catalogue"}: ${issue.message}`),
    );
  }
  const catalogue = parsed.data;
  const problems: string[] = [];

  const knownAtoms = new Set<Atom>();
  const families = new Set<string>();
  for (const definition of catalogue.atoms) {
    const atom = tryParseAtom(definition.atom);
    if (atom === null) {
      problems.push(`atom ${definition.atom} is malformed`);
      continue;
    }
    if (atom.wildcard !== null) {
      problems.push(`atom ${definition.atom} is a wildcard; the catalogue lists concrete atoms only`);
      continue;
    }
    if (atom.family !== definition.family) {
      problems.push(`atom ${definition.atom} declares family ${definition.family}`);
    }
    knownAtoms.add(definition.atom);
    families.add(atom.family);
  }
  for (const atom of duplicates(catalogue.atoms.map((definition) => definition.atom))) {
    problems.push(`atom ${atom} is defined more than once`);
  }
  for (const roleId of duplicates(catalogue.roles.map((role) => role.id))) {
    problems.push(`role ${roleId} is defined more than once`);
  }

  const reserved = new Set(catalogue.ownerReserved);
  for (const atom of reserved) {
    if (!knownAtoms.has(atom)) problems.push(`reserved atom ${atom} is not a known atom`);
  }

  for (const role of catalogue.roles) {
    for (const atom of role.atoms) {
      const problem = roleAtomProblem(atom, knownAtoms, families);
      if (problem !== null) problems.push(`role ${role.id}: ${problem}`);
      else if (role.id !== catalogue.ownerRoleId && reserved.has(atom)) {
        problems.push(`role ${role.id}: holds owner-reserved atom ${atom}`);
      }
    }
  }

  const owner = catalogue.roles.find((role) => role.id === catalogue.ownerRoleId);
  if (owner === undefined) problems.push(`owner role ${catalogue.ownerRoleId} is not defined`);
  else {
    if (!owner.atoms.includes(ALL)) problems.push(`owner role ${owner.id} must hold ${ALL}`);
    if (!owner.builtin) problems.push(`owner role ${owner.id} must be built-in`);
  }

  if (problems.length > 0) throw new CatalogueError(problems);
  return catalogue;
}

/** Why `atom` cannot appear in a role, or null when it can. */
export function roleAtomProblem(
  atom: Atom,
  knownAtoms: ReadonlySet<Atom>,
  families: ReadonlySet<string>,
): string | null {
  const parsed = tryParseAtom(atom);
  if (parsed === null) return `malformed atom ${atom}`;
  if (parsed.wildcard === "all") return null;
  if (parsed.wildcard === "family") return families.has(parsed.family) ? null : `unknown atom ${atom}`;
  return knownAtoms.has(atom) ? null : `unknown atom ${atom}`;
}
