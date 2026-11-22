// Needs you, decided in a process of the test's own against its own database: the marks Skelcrew
// sets itself, such as the round limit or a missing host plugin. Also that only an agent's hooks
// can say it asks a question or stopped. The needsyou-*.test.ts files check the rest against a
// running daemon, and inbox.test.ts the lead's items.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { source, threadSql } from "./harness.ts";
import { home, serve, setUp, skel, tearDown, until } from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

test("only an agent's hooks can say it is asking you a question, stopped, or stopped on an error", async () => {
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
  for (const args of [
    ["hook", "question-asked"],
    ["hook", "prompt"],
    ["hook", "turn-failed"],
    ["hook", "turn-ended"],
    ["hook", "question-closed"],
    ["hook", "turn-interrupted"],
  ]) {
    const run = await skel(args);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("doesn't know that request");
  }
});

// Runs the code in a process of its own, with HOME set to the test's, as homedir() keeps the HOME
// this process started with. The database is open as `db`, with simon/app and its thread app-12
// in it, and `thread()` reads app-12 back. Nothing runs the builder, so these run anywhere, a
// sandbox included. Returns what the code printed last, as JSON.
function inProcess(body: string): Record<string, unknown> {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { needsYou, needsYouFor, threadWord, turnEnded } from ${JSON.stringify(source("flow/status.ts"))};
import { goOn, noteLimit, submitRound } from ${JSON.stringify(source("flow/round.ts"))};
import { reviewOnPr, verdictPosted, verdictReached } from ${JSON.stringify(source("flow/ledger.ts"))};
import { readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
import { bringBack } from ${JSON.stringify(source("flow/builder.ts"))};
import { armMerge, cancelMerge } from ${JSON.stringify(source("flow/merging.ts"))};
import { cloneDir } from ${JSON.stringify(source("paths.ts"))};
import { mkdirSync } from "node:fs";
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "12", status: "working" })}\`);
const thread = () => readThread(db, "app-12");
// The note for the lead that the thread started needing you, kept until it is typed in, and the
// other notes kept for the lead.
const noting = () => thread().noting;
const notes = () => db.query("SELECT text FROM notes ORDER BY id").all().map((n) => n.text);
${body}
process.exit(0);`;
  const done = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!done.success) throw new Error(done.stderr.toString());
  return JSON.parse(done.stdout.toString().trim().split("\n").at(-1) ?? "{}");
}

// The note a review asking for changes at the built-in round limit of 3 leaves for the lead.
const reachedNote = "changes asked for after 3 rounds of changes, so the round limit is reached";

// The note that a thread needs you is the lead's to hear once, however often the daemon starts
// while the plugin is gone. A thread that needed you already hears of it in a note of its own.
test("a missing host plugin marks the thread with what to install, and tells the lead once", () => {
  const seen = inProcess(`
record(db, "app-12", { session: "s", host: "gone", host_id: "gone-app-12", asking: true, noting: null });
await bringBack(db, "none", thread());
await bringBack(db, "none", thread());
console.log(JSON.stringify({ mark: thread().needs_you_for, notes: notes() }));`);
  const mark = "run sc install: its session host gone is missing";
  expect(seen).toEqual({ mark, notes: [`APP-12 needs you: ${mark}`] });
});

// A release before this one had a failed review need you. The lead can run it again, so once
// upgraded it shows as failed without needing you. One past the round limit still needs you.
test("an upgrade moves a failed review off needing you, but not one past the round limit", () => {
  const seen = inProcess(`
db.run(\`${threadSql({ task: "13", status: "waiting" })}\`);
db.run("UPDATE threads SET needs_you = 1");
db.run("UPDATE tasks SET verdict = 'failed'");
db.run("UPDATE tasks SET held = 'Fix it.' WHERE task = 't13'");
db.run("DROP VIEW task_threads");
db.run("ALTER TABLE threads DROP COLUMN review_failed");
const upgraded = openDb();
const row = (folder) => upgraded.query("SELECT needs_you, review_failed FROM task_threads WHERE folder = ?").get(folder);
console.log(JSON.stringify({ failed: row("app-12"), past: row("app-13") }));`);
  expect(seen).toEqual({
    failed: { needs_you: 0, review_failed: 1 },
    past: { needs_you: 1, review_failed: 0 },
  });
});

// Waiting on a review never needs you, so a submit past the round limit waits on its review,
// and only a review that asks for changes again brings the limit back.
test("a submit past the round limit doesn't need you while it is pushed and reviewed", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", held: "Fix it." });
const before = needsYouFor(thread());
submitRound(db, "none", "app-12", "Round 5");
console.log(JSON.stringify({ before, needsYou: needsYou(thread()), word: threadWord(thread(), 3) }));`);
  expect(seen).toEqual({ before: "round limit", needsYou: false, word: "reviewing" });
});

// Going on past the round limit is a decision, but bringing back a missing host plugin is still
// yours to do, so its instruction stays.
test("going on past the round limit keeps the instruction to bring back a missing host plugin", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", session: "s", host: "gone", host_id: "gone-app-12" });
await bringBack(db, "none", thread());
goOn(db, "none", "app-12");
console.log(JSON.stringify({ mark: thread().needs_you_for, rounds: thread().rounds }));`);
  expect(seen).toEqual({ mark: "run sc install: its session host gone is missing", rounds: 3 });
});

// Arming a merge past the round limit is your decision, which a plan that ends later, such as
// one you cancel, doesn't undo.
test("arming a merge past the round limit decides it, after the plan ends too", () => {
  const seen = inProcess(`
db.run("UPDATE repositories SET forge = 'github'");
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", held: "Fix it.", pr: 7 });
const before = needsYou(thread());
armMerge(db, "none", thread(), { asked: "merge app-12 when it's ready" }, false);
const decided = thread().limit_decided;
cancelMerge(db, thread());
console.log(JSON.stringify({ before, decided, after: needsYou(thread()) }));`);
  expect(seen).toEqual({ before: true, decided: true, after: false });
});

// Saves a review asking for changes as a finished round does, under the built-in limit of 3
// rounds, then has it posted, and gives back whether the thread needs you and the note the lead
// is to get, which comes only once the review is posted. The note is then taken as typed in, as
// the daemon does, so the next one is seen afresh.
const changesAsked = `const changesAsked = () => {
  const t = thread();
  const review = { verdict: "changes", body: "Fix it.", findings: ["Fix it."] };
  const reached = { review, by: "claude", sha: "a".repeat(40), maxRounds: 3, ready: null, forge: true, kept: null, now: Date.now() };
  const o = verdictReached(t, reached);
  record(db, "app-12", { ...o.change, noting: null }, o.why);
  const unposted = noting();
  const round = thread().posting.review.round;
  const post = { pr: 7, id: "9", verdict: "changes", findings: ["Fix it."], round };
  record(db, "app-12", reviewOnPr(thread(), post, Date.now()));
  const saved = thread();
  const posted = verdictPosted(saved, saved.posting, Date.now());
  record(db, "app-12", posted.change);
  noteLimit(db, "none", "app-12", posted.note);
  const seen = { needsYou: needsYou(thread()), noting: unposted === null ? noting() : "noted before the post" };
  record(db, "app-12", { noting: null });
  return seen;
};`;

// Each review asking for changes at the round limit needs you and brings the lead a note, while
// nobody has decided: the first time, and after sc start let it go on.
test("the round limit needs you and tells the lead, the first time and every time after", () => {
  const seen = inProcess(`${changesAsked}
db.run("UPDATE repositories SET forge = 'github'");
record(db, "app-12", { status: "waiting", rounds: 2, verdict: "changes", pr: 7 });
const within = changesAsked();
const first = changesAsked();
goOn(db, "none", "app-12");
const second = changesAsked();
console.log(JSON.stringify({ within, first, second }));`);
  expect(seen).toEqual({
    within: { needsYou: false, noting: null },
    first: { needsYou: true, noting: reachedNote },
    second: { needsYou: true, noting: reachedNote },
  });
});

// A merge armed before the limit was reached decided nothing about it, and nor does one armed at
// an earlier limit: each review that asks for changes at the limit asks anew.
test("a merge armed before a review reaches the round limit doesn't keep the lead from hearing", () => {
  const seen = inProcess(`${changesAsked}
db.run("UPDATE repositories SET forge = 'github'");
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", pr: 7 });
armMerge(db, "none", thread(), { asked: "merge app-12 when it's ready" }, false);
const armedBefore = changesAsked();
goOn(db, "none", "app-12");
const armedAtLastLimit = changesAsked();
console.log(JSON.stringify({ armedBefore, armedAtLastLimit, plan: thread().merge_plan }));`);
  expect(seen).toEqual({
    armedBefore: { needsYou: true, noting: reachedNote },
    armedAtLastLimit: { needsYou: true, noting: reachedNote },
    plan: "armed",
  });
});

// A builder waiting on its own background job, such as a test run, isn't stopped: its harness
// starts a turn again once the job ends. So it shows working and the lead hears nothing. A turn
// that ends with nothing left running shows turn ended at once.
test("a turn that ends with a background job still running isn't a stopped builder", () => {
  const seen = inProcess(`
turnEnded(db, "none", "app-12", { message: "The tests are still running.", background: true });
const running = { ended: thread().turn_ended, word: threadWord(thread(), 3) };
turnEnded(db, "none", "app-12", { message: "The tests failed. Should I skip the slow one?" });
console.log(JSON.stringify({ running, stopped: thread().turn_ended, word: threadWord(thread(), 3) }));`);
  expect(seen).toEqual({
    running: { ended: false, word: "working" },
    stopped: true,
    word: "turn ended",
  });
});
