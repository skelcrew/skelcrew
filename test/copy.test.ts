// Skelcrew's copy of a repository's issues and PRs, as polls bring it up to date, and as the
// sidebar's readers, sc task and a builder read it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

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
db.run(\`INSERT OR IGNORE INTO threads (owner, repo, task, folder, branch, status)
  VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working')\`);
const ids = () => openTasks(db, "simon", "app").map((t) => t.id);
${code}`;
  const ran = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!ran.success) throw new Error(ran.stderr.toString());
  return JSON.parse(ran.stdout.toString());
}

test("open tasks read newest first", () => {
  const saved = `saveItems(db, "simon", "app", ${JSON.stringify([task(3), task(5), task(4)])}, true);
console.log(JSON.stringify(ids()));`;
  expect(run(saved)).toEqual(["5", "4", "3"]);
});

test("everything open replaces the copy, keeping a thread's task, now closed", () => {
  run(`saveItems(db, "simon", "app", ${JSON.stringify([task(12), task(13), task(14)])}, true);
console.log("{}");`);
  expect(
    run(`saveItems(db, "simon", "app", ${JSON.stringify([task(14)])}, true);
console.log(JSON.stringify({ open: ids(), kept: taskOf(db, "simon", "app", 12).state,
  counts: db.query("SELECT open_issues FROM repositories").get() }));`),
  ).toEqual({ open: ["14"], kept: "closed", counts: { open_issues: 1 } });
  expect(() => run(`taskOf(db, "simon", "app", 13);`)).toThrow(
    "there is no open task #13 in simon/app",
  );
});

test("a change brings an item in or updates it, and a closed one leaves once no thread has it", () => {
  run(`saveItems(db, "simon", "app", ${JSON.stringify([task(12), task(13)])}, true);
console.log("{}");`);
  const changes = [task(13, { state: "closed" }), task(15, { title: "New" })];
  expect(
    run(`saveItems(db, "simon", "app", ${JSON.stringify(changes)}, false);
console.log(JSON.stringify({ open: ids(), title: taskOf(db, "simon", "app", 15).title }));`),
  ).toEqual({ open: ["15", "12"], title: "New" });
  // Once its thread is done, a closed task leaves at the next change.
  expect(
    run(`db.run("UPDATE threads SET status = 'done'");
saveItems(db, "simon", "app", ${JSON.stringify([task(12, { state: "closed" })])}, false);
console.log(JSON.stringify(db.query("SELECT id FROM items ORDER BY id").all()));`),
  ).toEqual([{ id: "15" }]);
});
