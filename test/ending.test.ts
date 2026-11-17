// Ending a thread, run against a database of the test's own, with no daemon, tracker or forge.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-ending-test-")));
  mkdirSync(join(home, ".local", "share", "skelcrew", "repos", "simon", "app"), {
    recursive: true,
  });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A poll can still be ending a thread after another end finished it and it started over, such
// as while it waits for the old builder to exit. That late end must leave the new thread alone:
// its builder, its clone, its status and the lead.
test("a late end leaves a thread that started over alone", () => {
  const seen =
    withThread(`// Another end finishes the thread, and it starts over in the same folder, with a clone.
record(db, thread.folder, { status: "done" }, "ended by another end");
await Bun.sleep(5);
const fresh = await startThread(db, { repo: "app", task: "t1" });
mkdirSync(cloneOf(fresh), { recursive: true });
// The late end, holding the thread as it was.
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ status: readThread(db, fresh.folder).status, clone: existsSync(cloneOf(fresh)), notes }));`);
  expect(seen).toEqual({ status: "working", clone: true, notes: [] });
});

// Runs a script against the test's own home, with a thread app-t1 started on a repository with
// no tracker or forge, and returns what it printed as JSON. The script has db, thread, the
// imports below, and socket, a tmux socket on which no server runs.
function withThread(body: string): unknown {
  const code = `import { existsSync, mkdirSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { endThread, removing } from ${JSON.stringify(source("flow/events.ts"))};
import { cloneOf, readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, opened, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'file:///nowhere', 1)");
const thread = await startThread(db, { repo: "app", title: "Add export", body: "As JSON" });
const socket = "skel-test-ending-${process.pid}";
${body}`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  return JSON.parse(run.stdout.toString());
}

// sc rm can start while a poll is ending the same thread, such as while the poll waits for the
// builder to exit. The thread is then sc rm's to end: the lead hears what sc rm says, or
// nothing when the lead ran it, never the merge the poll saw.
test("a poll's end leaves a thread sc rm started removing while it waited", () => {
  const seen =
    withThread(`const ending = endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
// The poll's end is now waiting for the builder, and sc rm starts removing the thread.
removing.add(thread.folder);
await ending;
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ status: readThread(db, thread.folder).status, notes }));`);
  expect(seen).toEqual({ status: "working", notes: [] });
});

// A thread is marked done and its note for the lead saved together. A note that can't be
// saved, as when the disk is full, leaves the thread short of done, and the next end saves both.
test("an end whose note can't be saved leaves the thread for the next end", () => {
  const seen =
    withThread(`db.run("CREATE TRIGGER fail_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'disk full'); END");
const failed = await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main").then(() => "", (error) => String(error));
const after = readThread(db, thread.folder).status;
db.run("DROP TRIGGER fail_notes");
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ failed, after, status: readThread(db, thread.folder).status, notes }));`);
  expect(seen).toEqual({
    failed: "SQLiteError: disk full",
    after: "working",
    status: "done",
    notes: [{ text: "app-t1 is done: #7 merged into main" }],
  });
});
