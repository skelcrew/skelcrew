// Skelcrew's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
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

// A thread's own columns past the first few: what belongs to its agent. `submitted` is whether
// the builder ran sc submit in its current turn, and the rest of the flags say why it needs you.
// `noting` holds a note for the lead about that, kept until it is typed in, so one the daemon's
// stop cut short carries on when it starts again. `changed` is when anything last went in the
// thread's log. `working_since` is when the builder's current stretch of work began, for the
// sidebar. It changes with every message typed into the builder, so it is kept out of the
// thread's log, which would otherwise fill with it. `state` is what the builder is doing, from
// its harness's hooks and its screen. It changes with every turn, so it is kept out of the
// thread's log too. `role` is what the agent does on its task, and every thread so far is a
// builder.
const threadColumns = {
  needs_you: "INTEGER NOT NULL DEFAULT 0",
  asking: "INTEGER NOT NULL DEFAULT 0",
  erred: "INTEGER NOT NULL DEFAULT 0",
  limited: "INTEGER NOT NULL DEFAULT 0",
  limit_reset: "INTEGER",
  stalled: "INTEGER NOT NULL DEFAULT 0",
  submitted: "INTEGER NOT NULL DEFAULT 0",
  noting: "TEXT",
  started: "INTEGER",
  harness: "TEXT",
  changed: "INTEGER",
  working_since: "INTEGER",
  state: "TEXT",
  role: "TEXT NOT NULL DEFAULT 'builder'",
};

// A task's columns past its repository and ID: what belongs to the work rather than the agent
// on it. `submitting`, `reviewing` and `telling` hold the round under way, so one the daemon's
// stop cut short carries on when it starts again. `queued` is when the review in `reviewing`
// joined the queue of reviews, while it waits there for a place, so the sidebar can say so and
// a restart puts it back in the same order. `short` is the short title the lead gave the task
// for the sidebar. `assigned` is whether Skelcrew assigned you the task's issue, so it takes you
// off only then. `updates` holds the lead's messages to the builder, as JSON, since they change
// the task its reviewer checks against. `review_at` is when the latest review was asked for or
// ended, for sc ps. `merged` is whether the work ended with its changes merged, which tells a
// task that is done apart from one that was dropped.
export const taskColumns = {
  title: "TEXT",
  body: "TEXT",
  short: "TEXT",
  updates: "TEXT",
  assigned: "INTEGER NOT NULL DEFAULT 0",
  pr: "INTEGER",
  checks: "TEXT",
  conflicts: "TEXT",
  seen: "TEXT",
  last_review: "INTEGER",
  last_comment: "INTEGER",
  last_check: "INTEGER",
  rounds: "INTEGER NOT NULL DEFAULT 0",
  submitting: "TEXT",
  reviewing: "TEXT",
  queued: "INTEGER",
  telling: "TEXT",
  held: "TEXT",
  reviewer: "TEXT",
  reviewed_by: "TEXT",
  review_round: "INTEGER",
  verdict: "TEXT",
  review_line: "TEXT",
  review_at: "INTEGER",
  review_limited: "INTEGER NOT NULL DEFAULT 0",
  review_reset: "INTEGER",
  merged: "INTEGER NOT NULL DEFAULT 0",
};

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
  db.transaction(() => {
    prepareTables(db);
    viewThreads(db);
  }).immediate();
  return db;
}

// Returns whether the database keeps tasks, as a new one does, and one from an earlier release
// does once its threads have moved onto them.
const hasTasks = (db: Database) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() !== null;

// Creates the tasks table: one row per task, named by its repository and its ID, such as 12 or
// t1, as its threads name it.
function createTasks(db: Database): void {
  const columns = Object.entries(taskColumns).map(([column, type]) => `${column} ${type}`);
  db.run(`CREATE TABLE tasks (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    task INTEGER NOT NULL,
    ${columns.join(",\n    ")},
    PRIMARY KEY (owner, repo, task)
  )`);
}

// Makes task_threads, which every reader of threads reads: each thread with its task's columns,
// in one row, as Thread describes it. Its rowid is the thread's, so newest first still sorts by
// when the thread started. A database whose threads haven't moved onto tasks yet gets a view of
// its threads as they are, so sc run before the new daemon starts still shows them. The view is
// kept in the file, not on one connection: when the daemon moves the threads onto tasks, it
// makes the view again, and every connection already open reads the new one from then on. Both
// views have the same columns in the same order, as Bun keeps a cached query's column names
// when SQLite prepares it again for a changed view, and would put each value under another
// column's name. It is made again only when it changes, as that changes the file's schema,
// which every other connection then reads again.
function viewThreads(db: Database): void {
  const own = ["owner", "repo", "task", "folder", "branch", "base", "status", "session"];
  const moved = hasTasks(db);
  const columns = [
    ...[...own, ...Object.keys(threadColumns)].map((column) => `th.${column}`),
    ...Object.keys(taskColumns).map((column) => `${moved ? "k" : "th"}.${column}`),
  ];
  const view = `CREATE VIEW task_threads AS SELECT th.rowid AS rowid, ${columns.join(", ")}
    FROM threads th${moved ? " JOIN tasks k ON k.owner = th.owner AND k.repo = th.repo AND k.task = th.task" : ""}`;
  const made = db.query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?");
  if (z.object({ sql: z.string() }).nullable().parse(made.get("task_threads"))?.sql === view)
    return;
  db.run("DROP VIEW IF EXISTS task_threads");
  db.run(view);
}

// Moves a database from before tasks onto them, once: every thread becomes a task, which takes
// the thread's title, body, short title, updates, PR, checks, rounds, review state and
// assignment. Only the daemon runs it, once it holds the lock that keeps a second daemon out,
// so no daemon of the earlier release can write to columns nothing reads any more. It only
// adds: the threads keep their old columns, unread, and a copy of the database is saved
// beside it first, as the way back.
export function moveToTasks(db: Database): void {
  if (hasTasks(db)) return;
  // A copy left by a move that failed is of the same database, as nothing moved.
  const copy = join(dataDir(), "skelcrew-before-tasks.db");
  rmSync(copy, { force: true });
  db.run("VACUUM INTO ?", [copy]);
  // One transaction, so a move cut short leaves the database as it was.
  db.transaction(() => {
    createTasks(db);
    const columns = ["owner", "repo", "task", ...Object.keys(taskColumns)].join(", ");
    db.run(`INSERT INTO tasks (${columns}) SELECT ${columns} FROM threads`);
    viewThreads(db);
  }).immediate();
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
  // daemon doesn't bring its lead back until you open it again. `lead_state` is what its lead
  // is doing, as a thread's `state` says for its builder.
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
    lead_state: "TEXT",
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
  // Whether this is a new database, made now.
  const fresh = !db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
    .get();
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
  // The rest of a thread's columns, added as the repositories' are. A database from before
  // tasks keeps the task's columns on its threads too, where moveToTasks reads them, so they are
  // added here for every release's database. Nothing reads them from threads after that.
  for (const [column, type] of Object.entries({ ...threadColumns, ...taskColumns }))
    if (!db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = ?").get(column))
      db.run(`ALTER TABLE threads ADD COLUMN ${column} ${type}`);
  // A new database starts with tasks. One from an earlier release waits for its daemon to move
  // its threads onto tasks, as only the daemon knows no other daemon still writes to it.
  if (fresh) createTasks(db);
  // A tasks table made by an earlier release lacks the task's newer columns.
  if (hasTasks(db))
    for (const [column, type] of Object.entries(taskColumns))
      if (!db.query("SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?").get(column))
        db.run(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
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
  // Messages waiting to be typed into a thread's builder, by its folder, oldest first: the lead's
  // sc tell, and what Skelcrew tells it of its PR's events. Kept until typed in, so none is lost
  // while the builder is busy or stopped, or the daemon restarts. `sender` is lead or skelcrew,
  // `text` is what is typed, `said` the lead's own words, `at` when it was sent, in milliseconds
  // since 1970, `noted` whether the lead heard it still waits, and `typed_in` the PR's reviews
  // and comments it carries, as JSON, for the forge to mark seen. `pasted` is whether it sits at
  // the builder's prompt, pasted but left unsent for a question, so its draft there is known for
  // Skelcrew's own after a restart. An `id` is never used again, so a typing under way whose
  // message was dropped can't remove a newer one by its `id`.
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    said TEXT NOT NULL,
    at INTEGER NOT NULL,
    noted INTEGER NOT NULL DEFAULT 0,
    typed_in TEXT NOT NULL DEFAULT '[]',
    pasted INTEGER NOT NULL DEFAULT 0
  )`);
  // The reviews Skelcrew posted with your gh login, before its forge posted them as its own app.
  db.run("DROP TABLE IF EXISTS posted");
  // Each harness's usage limit holding reviews: until when, the reset time it gave, the tries
  // in a row that met it with none, and the repositories whose leads were told, as JSON.
  db.run(`CREATE TABLE IF NOT EXISTS limits (
    harness TEXT PRIMARY KEY,
    until INTEGER NOT NULL,
    reset INTEGER,
    tries INTEGER NOT NULL,
    told TEXT NOT NULL
  )`);
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
