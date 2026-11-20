// Needs you, decided in a process of the test's own against its own database: the marks you and
// the lead set, the round limit and the safety net. Also that only an agent's hooks can say it
// asks a question or stopped. The needsyou-*.test.ts files check the rest against a running daemon.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { read, source, threadSql } from "./harness.ts";
import { data, home, serve, setUp, skel, tearDown, until } from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

test("only an agent's hooks can say it is asking you a question, stopped, or stopped on an error", async () => {
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
  for (const args of [
    ["question", "asked"],
    ["question", "answered"],
    ["turn", "failed"],
    ["turn", "ended"],
    ["question", "closed"],
    ["turn", "interrupted"],
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
import { markForgotten, markNeedsYou, needsYou, needsYouFor, questionAnswered, threadWord, turnEnded } from ${JSON.stringify(source("flow/status.ts"))};
import { goOn, submitRound } from ${JSON.stringify(source("flow/round.ts"))};
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

// The thread's log, where every mark and clear says who did it and why.
const threadLog = () => read(join(data(), "threads", "app-12.log"));

test("the lead's mark needs you with its words and brings no note, and clearing it is logged", () => {
  const seen = inProcess(`
const action = "apply the check.yml split in PR #463";
markNeedsYou(db, "none", thread(), "\\u0007" + action + "\\n", "lead");
const marked = { needsYou: needsYou(thread()), word: needsYouFor(thread()), noting: noting() };
markNeedsYou(db, "none", thread(), null, "lead");
console.log(JSON.stringify({ marked, cleared: needsYou(thread()) }));`);
  // The mark is one line, with no control codes, as the lists show it.
  expect(seen.marked).toEqual({
    needsYou: true,
    word: "apply the check.yml split in PR #463",
    noting: null,
  });
  expect(seen.cleared).toBe(false);
  expect(threadLog()).toContain("the lead marked it: apply the check.yml split in PR #463");
  expect(threadLog()).toContain(
    "the lead cleared its needs you: apply the check.yml split in PR #463",
  );
});

test("your mark tells the lead, as the lead can't see your terminal", () => {
  const seen = inProcess(`
markNeedsYou(db, "none", thread(), "check the new design", "you");
const first = { noting: noting(), notes: notes() };
// A thread that needed you already, such as at its round limit, still brings the lead a note.
record(db, "app-12", { needs_you_for: null, asking: true });
markNeedsYou(db, "none", thread(), "pick the export format", "you");
console.log(JSON.stringify({ first, notes: notes() }));`);
  expect(seen).toEqual({
    first: { noting: null, notes: ["APP-12 needs you: you marked it: check the new design"] },
    notes: [
      "APP-12 needs you: you marked it: check the new design",
      "APP-12 needs you: you marked it: pick the export format",
    ],
  });
  expect(threadLog()).toContain("you marked it: check the new design");
});

test("a mark clears when you type to the builder, and only when the harness says what was typed", () => {
  const seen = inProcess(`
markNeedsYou(db, "none", thread(), "say which format", "lead");
questionAnswered(db, "app-12");
const unknown = needsYou(thread());
questionAnswered(db, "app-12", "JSON, please.");
console.log(JSON.stringify({ unknown, typed: needsYou(thread()) }));`);
  expect(seen).toEqual({ unknown: true, typed: false });
  expect(threadLog()).toContain("you typed to its builder");
});

test("clearing the round limit is a decision: it no longer needs you, until the next review", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", held: "Fix it." });
const before = needsYouFor(thread());
markNeedsYou(db, "none", thread(), null, "lead");
const after = { needsYou: needsYou(thread()), word: threadWord(thread(), 3), decided: thread().limit_decided };
console.log(JSON.stringify({ before, after }));`);
  expect(seen).toEqual({
    before: "round limit",
    after: { needsYou: false, word: "round limit", decided: true },
  });
  expect(threadLog()).toContain("the lead cleared its needs you: the round limit");
});

// Marking a thread past its round limit is the lead's decision about it, so once you type to the
// builder and the mark clears, the round limit doesn't need you again.
test("marking a thread past its round limit decides it, so clearing the mark leaves it decided", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", held: "Fix it." });
markNeedsYou(db, "none", thread(), "say whether to go on past the limit", "lead");
const decided = thread().limit_decided;
questionAnswered(db, "app-12", "Go on.");
console.log(JSON.stringify({ decided, needsYou: needsYou(thread()) }));`);
  expect(seen).toEqual({ decided: true, needsYou: false });
});

// A question open past the round limit hides the limit's word, but marking or clearing the
// thread still decides the limit, so it doesn't come back once the question is answered.
test("clearing a thread past its round limit decides it, though a question was open too", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", needs_you: true, rounds: 4, verdict: "changes", held: "Fix it.", asking: true });
markNeedsYou(db, "none", thread(), null, "lead");
questionAnswered(db, "app-12", "Go on.");
console.log(JSON.stringify({ decided: thread().limit_decided, needsYou: needsYou(thread()) }));`);
  expect(seen).toEqual({ decided: true, needsYou: false });
});

// The lead's own mark is still owed once you install the plugin, so the instruction goes first
// and keeps it, however often the engine starts while the plugin is gone.
test("a missing host plugin puts its instruction before the lead's mark, once", () => {
  const seen = inProcess(`
record(db, "app-12", { session: "s", host: "gone", host_id: "gone-app-12", needs_you_for: "apply the fix in #463" });
await bringBack(db, "none", thread());
await bringBack(db, "none", thread());
console.log(JSON.stringify({ mark: thread().needs_you_for, notes: notes() }));`);
  const mark = "run sc install: its session host gone is missing, then apply the fix in #463";
  // The thread needed you already, so the lead hears of the plugin in a note of its own, once.
  expect(seen).toEqual({ mark, notes: [`APP-12 needs you: ${mark}`] });
});

// Only you can bring the plugin back, so the lead's marks and clears can't hide that.
test("while the host plugin is missing, a mark or a clear keeps its instruction first", () => {
  const seen = inProcess(`
record(db, "app-12", { session: "s", host: "gone", host_id: "gone-app-12" });
await bringBack(db, "none", thread());
markNeedsYou(db, "none", thread(), "check the design", "lead");
const marked = thread().needs_you_for;
markNeedsYou(db, "none", thread(), null, "lead");
console.log(JSON.stringify({ marked, cleared: thread().needs_you_for }));`);
  expect(seen).toEqual({
    marked: "run sc install: its session host gone is missing, then check the design",
    cleared: "run sc install: its session host gone is missing",
  });
});

// A release before this one had a failed review need you. The lead can run it again, so once
// upgraded it shows as failed without needing you. One past the round limit still needs you.
test("an upgrade moves a failed review off needing you, but not one past the round limit", () => {
  const seen = inProcess(`
db.run(\`${threadSql({ task: "13", status: "waiting" })}\`);
db.run("UPDATE threads SET needs_you = 1");
db.run("UPDATE tasks SET verdict = 'failed'");
db.run("UPDATE tasks SET held = 'Fix it.' WHERE task = '13'");
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
markNeedsYou(db, "none", thread(), "say whether to go on", "lead");
await bringBack(db, "none", thread());
goOn(db, "none", "app-12");
console.log(JSON.stringify({ mark: thread().needs_you_for, rounds: thread().rounds }));`);
  expect(seen).toEqual({ mark: "run sc install: its session host gone is missing", rounds: 0 });
});

test("a new submit clears the mark", () => {
  const seen = inProcess(`
markNeedsYou(db, "none", thread(), "say which format", "lead");
submitRound(db, "none", "app-12", "Round 2");
console.log(JSON.stringify({ mark: thread().needs_you_for }));`);
  expect(seen).toEqual({ mark: null });
  // The log says what cleared it, as it does for every mark that clears on its own.
  expect(threadLog()).toContain("submitted: Round 2, which cleared its mark: say which format");
});

// The lead hears of a builder that stopped, but may be busy or miss it, so nothing waits unseen.
test("the safety net marks a stopped builder nobody acted on, with its last message, once the grace is over", () => {
  const seen = inProcess(`
turnEnded(db, "none", "app-12", { message: "Should I delete\\nthe old exports?" });
const ended = thread().ended_at;
markForgotten(db, "none", 5, ended + 4 * 60_000);
const early = needsYou(thread());
markForgotten(db, "none", 5, ended + 5 * 60_000);
console.log(JSON.stringify({ early, word: needsYouFor(thread()), noting: noting() }));`);
  expect(seen).toEqual({
    early: false,
    word: "Should I delete the old exports?",
    noting: "nobody acted on its stopped builder for 5 minutes: Should I delete the old exports?",
  });
});

// Waiting on a review or CI never needs you. The builder's words went to the lead, which marks
// the thread when only you can act, so the safety net is only for a builder with nothing in
// flight. Its wait starts once the review is over, if nobody acted by then.
test("the safety net waits out a review a turn that only replied ended during, then starts", () => {
  const seen = inProcess(`
const clone = cloneDir("simon", "app");
mkdirSync(clone, { recursive: true });
const git = (...args) => Bun.spawnSync(["git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "round 1");
git("update-ref", "refs/skelcrew/threads/app-12", "HEAD");
const head = git("rev-parse", "HEAD");
record(db, "app-12", { status: "waiting", reviewing: head });
turnEnded(db, "none", "app-12", { head, message: "Only a person can push the workflow change." });
const hour = Date.now() + 60 * 60_000;
markForgotten(db, "none", 5, hour);
const reviewed = needsYou(thread());
// The review fails an hour later, and leaves the builder stopped with nothing in flight.
record(db, "app-12", { reviewing: null, verdict: "failed", review_failed: true });
markForgotten(db, "none", 5, hour + 4 * 60_000);
const early = needsYou(thread());
markForgotten(db, "none", 5, hour + 5 * 60_000);
console.log(JSON.stringify({ reviewed, early, word: needsYouFor(thread()) }));`);
  expect(seen).toEqual({
    reviewed: false,
    early: false,
    word: "Only a person can push the workflow change.",
  });
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

// A turn that left work it didn't submit shows turn ended, but its last submit is still reviewed,
// so nothing waits on you yet, however long the review takes.
test("the safety net doesn't mark while the last submit is reviewed, even with work left over", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", reviewing: "abc" });
turnEnded(db, "none", "app-12", { message: "I started on the next part." });
markForgotten(db, "none", 5, Date.now() + 60 * 60_000);
console.log(JSON.stringify({ turnEnded: thread().turn_ended, needsYou: needsYou(thread()) }));`);
  expect(seen).toEqual({ turnEnded: true, needsYou: false });
});

// A submit still being pushed is on its way, so the builder stopping meanwhile waits on it.
test("the safety net doesn't mark while the last submit is still being pushed, until its round fails", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", submitting: "Round 2" });
turnEnded(db, "none", "app-12", { message: "Pushed it." });
const hour = Date.now() + 60 * 60_000;
markForgotten(db, "none", 5, hour);
const pushing = needsYou(thread());
// A round that failed keeps its submit saved, but is on its way no longer.
record(db, "app-12", { review_failed: true });
markForgotten(db, "none", 5, hour + 5 * 60_000);
console.log(JSON.stringify({ pushing, word: needsYouFor(thread()) }));`);
  expect(seen).toEqual({ pushing: false, word: "Pushed it." });
});

// A thread ready to merge is seen already, so a builder's reply there marks nothing.
test("the safety net leaves a thread that already needs you as it is", () => {
  const seen = inProcess(`
record(db, "app-12", { asking: true });
turnEnded(db, "none", "app-12", { message: "Thanks." });
record(db, "app-12", { ended_at: Date.now(), ended_said: "Thanks." });
markForgotten(db, "none", 5, Date.now() + 60 * 60_000);
console.log(JSON.stringify({ mark: thread().needs_you_for, ended: thread().ended_at }));`);
  expect(seen).toEqual({ mark: null, ended: null });
});

test("telling the builder or clearing it in time keeps the safety net from marking it", () => {
  const seen = inProcess(`
turnEnded(db, "none", "app-12", { message: "Delete the old exports?" });
questionAnswered(db, "app-12");
markForgotten(db, "none", 5, Date.now() + 60 * 60_000);
const told = needsYou(thread());
turnEnded(db, "none", "app-12", { message: "Done. Anything else?" });
markNeedsYou(db, "none", thread(), null, "lead");
markForgotten(db, "none", 5, Date.now() + 60 * 60_000);
console.log(JSON.stringify({ told, cleared: needsYou(thread()), ended: thread().turn_ended }));`);
  expect(seen).toEqual({ told: false, cleared: false, ended: true });
});
