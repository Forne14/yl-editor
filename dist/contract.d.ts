import { z } from "zod";
import { type ContentStore, type SchemaRegistry } from "./types.ts";
/**
 * The one-type registry the contract assumes: `note` under the `notes` collection, `{ title: string (min 1),
 * tags: string[] }`. Seed the host's schema registry with it (or merge its entry) when running the contract.
 */
export declare const contractRegistry: SchemaRegistry;
/** Builds a store over the same storage as the one under test, with a different registry. */
export type ReopenStore = (registry: SchemaRegistry, hooks: {
    onReadIssue: (key: string, issues: z.core.$ZodIssue[]) => void;
}) => Promise<ContentStore> | ContentStore;
export interface ContentStoreContractOptions {
    /** The registry the store under test was built with. Defaults to `contractRegistry`. */
    registry?: SchemaRegistry;
    /**
     * Reopens the store under test's storage with another registry and an `onReadIssue` hook. Enables the schema
     * evolution tests; without it they are skipped.
     */
    reopen?: ReopenStore;
}
/**
 * Registers the full ContentStore lifecycle as vitest `describe`/`test` blocks. `makeStore` runs before every test
 * and must return a store over empty storage whose registry carries the contract's `note` type.
 */
export declare function runContentStoreContract(name: string, makeStore: () => Promise<ContentStore> | ContentStore, options?: ContentStoreContractOptions): void;
//# sourceMappingURL=contract.d.ts.map