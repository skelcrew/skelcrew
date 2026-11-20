// The queue of tasks under limits.threads, read from a database of the test's own with no
// engine running: which tasks leave it and in what order, where a task joins, and moving one.
// The engine's own tests in queued.test.ts keep one run of each path through a real daemon.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-task-queue-test-")));
  // app allows one builder at once, by the skelcrew.yaml in Skelcrew's clone of it.
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "limits: { threads: 1 }\n");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Runs `code` against the database after `sql`, with app known as a repository, and returns
// what the code printed as JSON. `leave(skip)` takes the tasks whose turn came out of the queue
// and returns their folders. It takes a process of its own with HOME set: homedir() keeps the
// HOME this process started with, so opening the database from here would reach your real one.
function onQueue(sql: string, code: string): unknown {
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { backToQueue, joinTime, leaveQueue, moveInQueue } from ${JSON.stringify(source("flow/task-queue.ts"))};
import { readThread } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.exec("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");
db.exec(${JSON.stringify(sql)});
const leave = (skip = []) => leaveQueue(db, new Set(skip)).map((thread) => thread.folder);
${code}`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

// app-11's builder is at work, and app-12 and app-13 wait in the queue, joined at these times.
const twoQueued = (twelve: number, thirteen: number) => `
${threadSql({ task: "11", session: "s" })}
${threadSql({ task: "12", status: "queued", queued_since: twelve })}
${threadSql({ task: "13", status: "queued", queued_since: thirteen })}`;

test("tasks leave the queue in the order they joined, one at a time under a limit of one", () => {
  const left = onQueue(
    twoQueued(2, 1),
    `const whileBusy = leave();
db.run("UPDATE threads SET status = 'done' WHERE folder = 'app-11'");
const first = leave();
const second = leave();
db.run("UPDATE threads SET status = 'failed' WHERE folder = 'app-13'");
console.log(JSON.stringify({ whileBusy, first, second, third: leave() }));`,
  );
  expect(left).toEqual({ whileBusy: [], first: ["app-13"], second: [], third: ["app-12"] });
});

test("a task that still owes its claim holds back the tasks that joined after it", () => {
  const sql = `${twoQueued(1, 2)}
UPDATE threads SET status = 'done' WHERE folder = 'app-11';
INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '12');`;
  const left = onQueue(
    sql,
    `const owing = leave();
db.run("DELETE FROM claims");
console.log(JSON.stringify({ owing, claimed: leave() }));`,
  );
  expect(left).toEqual({ owing: [], claimed: ["app-12"] });
});

test("a task sc rm is removing holds its place, ahead of the tasks that joined after it", () => {
  const sql = `${twoQueued(1, 2)}
UPDATE threads SET status = 'done' WHERE folder = 'app-11';`;
  const left = onQueue(
    sql,
    `console.log(JSON.stringify({ removing: leave(["app-12"]), failed: leave() }));`,
  );
  expect(left).toEqual({ removing: [], failed: ["app-12"] });
});

test("a stopped task leaves the queue waiting on its PR, and one with no session works", () => {
  // app-12 was stopped with a PR, so it waits on the PR once back. app-13 never started.
  const sql = `${threadSql({ task: "12", status: "queued", queued_since: 1, session: "t", pr: 7 })}
${threadSql({ task: "13", status: "queued", queued_since: 2 })}`;
  const left = onQueue(
    sql,
    `const status = (folder) => readThread(db, folder).status;
leave();
const stopped = status("app-12");
db.run("UPDATE threads SET status = 'done' WHERE folder = 'app-12'");
leave();
console.log(JSON.stringify({ stopped, fresh: status("app-13") }));`,
  );
  expect(left).toEqual({ stopped: "waiting", fresh: "working" });
});

test("a task whose start the engine's stop cut short goes back in its place in the queue", () => {
  // app-12 left the queue, but the engine stopped before its builder's session was saved.
  const sql = `${twoQueued(1, 2)}
UPDATE threads SET status = 'done' WHERE folder = 'app-11';
UPDATE threads SET status = 'working' WHERE folder = 'app-12';`;
  const left = onQueue(
    sql,
    `backToQueue(db);
console.log(JSON.stringify({ status: readThread(db, "app-12").status, left: leave() }));`,
  );
  expect(left).toEqual({ status: "queued", left: ["app-12"] });
});

test("a task joins the queue after every task already in it, though the clock went back", () => {
  const later = Date.now() + 60_000;
  const joins = onQueue(twoQueued(1, later), "console.log(joinTime(db));");
  expect(joins).toBe(later + 1);
});

test("moving a queued task swaps it with its neighbour, and says its place in line", () => {
  const moved = onQueue(
    twoQueued(1, 2),
    `const move = (folder, by) => {
  try { return moveInQueue(db, readThread(db, folder), by); }
  catch (error) { return String(error); }
};
const said = [move("app-13", -1), move("app-13", -1), move("app-12", 1), move("app-11", 1)];
db.run("UPDATE threads SET status = 'done' WHERE folder = 'app-11'");
console.log(JSON.stringify({ said, first: leave() }));`,
  );
  expect(moved).toEqual({
    said: [
      "APP-13 starts next",
      "APP-13 starts next",
      "APP-12 is 2nd in line",
      "Error: APP-11 isn't queued, so it has no place to move",
    ],
    first: ["app-13"],
  });
});
