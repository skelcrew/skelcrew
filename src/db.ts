// skel's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

export const Repository = z.object({ name: z.string(), owner: z.string(), repo: z.string() });
export type Repository = z.infer<typeof Repository>;

// A repository is named by its GitHub name, with the owner only while another shares it.
// Names are unique in the end, and no row ever takes a name another row still holds.
export function nameRepositories(db: Database): void {
  db.run(`UPDATE repositories SET name = CASE
    WHEN (SELECT COUNT(*) FROM repositories AS other WHERE other.repo = repositories.repo) > 1
    THEN owner || '/' || repo ELSE repo END`);
}

const createRepositories = `CREATE TABLE IF NOT EXISTS repositories (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  PRIMARY KEY (owner, repo)
)`;

export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skel.db"), { strict: true });
  // Repositories once had a path to your checkout, and a name you chose. They keep their
  // GitHub names, and the lead clones them when it next starts.
  if (db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = 'path'").get())
    db.transaction(() => {
      db.run("ALTER TABLE repositories RENAME TO repositories_with_paths");
      db.run(createRepositories);
      db.run(`INSERT OR IGNORE INTO repositories (owner, repo, name)
        SELECT owner, repo, owner || '/' || repo FROM repositories_with_paths`);
      db.run("DROP TABLE repositories_with_paths");
      nameRepositories(db);
    })();
  db.run(createRepositories);
  // One row at most: there is one lead per machine.
  db.run(`CREATE TABLE IF NOT EXISTS lead (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    session TEXT NOT NULL
  )`);
  return db;
}
