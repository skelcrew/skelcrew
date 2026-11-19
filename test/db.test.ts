// Skelcrew's database, opened over one that lacks the newer columns.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
// last message. After the upgrade it waits on the lead, so the lead must hear of it once. A new
// screen opens the database first, while the earlier release's daemon still runs and changes its
// threads, so only the new daemon, once it holds its lock, moves them.
test("a thread whose turn ended before the upgrade has its lead told once, and no longer needs you", () => {
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
    { folder: "app-12", turn_ended: true, noting: null, needsYou: false },
    { folder: "app-13", turn_ended: true, noting: null, needsYou: false },
    { folder: "app-15", turn_ended: true, noting: null, needsYou: false },
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

// Threads with no issue are named by a code of the machine's, so two machines working on one
// repository never both have an app-t4 meaning different work.
test("a machine's code is two letters from its name, so names from two machines differ", async () => {
  const { codeOf } = await import("../src/db.ts");
  expect(codeOf("workbox")).toBe("wr");
  expect(codeOf("laptop")).toBe("lp");
  expect(codeOf("simon-laptop")).toBe("sl");
  expect(codeOf("Simons-MacBook-Pro.local")).toBe("sm");
  expect(codeOf("aeo")).toBe("ae");
  expect(codeOf("x")).toBe("xx");
  expect(codeOf("1234")).toBe("xx");
});

// A remote two machines share, with a first commit on main, and two machines with the same code,
// lp, such as laptop and lapdog. Returns the remote and each machine's home.
function twoMachines(): { remote: string; homes: string[] } {
  const remote = join(home, "app.git");
  const work = join(home, "work");
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  mkdirSync(work);
  git(home, "init", "-q", "--bare", "-b", "main", remote);
  git(work, "init", "-q", "-b", "main");
  git(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "a",
  );
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

// Waits for a process from startOn and returns the names it printed.
async function namesFrom(run: ReturnType<typeof startOn>): Promise<string[]> {
  const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  expect(err).toBe("");
  return JSON.parse(out);
}

// Two machines with the same code take names from the remote they share, at the same moment.
test("two machines with the same code starting threads at once never take one name", async () => {
  const { remote, homes } = twoMachines();
  const titles = ["One", "Two", "Three"];
  const runs = homes.map((machine) => startOn(machine, remote, titles));
  const names = (await Promise.all(runs.map(namesFrom))).flat();
  expect(names).toHaveLength(6);
  expect(new Set(names).size).toBe(6);
  expect(names.every((name) => /^app-lp[1-6]$/.test(name))).toBe(true);
}, 60_000);

// A claimed name stays claimed once its branch is gone, such as once its PR merged.
test("a name stays taken on another machine once claimed", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  expect(await namesFrom(startOn(laptop, remote, ["One"]))).toEqual(["app-lp1"]);
  expect(await namesFrom(startOn(lapdog, remote, ["Two"]))).toEqual(["app-lp2"]);
}, 60_000);

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
    expect(await namesFrom(run)).toEqual(["app-lp1"]);
    const claims = Bun.spawnSync(["git", "ls-remote", remote, "refs/skelcrew/names/*"]);
    expect(claims.stdout.toString()).toContain("refs/skelcrew/names/lp1");
  },
  60_000,
);

// A name claimed on a repository with no commits yet, such as one just created, is a ref of the
// remote all the same. The repository must still count as empty, so starting a thread there
// says it has no commits, rather than failing in git's words.
test("a name claimed on an empty repository leaves it empty", async () => {
  const { homes } = twoMachines();
  const [laptop = ""] = homes;
  const remote = join(home, "empty.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  const check = `import { hasNoCommits } from ${JSON.stringify(source("flow/repo.ts"))};
import { fetchBranch } from ${JSON.stringify(source("flow/git.ts"))};
import { cloneDir } from ${JSON.stringify(source("paths.ts"))};
const [repository] = db.query("SELECT * FROM repositories").all();
const fetched = await fetchBranch(db, repository, cloneDir("simon", "app"), null).then(() => "fetched", (error) => error.message);
console.log(JSON.stringify([await hasNoCommits(db, repository), fetched]));`;
  const run = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { threadName } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', ?)", [${JSON.stringify(remote)}]);
console.log(threadName(db, await startThread(db, { repo: "app", title: "One", body: "b" })));
${check}`,
    ],
    { env: { ...process.env, HOME: laptop }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  expect(err).toBe("");
  // Making the clone logs that the repository is empty first.
  const [name = "", result = ""] = out.trim().split("\n").slice(-2);
  expect(name).toBe("app-lp1");
  expect(JSON.parse(result)).toEqual([
    true,
    "simon/app has no commits yet, so a thread has nothing to start from. Push a first commit, then start it again.",
  ]);
}, 60_000);

// An issue created after a thread with no issue, with the thread's ID, such as lp1, would share
// its name. The copy of the tracker leaves it out, so app-lp1 stays the thread's alone.
test("an issue whose ID has the shape of Skelcrew's own is left out of the copy", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = ""] = homes;
  expect(await namesFrom(startOn(laptop, remote, ["One"]))).toEqual(["app-lp1"]);
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
const db = openDb();
saveItems(db, "simon", "app", ${JSON.stringify([issue("lp1"), issue("t4"), issue("t4abc"), issue("12")])}, ["task"]);
const shown = await showTask(db, { repo: "app", task: "lp1" });
console.log(JSON.stringify({ ids: db.query("SELECT id FROM items ORDER BY id").all(),
  title: shown.title, issue: shown.issue }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  const lines = run.stdout.toString().trim().split("\n");
  expect(lines.slice(0, -1)).toEqual([
    "left out issue lp1 of simon/app: Skelcrew names its own tasks like that",
    "left out issue t4 of simon/app: Skelcrew names its own tasks like that",
  ]);
  expect(JSON.parse(lines.at(-1) ?? "")).toEqual({
    ids: [{ id: "12" }, { id: "t4abc" }],
    title: "One",
    issue: null,
  });
}, 60_000);

test("a database keeps its code, and t names keep working", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = ""] = homes;
  const old = threadSql({ task: "t4", status: "done", title: "Old" });
  const before = `db.run(${JSON.stringify(old)});`;
  expect(await namesFrom(startOn(laptop, remote, ["One"], before))).toEqual(["app-lp1"]);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { findThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
const one = findThread(db, "app", "lp1");
console.log(JSON.stringify({ old: findThread(db, "app", "t4").folder, branch: one.branch }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    old: "app-t4",
    branch: "skelcrew/lp1-one",
  });
}, 60_000);

// A screen of the earlier release keeps running while a newer one opens the database, and it
// keeps the queries it prepared, with their column names. The newer release's view must add its
// columns where that screen's names still find the values they name, or it reads one column's
// value as another's, such as a host's name as the JSON of the events seen.
test("a screen of the earlier release reads every thread right once a newer release adds columns", () => {
  const code = `import { Database } from "bun:sqlite";
import { openDb } from ${JSON.stringify(source("db.ts"))};
// The earlier release's database: this one's view without the columns it lacked, which sit
// among the thread's and the task's columns.
const made = openDb();
made.run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working')");
made.run("INSERT INTO tasks (owner, repo, task, seen, updates) VALUES ('simon', 'app', 12, '[\\"r1\\"]', '[]')");
const view = made.query("SELECT sql FROM sqlite_master WHERE name = 'task_threads'").get().sql;
made.run("DROP VIEW task_threads");
made.run(view.replace(", th.host, th.host_id", "").replace(", k.review_post", ""));
made.close();
// The earlier release's screen has read its threads once.
const oldScreen = new Database(process.argv[1]);
const read = "SELECT * FROM task_threads";
oldScreen.query(read).all();
// The newer release opens the database, then the screen looks again.
openDb().close();
const { folder, seen, updates } = oldScreen.query(read).get();
console.log(JSON.stringify({ folder, seen, updates }));`;
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const run = Bun.spawnSync([process.execPath, "-e", code, join(data, "skelcrew.db")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    folder: "app-12",
    seen: '["r1"]',
    updates: "[]",
  });
});

// The daemon fills in each older task's issue link from Skelcrew's copy of the tracker as it
// starts. An item there it can't read must leave the link empty, not stop the daemon.
test("an item Skelcrew can't read leaves its task's link empty as the daemon upgrades", () => {
  const code = `import { finishUpgrade, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
db.run("INSERT INTO tasks (owner, repo, task) VALUES ('simon', 'app', 12)");
db.run("INSERT INTO items (owner, repo, kind, id, state, created, item) VALUES ('simon', 'app', 'task', '12', 'open', '2026-11-18T00:00:00Z', 'not json')");
db.run("INSERT INTO upgrades (step) VALUES ('fill tasks')");
finishUpgrade(db);
console.log(JSON.stringify(db.query("SELECT issue_link, closes FROM tasks").get()));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({ issue_link: null, closes: null });
});
