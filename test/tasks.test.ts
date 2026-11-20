// Moving a database from before tasks onto them: every thread becomes a task with one builder
// thread, and everything sc shows stays the same. The database file in test/databases was saved
// by the release before tasks, with threads in every status, and the JSON beside it is what that
// release's commands and screen showed of it.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { fakePlugin, git, homeEnv, runSkel, source, until } from "./harness.ts";

const saved = join(import.meta.dir, "databases");
let home = "";
const running: Subprocess[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-tasks-test-")));
  mkdirSync(join(home, "run"), { mode: 0o700 });
});
afterEach(async () => {
  for (const run of running.splice(0)) {
    run.kill();
    await run.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

const data = () => join(home, ".local", "share", "skelcrew");
const dbFile = () => join(data(), "skelcrew.db");
const env = () => homeEnv(home);

// Puts the saved database in the test's home, as the release before tasks left it.
function oldDatabase(): void {
  mkdirSync(data(), { recursive: true });
  copyFileSync(join(saved, "before-tasks.db"), dbFile());
}

// Runs code in a process of its own with the test's home, as homedir() keeps the HOME this
// process started with, and returns what it printed.
function run(code: string, ...args: string[]): string {
  const done = Bun.spawnSync([process.execPath, "-e", code, ...args], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return done.stdout.toString();
}

// Code that prints what each command and the screen show of the saved database's threads: sc
// repo ls, sc ps, sc ls and sc show, the sidebar, the lists and the tabs.
const showAll = `import { openDb, moveToTasks } from ${JSON.stringify(source("db.ts"))};
const list = await import(${JSON.stringify(source("flow/list.ts"))});
const { listGroups, entryCounts } = await import(${JSON.stringify(source("screen/lists.ts"))});
const { sidebarRows, repositoryTabs } = await import(${JSON.stringify(source("screen/rows.ts"))});
const db = openDb();
if (process.argv.includes("move")) moveToTasks(db);
const now = Date.UTC(2026, 10, 10, 12, 0, 0);
const tasks = ["app-12", "app-13", "app-14", "app-15", "app-16", "app-17", "app-t1", "notes-t1", "notes-t2"];
const shown = {
  repositories: list.listRepositories(db),
  ps: list.listThreads(db),
  psNotes: list.listThreads(db, "notes"),
  ls: list.listTasks(db),
  show: await Promise.all(
    tasks.map((name) => {
      const [repo, task] = name.split("-");
      return list.showTask(db, { repo, task }).catch(String);
    }),
  ),
  screen: ["app", "notes"].map((repo) => {
    const open = { owner: "simon", repo, lead: "lead-" + repo };
    return {
      sidebar: sidebarRows(db, [], () => 5, now, open),
      lists: ["issues", "threads", "prs"].map((e) => listGroups(db, open, e, now)),
      entries: entryCounts(db, open),
    };
  }),
  tabs: repositoryTabs(db, () => 5),
};
console.log(JSON.stringify(shown));`;

// What the release before tasks showed, with this test's home in its paths. Its issues, show
// and prs are what sc issue ls, sc issue show and sc pr show showed then, which sc ls and sc
// show now show.
const shownBefore = () =>
  JSON.parse(readFileSync(join(saved, "before-tasks.json"), "utf8").replaceAll("$HOME", home));

// Changes what the release before tasks showed of notes-t1, whose builder had ended its turn
// without a submit, to what Skelcrew shows of such a turn now. It then needed you, in yellow. It
// now waits on the lead, which got the builder's last message: dim, among the working threads,
// and counted nowhere.
function turnEndedWaits(saved: ReturnType<typeof shownBefore>): void {
  for (const row of [...saved.ps, ...saved.psNotes])
    if (row.thread === "notes-t1") row.needsYou = false;
  for (const task of saved.show) if (task.issue === "notes-t1") task.thread.needsYou = false;
  const notes = saved.screen[1];
  notes.entries[0].notes = [];
  const [needing, working] = notes.lists[1];
  const row = needing.rows[0];
  row.mark = ["○", "90"];
  row.ends[0] = ["turn ended", "90"];
  notes.lists[1] = [{ heading: "Working", rows: [...working.rows, row] }];
  for (const screen of saved.screen)
    for (const entry of screen.sidebar) if (entry.name === "notes-t1") entry.state = "idle";
  saved.tabs[1].needYou = 0;
}

// Returns the names of the database's tables.
function tables(file: string): string[] {
  const db = new Database(file, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  db.close();
  return rows.map((row) => String(Object.values(row ?? {})[0]));
}

test("after the move, every command and the screen show the same threads under the same names", () => {
  oldDatabase();
  // The saved database's app has GitHub as its forge, which shows its PRs.
  fakePlugin(home);
  // The first poll after the upgrade finds every check on app-13's approved PR green, as the
  // earlier release took them to be, and that its PR leaves .agents/ alone, which that release
  // never asked. Until a poll says so, it waits, as tested below.
  run(`import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run("UPDATE threads SET ci_passed = 1 WHERE folder = 'app-13'");
openDb().run("INSERT INTO pr_agents (owner, repo, pr, head, base, changed) VALUES ('simon', 'app', '41', 'abc123', 'main', 0)");`);
  // Before the new daemon moves it, sc shows the threads as they are.
  const shownThen = shownBefore();
  turnEndedWaits(shownThen);
  // That release didn't read .agents/ or plugins:, and neither repository has either, so none
  // waits for you.
  for (const row of shownThen.repositories) {
    row.agentsWaiting = false;
    row.installWaiting = false;
  }
  const { issues, show, prs, ...saved } = shownThen;
  const before = JSON.parse(run(showAll));
  const { ls, show: shown, ...same } = before;
  expect(same).toEqual(saved);
  expect(tables(dbFile())).not.toContain("tasks");
  // After the move, it shows them just the same.
  expect(JSON.parse(run(showAll, "move"))).toEqual(before);
  // sc ls lists each open issue sc issue ls listed, with its title and its thread's status.
  type Task = { task: string };
  for (const row of issues)
    expect(ls.find((task: Task) => task.task === row.issue)).toMatchObject({
      title: row.title,
      thread: row.thread,
    });
  // sc show shows each task sc issue show showed, with its title, its body as its reviewer
  // gets it, and its thread.
  const named = (name: string) =>
    shown.find((task: Task | string) => typeof task !== "string" && task.task === name);
  for (const task of show.filter((task: unknown) => typeof task !== "string"))
    expect(named(task.issue)).toMatchObject({
      title: task.title,
      body: task.body,
      threads: task.thread ? [task.thread] : [],
    });
  // And each PR sc pr show showed, on its task, as its page showed it.
  for (const { pr, thread, ...page } of prs.filter((pr: unknown) => typeof pr !== "string"))
    expect(named(thread)).toMatchObject({ pr, prPage: page });
  // Each task has its stage. app-13 is approved with its checks green, the stopped and failed
  // threads keep their tasks working, and app-16's issue closed with no merge Skelcrew saw.
  const stages = {
    "app-12": "working",
    "app-13": "ready for review",
    "app-14": "working",
    "app-15": "working",
    "app-16": "closed",
    "app-17": "issue",
    "app-t1": "working",
    "notes-t1": "working",
    "notes-t2": "working",
  };
  expect(
    Object.fromEntries(ls.map((row: Task & { stage: string }) => [row.task, row.stage])),
  ).toEqual(stages);
  for (const [name, stage] of Object.entries(stages)) expect(named(name)).toMatchObject({ stage });
  // A task whose issue closed and whose PR left the copy still shows, from what it saved.
  expect(named("app-16")).toMatchObject({ pr: 42, prPage: null });
  // Each thread has its task, and a copy of the database from before waits beside it.
  const db = new Database(dbFile(), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  expect(db.query("SELECT owner, repo, task FROM tasks ORDER BY rowid").all()).toEqual(
    db.query("SELECT owner, repo, task FROM threads ORDER BY rowid").all(),
  );
  expect(db.query("SELECT DISTINCT role FROM threads").all()).toEqual([{ role: "builder" }]);
  // Each task from an issue still in the copy keeps the link to it, and the line that closes it.
  expect(
    db.query("SELECT task, issue_link, closes FROM tasks WHERE task = 13 OR task = 't1'").all(),
  ).toEqual([
    { task: 13, issue_link: "https://github.com/simon/app/issues/13", closes: "Closes #13" },
    { task: "t1", issue_link: null, closes: null },
    { task: "t1", issue_link: null, closes: null },
  ]);
  db.close();
  const copy = join(data(), "skelcrew-before-tasks.db");
  expect(tables(copy)).not.toContain("tasks");
  expect(tables(copy)).toContain("threads");
});

test("the move runs once, and a thread started after it shows from its task", () => {
  oldDatabase();
  const code = `import { openDb, moveToTasks } from ${JSON.stringify(source("db.ts"))};
import { record, readThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
moveToTasks(db);
record(db, "app-15", { rounds: 4, short: "Darker" });
moveToTasks(db);
const { rounds, short, status } = readThread(db, "app-15");
console.log(JSON.stringify({ rounds, short, status }));`;
  expect(JSON.parse(run(code))).toEqual({ rounds: 4, short: "Darker", status: "stopped" });
  // The thread's old columns are left as they were, unread.
  const db = new Database(dbFile(), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  expect(db.query("SELECT rounds, short FROM threads WHERE folder = 'app-15'").get()).toEqual({
    rounds: 3,
    short: "Dark mode",
  });
  db.close();
});

// Leaves the database as the first release with tasks did: moved, with a tasks table without
// the columns added since: whether the work merged, the link to its issue, the line that
// closes it, whether CI passed after the approval and the commit the latest review was about.
function earlierTasks(): void {
  oldDatabase();
  run(`import { openDb, moveToTasks } from ${JSON.stringify(source("db.ts"))};
moveToTasks(openDb());`);
  const earlier = new Database(dbFile());
  earlier.run("DROP VIEW task_threads");
  earlier.run("ALTER TABLE tasks DROP COLUMN merged");
  earlier.run("ALTER TABLE tasks DROP COLUMN issue_link");
  earlier.run("ALTER TABLE tasks DROP COLUMN closes");
  earlier.run("ALTER TABLE tasks DROP COLUMN ci_passed");
  earlier.run("ALTER TABLE tasks DROP COLUMN reviewed_commit");
  earlier.close();
}

// Any sc run adds the columns, but the earlier release's daemon may still be running, so
// filling them waits for the new one.
test("a tasks table from an earlier release gains the task's newer columns, unfilled", () => {
  earlierTasks();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
const { rounds, merged, issue_link, closes } = readThread(openDb(), "app-15");
console.log(JSON.stringify({ rounds, merged, issue_link, closes }));`;
  expect(JSON.parse(run(code))).toEqual({
    rounds: 3,
    merged: false,
    issue_link: null,
    closes: null,
  });
});

// The earlier release showed an approval that needs you as ready to merge, without a poll
// saying every check passed. It waits for a poll to say so, as its saved checks can be stale.
test("an approval an earlier release showed as ready to merge waits for a poll", () => {
  earlierTasks();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
import { taskStage } from ${JSON.stringify(source("flow/stage.ts"))};
const db = openDb();
const stage = (folder) => [readThread(db, folder).ci_passed, taskStage(readThread(db, folder), true)];
console.log(JSON.stringify({ approved: stage("app-13"), working: stage("app-15") }));`;
  expect(JSON.parse(run(code))).toEqual({
    approved: [false, "working"],
    working: [false, "working"],
  });
});

// A check seen before Skelcrew kept the commit it showed on may vanish by the first poll after
// the upgrade. The daemon's upgrade saves the PR's head as one CI showed on, so the wait for CI's
// first check never ends with none there and lets a merge go ahead.
test("an upgrade saves the head of each PR that showed CI as one CI showed on", () => {
  const shown = `import { finishUpgrade, moveToTasks, openDb } from ${JSON.stringify(source("db.ts"))};
const db = openDb();
moveToTasks(db);
finishUpgrade(db);
console.log(JSON.stringify(db.query("SELECT task, ci_shown FROM tasks WHERE repo = 'app' AND task IN (12, 13, 14) ORDER BY task").all()));`;
  // From before tasks: PRs 40 and 41 had checks saved, at abc123 in Skelcrew's copy.
  oldDatabase();
  expect(JSON.parse(run(shown))).toEqual([
    { task: 12, ci_shown: "abc123" },
    { task: 13, ci_shown: "abc123" },
    { task: 14, ci_shown: null },
  ]);
  // From a release with tasks, which kept whether a PR ever showed CI. app-12's saved checks are
  // gone, yet its PR in the copy shows CI. app-13's PR left the copy, but the release kept that
  // it showed CI, at the commit its reviewer approved. app-14 has no PR.
  earlierTasks();
  const earlier = new Database(dbFile());
  earlier.run("ALTER TABLE tasks DROP COLUMN ci_shown");
  earlier.run("ALTER TABLE tasks ADD COLUMN ci_seen INTEGER NOT NULL DEFAULT 0");
  earlier.run("ALTER TABLE tasks ADD COLUMN reviewed_commit TEXT");
  earlier.run("UPDATE tasks SET checks = NULL WHERE repo = 'app'");
  earlier.run("UPDATE tasks SET ci_seen = 1, reviewed_commit = 'def456' WHERE task = 13");
  earlier.run("DELETE FROM items WHERE kind = 'pr' AND id = '41'");
  earlier.close();
  expect(JSON.parse(run(shown))).toEqual([
    { task: 12, ci_shown: "abc123" },
    { task: 13, ci_shown: "def456" },
    { task: 14, ci_shown: null },
  ]);
});

// An approval from before reviews saved their commit keeps standing: the daemon saves on the
// task the commit Skelcrew's clone keeps as the approval's ref, so the list, which reads only
// the database, can still merge it. An approval whose ref is gone gets none.
test("an approval from before the upgrade keeps its commit, from the clone's ref", () => {
  earlierTasks();
  const clone = join(data(), "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q");
  git(clone, "commit", "-q", "--allow-empty", "-m", "approved");
  const approved = git(clone, "rev-parse", "HEAD");
  git(clone, "update-ref", "refs/skelcrew/approved/app-13", approved);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { saveApprovedCommits } from ${JSON.stringify(source("flow/round.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
const before = readThread(db, "app-13").reviewed_commit;
saveApprovedCommits(db);
console.log(JSON.stringify({ before, after: readThread(db, "app-13").reviewed_commit, other: readThread(db, "app-12").reviewed_commit }));`;
  expect(JSON.parse(run(code))).toEqual({ before: null, after: approved, other: null });
});

// Writes the logs of three threads whose work ended before Skelcrew kept whether it merged:
// app-16's PR merged, app-12's merged as a merge when ready, and app-14 was removed after an
// earlier start of it had merged nothing. Marks app-12 and app-14 done, as they were left.
function endedBeforeMerges(): void {
  const logs = join(data(), "threads");
  mkdirSync(logs, { recursive: true });
  const line = (why: string) => `${JSON.stringify({ at: "2026-11-10T09:00:00Z", why })}\n`;
  writeFileSync(
    join(logs, "app-16.log"),
    `${line("started")}${line("PR #42 was merged: ended the thread")}`,
  );
  writeFileSync(
    join(logs, "app-12.log"),
    `${line("started")}${line("PR #7 was merged when ready: ended the thread")}`,
  );
  writeFileSync(
    join(logs, "app-14.log"),
    `${line("PR #30 was merged: ended the thread")}${line("started")}{"cut sh\n${line("removed: started over: ended the thread")}`,
  );
  const db = new Database(dbFile());
  db.run("UPDATE threads SET status = 'done' WHERE folder IN ('app-12', 'app-14')");
  db.close();
}

// Returns which of the tasks app-12, app-14 and app-16 are marked merged. The daemon may be
// writing as it starts, so the read waits for it rather than failing as locked.
function mergedTasks(): unknown {
  const db = new Database(dbFile(), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  const rows = db
    .query("SELECT task, merged FROM tasks WHERE task IN (12, 14, 16) ORDER BY task")
    .all();
  db.close();
  return rows;
}

test("the move marks tasks merged whose thread's log says their PR merged", () => {
  oldDatabase();
  endedBeforeMerges();
  run(`import { openDb, moveToTasks } from ${JSON.stringify(source("db.ts"))};
moveToTasks(openDb());`);
  expect(mergedTasks()).toEqual([
    { task: 12, merged: 1 },
    { task: 14, merged: 0 },
    { task: 16, merged: 1 },
  ]);
});

// sc run while the earlier release's daemon still runs adds the columns. That daemon then
// merges app-16 and removes app-14, and the new daemon, once it starts, fills them in.
test("the new daemon fills a tasks table from an earlier release, after the old daemon's last merge", async () => {
  earlierTasks();
  run(`import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb();`);
  endedBeforeMerges();
  machineSetUp();
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")), { timeout: 30_000 });
  expect(mergedTasks()).toEqual([
    { task: 12, merged: 1 },
    { task: 14, merged: 0 },
    { task: 16, merged: 1 },
  ]);
  const db = new Database(dbFile(), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  expect(db.query("SELECT issue_link, closes FROM tasks WHERE task = 15").get()).toEqual({
    issue_link: "https://github.com/simon/app/issues/15",
    closes: "Closes #15",
  });
  expect(db.query("SELECT * FROM upgrades").all()).toEqual([]);
  db.close();
}, 60_000);

test("a reader opened before the move reads the tasks after it", () => {
  oldDatabase();
  // The reader stands in for sc run before the new daemon starts, such as a screen left open.
  const code = `import { openDb, moveToTasks } from ${JSON.stringify(source("db.ts"))};
import { readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const reader = openDb();
const before = readThread(reader, "app-15").rounds;
const daemon = openDb();
moveToTasks(daemon);
record(daemon, "app-15", { rounds: 99 });
console.log(JSON.stringify({ before, after: readThread(reader, "app-15").rounds }));`;
  expect(JSON.parse(run(code))).toEqual({ before: 3, after: 99 });
});

// Sets up this machine as the first run would have, so the daemon starts. Its leads and
// builders stay down: no repository is open, every thread but app-15 is done, and the remotes
// are folders that aren't there, so nothing reaches the network.
function machineSetUp(): void {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: claude\n");
  writeFileSync(join(home, ".config", "skelcrew", "claude-token"), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", "skelcrew.service"), "");
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const db = new Database(dbFile());
  db.run("UPDATE repositories SET opened = NULL, remote = ? || '/nowhere/' || repo", [home]);
  db.run("UPDATE threads SET status = 'done' WHERE folder != 'app-15'");
  db.close();
}

// Starts a daemon on a tmux socket of the test's own, which it never needs here.
function serve(): Subprocess<"ignore", "pipe", "pipe"> {
  const socket = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const code = `import { serve } from ${JSON.stringify(source("flow/daemon.ts"))};
await serve(${JSON.stringify(socket)});`;
  const daemon = Bun.spawn([process.execPath, "-e", code], {
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(daemon);
  return daemon;
}

test("a daemon refuses to start, and leaves the database alone, while another daemon runs", async () => {
  oldDatabase();
  machineSetUp();
  // Stands in for the earlier release's daemon, which holds the same lock beside its socket.
  const lockFile = JSON.stringify(join(home, "run", "skelcrew.sock.lock"));
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { dlopen, FFIType } from "bun:ffi";
import { openSync, writeFileSync } from "node:fs";
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
if (libc.symbols.flock(openSync(${lockFile}, "a"), 2 | 4) !== 0) process.exit(1);
writeFileSync(${JSON.stringify(join(home, "held"))}, "");
await Bun.sleep(300_000);`,
    ],
    { env: env() },
  );
  running.push(holder);
  await until(() => existsSync(join(home, "held")), { timeout: 30_000 });
  const daemon = serve();
  const [err, code] = await Promise.all([new Response(daemon.stderr).text(), daemon.exited]);
  expect(code).not.toBe(0);
  expect(err).toContain("the daemon is already running");
  expect(tables(dbFile())).not.toContain("tasks");
  expect(existsSync(join(data(), "skelcrew-before-tasks.db"))).toBe(false);
});

test("a thread's rounds, PR, review and updates written just before the move show on its task", async () => {
  oldDatabase();
  machineSetUp();
  // The earlier release's daemon saves a review round on app-15 as it stops.
  const updates = [
    { from: "lead", at: Date.UTC(2026, 10, 11, 9, 0, 0), text: "Use the system's theme." },
  ];
  const old = new Database(dbFile());
  old.run(
    `UPDATE threads SET rounds = 5, pr = 77, reviewed_by = 'codex', review_round = 5,
      verdict = 'changes', review_line = 'Add a toggle.', updates = ? WHERE folder = 'app-15'`,
    [JSON.stringify(updates)],
  );
  old.close();
  serve();
  // The new daemon moves the database as it starts, before it listens.
  await until(() => existsSync(join(home, "run", "skelcrew.sock")), { timeout: 30_000 });
  // The daemon may be writing as it starts, so the read waits for it rather than failing as
  // locked.
  const db = new Database(dbFile(), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  expect(
    db
      .query(
        `SELECT rounds, pr, reviewed_by, review_round, verdict, review_line, updates FROM tasks
          WHERE task = 15`,
      )
      .get(),
  ).toEqual({
    rounds: 5,
    pr: 77,
    reviewed_by: "codex",
    review_round: 5,
    verdict: "changes",
    review_line: "Add a toggle.",
    updates: JSON.stringify(updates),
  });
  db.close();
  // The lead's update still reaches the task as its reviewer gets it.
  const shown = await runSkel(["issue", "show", "app-15", "--json"], env());
  expect(JSON.parse(shown.out).body).toContain("Use the system's theme.");
}, 60_000);
