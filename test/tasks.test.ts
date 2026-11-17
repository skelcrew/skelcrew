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
import { fakePlugin, homeEnv, runSkel, source, until } from "./harness.ts";

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
// repo ls, sc ps, sc issue ls, sc issue show and sc pr show, the sidebar, the lists and the tabs.
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
  issues: list.listTasks(db),
  show: tasks.map((name) => {
    try {
      const [r, t] = name.split("-");
      return list.showTask(db, r, t);
    } catch (e) {
      return String(e);
    }
  }),
  prs: await Promise.all(
    [{ repo: "app", pr: 40 }, { repo: "app", pr: 41 }, { repo: "app", task: "13" }, { repo: "app", task: "16" }]
      .map((which) => list.showPr(db, which).catch(String)),
  ),
  screen: ["app", "notes"].map((repo) => {
    const open = { owner: "simon", repo, lead: "lead-" + repo };
    return {
      sidebar: sidebarRows(db, [], () => 5, now, open),
      lists: ["issues", "threads", "prs"].map((e) => listGroups(db, open, e, now)),
      entries: entryCounts(db, open),
    };
  }),
  tabs: repositoryTabs(db),
};
console.log(JSON.stringify(shown));`;

// What the release before tasks showed, with this test's home in its paths.
const shownBefore = () =>
  JSON.parse(readFileSync(join(saved, "before-tasks.json"), "utf8").replaceAll("$HOME", home));

// Returns the names of the database's tables.
function tables(file: string): string[] {
  const db = new Database(file, { readonly: true });
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  db.close();
  return rows.map((row) => String(Object.values(row ?? {})[0]));
}

test("after the move, every command and the screen show the same threads under the same names", () => {
  oldDatabase();
  // The saved database's app has GitHub as its forge, which shows its PRs.
  fakePlugin(home);
  // Before the new daemon moves it, sc shows the threads as they are.
  expect(JSON.parse(run(showAll))).toEqual(shownBefore());
  expect(tables(dbFile())).not.toContain("tasks");
  // After the move, it shows them just the same.
  expect(JSON.parse(run(showAll, "move"))).toEqual(shownBefore());
  // Each thread has its task, and a copy of the database from before waits beside it.
  const db = new Database(dbFile(), { readonly: true });
  expect(db.query("SELECT owner, repo, task FROM tasks ORDER BY rowid").all()).toEqual(
    db.query("SELECT owner, repo, task FROM threads ORDER BY rowid").all(),
  );
  expect(db.query("SELECT DISTINCT role FROM threads").all()).toEqual([{ role: "builder" }]);
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
  expect(db.query("SELECT rounds, short FROM threads WHERE folder = 'app-15'").get()).toEqual({
    rounds: 3,
    short: "Dark mode",
  });
  db.close();
});

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
  const db = new Database(dbFile(), { readonly: true });
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
