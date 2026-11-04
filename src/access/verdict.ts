import type { AccessVerdict } from "../types.ts";

const ALLOWED: AccessVerdict = Object.freeze({ allowed: true });

export function allow(): AccessVerdict {
  return ALLOWED;
}

export function deny(reason: string): AccessVerdict {
  return { allowed: false, reason };
}

/** The stable denial reasons. Short enough for a UI to show as they are, stable enough to match on. */
export const reasons = {
  missing: (atom: string) => `missing ${atom}`,
  unknownAtom: (atom: string) => `unknown atom ${atom}`,
  malformedAtom: (atom: string) => `malformed atom ${atom}`,
  reserved: (atom: string) => `${atom} is reserved for the owner`,
  builtinReadOnly: "built-in roles are read-only",
  self: "cannot change your own role",
  owner: "the owner cannot be changed",
  notSignedIn: "not signed in",
  unmappedType: (documentType: string) => `no permission mapped for type ${documentType}`,
} as const;
