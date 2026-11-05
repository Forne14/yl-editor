/** Thrown when an atom does not match the `family.verb` / `family.*` / `*` grammar. */
export declare class AtomError extends Error {
    readonly atom: string;
    constructor(atom: string, detail: string);
}
/** Thrown when a catalogue fails validation. `problems` lists every issue found, not only the first. */
export declare class CatalogueError extends Error {
    readonly problems: readonly string[];
    constructor(problems: readonly string[]);
}
/** Thrown when a role cannot be resolved: an unknown id, or a custom role reusing a built-in role's id. */
export declare class RoleError extends Error {
    readonly roleId: string;
    constructor(roleId: string, detail: string);
}
//# sourceMappingURL=errors.d.ts.map