import { z } from "zod";
import { type Atom } from "./atoms.ts";
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
/** The structural shape of a catalogue. `validateCatalogue` adds the cross-checks. */
export declare const CatalogueSchema: z.ZodType<Catalogue>;
/**
 * Parses and cross-checks a catalogue, throwing `CatalogueError` with every problem found. Beyond the shape:
 * atoms are well-formed, concrete (no wildcards) and unique, and their `family` matches their spelling; role ids
 * are unique; every role atom is a known atom or a wildcard over a known family; reserved atoms are known; no
 * non-owner role names a reserved atom; the owner role exists and holds `*`.
 */
export declare function validateCatalogue(input: unknown): Catalogue;
/** Why `atom` cannot appear in a role, or null when it can. */
export declare function roleAtomProblem(atom: Atom, knownAtoms: ReadonlySet<Atom>, families: ReadonlySet<string>): string | null;
//# sourceMappingURL=catalogue.d.ts.map