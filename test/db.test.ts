// Skelcrew's database, opened over one that lacks the newer columns.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";

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
    env: { ...process.env, HOME: machine },
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

// A claimed name stays claimed after its branch goes, such as once its PR merged, and an issue
// in Skelcrew's copy of the tracker holds its ID too.
test("a name stays taken once claimed, and an issue's ID is never given to a thread", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = "", lapdog = ""] = homes;
  expect(await namesFrom(startOn(laptop, remote, ["One"]))).toEqual(["app-lp1"]);
  const issue = `db.run("INSERT INTO items (owner, repo, kind, id, state, created, item) VALUES ('simon', 'app', 'task', 'lp2', 'open', 'x', '{}')");`;
  expect(await namesFrom(startOn(lapdog, remote, ["Two"], issue))).toEqual(["app-lp3"]);
}, 60_000);

test("a database keeps its code, threads with no issue are its own, and t names keep working", async () => {
  const { remote, homes } = twoMachines();
  const [laptop = ""] = homes;
  const old = threadSql({ task: "t4", status: "done", title: "Old", own: 1 });
  const before = `db.run(${JSON.stringify(old)});`;
  expect(await namesFrom(startOn(laptop, remote, ["One"], before))).toEqual(["app-lp1"]);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { findThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
const one = findThread(db, "app", "lp1");
console.log(JSON.stringify({ old: findThread(db, "app", "t4").folder, branch: one.branch, own: one.own }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: laptop },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({
    old: "app-t4",
    branch: "skelcrew/lp1-one",
    own: true,
  });
}, 60_000);

// A database from before Skelcrew kept which tasks are its own read a t and a number as one.
test("a database from before marks its t tasks as Skelcrew's own, and its issues as the tracker's", () => {
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const old = new Database(join(data, "skelcrew.db"));
  old.run(`CREATE TABLE threads (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    folder TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT, status TEXT NOT NULL,
    session TEXT, PRIMARY KEY (owner, repo, task))`);
  old.run(`CREATE TABLE tasks (owner TEXT NOT NULL, repo TEXT NOT NULL, task INTEGER NOT NULL,
    title TEXT, PRIMARY KEY (owner, repo, task))`);
  for (const task of ["t4", "12", "ab12"]) {
    old.run("INSERT INTO threads VALUES ('simon', 'app', ?, ?, 'b', NULL, 'working', NULL)", [
      task,
      `app-${task}`,
    ]);
    old.run("INSERT INTO tasks VALUES ('simon', 'app', ?, NULL)", [task]);
  }
  old.close();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
console.log(JSON.stringify(db.query("SELECT task, own FROM tasks ORDER BY task").all()));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([
    { task: 12, own: 0 },
    { task: "ab12", own: 0 },
    { task: "t4", own: 1 },
  ]);
});
