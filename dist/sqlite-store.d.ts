import type Database from "better-sqlite3";
import { z } from "zod";
import { type ContentStore, type SchemaRegistry } from "./types.ts";
export interface SqliteContentStoreOptions {
    /**
     * Called when a public read (`draft: false`) finds a payload that fails the current schema. The stored payload is
     * served anyway. Defaults to a `console.warn` once per key per process.
     */
    onReadIssue?: (key: string, issues: z.core.$ZodIssue[]) => void;
}
/**
 * The shipped ContentStore on better-sqlite3. The interface is async; the SQLite calls stay synchronous underneath
 * and each method simply resolves. Every mutation reads, checks and writes inside one transaction.
 */
export declare function createSqliteContentStore(db: Database.Database, registry: SchemaRegistry, clock?: () => Date, options?: SqliteContentStoreOptions): ContentStore;
//# sourceMappingURL=sqlite-store.d.ts.map