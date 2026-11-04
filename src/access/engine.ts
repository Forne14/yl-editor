import { type Atom, familyWildcard, holds, tryParseAtom } from "./atoms.ts";
import { type Catalogue, type RoleDefinition, roleAtomProblem, validateCatalogue } from "./catalogue.ts";
import { RoleError } from "./errors.ts";
import type { AccessVerdict } from "./types.ts";
import { allow, deny, reasons } from "./verdict.ts";

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
export function createAccessEngine(input: Catalogue): AccessEngine {
  const catalogue = validateCatalogue(input);
  const knownAtoms = new Set(catalogue.atoms.map((definition) => definition.atom));
  const reserved = new Set(catalogue.ownerReserved);
  const builtins = new Map(catalogue.roles.map((role) => [role.id, role]));

  const atomsByFamily = new Map<string, Atom[]>();
  for (const definition of catalogue.atoms) {
    const members = atomsByFamily.get(definition.family) ?? [];
    members.push(definition.atom);
    atomsByFamily.set(definition.family, members);
  }
  const families = new Set(atomsByFamily.keys());

  /** What `family.*` confers once the reserved set is taken out. */
  function familyWithoutReserved(family: string): Atom[] {
    const members = atomsByFamily.get(family) ?? [];
    if (!members.some((atom) => reserved.has(atom))) return [familyWildcard(family)];
    return members.filter((atom) => !reserved.has(atom));
  }

  function resolve(role: RoleRef): RoleDefinition {
    if (typeof role === "string") {
      const builtin = builtins.get(role);
      if (builtin === undefined) throw new RoleError(role, "unknown role");
      return builtin;
    }
    const builtin = builtins.get(role.id);
    if (builtin !== undefined) {
      // A stored role reusing a built-in id must not smuggle in other atoms (or the owner's reserved set).
      if (builtin !== role && !sameAtoms(builtin.atoms, role.atoms)) {
        throw new RoleError(role.id, "a custom role cannot reuse a built-in role's id");
      }
      return builtin;
    }
    return role;
  }

  function isBuiltin(role: RoleDefinition): boolean {
    return role.builtin || builtins.has(role.id);
  }

  function atomsOfRole(role: RoleRef): ReadonlySet<Atom> {
    const definition = resolve(role);
    const isOwnerRole = isBuiltin(definition) && definition.id === catalogue.ownerRoleId;
    const resolved = new Set<Atom>();
    for (const atom of definition.atoms) {
      if (roleAtomProblem(atom, knownAtoms, families) !== null) continue;
      if (isOwnerRole) {
        resolved.add(atom);
        continue;
      }
      if (reserved.has(atom)) continue;
      const parsed = tryParseAtom(atom);
      if (parsed?.wildcard === "all") {
        for (const family of families) for (const conferred of familyWithoutReserved(family)) resolved.add(conferred);
      } else if (parsed?.wildcard === "family") {
        for (const conferred of familyWithoutReserved(parsed.family)) resolved.add(conferred);
      } else {
        resolved.add(atom);
      }
    }
    return resolved;
  }

  function firstUncovered(actor: ReadonlySet<Atom>, atoms: Iterable<Atom>): Atom | null {
    for (const atom of atoms) if (!holds(actor, atom)) return atom;
    return null;
  }

  function coverVerdict(actor: ReadonlySet<Atom>, atoms: Iterable<Atom>): AccessVerdict {
    const missing = firstUncovered(actor, atoms);
    return missing === null ? allow() : deny(reasons.missing(missing));
  }

  function canAuthorRole(actor: ReadonlySet<Atom>, atoms: readonly Atom[]): AccessVerdict {
    for (const atom of atoms) {
      if (tryParseAtom(atom) === null) return deny(reasons.malformedAtom(atom));
      if (roleAtomProblem(atom, knownAtoms, families) !== null) return deny(reasons.unknownAtom(atom));
      if (reserved.has(atom)) return deny(reasons.reserved(atom));
    }
    return coverVerdict(actor, atoms);
  }

  return {
    catalogue,
    expand: (atoms) => new Set(atoms),
    atomsOfRole,
    can: holds,
    covers: (actor, atoms) => firstUncovered(actor, atoms) === null,
    canAssignRole: (actor, role) => coverVerdict(actor, atomsOfRole(role)),
    canAuthorRole,
    canEditRole(actor, role, next) {
      if (isBuiltin(role)) return deny(reasons.builtinReadOnly);
      const old = coverVerdict(actor, atomsOfRole(role));
      if (!old.allowed) return old;
      return canAuthorRole(actor, next);
    },
    canDeleteRole(actor, role) {
      if (isBuiltin(role)) return deny(reasons.builtinReadOnly);
      return coverVerdict(actor, atomsOfRole(role));
    },
    canManagePerson(actor, target) {
      if (target.isOwner) return deny(reasons.owner);
      if (target.isSelf) return deny(reasons.self);
      return coverVerdict(actor, target.atoms);
    },
  };
}

function sameAtoms(left: readonly Atom[], right: readonly Atom[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((atom) => rightSet.has(atom));
}
