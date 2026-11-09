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

// Opens skel's database and prepares its tables so repositories, their leads and threads
// survive restarts.
export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skel.db"), { strict: true });
  // The daemon and skel run in your terminal can use the file at once. Without a wait, a
  // write that meets another one fails with "database is locked" at once.
  db.run("PRAGMA busy_timeout = 5000");
  // One process prepares the tables at a time. On a first run the daemon and the screen open
  // a new file together. Both would see a column missing, and the slower one would stop with
  // "duplicate column name" adding it.
  db.transaction(() => prepareTables(db)).immediate();
  return db;
}

// Creates the tables skel keeps, and adds the columns a database from an earlier release
// lacks, leaving everything already there as it is.
function prepareTables(db: Database): void {
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
  // `lead_session` is the session ID of the repository's lead, kept so it comes back with its
  // conversation. `opened` is when you last opened the repository, in milliseconds since 1970,
  // and null until you first do: its lead starts then, and from then on the daemon brings it
  // back. `lead_harness` is the harness the lead started on, which it keeps, as a conversation
  // can't move to another harness. `kept_lead` marks the repository whose lead is the one this machine had before skel
  // gave each repository its own.
  const columns = {
    open_issues: "INTEGER NOT NULL DEFAULT 0",
    open_prs: "INTEGER NOT NULL DEFAULT 0",
    lead_session: "TEXT",
    lead_harness: "TEXT",
    opened: "INTEGER",
    kept_lead: "INTEGER NOT NULL DEFAULT 0",
  };
  for (const [column, type] of Object.entries(columns))
    if (!db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = ?").get(column))
      db.run(`ALTER TABLE repositories ADD COLUMN ${column} ${type}`);
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
    harness TEXT,
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
    harness: "TEXT",
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
  // Notes for a repository's lead that aren't about a thread needing you, such as a thread
  // started from GitHub, kept until they are typed in, since the lead may not be running.
  db.run("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  for (const column of ["owner", "repo"])
    if (!db.query("SELECT 1 FROM pragma_table_info('notes') WHERE name = ?").get(column))
      db.run(`ALTER TABLE notes ADD COLUMN ${column} TEXT`);
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead'").get())
    keepTheLead(db);
  // The reviews skel posted. They go out with your gh login, so on GitHub they look like
  // reviews of yours, and polling must not type them back into the builder.
  db.run("CREATE TABLE IF NOT EXISTS posted (id INTEGER PRIMARY KEY)");
  // The plugins you installed: the folder each runs from, and the GitHub repository it came
  // from, or null for a folder of yours, used where it is.
  db.run(`CREATE TABLE IF NOT EXISTS plugins (
    name TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    source TEXT
  )`);
}

// Makes the one lead a machine had before skel gave each repository its own the lead of the
// repository you last attached from, or else of the first by name. It keeps its session, so
// --resume still finds its conversation, and leadPlaces gives it its old name, folder and
// socket, so a lead running through the upgrade carries on. Notes still waiting for it stay
// its own, and one more tells it what it now leads. Runs once: the tables it reads go.
function keepTheLead(db: Database): void {
  const session = z
    .object({ session: z.string() })
    .nullable()
    .parse(db.query("SELECT session FROM lead").get());
  const hasFrom = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attached_from'")
    .get();
  const from = hasFrom
    ? z
        .object({ repo: z.string().nullable() })
        .nullable()
        .parse(db.query("SELECT repo FROM attached_from").get())?.repo
    : null;
  const all = db
    .query("SELECT name, owner, repo FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
  const chosen =
    all.find((r) => `${r.owner}/${r.repo}`.toLowerCase() === from?.toLowerCase()) ?? all[0];
  if (chosen) {
    const { name, owner, repo } = chosen;
    db.run(
      "UPDATE repositories SET kept_lead = 1, lead_session = ?, opened = ? WHERE owner = ? AND repo = ?",
      [session?.session ?? null, Date.now(), owner, repo],
    );
    db.run("UPDATE notes SET owner = ?, repo = ? WHERE owner IS NULL", [owner, repo]);
    db.run("INSERT INTO notes (owner, repo, text) VALUES (?, ?, ?)", [
      owner,
      repo,
      `skel now gives each repository a lead of its own, and you are the lead of ${name} (${owner}/${repo}). Work only on ${name} from now on. For another repository, ask the human to open it with skel in a checkout of it: it gets a lead of its own.`,
    ]);
  }
  db.run("DROP TABLE lead");
  db.run("DROP TABLE IF EXISTS attached_from");
  db.run("DROP TABLE IF EXISTS attached");
}
