import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RegistryEntry, SchemaRegistry } from "./types";

const migration = readFileSync(fileURLToPath(new URL("../migrations/0001_documents.sql", import.meta.url)), "utf8");

export function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(migration);
  return db;
}

const note: RegistryEntry = {
  type: "note",
  collection: "notes",
  schema: z.strictObject({ title: z.string().min(1), tags: z.array(z.string()) }),
};

export const testRegistry: SchemaRegistry = {
  entry: (type) => (type === note.type ? note : undefined),
  byCollection: (c) => (c === note.collection ? note : undefined),
};
