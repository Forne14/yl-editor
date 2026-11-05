import { familyWildcard, holds, tryParseAtom } from "./atoms.js";
import { roleAtomProblem, validateCatalogue } from "./catalogue.js";
import { RoleError } from "./errors.js";
import { allow, deny, reasons } from "./verdict.js";
/**
 * Builds the policy decision point over a catalogue (validated here, so a bad catalogue fails at start-up). The
 * engine decides; it stores nothing and enforces nothing. The host checks its own gate atom (for instance
 * `roles.manage`) before asking these questions, and enforces the answer at the write.
 */
export function createAccessEngine(input) {
    const catalogue = validateCatalogue(input);
    const knownAtoms = new Set(catalogue.atoms.map((definition) => definition.atom));
    const reserved = new Set(catalogue.ownerReserved);
    const builtins = new Map(catalogue.roles.map((role) => [role.id, role]));
    const atomsByFamily = new Map();
    for (const definition of catalogue.atoms) {
        const members = atomsByFamily.get(definition.family) ?? [];
        members.push(definition.atom);
        atomsByFamily.set(definition.family, members);
    }
    const families = new Set(atomsByFamily.keys());
    /** What `family.*` confers once the reserved set is taken out. */
    function familyWithoutReserved(family) {
        const members = atomsByFamily.get(family) ?? [];
        if (!members.some((atom) => reserved.has(atom)))
            return [familyWildcard(family)];
        return members.filter((atom) => !reserved.has(atom));
    }
    function resolve(role) {
        if (typeof role === "string") {
            const builtin = builtins.get(role);
            if (builtin === undefined)
                throw new RoleError(role, "unknown role");
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
    function isBuiltin(role) {
        return role.builtin || builtins.has(role.id);
    }
    function atomsOfRole(role) {
        const definition = resolve(role);
        const isOwnerRole = isBuiltin(definition) && definition.id === catalogue.ownerRoleId;
        const resolved = new Set();
        for (const atom of definition.atoms) {
            if (roleAtomProblem(atom, knownAtoms, families) !== null)
                continue;
            if (isOwnerRole) {
                resolved.add(atom);
                continue;
            }
            if (reserved.has(atom))
                continue;
            const parsed = tryParseAtom(atom);
            if (parsed?.wildcard === "all") {
                for (const family of families)
                    for (const conferred of familyWithoutReserved(family))
                        resolved.add(conferred);
            }
            else if (parsed?.wildcard === "family") {
                for (const conferred of familyWithoutReserved(parsed.family))
                    resolved.add(conferred);
            }
            else {
                resolved.add(atom);
            }
        }
        return resolved;
    }
    function firstUncovered(actor, atoms) {
        for (const atom of atoms)
            if (!holds(actor, atom))
                return atom;
        return null;
    }
    function coverVerdict(actor, atoms) {
        const missing = firstUncovered(actor, atoms);
        return missing === null ? allow() : deny(reasons.missing(missing));
    }
    function canAuthorRole(actor, atoms) {
        for (const atom of atoms) {
            if (tryParseAtom(atom) === null)
                return deny(reasons.malformedAtom(atom));
            if (roleAtomProblem(atom, knownAtoms, families) !== null)
                return deny(reasons.unknownAtom(atom));
            if (reserved.has(atom))
                return deny(reasons.reserved(atom));
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
            if (isBuiltin(role))
                return deny(reasons.builtinReadOnly);
            const old = coverVerdict(actor, atomsOfRole(role));
            if (!old.allowed)
                return old;
            return canAuthorRole(actor, next);
        },
        canDeleteRole(actor, role) {
            if (isBuiltin(role))
                return deny(reasons.builtinReadOnly);
            return coverVerdict(actor, atomsOfRole(role));
        },
        canManagePerson(actor, target) {
            if (target.isOwner)
                return deny(reasons.owner);
            if (target.isSelf)
                return deny(reasons.self);
            return coverVerdict(actor, target.atoms);
        },
    };
}
function sameAtoms(left, right) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every((atom) => rightSet.has(atom));
}
//# sourceMappingURL=engine.js.map