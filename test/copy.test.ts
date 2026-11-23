// Skelcrew's copy of a repository's issues and PRs, as polls bring it up to date, and as the
// sidebar's readers, sc issue and a builder read it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-copy-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Returns a task as a tracker hands it to Skelcrew.
const task = (id: number, more: object = {}) => ({
  kind: "task",
  id: String(id),
  title: `Task ${id}`,
  body: "",
  state: "open",
  author: null,
  labels: [],
  link: `https://github.com/simon/app/issues/${id}`,
  created: `2026-11-0${id % 10}T10:00:00Z`,
  updated: "2026-11-05T10:00:00Z",
  closes: `Closes #${id}`,
  ...more,
});

// Runs code against the database in this test's home, with Skelcrew's copy and an app repository
// whose thread works on task 12, and returns what it printed as JSON. It takes a process of its
// own, as the database's folder comes from the HOME a process started with.
function run(code: string): unknown {
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { saveItems, openTasks, taskOf } from ${JSON.stringify(source("flow/copy.ts"))};
const db = openDb();
db.run("INSERT OR IGNORE INTO repositories (owner, repo, name) VALUES ('simon', 'app', 'app')");
db.run(${JSON.stringify(threadSql({ task: "12" }))});
const ids = () => openTasks(db, "simon", "app").map((t) => t.id);
${code}`;
  const ran = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!ran.success) throw new Error(ran.stderr.toString());
  return JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) ?? "");
}

test("open tasks read newest first", () => {
  const saved = `saveItems(db, "simon", "app", ${JSON.stringify([task(3), task(5), task(4)])}, ["task"]);
console.log(JSON.stringify(ids()));`;
  expect(run(saved)).toEqual(["5", "4", "3"]);
});

test("everything open replaces the copy, keeping a thread's task, now closed", () => {
  run(`saveItems(db, "simon", "app", ${JSON.stringify([task(12), task(13), task(14)])}, ["task"]);
console.log("{}");`);
  expect(
    run(`saveItems(db, "simon", "app", ${JSON.stringify([task(14)])}, ["task"]);
console.log(JSON.stringify({ open: ids(), kept: taskOf(db, "simon", "app", "12").state,
  counts: db.query("SELECT open_issues FROM repositories").get() }));`),
  ).toEqual({ open: ["14"], kept: "closed", counts: { open_issues: 1 } });
  expect(() => run(`taskOf(db, "simon", "app", "13");`)).toThrow(
    "there is no open issue 13 in simon/app",
  );
});

// A task named after its issue before every task took a number kept its name in lowercase, such
// as jott-12, which the upgrade made its issue. The copy gives it the tracker's own spelling, so
// a restart finds its issue, and its label doesn't start a second task.
test("a task whose issue was saved in lowercase takes the tracker's spelling", () => {
  const code = `db.run(${JSON.stringify(threadSql({ task: "t5", issue: "jott-12", folder: "app-jott-12" }))});
saveItems(db, "simon", "app", ${JSON.stringify([task(12, { id: "JOTT-12" })])}, ["task"]);
console.log(JSON.stringify(db.query("SELECT task, issue FROM tasks WHERE task = 't5'").get()));`;
  expect(run(code)).toEqual({ task: "t5", issue: "JOTT-12" });
});

test("a change brings an item in or updates it, and a closed one leaves once no thread has it", () => {
  run(`saveItems(db, "simon", "app", ${JSON.stringify([task(12), task(13)])}, ["task"]);
console.log("{}");`);
  const changes = [task(13, { state: "closed" }), task(15, { title: "New" })];
  expect(
    run(`saveItems(db, "simon", "app", ${JSON.stringify(changes)}, []);
console.log(JSON.stringify({ open: ids(), title: taskOf(db, "simon", "app", "15").title }));`),
  ).toEqual({ open: ["15", "12"], title: "New" });
  // Once its thread is done, a closed task leaves at the next change.
  expect(
    run(`db.run("UPDATE threads SET status = 'done'");
saveItems(db, "simon", "app", ${JSON.stringify([task(12, { state: "closed" })])}, []);
console.log(JSON.stringify(db.query("SELECT id FROM items ORDER BY id").all()));`),
  ).toEqual([{ id: "15" }]);
});

// A task with no issue saves that it has no line to close, rather than nothing saved, so its PR
// never closes an issue it didn't start on.
test("a task with no issue saves an empty closing line", () => {
  // A remote of its own, with a commit, where the thread's name is claimed.
  const remote = join(home, "app.git");
  const work = join(home, "work");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
  Bun.spawnSync(["git", "init", "-q", "-b", "main", work]);
  writeFileSync(
    join(work, "skelcrew.yaml"),
    "setup: []\ntest: []\nlimits: { threads: 9 }\nroles: { builder: { harness: claude }, reviewer: { harness: claude } }\n",
  );
  Bun.spawnSync(["git", "-C", work, "add", "."]);
  const identity = ["-c", "user.name=t", "-c", "user.email=t@t"];
  Bun.spawnSync(["git", "-C", work, ...identity, "commit", "-q", "-m", "a"]);
  Bun.spawnSync(["git", "-C", work, "push", "-q", remote, "main"]);
  const code = `db.run("UPDATE repositories SET opened = 1, remote = ?, claimed = 1", [${JSON.stringify(remote)}]);
const { startThread } = await import(${JSON.stringify(source("flow/builder.ts"))});
const { readThread } = await import(${JSON.stringify(source("flow/thread.ts"))});
const started = await startThread(db, { repo: "app", title: "Tidy", body: "" });
console.log(JSON.stringify(readThread(db, started.folder).closes));`;
  expect(run(code)).toBe("");
});

// A started task's PR closes the issue it started on, by the line saved as it started, though
// the tracker's copy of the issue changed or left since. One saved with no line closes nothing,
// though the copy has one now. A task saved before Skelcrew kept the line takes the copy's.
test("a started task closes its issue by the line it saved, whatever the copy says now", () => {
  const closes =
    () => `const { threadTask } = await import(${JSON.stringify(source("flow/copy.ts"))});
const { readThread } = await import(${JSON.stringify(source("flow/thread.ts"))});
console.log(JSON.stringify(threadTask(db, readThread(db, "app-12")).closes));`;
  expect(
    run(`db.run("UPDATE tasks SET title = 'Task 12', closes = 'Closes #12'");
${closes()}`),
  ).toBe("Closes #12");
  expect(
    run(`saveItems(db, "simon", "app", ${JSON.stringify([task(12, { closes: "Fixes JOTT-12" })])}, ["task"]);
${closes()}`),
  ).toBe("Closes #12");
  expect(
    run(`db.run("UPDATE tasks SET closes = ''");
${closes()}`),
  ).toBe("");
  expect(
    run(`db.run("UPDATE tasks SET closes = NULL");
${closes()}`),
  ).toBe("Fixes JOTT-12");
});
