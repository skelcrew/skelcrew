// skel's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

// `name` is the repository's name in skel, and `repo` its GitHub name without the owner.
export const Repository = z.object({ name: z.string(), owner: z.string(), repo: z.string() });
export type Repository = z.infer<typeof Repository>;

// Updates repository names, adding the owner only when repositories share a GitHub name.
// Names are unique in the end, and no row ever takes a name another row still holds.
export function nameRepositories(db: Database): void {
  db.run(`UPDATE repositories SET name = CASE
    WHEN (SELECT COUNT(*) FROM repositories AS other WHERE other.repo = repositories.repo) > 1
    THEN owner || '/' || repo ELSE repo END`);
}

// Opens skel's database and prepares its tables so repositories, the lead and threads
// survive restarts.
export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skel.db"), { strict: true });
  // The daemon and skel run in your terminal can use the file at once. Without a wait, a
  // write that meets another one fails with "database is locked" at once.
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS repositories (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    PRIMARY KEY (owner, repo)
  )`);
  // Whether skel made sure the repository has the skel label. A repository saved before this
  // column existed gets it once, when the daemon next refreshes its clone.
  if (!db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = 'labeled'").get())
    db.run("ALTER TABLE repositories ADD COLUMN labeled INTEGER NOT NULL DEFAULT 0");
  // How many issues and PRs are open in all, as the sidebar counts those it doesn't show.
  for (const column of ["open_issues", "open_prs"])
    if (!db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = ?").get(column))
      db.run(`ALTER TABLE repositories ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  // One row at most: there is one lead per machine.
  db.run(`CREATE TABLE IF NOT EXISTS lead (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    session TEXT NOT NULL
  )`);
  // Where you last attached from, as owner/repo, or null outside any repository on GitHub.
  // The lead hears of it with your next message, which can come after a restart.
  db.run(`CREATE TABLE IF NOT EXISTS attached_from (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    repo TEXT
  )`);
  // The last note telling the lead where you attached from, and the lead's conversation it
  // went to. Kept so the note comes only when it changes, even after a restart.
  db.run(`CREATE TABLE IF NOT EXISTS attached (
    one INTEGER PRIMARY KEY CHECK (one = 1),
    session TEXT NOT NULL,
    note TEXT NOT NULL
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
    held TEXT,
    last_review INTEGER,
    last_comment INTEGER,
    last_check INTEGER,
    asking INTEGER NOT NULL DEFAULT 0,
    noting TEXT,
    title TEXT,
    started INTEGER,
    checks TEXT,
    reviewer TEXT,
    reviewed_by TEXT,
    review_round INTEGER,
    verdict TEXT,
    review_line TEXT,
    PRIMARY KEY (owner, repo, task)
  )`);
  // Creating a table leaves one that exists as it is, so a release that gives threads a new
  // column lists it here too, and databases already in use gain it. `submitting`,
  // `reviewing` and `telling` hold the round under way, so one the daemon's stop cut short
  // carries on when it starts again, and `noting` holds a note for the lead the same way.
  const added = {
    rounds: "INTEGER NOT NULL DEFAULT 0",
    pr: "INTEGER",
    needs_you: "INTEGER NOT NULL DEFAULT 0",
    reviewing: "TEXT",
    submitting: "TEXT",
    telling: "TEXT",
    held: "TEXT",
    last_review: "INTEGER",
    last_comment: "INTEGER",
    last_check: "INTEGER",
    asking: "INTEGER NOT NULL DEFAULT 0",
    noting: "TEXT",
    title: "TEXT",
    started: "INTEGER",
    checks: "TEXT",
    reviewer: "TEXT",
    reviewed_by: "TEXT",
    review_round: "INTEGER",
    verdict: "TEXT",
    review_line: "TEXT",
  };
  for (const [column, type] of Object.entries(added))
    if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = ?").get(column))
      db.run(`ALTER TABLE threads ADD COLUMN ${column} ${type}`);
  // The newest open issues and PRs of each repository, as the last poll with a screen open
  // found them. Only a copy for the sidebar, which looks each second and so can't ask GitHub.
  // Tasks stay in the tracker.
  db.run(`CREATE TABLE IF NOT EXISTS open_items (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    kind TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    created TEXT NOT NULL,
    PRIMARY KEY (owner, repo, kind, number)
  )`);
  // Notes for the lead that aren't about a thread needing you, such as a thread started from
  // GitHub, kept until they are typed in, since the lead may not be running.
  db.run("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  // The reviews skel posted. They go out with your gh login, so on GitHub they look like
  // reviews of yours, and polling must not type them back into the builder.
  db.run("CREATE TABLE IF NOT EXISTS posted (id INTEGER PRIMARY KEY)");
  return db;
}
