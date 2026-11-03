// skel's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

export const Repository = z.object({
  name: z.string(),
  path: z.string(),
  owner: z.string(),
  repo: z.string(),
});
export type Repository = z.infer<typeof Repository>;

export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skel.db"), { strict: true });
  db.run(`CREATE TABLE IF NOT EXISTS repositories (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL
  )`);
  // One row at most: there is one lead per machine.
  db.run(`CREATE TABLE IF NOT EXISTS lead (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    session TEXT NOT NULL
  )`);
  return db;
}
