import type Database from "better-sqlite3";
import { type ContentStore, type SchemaRegistry } from "./types.ts";
/**
 * The shipped ContentStore on better-sqlite3. The interface is async; the SQLite calls stay synchronous underneath
 * and each method simply resolves. Every mutation reads, checks and writes inside one transaction.
 */
export declare function createSqliteContentStore(db: Database.Database, registry: SchemaRegistry, clock?: () => Date): ContentStore;
//# sourceMappingURL=sqlite-store.d.ts.map