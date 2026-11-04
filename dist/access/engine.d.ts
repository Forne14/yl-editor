import { type Atom } from "./atoms.ts";
import { type Catalogue, type RoleDefinition } from "./catalogue.ts";
import type { AccessVerdict } from "../types.ts";
/** A role named by its catalogue id, or a custom role's definition as the host stores it. */
export type RoleRef = string | RoleDefinition;
export interface ManagedPerson {
    /** The resolved atoms of the person's role (from `atomsOfRole`). */
    atoms: ReadonlySet<Atom>;
    isOwner: boolean;
    /** Whether the person is the actor. */
    isSelf: boolean;
}
export interface AccessEngine {
    readonly catalogue: Catalogue;
    /** The atoms as a set. Wildcards stay members; nothing is enumerated. */
    expand(atoms: readonly Atom[]): ReadonlySet<Atom>;
    /**
     * The atoms a holder of this role has. For every role but the owner's, the owner-reserved set is subtracted: a
     * wildcard that would confer a reserved atom is replaced by what it confers minus the reserved atoms. Malformed and
     * unknown atoms (a custom role naming an atom since removed) are dropped. Throws `RoleError` on an unknown id.
     */
    atomsOfRole(role: RoleRef): ReadonlySet<Atom>;
    /** Same as `holds`. */
    can(held: ReadonlySet<Atom>, atom: Atom): boolean;
    /** Every atom is conferred by `actor`; `family.*` only by `family.*` or `*`, and `*` only by `*`. */
    covers(actor: ReadonlySet<Atom>, atoms: Iterable<Atom>): boolean;
    /** atoms(role) ⊆ actor. */
    canAssignRole(actor: ReadonlySet<Atom>, role: RoleRef): AccessVerdict;
    /** Every atom known, not reserved, and held by the actor. */
    canAuthorRole(actor: ReadonlySet<Atom>, atoms: readonly Atom[]): AccessVerdict;
    /** Built-in roles are read-only; otherwise the actor must cover the old atoms and author the new ones. */
    canEditRole(actor: ReadonlySet<Atom>, role: RoleDefinition, next: readonly Atom[]): AccessVerdict;
    /** Built-in roles are read-only; otherwise the actor must cover the role's atoms. */
    canDeleteRole(actor: ReadonlySet<Atom>, role: RoleDefinition): AccessVerdict;
    /** Not the owner, not oneself, and the person's atoms ⊆ actor. */
    canManagePerson(actor: ReadonlySet<Atom>, target: ManagedPerson): AccessVerdict;
}
/**
 * Builds the policy decision point over a catalogue (validated here, so a bad catalogue fails at start-up). The
 * engine decides; it stores nothing and enforces nothing. The host checks its own gate atom (for instance
 * `roles.manage`) before asking these questions, and enforces the answer at the write.
 */
export declare function createAccessEngine(input: Catalogue): AccessEngine;
//# sourceMappingURL=engine.d.ts.map