import { type ContentStore, type SchemaRegistry } from "./types.ts";
/**
 * The one-type registry the contract assumes: `note` under the `notes` collection, `{ title: string (min 1),
 * tags: string[] }`. Seed the host's schema registry with it (or merge its entry) when running the contract.
 */
export declare const contractRegistry: SchemaRegistry;
export interface ContentStoreContractOptions {
    /** The registry the store under test was built with. Defaults to `contractRegistry`. */
    registry?: SchemaRegistry;
}
/**
 * Registers the full ContentStore lifecycle as vitest `describe`/`test` blocks. `makeStore` runs before every test
 * and must return a store over empty storage whose registry carries the contract's `note` type.
 */
export declare function runContentStoreContract(name: string, makeStore: () => Promise<ContentStore> | ContentStore, options?: ContentStoreContractOptions): void;
//# sourceMappingURL=contract.d.ts.map