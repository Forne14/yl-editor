/** Thrown when an atom does not match the `family.verb` / `family.*` / `*` grammar. */
export class AtomError extends Error {
    atom;
    constructor(atom, detail) {
        super(`malformed atom ${JSON.stringify(atom)}: ${detail}`);
        this.name = "AtomError";
        this.atom = atom;
    }
}
/** Thrown when a catalogue fails validation. `problems` lists every issue found, not only the first. */
export class CatalogueError extends Error {
    problems;
    constructor(problems) {
        super(`invalid catalogue: ${problems.join("; ")}`);
        this.name = "CatalogueError";
        this.problems = problems;
    }
}
/** Thrown when a role cannot be resolved: an unknown id, or a custom role reusing a built-in role's id. */
export class RoleError extends Error {
    roleId;
    constructor(roleId, detail) {
        super(`role ${JSON.stringify(roleId)}: ${detail}`);
        this.name = "RoleError";
        this.roleId = roleId;
    }
}
//# sourceMappingURL=errors.js.map