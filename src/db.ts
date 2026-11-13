// Skelcrew's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.ts";

// `name` is the repository's name in Skelcrew. `owner` and `repo` are its name on its forge, or
// without a forge its remote's path. `forge` is the plugin that claims its remote, or null
// when none does, and `remote` is the URL git clones and pushes it from.
export const Repository = z.object({
  name: z.string(),
  owner: z.string(),
  repo: z.string(),
  forge: z.string().nullable(),
  remote: z.string(),
});
export type Repository = z.infer<typeof Repository>;

// Updates repository names, adding the owner only when repositories share a name.
// Names are unique in the end, and no row ever takes a name another row still holds.
export function nameRepositories(db: Database): void {
  db.run(`UPDATE repositories SET name = CASE
    WHEN (SELECT COUNT(*) FROM repositories AS other WHERE other.repo = repositories.repo) > 1
    THEN owner || '/' || repo ELSE repo END`);
}

// Opens Skelcrew's database and prepares its tables so repositories, their leads and threads
// survive restarts.
export function openDb(): Database {
  mkdirSync(dataDir(), { recursive: true });
  const db = new Database(join(dataDir(), "skelcrew.db"), { strict: true });
  // The daemon and Skelcrew run in your terminal can use the file at once. Without a wait, a
  // write that meets another one fails with "database is locked" at once.
  db.run("PRAGMA busy_timeout = 5000");
  // One process prepares the tables at a time. On a first run the daemon and the screen open
  // a new file together. Both would see a column missing, and the slower one would stop with
  // "duplicate column name" adding it.
  db.transaction(() => prepareTables(db)).immediate();
  return db;
}

// Creates the tables Skelcrew keeps, and adds the columns a database from an earlier release
// lacks, leaving everything already there as it is.
function prepareTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS repositories (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    PRIMARY KEY (owner, repo)
  )`);
  // Creating a table leaves one that exists as it is, so the columns past the first few are
  // added here, to new databases and to ones from an earlier release alike. `open_issues` and
  // `open_prs` count the tasks and PRs open in Skelcrew's copy, as the sidebar counts those it
  // doesn't show.
  // `lead_session` is the session ID of the repository's lead, kept so it comes back with its
  // conversation. `opened` is when you last opened the repository, in milliseconds since 1970,
  // and null until you first do: its lead starts then, and from then on the daemon brings it
  // back. `lead_harness` is the harness the lead started on, which it keeps, as a conversation
  // can't move to another harness. `kept_lead` marks the repository whose lead is the one this
  // machine had before Skelcrew gave each repository its own. `claimed` is whether Skelcrew has
  // asked the forges installed which of them claims the repository's remote, `forge` is the one
  // that does, or null, and `author` is who commits in its name, as git writes an author.
  // `old_remote` is the host and owner/name in lower case, such as github.com/simon/old, of a
  // checkout's remote that uses an old name of the repository, once its forge has said so.
  // `tab_closed` marks a repository whose lead you exited, so its tab stays hidden and the
  // daemon doesn't bring its lead back until you open it again.
  const repositoryColumns = {
    open_issues: "INTEGER NOT NULL DEFAULT 0",
    open_prs: "INTEGER NOT NULL DEFAULT 0",
    lead_session: "TEXT",
    lead_harness: "TEXT",
    opened: "INTEGER",
    kept_lead: "INTEGER NOT NULL DEFAULT 0",
    forge: "TEXT",
    claimed: "INTEGER NOT NULL DEFAULT 0",
    author: "TEXT",
    old_remote: "TEXT",
    tab_closed: "INTEGER NOT NULL DEFAULT 0",
  };
  // SQLite has no ADD COLUMN IF NOT EXISTS, so each column is looked up first.
  for (const [column, type] of Object.entries(repositoryColumns))
    if (!db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = ?").get(column))
      db.run(`ALTER TABLE repositories ADD COLUMN ${column} ${type}`);
  // Every repository Skelcrew had before it kept remotes came from GitHub, by its GitHub name.
  if (!db.query("SELECT 1 FROM pragma_table_info('repositories') WHERE name = 'remote'").get()) {
    db.run("ALTER TABLE repositories ADD COLUMN remote TEXT NOT NULL DEFAULT ''");
    db.run(
      "UPDATE repositories SET remote = 'https://github.com/' || owner || '/' || repo || '.git'",
    );
  }
  // A thread names its repository by its owner and name, which never change, and is named
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
    PRIMARY KEY (owner, repo, task)
  )`);
  // The rest of a thread's columns, added as the repositories' are. `submitting`,
  // `reviewing` and `telling` hold the round under way, so one the daemon's stop cut short
  // carries on when it starts again, and `noting` holds a note for the lead the same way.
  // `short` is the short title the lead gave the thread for the sidebar.
  // `assigned` is whether Skelcrew assigned you the thread's issue, so it takes you off only then.
  // `changed` is when anything last went in the thread's log.
  const threadColumns = {
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
    body: "TEXT",
    seen: "TEXT",
    short: "TEXT",
    assigned: "INTEGER NOT NULL DEFAULT 0",
    changed: "INTEGER",
  };
  for (const [column, type] of Object.entries(threadColumns))
    if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = ?").get(column))
      db.run(`ALTER TABLE threads ADD COLUMN ${column} ${type}`);
  // Skelcrew's copy of each repository's open tasks and PRs, as items, kept as JSON. The columns
  // are what readers pick and sort by. A database from an earlier release also has an
  // open_items table, which nothing reads now. It stays, as a daemon of that release may still
  // write to it until it restarts on this one.
  db.run(`CREATE TABLE IF NOT EXISTS items (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    state TEXT NOT NULL,
    created TEXT NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (owner, repo, kind, id)
  )`);
  // Notes for a repository's lead that aren't about a thread needing you, such as a thread
  // started from a tracker, kept until they are typed in, since the lead may not be running.
  db.run("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  // A note names its repository, and one from before each repository had its own lead names
  // none until adoptOldLead gives it one.
  for (const column of ["owner", "repo"])
    if (!db.query("SELECT 1 FROM pragma_table_info('notes') WHERE name = ?").get(column))
      db.run(`ALTER TABLE notes ADD COLUMN ${column} TEXT`);
  // A lead table means a database from before each repository had its own lead.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lead'").get())
    adoptOldLead(db);
  // The reviews Skelcrew posted with your gh login, before its forge posted them as its own app.
  db.run("DROP TABLE IF EXISTS posted");
  // The plugins you installed: the folder each runs from, and the GitHub repository it came
  // from, or null for a folder of yours, used where it is.
  db.run(`CREATE TABLE IF NOT EXISTS plugins (
    name TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    source TEXT
  )`);
}

// Upgrades a database from before each repository had its own lead. The machine's one lead
// becomes the lead of the repository you last attached from, or else the first by name. It
// keeps its session, so --resume still finds its conversation. leadPlaces keeps its old name,
// folder and socket, so a lead running through the upgrade carries on. Waiting notes stay
// with it, plus one telling it which repository it now leads. Runs once, as it drops the old
// tables.
function adoptOldLead(db: Database): void {
  // The one lead's session, and the repository you last attached from, if that was kept.
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
    .query("SELECT * FROM repositories ORDER BY name")
    .all()
    .map((row) => Repository.parse(row));
  // The repository you last attached from, matched without case, as GitHub's names are.
  const chosen =
    all.find((r) => `${r.owner}/${r.repo}`.toLowerCase() === from?.toLowerCase()) ?? all[0];
  if (chosen) {
    const { name, owner, repo } = chosen;
    // Marked as opened now, so the daemon brings the kept lead back from here on.
    db.run(
      "UPDATE repositories SET kept_lead = 1, lead_session = ?, opened = ? WHERE owner = ? AND repo = ?",
      [session?.session ?? null, Date.now(), owner, repo],
    );
    db.run("UPDATE notes SET owner = ?, repo = ? WHERE owner IS NULL", [owner, repo]);
    db.run("INSERT INTO notes (owner, repo, text) VALUES (?, ?, ?)", [
      owner,
      repo,
      `Skelcrew now gives each repository a lead of its own, and you are the lead of ${name} (${owner}/${repo}). Work only on ${name} from now on. For another repository, ask the human to open it with sc in a checkout of it: it gets a lead of its own.`,
    ]);
  }
  db.run("DROP TABLE lead");
  db.run("DROP TABLE IF EXISTS attached_from");
  db.run("DROP TABLE IF EXISTS attached");
}
