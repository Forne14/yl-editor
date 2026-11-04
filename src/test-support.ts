import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractRegistry } from "./contract.ts";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Every migration in `migrations/`, applied in name order. */
const migrations = readdirSync(migrationsDirectory)
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort()
  .map((fileName) => readFileSync(`${migrationsDirectory}${fileName}`, "utf8"));

export function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations) db.exec(migration);
  return db;
}

/** The contract's one-type registry (`note` under `notes`), kept under its older name for existing tests. */
export const testRegistry = contractRegistry;
