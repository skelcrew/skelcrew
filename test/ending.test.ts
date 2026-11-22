// Ending a thread, run against a database of the test's own, with no daemon, tracker or forge.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";
// The test's own tmux socket, never Skelcrew's. Only a test that starts a lead runs a server on it.
let socket = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-ending-test-")));
  socket = `skel-test-ending-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // Skelcrew's clone of the repository, where it keeps refs of what each thread pushed.
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", clone]);
  // The repository's remote, where a thread with no issue claims its name.
  Bun.spawnSync(["git", "init", "-q", "--bare", join(home, "app.git")]);
});
afterEach(() => {
  // Ending the server leaves its socket file behind.
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "pipe" });
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  rmSync(join(folder, socket), { force: true });
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

// A Pi builder's session folder stays for its conversation, but its copy of your login goes
// with the thread, so no key is left behind. A thread that started over keeps its new one.
test("an end removes the builder's copy of your login, and a late end leaves a new one alone", () => {
  const seen = withThread(`const { writeFileSync } = await import("node:fs");
const { dirname } = await import("node:path");
const login = ${JSON.stringify(join(home, ".local", "share", "skelcrew", "pi-sessions"))} + "/" + thread.folder + "/auth.json";
mkdirSync(dirname(login), { recursive: true });
writeFileSync(login, '{"openrouter":{"type":"api_key","key":"k"}}');
writeFileSync(dirname(login) + "/conversation.jsonl", "{}");
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
const ended = { login: existsSync(login), conversation: existsSync(dirname(login) + "/conversation.jsonl") };
const fresh = await startThread(db, { repo: "app", task: "t1" });
const freshLogin = ${JSON.stringify(join(home, ".local", "share", "skelcrew", "pi-sessions"))} + "/" + fresh.folder + "/auth.json";
mkdirSync(dirname(freshLogin), { recursive: true });
writeFileSync(freshLogin, "{}");
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
console.log(JSON.stringify({ ended, fresh: existsSync(freshLogin) }));`);
  expect(seen).toEqual({ ended: { login: false, conversation: true }, fresh: true });
});

// A failure note still waiting for the lead, such as while the human reads further up in it,
// would reach the lead after the thread started over, and the lead would ask for a start the
// thread already had.
test("a thread that starts over drops the note that it failed, still waiting for the lead", () => {
  // failThread logs as the daemon would, which would mix with what the script prints.
  const seen = withThread(`const print = console.log;
console.log = () => {};
failThread(db, socket, thread, new Error("its setup command failed"));
console.log = print;
const held = db.query("SELECT text FROM notes").all().map((note) => note.text);
await Bun.sleep(5);
await startThread(db, { repo: "app", task: "t1" });
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ held, notes }));`);
  expect(seen).toEqual({ held: [`APP-1 failed: its setup command failed`], notes: [] });
});

// Runs a script against the test's own home, with a thread app-1 started on a repository with
// no tracker or forge, and returns what it printed as JSON. The script has db, thread, the
// imports below, and socket, the test's tmux socket, where no lead runs unless the script starts one.
function withThread(body: string): unknown {
  const code = `import { existsSync, mkdirSync } from "node:fs";
import { openDb } from ${JSON.stringify(source("db.ts"))};
import { failThread, startThread } from ${JSON.stringify(source("flow/builder.ts"))};
import { endThread } from ${JSON.stringify(source("flow/events.ts"))};
import { supervisor } from ${JSON.stringify(source("flow/supervisor.ts"))};
import { noteForLead } from ${JSON.stringify(source("flow/messages.ts"))};
import { cloneOf, readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, opened, remote, claimed) VALUES ('app', 'simon', 'app', 1, ?, 1)", [${JSON.stringify(`file://${join(home, "app.git")}`)}]);
const thread = await startThread(db, { repo: "app", title: "Add export", body: "As JSON" });
const socket = ${JSON.stringify(socket)};
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
const removal = supervisor(thread.folder).remove(() => ending);
await ending;
await removal;
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ status: readThread(db, thread.folder).status, notes }));`);
  expect(seen).toEqual({ status: "working", notes: [] });
});

// A thread is marked done and its note for the lead saved together. A note that can't be
// saved, as when the disk is full, leaves the thread short of done, with its clone and no end
// in its log, and the next end saves both, logs it once and removes the clone.
test("an end whose note can't be saved leaves the thread for the next end", () => {
  const seen =
    withThread(`db.run("CREATE TRIGGER fail_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'disk full'); END");
// How many times the thread's log says it ended.
const { readFileSync } = await import("node:fs");
const ends = () => readFileSync(${JSON.stringify(join(home, ".local", "share", "skelcrew", "threads", `app-1.log`))}, "utf8").split("ended the thread").length - 1;
mkdirSync(cloneOf(thread), { recursive: true });
const failed = await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main").then(() => "", (error) => String(error));
const after = { status: readThread(db, thread.folder).status, logged: ends(), clone: existsSync(cloneOf(thread)) };
db.run("DROP TRIGGER fail_notes");
await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
const notes = db.query("SELECT text FROM notes").all();
console.log(JSON.stringify({ failed, after, status: readThread(db, thread.folder).status, logged: ends(), clone: existsSync(cloneOf(thread)), notes }));`);
  expect(seen).toEqual({
    failed: "SQLiteError: disk full",
    after: { status: "working", logged: 0, clone: true },
    status: "done",
    logged: 1,
    clone: false,
    notes: [{ text: `APP-1 is done: #7 merged into main` }],
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
      { text: `APP-1 is done: #7 merged into main` },
    ],
    notes: [{ text: "started app-t2 from github: Fix login" }],
  });
});

// A thread starting over drops its end note even while it is being typed, after its paste,
// which still goes in. If the new thread then ends the same way, its note says the same. It
// must still reach the lead, not be deleted as the note just typed, so no note's ID is ever
// used twice.
test("a thread that ends again while its dropped end note is typed still tells the lead", () => {
  const typed = join(home, "typed");
  // A lead at its prompt that keeps every byte typed into it, a paste as soon as it arrives.
  const lead = `printf '\\033[?2004h'; stty -echo -icanon min 1; echo '❯'; exec cat >> ${typed}`;
  const seen = withThread(`import { readFileSync } from "node:fs";
import { leadPlaces } from ${JSON.stringify(source("paths.ts"))};
import { typeLeadNotes } from ${JSON.stringify(source("flow/messages.ts"))};
const typedSoFar = () => (existsSync(${JSON.stringify(typed)}) ? readFileSync(${JSON.stringify(typed)}, "utf8") : "");
const until = async (done) => { for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(25); return done(); };
const tmux = (...args) => Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args]);
tmux("new-session", "-d", "-s", leadPlaces("simon", "app").name, "-x", "100", "-y", "30", "sh", "-c", ${JSON.stringify(lead)});
// Each note sent, with its Enter after its paste, which the terminal hands on as a new line.
const sent = () => typedSoFar().split("APP-1 is done: #7 merged into main\\x1b[201~\\n").length - 1;
try {
  await endThread(db, socket, thread, "PR #7 was merged", "is done: #7 merged into main");
  const first = db.query("SELECT id FROM notes").get().id;
  // The end note is pasted, and its Enter comes a moment later.
  const pasted = await until(() => typedSoFar().includes("APP-1 is done"));
  await Bun.sleep(5);
  const fresh = await startThread(db, { repo: "app", task: "t1" });
  await endThread(db, socket, fresh, "PR #7 was merged", "is done: #7 merged into main");
  const second = db.query("SELECT id FROM notes").get()?.id;
  // The second end waits for the next digest of routine notes, which the test brings forward
  // once the first has gone in.
  await until(() => db.query("SELECT digest_at FROM repositories").get().digest_at > 0);
  db.run("UPDATE repositories SET digest_at = 0");
  typeLeadNotes(db, socket);
  // Both are sent, so nothing is left typing once tmux ends.
  const delivered = await until(() => sent() === 2);
  console.log(JSON.stringify({ pasted, newId: second !== undefined && second !== first, delivered }));
} finally {
  tmux("kill-server");
}`);
  expect(seen).toEqual({ pasted: true, newId: true, delivered: true });
});

// The list opens a done task's PR from the link saved with it. A task started over has a new
// attempt with no PR yet, so the earlier attempt's link must go with its PR.
test("a task started over keeps no PR link from its earlier attempt", () => {
  const seen = withThread(`record(db, thread.folder, { status: "done" }, "ended");
db.run("UPDATE tasks SET pr = 7, pr_link = 'https://github.com/simon/app/pull/7' WHERE task = 't1'");
await startThread(db, { repo: "app", task: "t1" });
console.log(JSON.stringify(db.query("SELECT pr, pr_link FROM tasks WHERE task = 't1'").get()));`);
  expect(seen).toEqual({ pr: null, pr_link: null });
});

// A thread starting over first deletes the old thread's refs of what it pushed. Without a
// forge, a push ref left behind would make the new thread look as if it had pushed already, and
// end it at once. So a start over whose refs git can't delete is refused, and nothing changes.
test("a start over that can't delete the old thread's refs is refused", () => {
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  const seen = withThread(`import { writeFileSync } from "node:fs";
record(db, thread.folder, { status: "done" }, "ended");
// The old thread pushed, and its push ref is locked, as by a git command still running.
const git = (...args) => Bun.spawnSync(["git", "-C", ${JSON.stringify(clone)}, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
git("commit", "-q", "--allow-empty", "-m", "pushed");
git("update-ref", "refs/skelcrew/threads/app-1", "HEAD");
writeFileSync(${JSON.stringify(join(clone, ".git", "refs", "skelcrew", "threads", `app-1.lock`))}, "");
const refused = await startThread(db, { repo: "app", task: "t1" }).then(() => "", (error) => String(error));
console.log(JSON.stringify({ refused: refused.includes("couldn't start APP-1 over"), status: readThread(db, thread.folder).status, started: readThread(db, thread.folder).started === thread.started }));`);
  expect(seen).toEqual({ refused: true, status: "done", started: true });
});

// A setup that couldn't clone the repository fails its thread and leaves no clone, so no refs.
// Starting that thread over must still work, so setting it up can clone once the problem is
// fixed.
test("a failed thread starts over when Skelcrew has no clone of its repository", () => {
  const seen = withThread(`import { rmSync } from "node:fs";
record(db, thread.folder, { status: "failed" }, "couldn't clone");
rmSync(${JSON.stringify(join(home, ".local", "share", "skelcrew", "repos", "simon", "app"))}, { recursive: true });
await Bun.sleep(5);
const fresh = await startThread(db, { repo: "app", task: "t1" });
console.log(JSON.stringify({ status: readThread(db, fresh.folder).status, new: fresh.started !== thread.started }));`);
  expect(seen).toEqual({ status: "working", new: true });
});

// The look for exited leads can find a lead you exited just as you open its repository again.
// Opening it then wins: its tab stays open, and the start that follows deals with the old session.
test("a lead you exited and opened again at once keeps its tab open", () => {
  const seen =
    withThread(`const { closeExitedLeads, leadOf } = await import(${JSON.stringify(source("flow/lead.ts"))});
const { exitedCleanly, startSession } = await import(${JSON.stringify(source("agents/sessions.ts"))});
const { name } = leadOf(db, "simon", "app");
const done = ${JSON.stringify(join(home, "lead.done"))};
const labels = { repository: "simon/app", role: "lead" };
await startSession(socket, name, { folder: ${JSON.stringify(home)}, command: ["sh", "-c", \`while [ ! -e \${done} ]; do sleep 0.05; done\`], env: {}, labels, keepOnExit: true });
require("node:fs").writeFileSync(done, "");
while (!exitedCleanly(socket, name)) await Bun.sleep(20);
const closing = closeExitedLeads(db, socket);
db.run("UPDATE repositories SET opened = opened + 1, tab_closed = 0 WHERE owner = 'simon' AND repo = 'app'");
await closing;
console.log(JSON.stringify(db.query("SELECT tab_closed FROM repositories WHERE repo = 'app'").get()));`);
  expect(seen).toEqual({ tab_closed: 0 });
});
