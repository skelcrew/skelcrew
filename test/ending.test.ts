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
  const code = `import { existsSync, mkdirSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { endThread } from ${JSON.stringify(source("flow/events.ts"))};
import { cloneOf, readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, opened, remote, claimed) VALUES ('app', 'simon', 'app', 1, 'file:///nowhere', 1)");
const old = await startThread(db, { repo: "app", title: "Add export", body: "As JSON" });
// Another end finishes the thread, and it starts over in the same folder, with a clone.
record(db, old.folder, { status: "done" }, "ended by another end");
await Bun.sleep(5);
const fresh = await startThread(db, { repo: "app", task: "t1" });
mkdirSync(cloneOf(fresh), { recursive: true });
// The late end, holding the thread as it was. No tmux server runs on this socket.
await endThread(db, "skel-test-ending-${process.pid}", old, "PR #7 was merged", "is done: #7 merged into main");
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ status: readThread(db, fresh.folder).status, clone: existsSync(cloneOf(fresh)), notes }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual({ status: "working", clone: true, notes: [] });
});
