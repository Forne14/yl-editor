/** Thrown when an atom does not match the `family.verb` / `family.*` / `*` grammar. */
export class AtomError extends Error {
  readonly atom: string;

  constructor(atom: string, detail: string) {
    super(`malformed atom ${JSON.stringify(atom)}: ${detail}`);
    this.name = "AtomError";
    this.atom = atom;
  }
}

/** Thrown when a catalogue fails validation. `problems` lists every issue found, not only the first. */
export class CatalogueError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid catalogue: ${problems.join("; ")}`);
    this.name = "CatalogueError";
    this.problems = problems;
  }
}

/** Thrown when a role cannot be resolved: an unknown id, or a custom role reusing a built-in role's id. */
export class RoleError extends Error {
  readonly roleId: string;

  constructor(roleId: string, detail: string) {
    super(`role ${JSON.stringify(roleId)}: ${detail}`);
    this.name = "RoleError";
    this.roleId = roleId;
  }
}
