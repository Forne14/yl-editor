const ALLOWED = Object.freeze({ allowed: true });
export function allow() {
    return ALLOWED;
}
export function deny(reason) {
    return { allowed: false, reason };
}
/** The stable denial reasons. Short enough for a UI to show as they are, stable enough to match on. */
export const reasons = {
    missing: (atom) => `missing ${atom}`,
    unknownAtom: (atom) => `unknown atom ${atom}`,
    malformedAtom: (atom) => `malformed atom ${atom}`,
    reserved: (atom) => `${atom} is reserved for the owner`,
    builtinReadOnly: "built-in roles are read-only",
    self: "cannot change your own role",
    owner: "the owner cannot be changed",
    notSignedIn: "not signed in",
    unmappedType: (documentType) => `no permission mapped for type ${documentType}`,
};
//# sourceMappingURL=verdict.js.map