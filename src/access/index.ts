export type { Access, AccessVerdict, DocumentRef, MaybePromise } from "../types.ts";
export { ALL, type Atom, type ParsedAtom, parseAtom, holds } from "./atoms.ts";
export { AtomError, CatalogueError, RoleError } from "./errors.ts";
export {
  type AtomDefinition,
  type Catalogue,
  type RoleDefinition,
  CatalogueSchema,
  validateCatalogue,
} from "./catalogue.ts";
export { type AccessEngine, type ManagedPerson, type RoleRef, createAccessEngine } from "./engine.ts";
export { type DocumentAccessMap, type DocumentAccessOptions, documentAccess } from "./document-access.ts";
export { allow, deny, reasons } from "./verdict.ts";
