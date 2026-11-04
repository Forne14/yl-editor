import { type Atom } from "./atoms.ts";
import type { Access, MaybePromise } from "../types.ts";
/** Which atom gates editing and publishing each document type. */
export interface DocumentAccessMap {
    [documentType: string]: {
        edit: Atom;
        publish: Atom;
    };
}
export interface DocumentAccessOptions {
    /** The signed-in actor's resolved atoms, or null when nobody is signed in. */
    atomsOf: (locals: unknown) => MaybePromise<ReadonlySet<Atom> | null>;
    map: DocumentAccessMap;
}
/**
 * Adapts atoms to the package's `Access` seam. Fails closed: nobody signed in, or a document type with no mapping,
 * is denied. Every mapped atom is parsed up front, so a typo throws `AtomError` at start-up rather than denying
 * quietly at request time.
 */
export declare function documentAccess(options: DocumentAccessOptions): Access;
//# sourceMappingURL=document-access.d.ts.map