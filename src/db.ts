// Skelcrew's state on this machine: one SQLite file.
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir, dbLogFile, threadsDir } from "./paths.ts";

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

// The bad values already logged, so a reader that looks each second logs each one once.
const loggedValues = new Set<string>();

// Returns the JSON a column saved, checked against `shape`, or `empty` when it can't be read, such
// as a value an older release saved in another shape. `column` names its table and column, such
// as tasks.seen, for the line logged then. A bad value must never stop the sidebar, the lists or
// the daemon, so it reads as empty and goes to the log, once, rather than to your screen.
export function readJson<T>(column: string, saved: string, shape: z.ZodType<T>, empty: T): T {
  try {
    const read = shape.safeParse(JSON.parse(saved));
    if (read.success) return read.data;
  } catch {}
  const line = `${column} holds ${JSON.stringify(saved)}, which Skelcrew can't read, so it reads as empty.`;
  if (loggedValues.has(line)) return empty;
  loggedValues.add(line);
  // A log that can't be written, such as on a full disk, must not stop the reader either.
  try {
    appendFileSync(dbLogFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {}
  return empty;
}

// Returns a check for a column that holds JSON or null, which reads both as `shape`, and a
// value it can't read as `empty`, as readJson does. Null reads as `empty` too.
export const savedJson = <T>(column: string, shape: z.ZodType<T>, empty: T) =>
  z
    .string()
    .nullable()
    .transform((saved) => (saved === null ? empty : readJson(column, saved, shape, empty)));

// Updates repository names, adding the owner only when repositories share a name, in any case,
// such as App and app. Names are typed in any case, so two that differ only in case would name
// both. Names are unique in the end, and no row ever takes a name another row still holds.
export function nameRepositories(db: Database): void {
  db.run(`UPDATE repositories SET name = CASE
    WHEN (SELECT COUNT(*) FROM repositories AS other
      WHERE lower(other.repo) = lower(repositories.repo)) > 1
    THEN owner || '/' || repo ELSE repo END`);
}

// Moves a review that failed or timed out, saved by a release that had it need you, onto its
// own flag, once, as the column that holds it is added. The lead can run such a review again, so
// it no longer needs you. One past the round limit, with changes held, still needs you for the
// limit, and one with a round under way is carried on as the engine starts, so both are left.
function flagFailedReviews(db: Database): void {
  const failed = `verdict IN ('failed', 'timed out') AND held IS NULL AND submitting IS NULL AND reviewing IS NULL`;
  const where = hasTasks(db)
    ? `(owner, repo, task) IN (SELECT owner, repo, task FROM tasks WHERE ${failed})`
    : failed;
  db.run(`UPDATE threads SET review_failed = 1, needs_you = 0 WHERE needs_you = 1 AND ${where}`);
}

// A thread's own columns past the first few: what belongs to its agent. `submitted` is whether
// the builder ran sc submit in its current turn, `told_lead` whether it ran sc tell lead in it, and `turn_ended` whether it ended a turn without
// one since, which waits on the lead. It is null on a thread an earlier release saved, until the
// daemon moves its `stalled` over. The rest of the flags say why it needs you.
// `noting` holds a note for the lead about that, kept until it is typed in, so one the daemon's
// stop cut short carries on when it starts again. `changed` is when anything last went in the
// thread's log. `working_since` is when the builder's current stretch of work began, for the
// sidebar. It changes with every message typed into the builder, so it is kept out of the
// thread's log, which would otherwise fill with it. `state` is what the builder is doing, from
// its harness's hooks and its screen. It changes with every turn, so it is kept out of the
// thread's log too. `role` is what the agent does on its task, and every thread so far is a
// builder. `merge_plan` is `armed` while you have armed a merge when ready on the thread.
// `merge_id` is that plan's own ID, new each time it is armed. `merge_by` and `merge_at` say
// who armed it and when, for the PR's record. `merge_asked` is your words, exactly, when you
// asked the lead to arm it, so the plan itself shows what let it merge, and null when you armed
// it at your terminal. `merge_waits` is what an armed merge waits on, as the last poll
// found, and `merge_noted` the review round the lead last heard it still waits after.
// `merge_pinned` is the PR's head when you asked to merge it without Skelcrew's approval, and
// null for a merge when ready: only that commit merges, so a push after you asked cancels it.
// `merge_record` is the plan and commit whose record Skelcrew posted on the PR, and
// `merge_record_id` that review's ID, so a restart never posts it twice. `merge_followup` is the
// issue a merge without approval filed its review's open findings in, so it files one only.
// `needs_you_for` is what you must do for the thread, in words for you, as the lead, you or the
// safety net marked it, or null with no mark. `limit_decided` is whether the lead or you cleared
// the round limit's needs you, so it stops needing you for it until the next review.
// `review_failed` is whether the latest review or round failed, which the lead hears of and
// can run again. `ended_at` is when its builder ended a turn without submitting and nobody has acted on it
// since, and `ended_said` what the builder said last then, for the safety net.
// They are
// the thread's, so a thread that starts over begins with none. `host` is the session host its
// builder runs on, tmux or a runtime plugin, and `host_id` the session's ID there, which on tmux
// is the folder. A thread from before hosts runs on tmux. A thread whose builder you stopped has
// no host, so it starts again on the current one.
const threadColumns = {
  needs_you: "INTEGER NOT NULL DEFAULT 0",
  asking: "INTEGER NOT NULL DEFAULT 0",
  erred: "INTEGER NOT NULL DEFAULT 0",
  limited: "INTEGER NOT NULL DEFAULT 0",
  limit_reset: "INTEGER",
  turn_ended: "INTEGER",
  submitted: "INTEGER NOT NULL DEFAULT 0",
  told_lead: "INTEGER NOT NULL DEFAULT 0",
  noting: "TEXT",
  started: "INTEGER",
  harness: "TEXT",
  changed: "INTEGER",
  working_since: "INTEGER",
  state: "TEXT",
  role: "TEXT NOT NULL DEFAULT 'builder'",
  host: "TEXT DEFAULT 'tmux'",
  host_id: "TEXT",
  merge_plan: "TEXT",
  merge_id: "TEXT",
  merge_by: "TEXT",
  merge_at: "INTEGER",
  merge_asked: "TEXT",
  merge_waits: "TEXT",
  merge_noted: "INTEGER",
  merge_pinned: "TEXT",
  merge_record: "TEXT",
  merge_record_id: "TEXT",
  merge_followup: "TEXT",
  needs_you_for: "TEXT",
  limit_decided: "INTEGER NOT NULL DEFAULT 0",
  ended_at: "INTEGER",
  ended_said: "TEXT",
  review_failed: "INTEGER NOT NULL DEFAULT 0",
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
// task that is done apart from one that was dropped. `issue_link` is the link to the issue the
// task came from, saved as it starts, and null for a task with no issue, such as t1. `closes` is
// the line a PR's body needs to close that issue on merge, saved as it starts too, so its PR
// closes it though the tracker or Skelcrew's copy of it changed since. It is empty when there is
// none, and null only in a row from before Skelcrew kept it. `review_post` is Skelcrew's review
// on the PR, as JSON: the PR, the review's ID and what it last said, so each round edits it.
// `agents` is the git tree of the .agents/ you had approved when the task started, which its
// agents keep, or null for the built-in roles. `flow` is the flow the task runs from start to end,
// `default` unless it was started with another. `pr_link` is the link to the task's PR, saved from
// Skelcrew's copy of the forge while the PR is in it, so the list can still open the PR of a task
// that ended, once the copy has dropped it. `queued_since` is when the task last joined the queue
// of limits.threads, which goes first come first served, kept until its builder's session is
// saved.
export const taskColumns = {
  title: "TEXT",
  body: "TEXT",
  short: "TEXT",
  updates: "TEXT",
  assigned: "INTEGER NOT NULL DEFAULT 0",
  pr: "INTEGER",
  checks: "TEXT",
  conflicts: "TEXT",
  ci_passed: "INTEGER NOT NULL DEFAULT 0",
  ci_seen: "INTEGER NOT NULL DEFAULT 0",
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
  reviewed_commit: "TEXT",
  review_at: "INTEGER",
  review_limited: "INTEGER NOT NULL DEFAULT 0",
  review_reset: "INTEGER",
  review_post: "TEXT",
  merged: "INTEGER NOT NULL DEFAULT 0",
  issue_link: "TEXT",
  closes: "TEXT",
  agents: "TEXT",
  flow: "TEXT NOT NULL DEFAULT 'default'",
  pr_link: "TEXT",
  queued_since: "INTEGER",
};

// Marks each done task merged when its thread's log says its work ended by a merge, for tasks
// that ended before Skelcrew kept it. The log's last line that ended the thread says why: its PR
// was merged, by you or as a merge when ready, or without a forge, its branch was merged into
// its base. Anything else, such as
// sc rm or a PR closed without merging, and a thread whose log is gone, leaves it unmerged.
function recoverMerges(db: Database): void {
  const done = db
    .query("SELECT owner, repo, task, folder FROM threads WHERE status = 'done'")
    .all()
    .map((row) =>
      z
        .object({
          owner: z.string(),
          repo: z.string(),
          task: z.coerce.string(),
          folder: z.string(),
        })
        .parse(row),
    );
  for (const { owner, repo, task, folder } of done) {
    let text: string;
    try {
      text = readFileSync(join(threadsDir(), `${folder}.log`), "utf8");
    } catch {
      continue;
    }
    // Each line is the thread as it was then, with why it changed. A line cut short by a crash
    // is skipped.
    const whys = text.split("\n").flatMap((line) => {
      try {
        const why = z.object({ why: z.string() }).safeParse(JSON.parse(line));
        return why.success ? [why.data.why] : [];
      } catch {
        return [];
      }
    });
    const ended = whys.filter((why) => why.endsWith(": ended the thread")).at(-1) ?? "";
    if (/^PR #\d+ was merged( when ready)?: |^its branch .* is merged into /.test(ended))
      db.run("UPDATE tasks SET merged = 1 WHERE owner = ? AND repo = ? AND task = ?", [
        owner,
        repo,
        task,
      ]);
  }
}

// Saves the link to its issue, and the line that closes it, on each task that lacks them, from
// Skelcrew's copy of the tracker, for tasks that started before Skelcrew kept them. An issue
// that has left the copy, as a closed one does once its thread is done, has nothing to give.
// Neither has an item that isn't JSON: SQLite would stop on it, and the daemon with it. Such
// an item is logged here, as no list may ever read it.
function linkIssues(db: Database): void {
  for (const row of db.query("SELECT item FROM items WHERE NOT json_valid(item)").all())
    readJson("items.item", z.object({ item: z.string() }).parse(row).item, z.unknown(), null);
  for (const [column, field] of [
    ["issue_link", "link"],
    ["closes", "closes"],
  ])
    db.run(`UPDATE tasks SET ${column} = (SELECT json_extract(i.item, '$.${field}') FROM items i
      WHERE i.owner = tasks.owner AND i.repo = tasks.repo AND i.kind = 'task'
        AND i.id = CAST(tasks.task AS TEXT) AND json_valid(i.item))
      WHERE ${column} IS NULL`);
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
  db.transaction(() => {
    prepareTables(db);
    viewThreads(db);
  }).immediate();
  return db;
}

// Returns whether the database keeps tasks, as a new one does, and one from an earlier release
// does once its threads have moved onto them.
export const hasTasks = (db: Database) =>
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
// kept in the file, not on one connection: when the daemon moves the threads onto tasks, or a
// newer release adds columns, the view is made again, and every connection already open reads
// the new one from then on. So the columns the view had keep their places, and new ones go at
// its end. Bun keeps a cached query's column names when SQLite prepares it again for a changed
// view, so a column put in the middle would make an older screen, still running, read each
// value after it under another column's name. It is made again only when it changes, as that
// changes the file's schema, which every other connection then reads again.
function viewThreads(db: Database): void {
  const own = ["owner", "repo", "task", "folder", "branch", "base", "status", "session"];
  const moved = hasTasks(db);
  // A daemon of an earlier release reads `stalled` from this view until it stops. So the view
  // has a `stalled` where that release had it, with the same value as `turn_ended`, and puts
  // `turn_ended` last, where a query that daemon already prepared reads nothing. Every database
  // has the same columns, so none depends on whether the threads table still has its own
  // `stalled`. Until the new daemon moves a thread, its `turn_ended` shows that `stalled`, so the
  // screen and sc show a turn that ended meanwhile.
  const turnEnded = hasColumn(db, "threads", "stalled")
    ? "COALESCE(th.turn_ended, th.stalled)"
    : "th.turn_ended";
  // Each column by its name in the view, in the order a new database's view has them.
  const threadColumn = (column: string): [string, string] =>
    column === "turn_ended" ? ["stalled", `${turnEnded} AS stalled`] : [column, `th.${column}`];
  const named = new Map([
    ...[...own, ...Object.keys(threadColumns)].map(threadColumn),
    ...Object.keys(taskColumns).map((column): [string, string] => [
      column,
      `${moved ? "k" : "th"}.${column}`,
    ]),
    ["turn_ended", `${turnEnded} AS turn_ended`],
  ]);
  // The view the database has keeps its order, and the columns it lacks follow. That holds for
  // a view an earlier release made in another order too. Putting an older order back would
  // fix no screen: one that cached the older order stopped at its first bad value, as a throw
  // ends the sidebar. It would break every screen and daemon started since, which read this one.
  const had = db
    .query("SELECT name FROM pragma_table_info('task_threads')")
    .all()
    .map((row) => z.object({ name: z.string() }).parse(row).name)
    .filter((name) => named.has(name));
  const order = [...new Set([...had, ...named.keys()])];
  const columns = order.flatMap((name) => named.get(name) ?? []);
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
    linkIssues(db);
    recoverMerges(db);
    viewThreads(db);
  }).immediate();
}

// Fills in the columns a tasks table from an earlier release gained: each task's issue link and
// whether its work merged. Any sc run adds the columns, but only the daemon fills them, once it
// holds the lock that keeps a second daemon out. Filled while the earlier release's daemon still
// ran, a task it started or merged afterwards would miss its link or its merge for good.
export function finishUpgrade(db: Database): void {
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM upgrades WHERE step = 'fill tasks'").get()) return;
    linkIssues(db);
    recoverMerges(db);
    db.run("DELETE FROM upgrades WHERE step = 'fill tasks'");
  }).immediate();
}

// Returns SQL that marks, in `table`, every task whose saved checks show a poll found CI as
// having seen CI, for a database from before Skelcrew kept that. Otherwise checks that vanish
// before the first poll after the upgrade would read as a repository without CI.
const seenBefore = (table: string) => `UPDATE ${table} SET ci_seen = 1 WHERE checks IS NOT NULL`;

// Returns whether the table has the column.
const hasColumn = (db: Database, table: string, column: string) =>
  db.query(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) !== null;

// Creates the tables Skelcrew keeps, and adds the columns a database from an earlier release
// lacks, leaving everything already there as it is.
function prepareTables(db: Database): void {
  // An earlier release named threads by a code of the machine's, kept in a table named machine.
  // Nothing reads it now, but it stays: that release's daemon can still be running as a newer sc
  // opens the database, and it reads the code each time it starts a thread.
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
  // is doing, as a thread's `state` says for its builder. `agents_noted` is the tree of an
  // .agents/ you haven't approved that the lead was told of, or `none` for one removed, so it is
  // told once. `lead_flows` is whether the lead knows of flows, from the instructions it started
  // with or a note, so a lead already running when Skelcrew learned of them is told once.
  // `lead_briefs` is the same for briefing another repository's lead. `ci_seen` is whether a
  // poll ever found CI on any of the repository's PRs, kept after they close, so a merge never
  // takes a PR with no checks yet for one without CI. `lead_host` is the session host the lead
  // runs on, tmux or a runtime plugin, which it keeps until it ends, and `lead_host_id` its
  // session's ID there. A lead from before hosts runs on tmux, where its ID is its name.
  // `lead_agents` is the tree of the approved .agents/ the running lead started on, `none` for
  // the built-in roles, or null for a lead started before Skelcrew kept it, which starts again
  // on the approved .agents/ the next time it is asked for, if you approved one.
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
    agents_noted: "TEXT",
    lead_flows: "INTEGER NOT NULL DEFAULT 0",
    lead_briefs: "INTEGER NOT NULL DEFAULT 0",
    ci_seen: "INTEGER NOT NULL DEFAULT 0",
    lead_host: "TEXT DEFAULT 'tmux'",
    lead_host_id: "TEXT",
    lead_agents: "TEXT",
  };
  // Whether repositories gain `ci_seen` now, so it is filled from the copy below.
  const repositoriesSeen = !hasColumn(db, "repositories", "ci_seen");
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
  const threadsSeen = !hasColumn(db, "threads", "ci_seen");
  const reviewsFlagged = !hasColumn(db, "threads", "review_failed");
  for (const [column, type] of Object.entries({ ...threadColumns, ...taskColumns }))
    if (!hasColumn(db, "threads", column))
      db.run(`ALTER TABLE threads ADD COLUMN ${column} ${type}`);
  if (threadsSeen) db.run(seenBefore("threads"));
  if (!fresh && reviewsFlagged) flagFailedReviews(db);
  // A new database starts with tasks. One from an earlier release waits for its daemon to move
  // its threads onto tasks, as only the daemon knows no other daemon still writes to it.
  if (fresh) createTasks(db);
  // Work on the tables left for the daemon, by name, until it is done.
  db.run("CREATE TABLE IF NOT EXISTS upgrades (step TEXT PRIMARY KEY)");
  // A tasks table made by an earlier release lacks the task's newer columns. Filling them in
  // waits for the new daemon, as finishUpgrade says.
  if (hasTasks(db)) {
    const tasksSeen = !hasColumn(db, "tasks", "ci_seen");
    for (const [column, type] of Object.entries(taskColumns))
      if (!hasColumn(db, "tasks", column)) {
        db.run(`ALTER TABLE tasks ADD COLUMN ${column} ${type}`);
        if (column === "issue_link" || column === "merged" || column === "closes")
          db.run("INSERT OR IGNORE INTO upgrades (step) VALUES ('fill tasks')");
      }
    if (tasksSeen) db.run(seenBefore("tasks"));
  }
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
  // A note's ID is never used twice, which AUTOINCREMENT makes so: without it, SQLite gives a
  // new note the ID of the last one deleted. Typing a note deletes it by its ID once it is in,
  // and a note dropped while it was typed, such as a thread's end once the thread starts over,
  // must not hand its ID to a note saved meanwhile, which would then be deleted unheard.
  // The release the daemon installed in the background, for the list's notice, until it runs
  // on it. At most one row.
  db.run("CREATE TABLE IF NOT EXISTS installed (release TEXT NOT NULL)");
  db.run(
    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)",
  );
  // A note names its repository, and one from before each repository had its own lead names
  // none until adoptOldLead gives it one. A note that a thread ended or failed names that
  // thread's folder in `ended`, so a thread starting over there can drop it before the lead
  // hears it.
  for (const column of ["owner", "repo", "ended"])
    if (!db.query("SELECT 1 FROM pragma_table_info('notes') WHERE name = ?").get(column))
      db.run(`ALTER TABLE notes ADD COLUMN ${column} TEXT`);
  // A database from an earlier release made the table without AUTOINCREMENT, which SQLite can't
  // add to a table, so the notes move to a new one, keeping their IDs.
  const notesTable = z
    .object({ sql: z.string() })
    .parse(db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get());
  if (!notesTable.sql.includes("AUTOINCREMENT")) {
    db.run(
      "CREATE TABLE notes_new (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, owner TEXT, repo TEXT, ended TEXT)",
    );
    db.run(
      "INSERT INTO notes_new (id, text, owner, repo, ended) SELECT id, text, owner, repo, ended FROM notes",
    );
    db.run("DROP TABLE notes");
    db.run("ALTER TABLE notes_new RENAME TO notes");
  }
  // `urgent` marks a note the human may need soon, such as a builder's message, which goes
  // ahead of Skelcrew's routine notes when several wait for the lead.
  if (!db.query("SELECT 1 FROM pragma_table_info('notes') WHERE name = 'urgent'").get())
    db.run("ALTER TABLE notes ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0");
  // `wrapped` marks a builder's message or a brief, which Skelcrew wraps in its own tags, apart
  // from notes whose tags, from outside text, are escaped as they are typed in. A builder's
  // message saved before is told by its exact shape: Skelcrew's opening tag on its first line and
  // its closing tag on its last. No other note starts so, as each starts with a thread's name or
  // Skelcrew's words, and a plugin's note is on one line. The older Skelcrew removed only exact
  // skelcrew tags from inside, so the body can still hold a brief's <asked> or <brief>, or a
  // closing tag with a space, such as </skelcrew >. So its body is escaped as outside text is,
  // with the < that starts any such tag written &lt;, and the wrapper is kept as it was.
  if (!db.query("SELECT 1 FROM pragma_table_info('notes') WHERE name = 'wrapped'").get()) {
    db.run("ALTER TABLE notes ADD COLUMN wrapped INTEGER NOT NULL DEFAULT 0");
    const saved = z.array(z.object({ id: z.number(), text: z.string() }));
    for (const { id, text } of saved.parse(db.query("SELECT id, text FROM notes").all())) {
      const shape = text.match(
        /^(<skelcrew from="[^"<>]+" reply="sc tell [^"<>]+">)\n([\s\S]*)\n<\/skelcrew>$/,
      );
      const [, wrapper, inside] = shape ?? [];
      if (wrapper === undefined || inside === undefined) continue;
      const body = inside.replace(/<(?=\s*\/?\s*(?:skelcrew|asked|brief))/gi, "&lt;");
      db.run("UPDATE notes SET wrapped = 1, text = ? WHERE id = ?", [
        `${wrapper}\n${body}\n</skelcrew>`,
        id,
      ]);
    }
  }
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
  // A lead's message to a builder, and a builder's message or a brief to a lead, are typed in as
  // Skelcrew wrapped them. One saved before herdr's <hc> tags were removed from inside can still
  // hold one, so it is escaped. A brief's plain <asked> or <brief> element with one is escaped
  // whole and marked escaped="yes", as a new brief's is, so the lead reads back the exact words:
  // & as &amp; and < as &lt;. Such an element held no tag or control character of Skelcrew's,
  // which escaped it then. Anywhere else, only the < that starts the tag is written &lt;.
  // Skelcrew's wrapper holds no such tag, and escaped text no longer matches, so this changes
  // nothing the next time.
  const herdrTag = /<(?=\s*\/?\s*hc\b)/i;
  const Saved = z.array(z.object({ id: z.number(), text: z.string() }));
  for (const { id, text } of Saved.parse(
    db.query("SELECT id, text FROM notes WHERE wrapped = 1").all(),
  )) {
    const escaped = text
      .replace(
        /\n<(asked|brief)>\n([\s\S]*?)\n<\/\1>(?=\n)/g,
        (element, tag: string, said: string) =>
          herdrTag.test(said)
            ? `\n<${tag} escaped="yes">\n${said.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}\n</${tag}>`
            : element,
      )
      .replace(new RegExp(herdrTag.source, "gi"), "&lt;");
    if (escaped !== text) db.run("UPDATE notes SET text = ? WHERE id = ?", [escaped, id]);
  }
  // A builder's waiting messages are saved escaped too: the < that starts a herdr tag in the
  // lead's, wrapped by Skelcrew, and that of any herdr, skelcrew, asked or brief tag in Skelcrew's
  // or the review's, which quote people. One the older Skelcrew pasted at the builder's prompt,
  // left there for a question, sits there unescaped. So escaping it also forgets it was pasted:
  // Skelcrew then waits on that draft as on a person's and never presses Enter on it, and the
  // escaped text goes in once the draft is gone.
  const Waiting = z.array(z.object({ id: z.number(), sender: z.string(), text: z.string() }));
  for (const { id, sender, text } of Waiting.parse(
    db.query("SELECT id, sender, text FROM messages").all(),
  )) {
    const tag =
      sender === "lead" ? herdrTag.source : /<(?=\s*\/?\s*(?:skelcrew|asked|brief|hc\b))/.source;
    const escaped = text.replace(new RegExp(tag, "gi"), "&lt;");
    if (escaped !== text)
      db.run("UPDATE messages SET text = ?, pasted = 0 WHERE id = ?", [escaped, id]);
  }
  // For each open PR in Skelcrew's copy, the head commit and base branch a poll last looked at
  // and whether the PR's changes there touch .agents/, so the merge confirms say so while reading
  // only the database. Each poll looks again, as a retargeted PR or a moved base can change that.
  db.run(`CREATE TABLE IF NOT EXISTS pr_agents (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    changed INTEGER NOT NULL,
    PRIMARY KEY (owner, repo, pr)
  )`);
  // The reviews Skelcrew posted with your gh login, before its forge posted them as its own app.
  db.run("DROP TABLE IF EXISTS posted");
  // The claims Skelcrew asked a tracker for, to start a labelled issue, whose outcome it doesn't
  // know yet: saved before it asks, and gone once the task is recorded or the tracker said no.
  // One still here after a stop of the engine or a failed ask may have been granted to this
  // machine, though the tracker now says the issue is taken. A task sc start put in the queue of
  // limits.threads has one too, until its claim is made, and can't leave the queue before.
  db.run(`CREATE TABLE IF NOT EXISTS claims (
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    task TEXT NOT NULL,
    PRIMARY KEY (owner, repo, task)
  )`);
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
  // The commands you approved for a plugin from a folder of yours, as JSON, so building it again
  // asks only when they change. Null for a plugin from GitHub, and for one installed before
  // Skelcrew kept them, which is asked about once more.
  if (!db.query("SELECT 1 FROM pragma_table_info('plugins') WHERE name = 'approved'").get())
    db.run("ALTER TABLE plugins ADD COLUMN approved TEXT");
  // A PR in the copy that showed CI before repositories kept it counts as CI found. It may have
  // closed while the daemon was down, and the first poll after drops it from the copy, so a
  // merge would then take a PR with no checks yet for one in a repository without CI. Skelcrew's
  // own check is no CI, and an item that isn't JSON is read as none.
  if (repositoriesSeen)
    db.run(`UPDATE repositories SET ci_seen = 1 WHERE EXISTS (
      SELECT 1 FROM items,
        json_each(CASE WHEN json_valid(items.item) THEN items.item ELSE '{}' END, '$.checks') AS c
      WHERE items.owner = repositories.owner AND items.repo = repositories.repo
        AND items.kind = 'pr' AND json_extract(c.value, '$.name') IS NOT 'skelcrew/check')`);
}

// Upgrades the threads an earlier release saved, whose `turn_ended` is still null, from its
// `stalled`: a builder that stopped without submitting, which then needed you. Such a turn now
// waits on the lead, which reads the builder's last message. These turns never sent the lead
// one, so it gets a note to ask the builder instead, whether or not it already heard that the
// thread needed you. A note it hasn't heard yet would say the thread needs you, which is no
// longer so, so it goes. Only the daemon runs it, once it holds the lock that keeps a second
// daemon out: a daemon of the earlier release, still running, could change `stalled` after
// the move. A thread saved since has `turn_ended`, so each thread moves once.
export function moveTurnEnded(db: Database): void {
  if (!hasColumn(db, "threads", "stalled")) return;
  const unmoved = "turn_ended IS NULL";
  // One transaction, so a move cut short leaves every thread to the next start.
  db.transaction(() => {
    db.run(`INSERT INTO notes (owner, repo, text)
      SELECT th.owner, th.repo, r.name || '-' || th.task || '''s builder ended its turn without sc submit before Skelcrew sent such turns to you, so its last message never reached you. Ask it what it waits on with sc tell ' || r.name || '-' || th.task || ', and bring a question to the human.'
      FROM threads th JOIN repositories r ON r.owner = th.owner AND r.repo = th.repo
      WHERE th.${unmoved} AND th.stalled = 1 AND th.status IN ('working', 'waiting')
      ORDER BY th.rowid`);
    // Only a thread that no longer needs you loses its note. One that still does keeps it.
    db.run(`UPDATE threads SET noting = NULL WHERE ${unmoved} AND stalled = 1 AND needs_you = 0
      AND asking = 0 AND (erred = 0 OR limited = 1)`);
    db.run(`UPDATE threads SET turn_ended = stalled WHERE ${unmoved}`);
  }).immediate();
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
