// The inbox: the lead's items in Needs you, decided in a process of the test's own against its own
// database. Posting, replacing and answering items, what a pick lets the lead do, Skelcrew's own
// marks before and after an item, the notes an item holds back, and the needs-you code it took
// the place of staying gone. The last tests run sc and the daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DaemonRequest } from "../src/flow/requests.ts";
import { insideSandbox, read, runSkel, source, threadSql } from "./harness.ts";
import {
  addApp,
  asLead,
  data,
  env,
  home,
  lead,
  needsYou,
  needsYouFor,
  serve,
  setUp,
  skel,
  startApp12,
  tearDown,
  until,
  untilNeedsYou,
} from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

// Runs the code in a process of its own, with HOME set to the test's. The database is open as
// `db`, with simon/app and its thread app-12 working in it, and `thread()` reads app-12 back.
// `row(name)` is that row of app's list, `lines()` the list as drawn, without colours, and
// `notes()` what waits for the lead. Returns what the code printed last, as JSON.
function inProcess(body: string): Record<string, unknown> {
  const code = `import { openDb, marksToItems } from ${JSON.stringify(source("db.ts"))};
import { answerItem, clearItem, itemOf, postItem } from ${JSON.stringify(source("flow/inbox.ts"))};
import { noteLimit } from ${JSON.stringify(source("flow/round.ts"))};
import { readThread, record } from ${JSON.stringify(source("flow/thread.ts"))};
import { listRows, sectionHeadings, shownRows } from ${JSON.stringify(source("list/rows.ts"))};
import { drawRows } from ${JSON.stringify(source("list/layout.ts"))};
import { readTask, listThreads } from ${JSON.stringify(source("flow/list.ts"))};
import { readFileSync } from "node:fs";
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');
${threadSql({ task: "12", status: "working", title: "Add export" })}\`);
const thread = () => readThread(db, "app-12");
const open = { owner: "simon", repo: "app" };
const all = () => listRows(db, open, Date.now());
const row = (name) => all().find((r) => r.name === name);
const sections = new Set(["needs you", "task queue", "building", "reviewing", "checks", "backlog"]);
const drawn = () => {
  const rows = shownRows(all(), sections, true);
  return drawRows(rows, sectionHeadings(all(), sections), 0, 0, 60, 40);
};
const lines = () => drawn().lines.map((line) => Bun.stripANSI(line).trimEnd());
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

// The item the tests post: a decision with two options, the first recommended.
const asked = "T12 has gone 8 rounds. The race it was for is fixed.";
const options = `["force merge (recommended)", "keep going"]`;

test("the lead's item shows under Needs you with its text and options, and posting again replaces it", () => {
  const seen = inProcess(`
postItem(db, "app", "12", "first try", []);
const about = postItem(db, "app", "12", ${JSON.stringify(`${asked}\n`)}, ${options});
const shown = row("APP-12");
console.log(JSON.stringify({ about, section: shown.section, ask: shown.ask, count: db.query("SELECT COUNT(*) AS n FROM asks").get().n, lines: lines() }));`);
  expect(seen.about).toBe("APP-12");
  expect(seen.section).toBe("needs you");
  // The text is one line, however the lead wrote it.
  expect(seen.ask).toEqual({ text: asked, options: ["force merge (recommended)", "keep going"] });
  expect(seen.count).toBe(1);
  const drawn = (seen.lines as string[]).join("\n");
  expect(drawn).toContain("T12 has gone 8 rounds.");
  expect(drawn).toContain("a) force merge (recommended)");
  expect(drawn).toContain("b) keep going");
  expect(drawn).toContain("r) reply");
  expect(drawn).not.toContain("first try");
});

// A tap on an option's line answers with it, on a narrow screen as on a wide one.
test("each option's line answers with its letter when tapped", () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
const { lines: shown, targets } = drawn();
const picks = shown.flatMap((line, at) => {
  const target = targets[at];
  return target && "pick" in target ? [[Bun.stripANSI(line).trim(), target.pick]] : [];
});
console.log(JSON.stringify({ picks }));`);
  expect(seen.picks).toEqual([
    ["a) force merge (recommended)", "a"],
    ["b) keep going", "b"],
    ["r) reply", "reply"],
  ]);
});

test("your pick goes back to the lead as your words, and its file holds that option alone", async () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
const said = answerItem(db, "none", "app", "12", ${JSON.stringify(asked)}, { pick: "b" });
console.log(JSON.stringify({ said, notes: notes(), item: itemOf(db, "simon", "app", "12"), section: row("APP-12").section }));`);
  expect(seen.said).toBe("Told the lead your answer on APP-12.");
  expect(seen.item).toBe(null);
  expect(seen.section).toBe("building");
  const words = `You picked b (keep going) on APP-12: ${asked}`;
  const file = join(data(), "leads", "simon", "app", "answers", "app-12.txt");
  expect(seen.notes).toEqual([
    `${words}\n\nThese words are the human's: give --asked-file ${file} to what you run on this answer.`,
  ]);
  // The file lets the lead do only what you picked: the option you didn't pick isn't in it.
  const text = await Bun.file(file).text();
  expect(text).toBe(`${words}\n`);
  expect(text).not.toContain("force merge");
});

test("an item without options takes a reply in your own words", () => {
  const seen = inProcess(`
postItem(db, "app", "12", "Which export format do you want?", []);
answerItem(db, "none", "app", "12", "Which export format do you want?", { reply: "CSV, with a header row" });
console.log(JSON.stringify({ notes: notes() }));`);
  expect(seen.notes).toEqual([
    expect.stringContaining(
      "You replied on APP-12: CSV, with a header row\n\nThe item was: Which export format do you want?",
    ),
  ]);
});

test("an answer is refused for a letter the item lacks, or for an item the lead replaced", () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
const tried = (seen, answer) => { try { answerItem(db, "none", "app", "12", seen, answer); return "answered"; } catch (error) { return error.message; } };
const letter = tried(${JSON.stringify(asked)}, { pick: "c" });
postItem(db, "app", "12", "Merge it now?", ["yes", "no"]);
const replaced = tried(${JSON.stringify(asked)}, { pick: "a" });
console.log(JSON.stringify({ letter, replaced, notes: notes(), item: itemOf(db, "simon", "app", "12").text }));`);
  expect(seen).toEqual({
    letter: "APP-12's item has no option c",
    replaced: "the lead changed its item on APP-12 as you answered, so read it again",
    notes: [],
    item: "Merge it now?",
  });
});

// Skelcrew marks a thread at once for what it sees itself, and the lead then decides whether to
// ask you. Until it does, the row says the lead is looking. Once it posts, only the item shows.
test("Skelcrew's mark shows the lead is looking, until the lead's item takes its place", () => {
  const seen = inProcess(`
record(db, "app-12", { asking: true });
const before = { section: row("APP-12").section, says: row("APP-12").says, lines: lines() };
postItem(db, "app", "12", "Should the export include archived rows?", ["yes", "no"]);
console.log(JSON.stringify({ before, after: lines() }));`);
  const before = seen.before as { section: string; says: string; lines: string[] };
  expect(before.section).toBe("needs you");
  expect(before.says).toBe("question");
  expect(before.lines.join("\n")).toContain("question · the lead is looking at this");
  const after = (seen.after as string[]).join("\n");
  expect(after).toContain("Should the export include archived rows?");
  expect(after).not.toContain("the lead is looking at this");
});

test("a builder that stops without submitting shows under Needs you at once", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", turn_ended: true });
console.log(JSON.stringify({ section: row("APP-12").section, says: row("APP-12").says }));`);
  expect(seen).toEqual({ section: "needs you", says: "turn ended" });
});

// The lead already asks you, so hearing the thread needs you for the same thing again would only
// make it repeat the question. A new review round is news, so it still reaches the lead, as does a
// question its builder asks.
test("while an item is open, the round limit brings no note, but a new round and a question do", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it." });
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
record(db, "app-12", { needs_you: true }, "changes asked for after 3 rounds of changes, so the round limit is reached");
const limit = thread().noting;
noteLimit(db, "none", "app-12", "a new review asked for changes past the round limit");
const round = thread().noting;
record(db, "app-12", { noting: null, needs_you: false });
record(db, "app-12", { asking: true }, "its builder asked a question");
console.log(JSON.stringify({ limit, round, question: thread().noting }));`);
  expect(seen).toEqual({
    limit: null,
    round: "a new review asked for changes past the round limit",
    question: "its builder asked a question",
  });
});

test("an item goes when its thread ends, and the lead can take one off", () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
record(db, "app-12", { status: "done" });
const ended = itemOf(db, "simon", "app", "12");
postItem(db, "app", null, "Add simon/web too?", ["yes", "no"]);
const about = clearItem(db, "app", null);
const done = (() => { try { postItem(db, "app", "12", "Again?", []); return "posted"; } catch (error) { return error.message; } })();
console.log(JSON.stringify({ ended, about, left: db.query("SELECT COUNT(*) AS n FROM asks").get().n, done }));`);
  expect(seen).toEqual({ ended: null, about: "app", left: 0, done: "APP-12 is done already" });
});

// What sc ask start and sc ask repo add once asked with y or n is an item with yes and no now: one
// about a task not started yet, or about the repository itself.
test("a yes or no proposal is an item, on a task not started or on the repository", () => {
  const seen = inProcess(`
db.run("INSERT INTO backlog (owner, repo, task, title, body, created, by, filed_commit) VALUES ('simon', 'app', 't3', 'Dark mode', 'Add it', '2026-11-22T10:00:00Z', 'simon', 'c')");
postItem(db, "app", "t3", "Start APP-T3, Dark mode?", ["yes", "no"]);
postItem(db, "app", null, "Add simon/web, which the export calls?", ["yes", "no"]);
const task = row("APP-T3");
const repository = row("ask");
answerItem(db, "none", "app", "t3", "Start APP-T3, Dark mode?", { pick: "a" });
console.log(JSON.stringify({
  task: { section: task.section, part: task.part, ask: task.ask, starts: task.start !== null },
  repository: { section: repository.section, label: repository.label, ask: repository.ask },
  notes: notes(),
}));`);
  expect(seen.task).toEqual({
    section: "needs you",
    part: "backlog",
    ask: { text: "Start APP-T3, Dark mode?", options: ["yes", "no"] },
    starts: true,
  });
  expect(seen.repository).toEqual({
    section: "needs you",
    label: "app",
    ask: { text: "Add simon/web, which the export calls?", options: ["yes", "no"] },
  });
  expect(seen.notes).toEqual([
    expect.stringContaining("You picked a (yes) on APP-T3: Start APP-T3, Dark mode?"),
  ]);
});

// Each item waits on you, whatever its thread shows, so its row's mark is filled and the
// repository's tab counts it, on a thread, a task not started or the repository itself.
test("an item fills its row's mark, and the repository's tab counts each one", () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
postItem(db, "app", "t3", "Start APP-T3?", ["yes", "no"]);
postItem(db, "app", null, "Add simon/web?", ["yes", "no"]);
const { repositoryTabs } = await import(${JSON.stringify(source("list/rows.ts"))});
console.log(JSON.stringify({ mark: row("APP-12").mark, tab: repositoryTabs(db, null)[0] }));`);
  expect(seen).toEqual({
    mark: { sign: "●", colour: "yellow" },
    tab: { name: "app", fullName: "simon/app", needYou: 3, colour: "yellow", ready: 0 },
  });
});

test("sc ps and sc show say an item waits, and sc show gives its text and options", () => {
  const seen = inProcess(`
postItem(db, "app", "12", ${JSON.stringify(asked)}, ${options});
const ps = listThreads(db, "app")[0];
const show = readTask(db, { repo: "app", task: "12" });
console.log(JSON.stringify({ ps: { needsYou: ps.needsYou, needsYouFor: ps.needsYouFor }, item: show.item }));`);
  expect(seen).toEqual({
    ps: { needsYou: true, needsYouFor: "item waits" },
    item: { text: asked, options: ["force merge (recommended)", "keep going"] },
  });
});

// Marks the lead, you or the safety net set before the inbox still ask something of you, so they
// move into it as items. A missing host plugin's instruction stays the thread's mark.
test("marks from before the inbox move into it as items", () => {
  const seen = inProcess(`
db.run(\`${threadSql({ task: "13", status: "waiting" })}\`);
record(db, "app-12", { needs_you_for: "apply the check.yml split in PR #463" });
record(db, "app-13", { needs_you_for: "run sc install: its session host herdr is missing, then check the design" });
marksToItems(db);
const items = db.query("SELECT task, text, options FROM asks ORDER BY task").all();
const marks = db.query("SELECT task || '' AS task, needs_you_for FROM task_threads ORDER BY task").all();
console.log(JSON.stringify({ items, marks }));`);
  expect(seen).toEqual({
    items: [
      { task: "12", text: "apply the check.yml split in PR #463", options: "[]" },
      { task: "13", text: "check the design", options: "[]" },
    ],
    marks: [
      { task: "12", needs_you_for: null },
      { task: "13", needs_you_for: "run sc install: its session host herdr is missing" },
    ],
  });
});

test("sc needs-you is gone, and says to ask with sc ask", async () => {
  const run = await runSkel(["needs-you", "app-12", "check the design"], env());
  expect(run.code).not.toBe(0);
  expect(run.err).toContain("sc needs-you is gone");
  expect(run.err).toContain("sc ask");
  const help = await runSkel(["--help"], env());
  expect(help.out).not.toContain("needs-you");
  expect(help.out).toContain("ask <task>");
  // The daemon no longer knows the request.
  const old = { command: "needs you", repo: "app", task: "12", reason: "check the design" };
  expect(DaemonRequest.safeParse(old).success).toBe(false);
});

test("only the lead posts an item, and only you answer one", async () => {
  serve();
  await until(() => existsSync(join(home, "run", "skelcrew.sock")));
  await Bun.sleep(100);
  const posted = await skel(["ask", "app-12", "Ship it?", "--option", "yes"]);
  expect(posted.code).not.toBe(0);
  expect(posted.err).toContain("doesn't know that request");
});

// bubblewrap can't start inside Skelcrew's own sandbox, so only there the lead can't start.
describe.skipIf(insideSandbox)("the inbox, with a running daemon", () => {
  test("the lead posts with sc ask, sc ps says an item waits, and your pick reaches the lead", async () => {
    addApp();
    await startApp12();
    const posted = await asLead([
      "ask",
      "app-12",
      asked,
      "--option",
      "force merge",
      "--option",
      "keep going",
    ]);
    expect(posted.err).toBe("");
    expect(posted.out).toContain("Asked the human about APP-12.");
    await untilNeedsYou(true);
    expect(await needsYouFor()).toBe("item waits");
    expect((await skel(["show", "app-12"])).out).toContain("a) force merge");
    const code = `import { answerItem } from ${JSON.stringify(source("client.ts"))};
console.log(await answerItem("simon/app", "12", ${JSON.stringify(asked)}, { pick: "a" }));`;
    const answered = Bun.spawnSync([process.execPath, "-e", code], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(answered.stderr.toString()).toBe("");
    expect(answered.stdout.toString()).toContain("Told the lead your answer on APP-12.");
    await until(() => read(join(lead(), "typed")).includes("You picked a (force merge) on APP-12"));
    expect(await needsYou()).toBe(false);
    // The lead takes an item off with --clear.
    await asLead(["ask", "app-12", "Ship it?", "--option", "yes"]);
    await untilNeedsYou(true);
    expect((await asLead(["ask", "--clear", "app-12"])).out).toContain(
      "Took the item on APP-12 off.",
    );
    await untilNeedsYou(false);
  }, 60_000);
});
