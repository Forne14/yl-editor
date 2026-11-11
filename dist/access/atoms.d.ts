/** A permission atom: `family.verb`, `family.verb.own`, `family.*` or `*`. */
export type Atom = string;
/** The atom that confers every other atom. */
export declare const ALL = "*";
export interface ParsedAtom {
    /** The family, or `"*"` for the all-wildcard. */
    family: string;
    /** Everything after the family (`"publish"`, `"write.own"`), or null for a wildcard. */
    rest: string | null;
    wildcard: "all" | "family" | null;
}
/** Parses an atom. Throws `AtomError` on anything outside the grammar. */
export declare function parseAtom(atom: Atom): ParsedAtom;
/** Parses without throwing; null when malformed. */
export declare function tryParseAtom(atom: Atom): ParsedAtom | null;
export declare function familyWildcard(family: string): Atom;
/**
 * Whether `held` confers `atom`. Resolution order: the exact atom, else its family wildcard, else `*`.
 * Asking about a wildcard asks whether that wildcard is conferred: `family.*` only by `family.*` or `*`, and `*`
 * only by `*`. A malformed atom is never held.
 */
export declare function holds(held: ReadonlySet<Atom>, atom: Atom): boolean;
//# sourceMappingURL=atoms.d.ts.map