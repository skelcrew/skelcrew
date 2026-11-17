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
// imports below, and socket, a tmux socket on which no server runs, so no lead hears a note.
function withThread(body: string): unknown {
  const code = `import { existsSync, mkdirSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { endThread, removing } from ${JSON.stringify(source("flow/events.ts"))};
import { noteForLead } from ${JSON.stringify(source("flow/lead.ts"))};
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

// A note that a thread ended can wait while the lead is busy. If the thread starts over first,
// the note would name the new thread, and the lead would drop it, so it goes when the thread
// starts over. Other notes for the lead stay.
test("a thread starting over drops the note that its old self ended", () => {
  const seen = withThread(`noteForLead(db, socket, thread, "started app-t2 from github: Fix login");
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
const queued = db.query("SELECT text FROM notes ORDER BY id").all();
await Bun.sleep(5);
await startThread(db, { repo: "app", task: "t1" });
const notes = db.query("SELECT text FROM notes ORDER BY id").all();
console.log(JSON.stringify({ queued, notes }));`);
  expect(seen).toEqual({
    queued: [
      { text: "started app-t2 from github: Fix login" },
      { text: "app-t1 is done: #7 merged into main" },
    ],
    notes: [{ text: "started app-t2 from github: Fix login" }],
  });
});

// SQLite gives a new note the ID of the last one deleted. A thread starting over drops its end
// note while it is being typed, after its paste, which still goes in. A note saved right then
// takes its ID, and must still reach the lead, not be deleted as the note just typed.
test("a note saved while a dropped end note is typed still reaches the lead", () => {
  const typed = join(home, "typed");
  // A lead at its prompt that keeps every byte typed into it, a paste as soon as it arrives.
  const lead = `printf '\\033[?2004h'; stty -echo -icanon min 1; echo '❯'; exec cat >> ${typed}`;
  const seen = withThread(`import { readFileSync } from "node:fs";
import { leadPlaces } from ${JSON.stringify(source("paths.ts"))};
const typedSoFar = () => (existsSync(${JSON.stringify(typed)}) ? readFileSync(${JSON.stringify(typed)}, "utf8") : "");
const until = async (done) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(25); return done(); };
const tmux = (...args) => Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args]);
tmux("new-session", "-d", "-s", leadPlaces("simon", "app").name, "-x", "100", "-y", "30", "sh", "-c", ${JSON.stringify(lead)});
try {
  await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
  const { id } = db.query("SELECT id FROM notes").get();
  // The end note is pasted, and its Enter comes a moment later.
  const pasted = await until(() => typedSoFar().includes("app-t1 is done"));
  await startThread(db, { repo: "app", task: "t1" });
  noteForLead(db, socket, thread, "started app-t2 from github: Fix login");
  const reused = db.query("SELECT id FROM notes").get()?.id === id;
  // Sent, with its Enter after its paste, which the terminal hands on as a new line, so
  // nothing is left typing once tmux ends.
  const delivered = await until(() => typedSoFar().includes("Fix login\\x1b[201~\\n"));
  console.log(JSON.stringify({ pasted, reused, delivered }));
} finally {
  tmux("kill-server");
}`);
  expect(seen).toEqual({ pasted: true, reused: true, delivered: true });
});
