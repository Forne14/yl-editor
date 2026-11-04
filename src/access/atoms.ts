import { AtomError } from "./errors.ts";

/** A permission atom: `family.verb`, `family.verb.own`, `family.*` or `*`. */
export type Atom = string;

/** The atom that confers every other atom. */
export const ALL = "*";

export interface ParsedAtom {
  /** The family, or `"*"` for the all-wildcard. */
  family: string;
  /** Everything after the family (`"publish"`, `"write.own"`), or null for a wildcard. */
  rest: string | null;
  wildcard: "all" | "family" | null;
}

const SEGMENT = /^[a-z][a-z0-9_]*$/;

/** Parses an atom. Throws `AtomError` on anything outside the grammar. */
export function parseAtom(atom: Atom): ParsedAtom {
  if (typeof atom !== "string" || atom.length === 0) throw new AtomError(String(atom), "empty");
  if (atom === ALL) return { family: ALL, rest: null, wildcard: "all" };
  const [family, ...tail] = atom.split(".");
  if (family === undefined || !SEGMENT.test(family)) throw new AtomError(atom, "family must be lower_snake_case");
  if (tail.length === 0) throw new AtomError(atom, "expected family.verb");
  if (tail.length === 1 && tail[0] === ALL) return { family, rest: null, wildcard: "family" };
  for (const segment of tail) {
    if (segment === ALL) throw new AtomError(atom, "a wildcard is either the whole atom or directly after the family");
    if (!SEGMENT.test(segment))
      throw new AtomError(atom, `segment ${JSON.stringify(segment)} must be lower_snake_case`);
  }
  return { family, rest: tail.join("."), wildcard: null };
}

/** Parses without throwing; null when malformed. */
export function tryParseAtom(atom: Atom): ParsedAtom | null {
  try {
    return parseAtom(atom);
  } catch {
    return null;
  }
}

export function familyWildcard(family: string): Atom {
  return `${family}.${ALL}`;
}

/**
 * Whether `held` confers `atom`. Resolution order: the exact atom, else its family wildcard, else `*`.
 * Asking about a wildcard asks whether that wildcard is conferred: `family.*` only by `family.*` or `*`, and `*`
 * only by `*`. A malformed atom is never held.
 */
export function holds(held: ReadonlySet<Atom>, atom: Atom): boolean {
  const parsed = tryParseAtom(atom);
  if (parsed === null) return false;
  if (held.has(atom)) return true;
  if (parsed.wildcard !== "all" && held.has(familyWildcard(parsed.family))) return true;
  return held.has(ALL);
}
