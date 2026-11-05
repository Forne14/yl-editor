import { holds, parseAtom } from "./atoms.js";
import { allow, deny, reasons } from "./verdict.js";
/**
 * Adapts atoms to the package's `Access` seam. Fails closed: nobody signed in, or a document type with no mapping,
 * is denied. Every mapped atom is parsed up front, so a typo throws `AtomError` at start-up rather than denying
 * quietly at request time.
 */
export function documentAccess(options) {
    const map = new Map();
    for (const [documentType, atoms] of Object.entries(options.map)) {
        parseAtom(atoms.edit);
        parseAtom(atoms.publish);
        map.set(documentType, { edit: atoms.edit, publish: atoms.publish });
    }
    async function decide(locals, doc, action) {
        const held = await options.atomsOf(locals);
        if (held === null)
            return deny(reasons.notSignedIn);
        const mapping = map.get(doc.type);
        if (mapping === undefined)
            return deny(reasons.unmappedType(doc.type));
        const atom = mapping[action];
        return holds(held, atom) ? allow() : deny(reasons.missing(atom));
    }
    return {
        canEdit: (locals, doc) => decide(locals, doc, "edit"),
        canPublish: (locals, doc) => decide(locals, doc, "publish"),
    };
}
//# sourceMappingURL=document-access.js.map