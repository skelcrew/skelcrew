// Skelcrew's database, opened over one that lacks the newer columns.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePlugin, source, threadSql } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-db-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("a thread saved before the newer columns keeps working, with no rounds and no pull request yet", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skelcrew.db"));
  old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
    session TEXT, PRIMARY KEY (owner, repo, task))`);
  old.run(
    `INSERT INTO threads VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', NULL, 'working', NULL)`,
  );
  old.close();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { liveThreads } from ${JSON.stringify(source("flow/thread.ts"))};
console.log(JSON.stringify(liveThreads(openDb())));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([
    expect.objectContaining({
      folder: "app-12",
      rounds: 0,
      pr: null,
      needs_you: false,
      reviewing: null,
      queued: null,
      submitting: null,
      telling: null,
      held: null,
      last_review: null,
      last_comment: null,
      last_check: null,
      title: null,
      started: null,
      checks: null,
      reviewer: null,
      reviewed_by: null,
      review_round: null,
      verdict: null,
      review_line: null,
    }),
  ]);
});

// The daemon writes while Skelcrew run in your terminal, or a test, reads or writes too.
test("a write waits for another process's write instead of failing", async () => {
  const db = JSON.stringify(source("db.ts"));
  const env = { ...process.env, HOME: home };
  const run = (code: string) =>
    Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  await run(`import { openDb } from ${db}; openDb();`).exited;
  const file = JSON.stringify(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  const held = JSON.stringify(join(home, "held"));
  const holder = run(`import { Database } from "bun:sqlite";
const db = new Database(${file});
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
await Bun.write(${held}, "");
await Bun.sleep(1000);
db.run("COMMIT");`);
  while (!(await Bun.file(join(home, "held")).exists())) await Bun.sleep(20);
  const writer = run(`import { openDb } from ${db};
openDb().run("INSERT INTO repositories (owner, repo, name) VALUES ('simon', 'site', 'site')");`);
  const [err, code] = await Promise.all([new Response(writer.stderr).text(), writer.exited]);
  await holder.exited;
  expect(err).toBe("");
  expect(code).toBe(0);
});

test("a process that opens the database while another is adding the newer columns still starts", async () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const other = new Database(join(data, "skelcrew.db"));
  // The waiting process keeps looking at the file, and a commit that meets one of those looks
  // fails at once without a wait of its own.
  other.run("PRAGMA busy_timeout = 5000");
  other.run(`CREATE TABLE repositories (owner TEXT NOT NULL, repo TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE, PRIMARY KEY (owner, repo))`);
  other.run("BEGIN IMMEDIATE");
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
console.log("opening");
openDb().close();`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = run.stdout.getReader();
  await reader.read();
  // Long enough for the process to reach the point where it waits for its turn to write. One
  // that gets there late only sees the finished columns, so a slow machine can't fail this.
  await Bun.sleep(500);
  other.run("ALTER TABLE repositories ADD COLUMN labeled INTEGER NOT NULL DEFAULT 0");
  other.run("COMMIT");
  other.close();
  expect(await new Response(run.stderr).text()).toBe("");
  expect(await run.exited).toBe(0);
}, 60_000);

// A database from the release before Skelcrew kept a copy of issues and PRs: it had only the
// newest open ones' numbers and titles, for the sidebar.
test("a database from before the copy gains it, and keeps its repositories and threads", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skelcrew.db"));
  old.run(`CREATE TABLE repositories (owner TEXT NOT NULL, repo TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE, labeled INTEGER NOT NULL DEFAULT 0,
    open_issues INTEGER NOT NULL DEFAULT 0, open_prs INTEGER NOT NULL DEFAULT 0,
    lead_session TEXT, opened INTEGER, kept_lead INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner, repo))`);
  old.run(
    `INSERT INTO repositories (owner, repo, name, open_issues) VALUES ('simon', 'app', 'app', 240)`,
  );
  old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
    session TEXT, PRIMARY KEY (owner, repo, task))`);
  old.run(
    `INSERT INTO threads VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', NULL, 'working', NULL)`,
  );
  old.run(`CREATE TABLE open_items (owner TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL,
    number INTEGER NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL,
    PRIMARY KEY (owner, repo, kind, number))`);
  old.run(`INSERT INTO open_items VALUES ('simon', 'app', 'issue', 12, 'Add export', 'x')`);
  old.close();
  const task = {
    kind: "task",
    id: "12",
    title: "Add export",
    body: "As JSON",
    state: "open",
    author: null,
    labels: ["skelcrew"],
    link: "https://github.com/simon/app/issues/12",
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    closes: "Closes #12",
  };
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { saveItems, taskOf } from ${JSON.stringify(source("flow/copy.ts"))};
import { liveThreads } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
const before = db.query("SELECT COUNT(*) AS n FROM items").get();
saveItems(db, "simon", "app", [${JSON.stringify(task)}], ["task"]);
const counts = db.query("SELECT open_issues, open_prs FROM repositories").get();
console.log(JSON.stringify({ before, task: taskOf(db, "simon", "app", 12), counts,
  threads: liveThreads(db).map((t) => t.folder) }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    before: { n: 0 },
    task,
    counts: { open_issues: 1, open_prs: 0 },
    threads: ["app-12"],
  });
});

test("each change that goes in a thread's log saves when it happened, for the list of threads", () => {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { log, readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run(${JSON.stringify(threadSql({ task: "12" }))});
const before = readThread(db, "app-12").changed;
const start = Date.now();
record(db, "app-12", { status: "waiting" });
const recorded = readThread(db, "app-12").changed;
db.run("UPDATE threads SET changed = 0");
log(db, readThread(db, "app-12"), "the lead told its builder: hello");
console.log(JSON.stringify({ before, start, recorded, logged: readThread(db, "app-12").changed,
  end: Date.now() }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const { before, start, recorded, logged, end } = JSON.parse(run.stdout.toString());
  expect(before).toBeNull();
  expect(recorded).toBeGreaterThanOrEqual(start);
  expect(recorded).toBeLessThanOrEqual(end);
  expect(logged).toBeGreaterThanOrEqual(start);
});

// A notes table from before notes' IDs were never used twice moves to one where they never are,
// keeping its notes and their IDs.
test("an earlier notes table keeps its notes and never gives a deleted note's ID again", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skelcrew.db"));
  old.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, owner TEXT, repo TEXT)");
  old.run("INSERT INTO notes (id, text, owner, repo) VALUES (1, 'first', 'simon', 'app')");
  old.run("INSERT INTO notes (id, text, owner, repo) VALUES (2, 'second', 'simon', 'app')");
  old.close();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
const kept = db.query("SELECT id, text FROM notes ORDER BY id").all();
db.run("DELETE FROM notes WHERE id = 2");
db.run("INSERT INTO notes (owner, repo, text) VALUES ('simon', 'app', 'third')");
const third = db.query("SELECT id FROM notes WHERE text = 'third'").get().id;
console.log(JSON.stringify({ kept, third }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    kept: [
      { id: 1, text: "first" },
      { id: 2, text: "second" },
    ],
    third: 3,
  });
});

// A turn that ended without a submit once needed you, and never sent the lead the builder's
// last message. After the upgrade the lead must hear of it once. It still shows under Needs you
// while the lead reads it. A new
// screen opens the database first, while the earlier release's daemon still runs and changes its
// threads, so only the new daemon, once it holds its lock, moves them.
test("a thread whose turn ended before the upgrade has its lead told once, and shows under Needs you", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skelcrew.db"));
  old.run(
    "CREATE TABLE repositories (owner TEXT NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL UNIQUE, PRIMARY KEY (owner, repo))",
  );
  old.run("INSERT INTO repositories VALUES ('simon', 'app', 'app')");
  old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
    session TEXT, stalled INTEGER NOT NULL DEFAULT 0, noting TEXT, PRIMARY KEY (owner, repo, task))`);
  // app-12's lead already heard it needed you. app-13's note still waits. app-14 is done.
  // app-15's builder works, and app-16's turn ended, until the old daemon changes them.
  old.run(`INSERT INTO threads VALUES
    ('simon', 'app', 12, 'app-12', 'skelcrew/12', NULL, 'waiting', NULL, 1, NULL),
    ('simon', 'app', 13, 'app-13', 'skelcrew/13', NULL, 'working', NULL, 1, 'its builder stopped without submitting'),
    ('simon', 'app', 14, 'app-14', 'skelcrew/14', NULL, 'done', NULL, 1, NULL),
    ('simon', 'app', 15, 'app-15', 'skelcrew/15', NULL, 'working', NULL, 0, NULL),
    ('simon', 'app', 16, 'app-16', 'skelcrew/16', NULL, 'working', NULL, 1, NULL)`);
  old.close();
  const code = `import { Database } from "bun:sqlite";
import { moveTurnEnded, openDb } from ${JSON.stringify(source("db.ts"))};
import { liveThreads } from ${JSON.stringify(source("flow/thread.ts"))};
import { needsYou } from ${JSON.stringify(source("flow/status.ts"))};
// A new screen opens the database.
openDb().close();
// The old daemon, still running, sees app-15's builder stop and app-16's get an answer.
const oldDaemon = new Database(process.argv[1]);
oldDaemon.run("UPDATE threads SET stalled = 1, noting = 'its builder stopped without submitting' WHERE folder = 'app-15'");
oldDaemon.run("UPDATE threads SET stalled = 0 WHERE folder = 'app-16'");
oldDaemon.close();
// The new daemon starts, twice, as after a restart.
for (const start of [1, 2]) {
  const db = openDb();
  moveTurnEnded(db);
  db.close();
}
const db = openDb();
const threads = liveThreads(db).map((t) => ({ folder: t.folder, turn_ended: t.turn_ended, noting: t.noting, needsYou: needsYou(t) }));
const notes = db.query("SELECT owner, repo, text FROM notes ORDER BY id").all();
console.log(JSON.stringify({ threads, notes }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code, join(data, "skelcrew.db")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const { threads, notes } = JSON.parse(run.stdout.toString());
  expect(threads).toEqual([
    { folder: "app-12", turn_ended: true, noting: null, needsYou: true },
    { folder: "app-13", turn_ended: true, noting: null, needsYou: true },
    { folder: "app-15", turn_ended: true, noting: null, needsYou: true },
    { folder: "app-16", turn_ended: false, noting: null, needsYou: false },
  ]);
  expect(notes).toEqual(
    ["app-12", "app-13", "app-15"].map((name) => ({
      owner: "simon",
      repo: "app",
      text: `${name}'s builder ended its turn without sc submit before Skelcrew sent such turns to you, so its last message never reached you. Ask it what it waits on with sc tell ${name}, and bring a question to the human.`,
    })),
  );
});

// A daemon of the earlier release reads \`stalled\` from the database's view. A database made by
// this release has it too, with the same value as \`turn_ended\`.
test("a new database's view has stalled with the same value as turn_ended", () => {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
for (const [task, ended] of [[12, 1], [13, 0]]) {
  db.run("INSERT INTO threads (owner, repo, task, folder, branch, status, turn_ended) VALUES ('simon', 'app', ?, ?, ?, 'working', ?)",
    [task, "app-" + task, "skelcrew/" + task, ended]);
  db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', ?)", [task]);
}
console.log(JSON.stringify(db.query("SELECT folder, stalled, turn_ended FROM task_threads ORDER BY rowid").all()));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([
    { folder: "app-12", stalled: 1, turn_ended: 1 },
    { folder: "app-13", stalled: 0, turn_ended: 0 },
  ]);
});

// A daemon of the earlier release reads every thread from the database's view, and keeps the
// queries it prepared. A new screen opening the database makes the view again while that daemon
// still runs. The daemon must go on seeing its builders' turns that ended, or it loses track of
// a builder waiting for an answer.
test("a daemon of the earlier release still sees turns that ended once a new screen opens the database", () => {
  const code = `import { Database } from "bun:sqlite";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { liveThreads } from ${JSON.stringify(source("flow/thread.ts"))};
// The earlier release's database: this one's, with the column \`stalled\` where \`turn_ended\`
// is, and a view of each thread's and task's columns, without \`turn_ended\` at its end.
const made = openDb();
made.run("ALTER TABLE threads RENAME COLUMN turn_ended TO stalled");
const names = (table) => made.query("SELECT name FROM pragma_table_info(?)").all(table).map((c) => c.name);
const own = names("threads");
const viewed = names("task_threads").filter((c) => c !== "rowid" && c !== "turn_ended");
made.run("DROP VIEW task_threads");
made.run(\`CREATE VIEW task_threads AS SELECT th.rowid AS rowid, \${viewed.map((c) => (own.includes(c) ? "th." : "k.") + c).join(", ")}
  FROM threads th JOIN tasks k ON k.owner = th.owner AND k.repo = th.repo AND k.task = th.task\`);
for (const [task, stalled] of [[12, 1], [13, 0]]) {
  made.run("INSERT INTO threads (owner, repo, task, folder, branch, status, stalled, noting) VALUES ('simon', 'app', ?, ?, ?, 'working', ?, ?)",
    [task, "app-" + task, "skelcrew/" + task, stalled, "note " + task]);
  made.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', ?)", [task]);
}
made.close();
// The earlier release's daemon runs, and has read its threads once.
const oldDaemon = new Database(process.argv[1]);
const read = "SELECT * FROM task_threads ORDER BY rowid";
oldDaemon.query(read).all();
// A new screen opens the database. Then app-13's builder ends its turn, which the old daemon
// saves, and app-12's builder submits, which a new sc saves.
const screen = openDb();
oldDaemon.run("UPDATE threads SET stalled = 1 WHERE folder = 'app-13'");
screen.run("UPDATE threads SET turn_ended = 0 WHERE folder = 'app-12'");
screen.close();
const seen = (rows) => rows.map((t) => ({ folder: t.folder, stalled: t.stalled, noting: t.noting }));
console.log(JSON.stringify({
  prepared: seen(oldDaemon.query(read).all()),
  fresh: seen(oldDaemon.prepare(read).all()),
  now: liveThreads(openDb()).map((t) => ({ folder: t.folder, turn_ended: t.turn_ended })),
}));`;
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const run = Bun.spawnSync([process.execPath, "-e", code, join(data, "skelcrew.db")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const threads = [
    { folder: "app-12", stalled: 0, noting: "note 12" },
    { folder: "app-13", stalled: 1, noting: "note 13" },
  ];
  expect(JSON.parse(run.stdout.toString())).toEqual({
    prepared: threads,
    fresh: threads,
    now: [
      { folder: "app-12", turn_ended: false },
      { folder: "app-13", turn_ended: true },
    ],
  });
});

// A remote two machines share, with a first commit on main, and two machines, laptop and lapdog.
// Each has a database from when Skelcrew named threads by a code of the machine's, the same for
// both, as for laptop and lapdog. Returns the remote and each machine's home.
function twoMachines(): { remote: string; homes: string[] } {
  const remote = join(home, "app.git");
  const work = join(home, "work");
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  mkdirSync(work);
  git(home, "init", "-q", "--bare", "-b", "main", remote);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(
    join(work, "skelcrew.yaml"),
    "setup: []\ntest: []\nlimits: { threads: 9 }\nroles: { builder: { harness: claude }, reviewer: { harness: claude } }\n",
  );
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
  git(work, "push", "-q", remote, "main");
  const homes = ["laptop", "lapdog"].map((name) => join(home, name));
  for (const machine of homes) {
    const data = join(machine, ".local", "share", "skelcrew");
    mkdirSync(data, { recursive: true });
    const db = new Database(join(data, "skelcrew.db"));
    db.run("CREATE TABLE machine (code TEXT NOT NULL)");
    db.run("INSERT INTO machine VALUES ('lp')");
    db.close();
  }
  return { remote, homes };
}

// Starts threads with no issue on the machine whose home is given, one after another, after
// running `before` against its database. Gives back the process, which prints their names.
function startOn(machine: string, remote: string, titles: string[], before = "") {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { threadName } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
${before}
const names = [];
for (const title of ${JSON.stringify(titles)})
  names.push(threadName(db, await startThread(db, { repo: "app", title, body: "b" })));
console.log(JSON.stringify(names));`;
  return Bun.spawn([process.execPath, "-e", code], {
    // A git of the machine's own in its bin folder, if a test gives it one, goes first.
    env: { ...process.env, HOME: machine, PATH: `${join(machine, "bin")}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Waits for a process from startOn and returns the names it printed, on its last line. A line
// before it is a log line, such as an old name claimed as a start refreshes the backlog.
async function namesFrom(run: ReturnType<typeof startOn>): Promise<string[]> {
  const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  expect(err).toBe("");
  return JSON.parse(out.trim().split("\n").at(-1) ?? "");
}

// Two machines take names from the remote they share, at the same moment.
test("two machines starting threads at once never take one name", async () => {
  const { remote, homes } = twoMachines();
  const titles = ["One", "Two", "Three"];
  const runs = homes.map((machine) => startOn(machine, remote, titles));
  const names = (await Promise.all(runs.map(namesFrom))).flat();
  expect(names).toHaveLength(6);
  expect(new Set(names).size).toBe(6);
  expect(names.every((name) => /^APP-[1-6]$/.test(name))).toBe(true);
}, 60_000);

// A claimed name stays claimed once its branch is gone, such as once its PR merged.
test("a name stays taken on another machine once claimed", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  expect(await namesFrom(startOn(laptop, remote, ["One"]))).toEqual(["APP-1"]);
  expect(await namesFrom(startOn(lapdog, remote, ["Two"]))).toEqual(["APP-2"]);
}, 60_000);

// Threads named before Skelcrew claimed names on the remote, such as app-t25, were never claimed,
// and live only in the database of the machine that started them. So where a machine holds one,
// numbers start at 100, above all of them, and go on above every claim and every number this
// machine's tasks hold, claimed or not. Claims of names from a machine's code, such as wr140,
// don't count. A brand-new repository, with no old name, starts at t1, as the test above shows.
test("a machine with an old name takes t100, or the next number above every one claimed or held", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const old = `db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 't25')");`;
  expect(await namesFrom(startOn(laptop, remote, ["One"], old))).toEqual(["APP-100"]);
  const work = join(home, "work");
  for (const claim of ["t150", "wr140"])
    Bun.spawnSync(["git", "-C", work, "push", "-q", remote, `HEAD:refs/skelcrew/names/${claim}`]);
  const held = `db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 't170')");`;
  expect(await namesFrom(startOn(lapdog, remote, ["Two", "Three"], held))).toEqual([
    "APP-171",
    "APP-172",
  ]);
}, 60_000);

// Runs the daemon's refresh of app's backlog on a machine holding an old name, t3, from before
// Skelcrew claimed names, then starts a task there titled `title`, if given. Returns what it logged
// and the names it started.
async function refreshWithOldName(machine: string, remote: string, title?: string) {
  const clone = join(machine, ".local", "share", "skelcrew", "repos", "simon", "app");
  Bun.spawnSync(["git", "clone", "-q", remote, clone]);
  const before = `db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 't3')");
const { refreshBacklog } = await import(${JSON.stringify(source("flow/backlog.ts"))});
await refreshBacklog(db, db.query("SELECT * FROM repositories").get(), ${JSON.stringify(clone)});`;
  const run = startOn(machine, remote, title ? [title] : [], before);
  const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  expect(err).toBe("");
  const lines = out.trim().split("\n");
  return { said: lines.slice(0, -1), names: JSON.parse(lines.at(-1) ?? "[]") };
}

// Old names live only on the machine that has them, so another machine's first task could take
// one. The daemon claims them as old names as it refreshes the repository, and every machine then
// numbers above 99, above any machine's old names, claimed or not yet.
test("a machine claims its old names as it refreshes, so another machine's first task goes above them", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const refreshed = await refreshWithOldName(laptop, remote);
  expect(refreshed.said).toEqual(["claimed APP-3, a name from before Skelcrew claimed names"]);
  const claims = Bun.spawnSync(["git", "ls-remote", remote, "refs/skelcrew/*"]).stdout.toString();
  expect(claims).toContain("refs/skelcrew/old-names/t3");
  expect(claims).not.toContain("refs/skelcrew/names/t3");
  expect(await namesFrom(startOn(lapdog, remote, ["One"]))).toEqual(["APP-100"]);
}, 60_000);

// A claim doesn't say which machine made it, so an old name another machine claimed first is
// left as it is: the two tasks share it. This machine's next name still goes above every name.
test("an old name another machine claimed first is left alone, and the next name goes above it", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  expect(await namesFrom(startOn(lapdog, remote, ["One", "Two", "Three"]))).toEqual([
    "APP-1",
    "APP-2",
    "APP-3",
  ]);
  const refreshed = await refreshWithOldName(laptop, remote, "Four");
  expect(refreshed.said).toEqual([]);
  expect(refreshed.names).toEqual(["APP-4"]);
  const claims = Bun.spawnSync(["git", "ls-remote", remote, "refs/skelcrew/*"]).stdout.toString();
  expect(claims).not.toContain("old-names");
}, 60_000);

// A machine reads the claims, then another machine claims a higher name before it pushes. Its
// claim of a name below that one is refused, so it reads again and names its task above it. Two
// machines with different histories then never claim out of order, even at once.
test("a claim made from claims read before another machine's is refused, and the next name goes above", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const clone = join(laptop, ".local", "share", "skelcrew", "repos", "simon", "app");
  Bun.spawnSync(["git", "clone", "-q", remote, clone]);
  // The laptop reads the claims, and waits for the lapdog's claim before it claims t1.
  const ready = join(home, "lapdog-claimed");
  const code = `import { existsSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { claimedNames, claimName } from ${JSON.stringify(source("flow/git.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
const [repository] = db.query("SELECT * FROM repositories").all();
const read = await claimedNames(db, repository);
console.log("read");
while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(20);
console.log(JSON.stringify(await claimName(db, repository, ${JSON.stringify(clone)}, "t1", read.last)));
db.run("DELETE FROM repositories");`;
  const run = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = run.stdout.getReader();
  const decoder = new TextDecoder();
  let said = "";
  while (!said.includes("read\n")) said += decoder.decode((await out.read()).value);
  // The lapdog holds t170, so it claims t171.
  const held = `db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 't170')");`;
  expect(await namesFrom(startOn(lapdog, remote, ["One"], held))).toEqual(["APP-171"]);
  writeFileSync(ready, "");
  while (true) {
    const { value, done } = await out.read();
    if (done) break;
    said += decoder.decode(value);
  }
  expect(await new Response(run.stderr).text()).toBe("");
  expect(said).toBe("read\nfalse\n");
  // The laptop's next thread reads again and goes above the lapdog's.
  expect(await namesFrom(startOn(laptop, remote, ["Two"]))).toEqual(["APP-172"]);
}, 60_000);

// The daemon of the release that named threads by the machine's code can still be running as a
// newer sc opens the database. It reads the code each time it starts a thread, so the code stays.
test("a database from when threads were named by the machine's code keeps that code", () => {
  const { homes } = twoMachines();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
console.log(JSON.stringify(db.query("SELECT code FROM machine").all()));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: homes[0] },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([{ code: "lp" }]);
});

// Skelcrew asks a repository's forge once, as it refreshes its clone, and the forge can give
// another URL to clone from, such as https in place of ssh, as its login works there. A
// repository just added has no clone yet. One added before its forge's plugin was installed has
// a clone, but no forge yet. Either way the name is claimed at the forge's URL with its login,
// as a private repository lets nobody in without it.
test.each([
  ["just added", false],
  ["cloned before its forge was known", true],
])(
  "the first thread with no issue on a repository %s claims its name with its forge's URL and login",
  async (_, cloned) => {
    const { remote, homes } = twoMachines();
    const [laptop = ""] = homes;
    if (cloned) {
      const clone = join(laptop, ".local", "share", "skelcrew", "repos", "simon", "app");
      Bun.spawnSync(["git", "clone", "-q", remote, clone]);
    }
    // The remote is private: git refuses any command on it that doesn't carry the forge's login,
    // which git gets as a credential helper. A folder remote would need no login otherwise.
    const bin = join(laptop, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh
case "$*" in *${JSON.stringify(remote)}*)
  case "$*" in *"credential.helper=!"*) ;; *) echo "fatal: Authentication failed" >&2; exit 128 ;; esac ;;
esac
exec ${Bun.which("git") ?? "git"} "$@"
`,
      { mode: 0o755 },
    );
    const before = join(home, "unreachable.git");
    const forge = fakePlugin(laptop);
    const answer = {
      key: "simon/app",
      name: "app",
      link: "l",
      clone: remote,
      push: true,
      fork: false,
    };
    writeFileSync(join(forge, "claims.json"), JSON.stringify({ [before]: answer }));
    const run = startOn(laptop, before, ["One"], `db.run("UPDATE repositories SET claimed = 0");`);
    expect(await namesFrom(run)).toEqual(["APP-1"]);
    const claims = Bun.spawnSync(["git", "ls-remote", remote, "refs/skelcrew/names/*"]);
    expect(claims.stdout.toString()).toContain("refs/skelcrew/names/t1");
  },
  60_000,
);

// A start reads every line its builder and reviewer need before it claims a name, so one whose
// builder has no harness is refused at once, rather than once the task is recorded.
test("a thread whose builder has no harness is refused before it claims a name", async () => {
  const { homes } = twoMachines();
  const [laptop = ""] = homes;
  const remote = join(home, "roleless.git");
  const work = join(home, "roleless");
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  Bun.spawnSync(["git", "init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "skelcrew.yaml"), "setup: []\ntest: []\nlimits: { threads: 9 }\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "a");
  git(work, "push", "-q", remote, "main");
  const run = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
await startThread(db, { repo: "app", title: "One", body: "b" });`,
    ],
    { env: { ...process.env, HOME: laptop }, stdout: "pipe", stderr: "pipe" },
  );
  const err = await new Response(run.stderr).text();
  expect(await run.exited).toBe(1);
  expect(err).toContain(
    "simon/app's skelcrew.yaml names no harness for the builder. Add one under roles:",
  );
  const refs = Bun.spawnSync(["git", "-C", remote, "for-each-ref"], { stdout: "pipe" });
  expect(refs.stdout.toString()).not.toContain("refs/skelcrew/names");
}, 60_000);

// A repository with no commits yet, such as one just created, has no skelcrew.yaml, so a thread
// there is refused before it claims a name, and the remote stays empty.
test("a thread on an empty repository is refused, as it has no skelcrew.yaml, and claims no name", async () => {
  const { homes } = twoMachines();
  const [laptop = ""] = homes;
  const remote = join(home, "empty.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  const run = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
await startThread(db, { repo: "app", title: "One", body: "b" });`,
    ],
    { env: { ...process.env, HOME: laptop }, stdout: "pipe", stderr: "pipe" },
  );
  const err = await new Response(run.stderr).text();
  expect(await run.exited).toBe(1);
  expect(err).toContain(
    "simon/app has no skelcrew.yaml. Run sc init in a checkout of it to create one, then commit and push it.",
  );
  const refs = Bun.spawnSync(["git", "-C", remote, "for-each-ref"], { stdout: "pipe" });
  expect(refs.stdout.toString()).toBe("");
}, 60_000);

// No task is named after its issue, so an issue keeps its place in the copy whatever its ID,
// even one shaped like a task's own, such as t1. It is reached by its ID after a #.
// A tracker that doesn't say how it writes its IDs has them shown as they are.
test("an issue with any ID is kept in the copy, and never takes a task's name", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = ""] = homes;
  expect(await namesFrom(startOn(laptop, remote, ["One"]))).toEqual(["APP-1"]);
  const issue = (id: string) => ({
    kind: "task",
    id,
    title: `Issue ${id}`,
    body: "",
    state: "open",
    author: null,
    labels: [],
    link: `https://example.com/${id}`,
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    closes: "",
  });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { saveItems } from ${JSON.stringify(source("flow/copy.ts"))};
import { showTask } from ${JSON.stringify(source("flow/list.ts"))};
import { resolveTask } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
saveItems(db, "simon", "app", ${JSON.stringify([issue("t1"), issue("wr4"), issue("1")])}, ["task"]);
const show = async (typed) => {
  const { task, title, issue } = await showTask(db, { repo: "app", task: resolveTask(db, "app", typed).task });
  return { task, title, issue: issue?.id ?? null };
};
console.log(JSON.stringify({ ids: db.query("SELECT id FROM items ORDER BY id").all(),
  shown: await Promise.all(["1", "t1", "#t1", "#1"].map(show)) }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    ids: [{ id: "1" }, { id: "t1" }, { id: "wr4" }],
    shown: [
      { task: "APP-1", title: "One", issue: null },
      { task: "APP-1", title: "One", issue: null },
      { task: "APP#T1", title: "Issue t1", issue: "t1" },
      { task: "APP#1", title: "Issue 1", issue: "1" },
    ],
  });
}, 60_000);

// A task named before every task took a number, after its issue, such as app-2 for issue #2 or
// app-jott-12 for Linear's JOTT-12, or by a machine's code, such as app-wr4, gets a number
// claimed on the remote as the daemon next refreshes the repository, so it never clashes with
// another's. Another machine holding the same task gives it the same number. It keeps its folder
// and branch, and its old name still reaches it, but where a number and an old name are the
// same, the number wins, and the issue is reached by its ID after a #.
test("a task with an old name gets a number of its own, and its old name still reaches it", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const before = `db.run(\`INSERT INTO threads (owner, repo, task, folder, branch, status)
  VALUES ('simon', 'app', '2', 'app-2', 'skelcrew/2-old', 'working'),
    ('simon', 'app', 'wr4', 'app-wr4', 'skelcrew/wr4-older', 'done'),
    ('simon', 'app', 'jott-12', 'app-jott-12', 'skelcrew/jott-12-oldest', 'done'),
    ('simon', 'app', 'abc123', 'app-abc123', 'skelcrew/abc123-first', 'done')\`);
db.run(\`INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', '2', 'Old'),
  ('simon', 'app', 'wr4', 'Older'), ('simon', 'app', 'jott-12', 'Oldest'),
  ('simon', 'app', 'abc123', 'First')\`);
db.run(\`INSERT INTO asks (owner, repo, task, text, options, posted) VALUES
  ('simon', 'app', '2', 'Merge it?', '[]', 1), ('simon', 'app', '9', 'Start it?', '[]', 1)\`);`;
  const run = startOn(laptop, remote, ["New"], before);
  const out = await new Response(run.stdout).text();
  expect(await new Response(run.stderr).text()).toBe("");
  expect(out.trim().split("\n")).toEqual([
    "renamed APP-2 to APP-1, its number",
    "renamed APP-WR4 to APP-2, its number",
    "renamed APP-JOTT-12 to APP-3, its number",
    "renamed APP-ABC123 to APP-4, its number",
    '["APP-5"]',
  ]);
  // Another machine that holds the same task named after issue #2 gives it the same number.
  const same = `db.run(\`INSERT INTO threads (owner, repo, task, folder, branch, status)
  VALUES ('simon', 'app', '2', 'app-2', 'skelcrew/2-old', 'done')\`);
db.run("INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', '2', 'Old')");`;
  const other = startOn(lapdog, remote, ["Newer"], same);
  const otherOut = await new Response(other.stdout).text();
  expect(await new Response(other.stderr).text()).toBe("");
  expect(otherOut.trim().split("\n")).toEqual(["renamed APP-2 to APP-1, its number", '["APP-6"]']);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readThread, resolveTask, threadName } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
const named = (typed) => {
  const { folder, branch, issue, alias } = readThread(db, db.query("SELECT folder FROM task_threads WHERE task = ?").get(resolveTask(db, "app", typed).task).folder);
  return { typed, name: threadName(db, readThread(db, folder)), folder, branch, issue, alias };
};
const split = (repository, typed) => resolveTask(db, repository, typed);
console.log(JSON.stringify({ asks: db.query("SELECT task, text FROM asks ORDER BY task").all(),
  named: ["t1", "2", "#2", "wr4", "abc123", "5"].map(named),
  split: [split("APP-JOTT", "12"), split("app", "jott-12")] }));`;
  const shown = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(shown.stderr.toString()).toBe("");
  const old = { folder: "app-2", branch: "skelcrew/2-old", issue: "2", alias: "2" };
  const older = { folder: "app-wr4", branch: "skelcrew/wr4-older", issue: null, alias: "wr4" };
  expect(JSON.parse(shown.stdout.toString())).toEqual({
    // The lead's item about the task named after issue #2 follows it, and one about issue #9,
    // which no task has, is about #9.
    asks: [
      { task: "#9", text: "Start it?" },
      { task: "t1", text: "Merge it?" },
    ],
    named: [
      { typed: "t1", name: "APP-1", ...old },
      { typed: "2", name: "APP-2", ...older },
      { typed: "#2", name: "APP-1", ...old },
      { typed: "wr4", name: "APP-2", ...older },
      // An issue's ID of letters and digits, such as abc123, keeps its issue.
      {
        typed: "abc123",
        name: "APP-4",
        folder: "app-abc123",
        branch: "skelcrew/abc123-first",
        issue: "abc123",
        alias: "abc123",
      },
      {
        typed: "5",
        name: "APP-5",
        folder: "app-5",
        branch: "skelcrew/5-new",
        issue: null,
        alias: null,
      },
    ],
    // APP-JOTT-12 splits at its last dash, as every name does, and still reaches its task.
    split: [
      { repository: "APP", task: "t3" },
      { repository: "app", task: "t3" },
    ],
  });
  // Each number is claimed on the remote, so no other machine takes it.
  const claims = Bun.spawnSync(["git", "ls-remote", remote, "refs/skelcrew/names/*"]);
  expect(
    claims.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.split("/").at(-1))
      .sort(),
  ).toEqual(["last", "t1", "t2", "t3", "t4", "t5", "t6"]);
}, 60_000);

// A number from before Skelcrew claimed names, such as t1, lived on one machine only. Another
// machine may give that number to a task it renamed from an old name first. The task held under
// the number is then another task, so it is renumbered as well, and no two tasks share a name.
test("a task held under a number another machine gave a renamed task takes a number of its own", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const issueTask = `db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', '2', 'app-2', 'skelcrew/2-old', 'done')");
db.run("INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', '2', 'Old')");`;
  expect(await namesFrom(startOn(lapdog, remote, ["New"], issueTask))).toEqual(["APP-2"]);
  // This machine holds its own t1 from before, and the same task on issue #2, which the other
  // machine gave t1: its t1 moves out of the way first, and the task on issue #2 takes t1.
  const heldT1 = `db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', 't1', 'app-t1', 'skelcrew/t1-mine', 'done')");
db.run("INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', 't1', 'Mine')");
${issueTask}`;
  const run = startOn(laptop, remote, ["Newer"], heldT1);
  const out = await new Response(run.stdout).text();
  expect(await new Response(run.stderr).text()).toBe("");
  expect(out.trim().split("\n").slice(-3)).toEqual([
    "renamed APP-1 to APP-3, its number",
    "renamed APP-2 to APP-1, its number",
    '["APP-4"]',
  ]);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { resolveTask } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
console.log(JSON.stringify({ mine: db.query("SELECT task, alias, folder FROM task_threads WHERE title = 'Mine'").get(),
  byOldName: resolveTask(db, "app", "t1").task, byNumber: resolveTask(db, "app", "1").task }));`;
  const shown = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(shown.stderr.toString()).toBe("");
  expect(JSON.parse(shown.stdout.toString())).toEqual({
    mine: { task: "t3", alias: "t1", folder: "app-t1" },
    // APP-T1, the old name as it was spelled, is still the task that had it. APP-1 is the task
    // numbered 1 now, the one on issue #2.
    byOldName: "t3",
    byNumber: "t1",
  });
}, 60_000);

// A renumbering the remote refuses, such as while it can't be reached, is tried again at the next
// refresh, so a task never stays under a number another machine gave different work.
test("a task held under another task's number is renumbered at the next refresh when a try fails", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  const issueTask = `db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', '2', 'app-2', 'skelcrew/2-old', 'done')");
db.run("INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', '2', 'Old')");`;
  expect(await namesFrom(startOn(lapdog, remote, ["New"], issueTask))).toEqual(["APP-2"]);
  // The laptop's git refuses every push while the file is there.
  const failing = join(laptop, "fail-push");
  mkdirSync(join(laptop, "bin"));
  writeFileSync(
    join(laptop, "bin", "git"),
    `#!/bin/sh\ncase "$*" in *push*) [ -e ${JSON.stringify(failing)} ] && { echo refused >&2; exit 1; } ;; esac\nexec ${Bun.which("git") ?? "git"} "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(failing, "");
  const clone = join(laptop, ".local", "share", "skelcrew", "repos", "simon", "app");
  Bun.spawnSync(["git", "clone", "-q", remote, clone]);
  const code = `import { rmSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { refreshBacklog } from ${JSON.stringify(source("flow/backlog.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', 't1', 'app-t1', 'skelcrew/t1-mine', 'done')");
db.run("INSERT INTO tasks (owner, repo, task, title) VALUES ('simon', 'app', 't1', 'Mine')");
const [repository] = db.query("SELECT * FROM repositories").all();
await refreshBacklog(db, repository, ${JSON.stringify(clone)});
console.log(JSON.stringify(db.query("SELECT task FROM tasks").get()));
rmSync(${JSON.stringify(failing)});
await refreshBacklog(db, repository, ${JSON.stringify(clone)});
console.log(JSON.stringify(db.query("SELECT task, alias FROM tasks").get()));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop, PATH: `${join(laptop, "bin")}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const lines = run.stdout.toString().trim().split("\n");
  expect(lines.filter((line) => line.startsWith("{"))).toEqual([
    '{"task":"t1"}',
    '{"task":"t3","alias":"t1"}',
  ]);
  expect(lines).toContain("renamed APP-1 to APP-3, its number");
}, 60_000);

// An old name whose issue's ID held a dash, such as APP-JOTT-12, splits like any name, at its last
// dash, as task 12 of a repository named APP-JOTT. When Skelcrew has both app and app-jott, the
// name reaches the repository that has such a task, the one as typed first.
test("an old name with a dash reaches the repository that has its task", () => {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { resolveTask } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app'), ('app-jott', 'simon', 'app-jott')");
db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', 't3', 'app-jott-12', 'b', 'done')");
db.run("INSERT INTO tasks (owner, repo, task, alias) VALUES ('simon', 'app', 't3', 'jott-12')");
const before = resolveTask(db, "app-jott", "12");
db.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app-jott', 't12', 'app-jott-12-2', 'c', 'done')");
db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app-jott', 't12')");
console.log(JSON.stringify({ before, after: resolveTask(db, "app-jott", "12"), none: resolveTask(db, "app-jott", "13") }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    before: { repository: "app", task: "t3" },
    after: { repository: "app-jott", task: "t12" },
    none: { repository: "app-jott", task: "t13" },
  });
});

// A screen of the release before 2026-11-18 keeps running while a newer release opens its
// database, and it keeps the queries it prepared, with their column names. The database is one
// that release made, saved in test/databases, with a thread whose events seen and updates are
// JSON. Once the newer release opens it and its daemon upgrades it, the old screen's query must
// read every column as before, or it reads a host's name as the JSON of the events seen.
test("a screen of the release before 2026-11-18 reads every thread right once a newer release opens its database", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  copyFileSync(join(import.meta.dir, "databases", "before-nov-18.db"), join(data, "skelcrew.db"));
  const code = `import { Database } from "bun:sqlite";
import { finishUpgrade, moveToTasks, moveTurnEnded, openDb } from ${JSON.stringify(source("db.ts"))};
import { listRows } from ${JSON.stringify(source("list/rows.ts"))};
// The old screen's sidebar, with its query as that release wrote it, has drawn once.
const oldScreen = new Database(process.argv[1]);
const threads = oldScreen.query(\`SELECT * FROM task_threads
      WHERE status IN ('working', 'waiting', 'failed') AND owner = ? AND repo = ?
      ORDER BY rowid DESC\`);
const before = threads.all("simon", "app");
// The newer release's sc opens the database, and its daemon starts and upgrades it.
const db = openDb();
moveToTasks(db);
moveTurnEnded(db);
finishUpgrade(db);
const after = threads.all("simon", "app");
// The newer release's own list, which its sidebar is, draws from it too.
const rows = listRows(db, { owner: "simon", repo: "app" }, 0);
console.log(JSON.stringify({ before, after, rows: rows.map((row) => row.name) }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code, join(data, "skelcrew.db")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const { before, after, rows } = JSON.parse(run.stdout.toString());
  expect(before[0]).toMatchObject({ folder: "app-12", seen: '["review-1"]', pr: 7 });
  expect(after).toEqual(before);
  expect(rows).toEqual(["lead", "APP-12"]);
});

// The daemon fills in each older task's issue link from Skelcrew's copy of the tracker as it
// starts. An item there it can't read must leave the link empty, not stop the daemon, and is
// logged though no list reads it.
test("an item Skelcrew can't read leaves its task's link empty as the daemon upgrades", () => {
  const code = `import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishUpgrade, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 12)");
db.run("INSERT INTO items (owner, repo, kind, id, state, created, item) VALUES ('simon', 'app', 'task', '12', 'open', '2026-11-18T00:00:00Z', 'not json')");
db.run("INSERT INTO upgrades (step) VALUES ('fill tasks')");
finishUpgrade(db);
const log = readFileSync(join(process.env.HOME, ".local/share/skelcrew/db.log"), "utf8");
console.log(JSON.stringify({ ...db.query("SELECT issue_link, closes FROM tasks").get(), log }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const { log, ...task } = JSON.parse(run.stdout.toString());
  expect(task).toEqual({ issue_link: null, closes: null });
  expect(log.replace(/^\S+ /, "")).toBe(
    'items.item holds "not json", which Skelcrew can\'t read, so it reads as empty.\n',
  );
});

// A merge armed before Skelcrew kept which waits the lead heard in a round kept only the round,
// and went on saving new waits after its note. The thread's log says which wait the note was
// about, so the upgrade counts only that one as heard: the lead isn't told it twice, and still
// hears of a wait that came after.
test("an armed merge noted before the upgrade counts only the wait its log shows the lead heard", () => {
  const data = join(home, ".local", "share", "skelcrew");
  const threads = join(data, "threads");
  mkdirSync(threads, { recursive: true });
  const conflict = "its conflict with main to be fixed";
  // Each line of a thread's log is the thread as it was then.
  const logged = (folder: string, states: [number | null, string | null][]) =>
    writeFileSync(
      join(threads, `${folder}.log`),
      `${states.map(([noted, waits]) => JSON.stringify({ merge_noted: noted, merge_waits: waits })).join("\n")}\n{"cut short`,
    );
  // app-12's lead heard of the conflict in round 2.
  logged("app-12", [
    [null, null],
    [null, conflict],
    [2, conflict],
  ]);
  // app-13's lead heard it waited on an approval, and the conflict came later in the round.
  logged("app-13", [
    [null, "an approval"],
    [2, "an approval"],
    [2, conflict],
  ]);
  // app-14's conflict was heard in round 1, then cleared by a plan armed again, and its new
  // plan's note in round 2 was about failing checks.
  logged("app-14", [
    [1, conflict],
    [null, null],
    [2, "its failing checks to be fixed"],
    [2, conflict],
  ]);
  // app-15 has no log.
  const armed = (task: string) =>
    threadSql({
      task,
      status: "waiting",
      review_round: 2,
      merge_plan: "armed",
      merge_noted: 2,
      merge_waits: conflict,
    });
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
import { mergeNoteFor } from ${JSON.stringify(source("flow/decide.ts"))};
// The earlier release's database: the same, without the new column.
const old = openDb();
old.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${["12", "13", "14", "15"].map(armed).join("\n")}\`);
old.run("DROP VIEW task_threads");
old.run("ALTER TABLE threads DROP COLUMN merge_noted_for");
old.close();
const db = openDb();
const said = Object.fromEntries(["app-12", "app-13", "app-14", "app-15"].map((folder) => {
  const thread = readThread(db, folder);
  return [folder, mergeNoteFor(thread, thread.merge_waits)];
}));
console.log(JSON.stringify(said));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    "app-12": null,
    "app-13": "its conflict with",
    "app-14": "its conflict with",
    "app-15": "its conflict with",
  });
});

// An earlier release counted a review's round from the rounds of changes, which sc start past the
// round limit set back, so a thread can hold a lower round than one it posted. The daemon's
// upgrade reads the highest round from the thread's log, since the thread last started, so its
// next round goes on above every one it posted.
test("a thread whose round went back before the upgrade goes on above the highest it posted", () => {
  const threads = join(home, ".local", "share", "skelcrew", "threads");
  mkdirSync(threads, { recursive: true });
  // Each line of a thread's log is the thread as it was then.
  const logged = (folder: string, lines: [number, number, string][]) =>
    writeFileSync(
      join(threads, `${folder}.log`),
      `${lines
        .map(([started, round, verdict]) =>
          JSON.stringify({ started, review_round: round, verdict }),
        )
        .join("\n")}\n{"cut short`,
    );
  // app-12 posted round 5, then sc start set its count back and its next review said round 2.
  logged("app-12", [
    [1, 4, "changes"],
    [1, 5, "changes"],
    [1, 2, "changes"],
  ]);
  // app-13 started over after a thread that reached round 7, and is at round 1 since.
  logged("app-13", [
    [1, 7, "changes"],
    [2, 1, "approve"],
  ]);
  // app-14's round 3 review failed, so it counted no round: it runs again as round 3.
  logged("app-14", [
    [1, 2, "changes"],
    [1, 3, "failed"],
  ]);
  // app-15 has no log, and app-16 was never reviewed.
  const rows = [
    { task: "12", started: 1, review_round: 2, verdict: "changes" },
    { task: "13", started: 2, review_round: 1, verdict: "approve" },
    { task: "14", started: 1, review_round: 3, verdict: "failed" },
    { task: "15", started: 1, review_round: 4, verdict: "approve" },
    { task: "16", started: 1, review_round: null, verdict: null },
  ];
  const folders = rows.map((row) => `app-${row.task}`);
  const code = `import { finishUpgrade, openDb } from ${JSON.stringify(source("db.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
import { nextRound } from ${JSON.stringify(source("flow/ledger.ts"))};
// The earlier release's database: the same, without the new column.
const old = openDb();
old.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${rows.map((row) => threadSql({ status: "waiting", ...row })).join("\n")}\`);
old.run("DROP VIEW task_threads");
old.run("ALTER TABLE tasks DROP COLUMN top_round");
old.run("ALTER TABLE threads DROP COLUMN top_round");
old.close();
const db = openDb();
finishUpgrade(db);
const next = Object.fromEntries(${JSON.stringify(folders)}.map((folder) => [folder, nextRound(readThread(db, folder))]));
console.log(JSON.stringify(next));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    "app-12": 6,
    "app-13": 2,
    "app-14": 3,
    "app-15": 5,
    "app-16": 1,
  });
});
