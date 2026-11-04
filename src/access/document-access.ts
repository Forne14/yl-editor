import { type Atom, holds, parseAtom } from "./atoms.ts";
import type { Access, AccessVerdict, DocumentRef, MaybePromise } from "../types.ts";
import { allow, deny, reasons } from "./verdict.ts";

/** Which atom gates editing and publishing each document type. */
export interface DocumentAccessMap {
  [documentType: string]: { edit: Atom; publish: Atom };
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
export function documentAccess(options: DocumentAccessOptions): Access {
  const map = new Map<string, { edit: Atom; publish: Atom }>();
  for (const [documentType, atoms] of Object.entries(options.map)) {
    parseAtom(atoms.edit);
    parseAtom(atoms.publish);
    map.set(documentType, { edit: atoms.edit, publish: atoms.publish });
  }

  async function decide(locals: unknown, doc: DocumentRef, action: "edit" | "publish"): Promise<AccessVerdict> {
    const held = await options.atomsOf(locals);
    if (held === null) return deny(reasons.notSignedIn);
    const mapping = map.get(doc.type);
    if (mapping === undefined) return deny(reasons.unmappedType(doc.type));
    const atom = mapping[action];
    return holds(held, atom) ? allow() : deny(reasons.missing(atom));
  }

  return {
    canEdit: (locals, doc) => decide(locals, doc, "edit"),
    canPublish: (locals, doc) => decide(locals, doc, "publish"),
  };
}
