import type { AccessVerdict } from "../types.ts";
export declare function allow(): AccessVerdict;
export declare function deny(reason: string): AccessVerdict;
/** The stable denial reasons. Short enough for a UI to show as they are, stable enough to match on. */
export declare const reasons: {
    readonly missing: (atom: string) => string;
    readonly unknownAtom: (atom: string) => string;
    readonly malformedAtom: (atom: string) => string;
    readonly reserved: (atom: string) => string;
    readonly builtinReadOnly: "built-in roles are read-only";
    readonly self: "cannot change your own role";
    readonly owner: "the owner cannot be changed";
    readonly notSignedIn: "not signed in";
    readonly unmappedType: (documentType: string) => string;
};
//# sourceMappingURL=verdict.d.ts.map