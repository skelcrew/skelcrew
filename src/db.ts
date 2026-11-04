// skel's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

export const Repository = z.object({ name: z.string(), owner: z.string(), repo: z.string() });
export type Repository = z.infer<typeof Repository>;

// Updates repository names, adding the owner only when repositories share a GitHub name.
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

// Opens skel's database and prepares its tables so repositories, the lead and threads
// survive restarts.
export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skel.db"), { strict: true });
  // The daemon and skel run in your terminal can use the file at once. Without a wait, a
  // write that meets another one fails with "database is locked" at once.
  db.run("PRAGMA busy_timeout = 5000");
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
  // A thread names its repository by GitHub owner and name, which never change, and is named
  // once, at start, for its folder: its clone, log, config folder, session and socket all
  // use it, so none of them move when the repository's short name gains its owner.
  db.run(`CREATE TABLE IF NOT EXISTS threads (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    base TEXT,
    status TEXT NOT NULL,
    session TEXT,
    rounds INTEGER NOT NULL DEFAULT 0,
    pr INTEGER,
    needs_you INTEGER NOT NULL DEFAULT 0,
    reviewing TEXT,
    submitting TEXT,
    telling TEXT,
    asking INTEGER NOT NULL DEFAULT 0,
    noting TEXT,
    PRIMARY KEY (owner, repo, task)
  )`);
  // Threads an older skel started lack some of these columns. `submitting`,
  // `reviewing` and `telling` hold the round under way, so one the daemon's stop cut short
  // carries on when it starts again, and `noting` holds a note for the lead the same way.
  const added = {
    rounds: "INTEGER NOT NULL DEFAULT 0",
    pr: "INTEGER",
    needs_you: "INTEGER NOT NULL DEFAULT 0",
    reviewing: "TEXT",
    submitting: "TEXT",
    telling: "TEXT",
    asking: "INTEGER NOT NULL DEFAULT 0",
    noting: "TEXT",
  };
  for (const [column, type] of Object.entries(added))
    if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = ?").get(column))
      db.run(`ALTER TABLE threads ADD COLUMN ${column} ${type}`);
  return db;
}
