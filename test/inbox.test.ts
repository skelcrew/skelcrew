// The inbox: the lead's items in Needs you, decided in a process of the test's own against its own
// database. Posting, replacing and answering items, what a pick lets the lead do, Skelcrew's own
// marks before and after an item, the notes an item holds back, and the needs-you code it took
// the place of staying gone. The last tests run sc and the daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DaemonRequest } from "../src/flow/requests.ts";
import { red } from "../src/screen/look.ts";
import { insideSandbox, itemSql, read, runSkel, source, threadSql } from "./harness.ts";
import {
  addApp,
  asLead,
  data,
  env,
  home,
  hook,
  lead,
  needsYou,
  needsYouFor,
  serve,
  setUp,
  skel,
  socket,
  sql,
  startApp12,
  tearDown,
  thread,
  until,
  untilNeedsYou,
} from "./needsyou.ts";

beforeEach(setUp);
afterEach(tearDown);

// Runs the code in a process of its own, with HOME set to the test's. The database is open as
// `db`, with simon/app and its thread app-12 working in it, and `thread()` reads app-12 back.
// `row(name)` is that row of app's list, `lines()` the list as drawn, without colours,
// `notes()` what waits for the lead, and `asSeen(task)` that task's item as the list shows it. Returns what the code printed last, as JSON.
function inProcess(body: string): Record<string, unknown> {
  const code = `import { openDb, marksToItems } from ${JSON.stringify(source("db.ts"))};
import { answerItem, clearItem, itemOf, pickOwnItem, postItem } from ${JSON.stringify(source("flow/inbox.ts"))};
import { noteLimit } from ${JSON.stringify(source("flow/round.ts"))};
import { verdictReached } from ${JSON.stringify(source("flow/ledger.ts"))};
import { turnEnded } from ${JSON.stringify(source("flow/status.ts"))};
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
const ask = (repository, task, text, options, title) => postItem(db, repository, task, { title, text, options });
const asSeen = (task) => { const { title, text, options } = itemOf(db, "simon", "app", task); return { title, text, options }; };
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

test("the lead's item shows under Needs you by its title and how many options it has, and posting again replaces it", () => {
  const seen = inProcess(`
ask("app", "t12", "first try", ["yes", "no"]);
const about = ask("app", "t12", ${JSON.stringify(`${asked}\n`)}, ${options}, "Force merge T12?");
const shown = row("APP-12");
console.log(JSON.stringify({ about, section: shown.section, ask: shown.ask, count: db.query("SELECT COUNT(*) AS n FROM asks").get().n, lines: lines() }));`);
  expect(seen.about).toBe("APP-12");
  expect(seen.section).toBe("needs you");
  // The text is one line, however the lead wrote it.
  expect(seen.ask).toEqual({
    title: "Force merge T12?",
    text: asked,
    options: ["force merge (recommended)", "keep going"],
    acts: null,
  });
  expect(seen.count).toBe(1);
  const drawn = (seen.lines as string[]).join("\n");
  expect(drawn).toContain("12  Add export");
  expect(drawn).toContain("Force merge T12? · 2 options");
  expect(drawn).not.toContain("T12 has gone 8 rounds.");
  expect(drawn).not.toContain("a) force merge");
  expect(drawn).not.toContain("first try");
});

// An item posted without a title takes its text's first few words, cut at a word boundary.
test("an item without a title takes its first few words as its title", () => {
  const seen = inProcess(`
ask("app", "t12", "Should the export include archived rows from last year?", ["yes", "no"]);
console.log(JSON.stringify({ title: row("APP-12").ask.title, lines: lines() }));`);
  expect(seen.title).toBe("Should the export include…");
  expect((seen.lines as string[]).join("\n")).toContain("Should the export include… · y/n");
});

// The human can always act, so an item needs options, and a yes or no question has its own flag.
test("an item without at least two options is refused", () => {
  const seen = inProcess(`
const tried = (options) => { try { ask("app", "t12", "Which export format?", options); return "posted"; } catch (error) { return error.message; } };
console.log(JSON.stringify({ none: tried([]), one: tried(["CSV"]), left: db.query("SELECT COUNT(*) AS n FROM asks").get().n }));`);
  const refused =
    "give Simon at least two options to pick from with --option, or ask a yes/no question with --yes-no";
  expect(seen).toEqual({ none: refused, one: refused, left: 0 });
});

// An item saved before every item had options still lets you act on it, with yes and no.
test("an item stored without options shows yes and no", () => {
  const seen = inProcess(`
db.run("INSERT INTO asks (owner, repo, task, text, options, posted) VALUES ('simon', 'app', 't12', 'Check the design?', '[]', 0)");
console.log(JSON.stringify({ ask: row("APP-12").ask, said: answerItem(db, "none", "app", "t12", asSeen("t12"), { pick: "a" }), notes: notes() }));`);
  expect(seen.ask).toEqual({
    title: "Check the design?",
    text: "Check the design?",
    options: ["yes", "no"],
    acts: null,
  });
  expect(seen.notes).toEqual([
    expect.stringContaining("You picked a (yes) on APP-12: Check the design?"),
  ]);
});

// A tap on an option's line of the opened item answers with it, on a narrow screen as on a wide
// one. The row in the sidebar answers nothing, as it shows no options.
test("each option's line answers with its letter when tapped", () => {
  const seen = inProcess(`
const { drawItem } = await import(${JSON.stringify(source("list/layout.ts"))});
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.name === "APP-12");
const onRow = drawn().targets.some((target) => target && "pick" in target);
const { lines: shown, targets } = drawItem(rows[at], at, 60, 30, 0);
const picks = shown.flatMap((line, at) => {
  const target = targets[at];
  return target && "pick" in target ? [[Bun.stripANSI(line).replace(/│/g, "").trim(), target.pick]] : [];
});
console.log(JSON.stringify({ picks, onRow }));`);
  expect(seen.onRow).toBe(false);
  expect(seen.picks).toEqual([
    ["a) force merge (recommended)", "a"],
    ["b) keep going", "b"],
    ["r) reply", "reply"],
  ]);
});

test("your pick goes back to the lead as your words, and its file holds that option alone", async () => {
  const seen = inProcess(`
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const said = answerItem(db, "none", "app", "t12", asSeen("t12"), { pick: "b" });
console.log(JSON.stringify({ said, notes: notes(), item: itemOf(db, "simon", "app", "t12"), section: row("APP-12").section }));`);
  expect(seen.said).toBe("Told the lead your answer on APP-12.");
  expect(seen.item).toBe(null);
  expect(seen.section).toBe("building");
  const words = `You picked b (keep going) on APP-12: ${asked}`;
  const notes = seen.notes as string[];
  expect(notes).toHaveLength(1);
  const file = /--asked-file (\S+) /.exec(notes[0] ?? "")?.[1] ?? "";
  expect(file.startsWith(join(data(), "leads", "simon", "app", "answers", "app-12-"))).toBe(true);
  expect(notes[0]).toBe(
    `${words}\n\nThese words are Simon's: give --asked-file ${file} to what you run on this answer.`,
  );
  // The file lets the lead do only what you picked: the option you didn't pick isn't in it.
  const text = await Bun.file(file).text();
  expect(text).toBe(`${words}\n`);
  expect(text).not.toContain("force merge");
});

// The lead may still be about to act on the first answer when the second comes, so the second
// never changes the words the first note points to.
test("each answer keeps its own file, so a later one never changes an earlier one's words", async () => {
  const seen = inProcess(`
ask("app", "t12", "Merge it now?", ["yes", "no"]);
answerItem(db, "none", "app", "t12", asSeen("t12"), { pick: "a" });
ask("app", "t12", "Drop the old exports?", ["yes", "no"]);
answerItem(db, "none", "app", "t12", asSeen("t12"), { pick: "b" });
console.log(JSON.stringify({ notes: notes() }));`);
  const files = (seen.notes as string[]).map((note) => /--asked-file (\S+) /.exec(note)?.[1] ?? "");
  expect(new Set(files).size).toBe(2);
  expect(await Bun.file(files[0] ?? "").text()).toBe(
    "You picked a (yes) on APP-12: Merge it now?\n",
  );
  expect(await Bun.file(files[1] ?? "").text()).toBe(
    "You picked b (no) on APP-12: Drop the old exports?\n",
  );
});

test("an item takes a reply in your own words too", () => {
  const seen = inProcess(`
ask("app", "t12", "Which export format do you want?", ["CSV", "JSON"]);
answerItem(db, "none", "app", "t12", asSeen("t12"), { reply: "CSV, with a header row" });
console.log(JSON.stringify({ notes: notes() }));`);
  expect(seen.notes).toEqual([
    expect.stringContaining(
      "You replied on APP-12: CSV, with a header row\n\nThe item was: Which export format do you want?",
    ),
  ]);
});

// A letter picks what it showed beside it, so an item replaced with the same text but other
// options, or the same ones in another order, is refused too.
test("an answer is refused for a letter the item lacks, or for an item the lead replaced or retitled", () => {
  const seen = inProcess(`
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const before = asSeen("t12");
const tried = (seen, answer) => { try { answerItem(db, "none", "app", "t12", seen, answer); return "answered"; } catch (error) { return error.message; } };
const letter = tried(before, { pick: "c" });
ask("app", "t12", ${JSON.stringify(asked)}, ["keep going", "force merge (recommended)"]);
const reordered = tried(before, { pick: "a" });
ask("app", "t12", ${JSON.stringify(asked)}, ${options}, "Another title");
const retitled = tried(before, { pick: "a" });
ask("app", "t12", "Merge it now?", ["yes", "no"]);
const replaced = tried(before, { pick: "a" });
console.log(JSON.stringify({ letter, reordered, retitled, replaced, notes: notes(), item: itemOf(db, "simon", "app", "t12").text }));`);
  const changed = "the lead changed its item on APP-12 as you answered, so read it again";
  expect(seen).toEqual({
    letter: "APP-12's item has no option c",
    reordered: changed,
    retitled: changed,
    replaced: changed,
    notes: [],
    item: "Merge it now?",
  });
});

// Skelcrew marks a thread at once for what it sees itself, as an item of its own with options,
// never a bare reason. Once the lead posts, only the lead's item shows.
test("Skelcrew's own item shows with its options, until the lead's item takes its place", () => {
  const seen = inProcess(`
record(db, "app-12", { asking: true, said: "Should the export include archived rows?" });
const before = { section: row("APP-12").section, ask: row("APP-12").ask, lines: lines() };
ask("app", "t12", "Should the export include archived rows?", ["yes", "no"], "Archived rows?");
console.log(JSON.stringify({ before, after: lines() }));`);
  const before = seen.before as { section: string; ask: unknown; lines: string[] };
  expect(before.section).toBe("needs you");
  expect(before.ask).toEqual({
    title: "Its builder asked a question",
    text: "Should the export include archived rows?",
    options: ["Open the builder", "Let the lead handle it"],
    acts: ["open", "lead"],
  });
  expect(before.lines.join("\n")).toContain("Its builder asked a question · 2 options");
  const after = (seen.after as string[]).join("\n");
  expect(after).toContain("Archived rows? · y/n");
  expect(after).not.toContain("Its builder asked a question");
});

// Each thing Skelcrew marks itself is an item whose options act directly: each pick runs what its
// command would, and the lead hears the pick as your words. Letting the lead handle it, or not
// merging yet, hands the item to the lead, so it leaves Needs you until something new comes.
test("each of Skelcrew's own items runs its options", () => {
  const seen = inProcess(`
const marks = {
  "round limit": { status: "waiting", rounds: 8, verdict: "changes", held: "Fix it.", needs_you: true, review_findings: ["Handle an empty file", "Test the error"] },
  ready: { status: "waiting", verdict: "approve", needs_you: true, reviewed_commit: "abcdef1234567890" },
  question: { asking: true, said: "CSV or JSON?" },
  "turn ended": { turn_ended: true, said: "I am stuck on the login." },
  error: { erred: true, said: "OAuth token has expired" },
  host: { host: "herdr", needs_you_for: "run sc install: its session host herdr is missing" },
};
const fresh = { status: "working", rounds: 0, verdict: null, held: null, needs_you: false, review_findings: null, reviewed_commit: null, asking: false, turn_ended: false, erred: false, said: null, host: "tmux", needs_you_for: null, handed: null };
const out = {};
for (const [kind, mark] of Object.entries(marks)) {
  record(db, "app-12", { ...fresh, ...mark });
  const item = row("APP-12").ask;
  const ran = [];
  for (const pick of ["a", "b", "c"].slice(0, item.options.length)) {
    record(db, "app-12", { handed: null });
    db.run("DELETE FROM notes");
    const said = await pickOwnItem(db, "none", "app", "t12", item, pick, async (act) => "did " + act);
    ran.push({ said, note: notes()[0], shows: row("APP-12").section });
  }
  out[kind] = { title: item.title, text: item.text, options: item.options, ran };
}
console.log(JSON.stringify(out));`);
  const ran = (kind: string) =>
    (seen[kind] as { ran: { said: string }[] }).ran.map((pick) => pick.said);
  expect(seen["round limit"]).toMatchObject({
    title: "Review still wants changes after 8 rounds",
    text: "The latest review asks:\n1. Handle an empty file\n2. Test the error",
    options: ["Go on: fix the findings", "Merge without approval", "Stop the builder"],
  });
  expect(ran("round limit")).toEqual(["did go on", "did skip review", "did stop"]);
  expect(seen.ready).toMatchObject({
    title: "Ready to merge",
    text: "Its branch is ready at abcdef1.",
    options: ["Merge it", "Not yet"],
  });
  expect(ran("ready")).toEqual(["did merge", "Handed APP-12 to the lead."]);
  expect(seen.question).toMatchObject({
    title: "Its builder asked a question",
    text: "CSV or JSON?",
    options: ["Open the builder", "Let the lead handle it"],
  });
  expect(seen["turn ended"]).toMatchObject({
    title: "Its builder stopped without submitting",
    text: "I am stuck on the login.",
    options: ["Open the builder", "Let the lead handle it"],
  });
  expect(ran("turn ended")).toEqual(["did open", "Handed APP-12 to the lead."]);
  expect(seen.error).toMatchObject({
    title: "Its harness stopped on an error",
    text: "OAuth token has expired",
    options: ["Start it again", "Open the builder"],
  });
  expect(ran("error")[0]).toBe("did restart");
  expect(seen.host).toMatchObject({
    title: "Its session host is missing",
    options: ["Start it again", "Open the builder"],
  });
  expect(ran("host")[0]).toBe("did restart");
  // Each pick reaches the lead as your words, and a hand-off takes the item out of Needs you.
  const question = (seen.question as { ran: { note: string; shows: string }[] }).ran;
  expect(question[1]?.note).toBe(
    "You picked b (Let the lead handle it) on APP-12: Its builder asked a question\n\nCSV or JSON?",
  );
  expect(question[1]?.shows).toBe("building");
  const limit = (seen["round limit"] as { ran: { note: string; shows: string }[] }).ran;
  expect(limit[2]?.note).toContain("You picked c (Stop the builder) on APP-12");
  expect(limit[2]?.shows).toBe("needs you");
});

// A pick that runs a command is your decision on the task, kept in your words as sc decide
// --asked-file keeps one, so later reviewers see it. Restarting, opening the builder and handing
// the item to the lead decide nothing.
test("a pick on Skelcrew's own item that runs a command is recorded as your decision", () => {
  const seen = inProcess(`
const limit = { status: "waiting", rounds: 8, verdict: "changes", held: "Fix it.", needs_you: true, review_findings: ["Handle an empty file"] };
const decided = [];
const before = [];
for (const pick of ["a", "b", "c"]) {
  record(db, "app-12", { ...limit, handed: null });
  await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, pick, async () => { before.push([thread().decisions.length, notes().length]); return "ran"; });
  decided.push(thread().decisions.length);
}
record(db, "app-12", { ...limit, handed: null });
const refused = await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "b", async () => { throw new Error("CI failed"); }).catch((error) => error.message);
const afterRefused = thread().decisions.length;
record(db, "app-12", { rounds: 0, verdict: "approve", held: null, review_findings: null, reviewed_commit: "abcdef1234567890" });
await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "a", async () => "ran");
decided.push(thread().decisions.length);
record(db, "app-12", { needs_you: false, verdict: null, erred: true, said: "OAuth token has expired" });
for (const pick of ["a", "b"]) await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, pick, async () => "ran");
record(db, "app-12", { erred: false, asking: true, said: "CSV or JSON?" });
await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "b", async () => "ran");
console.log(JSON.stringify({ decided, before, refused, afterRefused, decisions: thread().decisions, notes: notes() }));`);
  expect(seen.decided).toEqual([1, 2, 3, 4]);
  // The decision and the lead's note are saved before the command runs, so a daemon that stops
  // in between still has both. A command that is refused takes the decision back and tells the lead.
  expect(seen.before).toEqual([
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  expect(seen.refused).toBe("CI failed");
  expect(seen.afterRefused).toBe(3);
  expect((seen.notes as string[])[4]).toBe("Simon's pick on APP-12 didn't run: CI failed");
  const told = (seen.notes as string[]).map((note) =>
    note.endsWith("as Simon's decision on the task."),
  );
  expect(told).toEqual([true, true, true, true, false, true, false, false, false]);
  const decisions = seen.decisions as { by: string; text: string; words: string }[];
  expect(decisions.map(({ by, text }) => ({ by, text }))).toEqual([
    {
      by: "human",
      text: 'Go on: fix the findings, as Simon picked on "Review still wants changes after 8 rounds"',
    },
    {
      by: "human",
      text: 'Merge without approval, as Simon picked on "Review still wants changes after 8 rounds"',
    },
    {
      by: "human",
      text: 'Stop the builder, as Simon picked on "Review still wants changes after 8 rounds"',
    },
    { by: "human", text: 'Merge it, as Simon picked on "Ready to merge"' },
  ]);
  expect(decisions[1]?.words).toBe(
    "You picked b (Merge without approval) on APP-12: Review still wants changes after 8 rounds\n\nThe latest review asks:\n1. Handle an empty file",
  );
});

// Each option makes of the daemon exactly the requests its command makes, which the daemon handles
// as yours: sc start, sc stop, sc merge --skip-review with the PR you saw, the merge m makes, and
// the screen's restart, or a stop and a start for a builder that isn't running or whose host is
// gone. Opening the builder and handing the item to the lead make none.
test("each option of Skelcrew's own items sends exactly its command's request", () => {
  const seen = inProcess(`
const { ownItem, pickRequests } = await import(${JSON.stringify(source("flow/own-items.ts"))});
const merging = { pr: 7, started: 1000, head: "b".repeat(40) };
const picking = { repo: "simon/app", task: "t12", commit: "a".repeat(40), merging };
const marks = {
  "round limit": { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it.", needs_you: true, pr: 7 },
  ready: { status: "waiting", verdict: "approve", held: null, needs_you: true, pr: 7, checks: "passing", ci_passed: true },
  question: { asking: true },
  error: { erred: true },
  host: { host: "herdr", needs_you_for: "run sc install: its session host herdr is missing" },
};
const fresh = { status: "working", rounds: 0, verdict: null, held: null, needs_you: false, asking: false, erred: false, host: "tmux", needs_you_for: null, pr: null };
const out = {};
for (const [kind, mark] of Object.entries(marks)) {
  record(db, "app-12", { ...fresh, ...mark });
  const item = ownItem(thread(), false);
  out[kind] = Object.fromEntries(item.options.map((option) => [option.label, [true, false].map((runs) => pickRequests(option.act, thread(), picking, runs))]));
}
console.log(JSON.stringify(out));`);
  const repo = "simon/app";
  const task = "t12";
  const start = { command: "start", repo, task };
  const stop = { command: "stop", repo, task };
  const both = (requests: unknown[]) => [requests, requests];
  expect(seen["round limit"]).toEqual({
    "Go on: fix the findings": both([start]),
    "Merge without approval": both([
      {
        command: "merge skip review",
        repo,
        task,
        seen: { pr: 7, started: 1000, head: "b".repeat(40) },
      },
    ]),
    "Stop the builder": both([stop]),
  });
  expect(seen.ready).toEqual({
    "Merge it": both([{ command: "merge", repo, pr: 7, commit: "a".repeat(40) }]),
    "Not yet": both([]),
  });
  expect(seen.question).toEqual({
    "Open the builder": both([]),
    "Let the lead handle it": both([]),
  });
  expect(seen.error).toEqual({
    "Start it again": [[{ command: "restart", repo, task }], [stop, start]],
    "Open the builder": both([]),
  });
  expect(seen.host).toEqual({
    "Start it again": both([stop, start]),
    "Open the builder": both([]),
  });
});

// A pick that starts or stops a builder can still fail, so its task stays in Needs you while it
// runs, its box saying what it does. One that fails leaves the item as it was, with the reason.
test("a start picked on an item stays in its box until it is done, and a failure keeps the item", () => {
  const seen = inProcess(`
record(db, "app-12", { erred: true, said: "OAuth token has expired" });
const item = row("APP-12").ask;
let during = null;
const failed = await pickOwnItem(db, "none", "app", "t12", item, "a", async () => {
  const r = row("APP-12");
  during = { section: r.section, ask: r.ask };
  throw new Error("APP-12's builder couldn't start again: no sandbox");
}).catch((error) => error.message);
const back = row("APP-12");
console.log(JSON.stringify({ item, during, failed, section: back.section, ask: back.ask }));`);
  const why = "APP-12's builder couldn't start again: no sandbox";
  expect(seen.during).toEqual({
    section: "needs you",
    ask: { ...(seen.item as object), doing: "starting…" },
  });
  expect(seen.failed).toBe(why);
  expect(seen.section).toBe("needs you");
  expect(seen.ask).toEqual({ ...(seen.item as object), failed: why });
});

// A start picked while every builder is busy queues the task, which is done for the pick: the
// task waits in the task queue, and its item goes, even one a stop doesn't clear, such as a
// missing host plugin.
test("a start picked that joins the queue takes its task out of Needs you", () => {
  const seen = inProcess(`
record(db, "app-12", { host: "herdr", needs_you_for: "run sc install: its session host herdr is missing" });
const said = await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "a", async () => {
  record(db, "app-12", { status: "queued" });
  return "APP-12 waits in the queue.";
});
console.log(JSON.stringify({ said, section: row("APP-12").section, ask: row("APP-12").ask }));`);
  expect(seen).toEqual({ said: "APP-12 waits in the queue.", section: "task queue", ask: null });
});

// A pick acts only on what you saw: once the thread needs you for something else, it is refused.
test("a pick on Skelcrew's own item is refused once the item changed", () => {
  const seen = inProcess(`
record(db, "app-12", { asking: true, said: "CSV or JSON?" });
const before = row("APP-12").ask;
record(db, "app-12", { said: "Header row or not?" });
const said = await pickOwnItem(db, "none", "app", "t12", before, "b", async () => "ran").catch((error) => error.message);
console.log(JSON.stringify({ said, notes: notes() }));`);
  expect(seen).toEqual({
    said: "what APP-12 needs you for changed as you answered, so read it again",
    notes: [],
  });
});

// A pick shows at once: while it runs, its task leaves Needs you for its stage, saying what the
// pick does, and its tab counts it no more. One that fails comes back with its reason in red in
// the box, until the next pick or until the thread no longer needs you.
test("a pick takes its task out of Needs you while it runs, and a failure comes back in red", () => {
  const seen = inProcess(`
const { repositoryTabs } = await import(${JSON.stringify(source("list/rows.ts"))});
const { itemBox } = await import(${JSON.stringify(source("list/layout.ts"))});
const ready = { status: "waiting", verdict: "approve", needs_you: true, reviewed_commit: "abcdef1234567890" };
record(db, "app-12", ready);
const look = () => { const r = row("APP-12"); return { section: r.section, says: r.says, needsYou: r.needsYou, ask: r.ask, badge: repositoryTabs(db, null)[0].needYou + repositoryTabs(db, null)[0].ready }; };
const before = look();
let during = null;
const refused = await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "a", async () => { during = look(); throw new Error("GitHub refused: not mergeable"); }).catch((error) => error.message);
const failed = look();
const box = itemBox(failed.ask, 60).map((line) => line.text).join("\\n");
let again = null;
await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "a", async () => { again = look(); throw new Error("still not"); }).catch(() => {});
record(db, "app-12", { needs_you: false });
const cleared = thread().pick_failed;
record(db, "app-12", { needs_you: true });
console.log(JSON.stringify({ before, during, refused, failed, box, again, cleared, after: look() }));`);
  expect(seen.before).toMatchObject({ section: "needs you", badge: 1 });
  expect(seen.during).toEqual({
    section: "ready",
    says: "merging…",
    needsYou: false,
    ask: null,
    badge: 0,
  });
  expect(seen.refused).toBe("GitHub refused: not mergeable");
  expect(seen.failed).toMatchObject({
    section: "needs you",
    ask: { title: "Ready to merge", failed: "GitHub refused: not mergeable" },
  });
  expect(seen.box).toContain(`\x1b[${red}mGitHub refused: not mergeable`);
  expect(seen.again).toMatchObject({ section: "ready", says: "merging…" });
  expect(seen.cleared).toBeNull();
  expect((seen.after as { ask: object }).ask).not.toHaveProperty("failed");
});

// A merge without approval arms a plan, which the forge can still refuse on its first try. The
// pick then fails: the plan stops, and the round limit needs you again, so the item comes back with
// the forge's reason, to pick again. So does a poll that failed before it could try. One still
// waiting on its checks stays armed.
test("a merge without approval the forge refuses at once brings its item back, unarmed", () => {
  const seen = inProcess(`
const { armMerge, takeBackFailedMerge } = await import(${JSON.stringify(source("flow/merging.ts"))});
db.run(\`${itemSql("app", "pr", 7, "Add export", "2026-11-20T10:00:00Z", { head: "b".repeat(40) })}\`);
db.run("UPDATE repositories SET forge = 'github'");
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it.", needs_you: true, pr: 7 });
const tryMerge = (waits) => async () => {
  armMerge(db, "none", thread(), { seen: { pr: 7, started: thread().started, head: "b".repeat(40) } }, true);
  record(db, "app-12", { merge_waits: waits });
  const failed = takeBackFailedMerge(db, thread(), pollFailed);
  if (failed !== null) throw new Error(failed);
  return "armed";
};
let pollFailed = null;
const refused = await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "b", tryMerge("the forge, which refused: Pull Request is not mergeable")).catch((error) => error.message);
const back = row("APP-12");
pollFailed = "github failed: GitHub is down";
const down = await pickOwnItem(db, "none", "app", "t12", back.ask, "b", tryMerge(null)).catch((error) => error.message);
const downBack = { section: row("APP-12").section, plan: thread().merge_plan, failed: row("APP-12").ask?.failed };
pollFailed = null;
const waiting = await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "b", tryMerge("its checks"));
console.log(JSON.stringify({ refused, section: back.section, ask: back.ask, down, downBack, plan: thread().merge_plan, waiting }));`);
  const why = "#7 didn't merge: the forge refused: Pull Request is not mergeable";
  expect(seen.refused).toBe(why);
  expect(seen.section).toBe("needs you");
  expect(seen.ask).toMatchObject({
    title: "Review still wants changes after 3 rounds",
    options: ["Go on: fix the findings", "Merge without approval", "Stop the builder"],
    failed: why,
  });
  // A poll that failed before the forge was asked to merge takes the plan back too.
  const down = "#7 didn't merge: github failed: GitHub is down";
  expect(seen.down).toBe(down);
  expect(seen.downBack).toEqual({ section: "needs you", plan: null, failed: down });
  expect(seen.waiting).toBe("armed");
  expect(seen.plan).toBe("armed");
});

// On the screen every option of Skelcrew's own item goes to the daemon, so the lead hears it:
// opening the builder then attaches, both merges ask y/n first, carrying the commit you saw
// approved for the PR, and the rest go at once. Skelcrew's own item takes no reply.
test("a pick on the screen goes to the daemon, asking first before a merge", () => {
  const seen = inProcess(`
const { picked } = await import(${JSON.stringify(source("list/actions.ts"))});
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it.", needs_you: true, pr: 7 });
const limit = row("APP-12");
const atLimit = ["a", "b", "c"].map((pick) => picked(limit, pick, "simon/app"));
record(db, "app-12", { held: null, rounds: 0, verdict: null, needs_you: false, asking: true });
const asking = ["a", "r"].map((pick) => picked(row("APP-12"), pick, "simon/app"));
const merge = { ask: "Merge app#7 into main? y/n", working: "Merging app#7…", request: { command: "merge", repo: "simon/app", pr: 7, commit: "a".repeat(40) }, queues: false };
const ready = { ...row("APP-12"), merge, ask: { title: "Ready to merge", text: "#7 is ready.", options: ["Merge it", "Not yet"], acts: ["merge", "lead"] } };
const merging = ["a", "b"].map((pick) => picked(ready, pick, "simon/app"));
const refused = picked({ ...ready, merge: { refused: "app#7's checks haven't passed" } }, "a", "simon/app");
console.log(JSON.stringify({ atLimit, asking, merging, refused }));`);
  const request = (title: string, text: string, pick: string, more = {}) => ({
    command: "pick",
    repo: "simon/app",
    task: "12",
    seen: { title, text },
    pick,
    ...more,
  });
  const limit = ["Review still wants changes after 3 rounds", "The latest review asks:"] as const;
  expect(seen.atLimit).toEqual([
    {
      run: {
        ask: "",
        working: "Go on: fix the findings…",
        request: request(...limit, "a"),
        queues: false,
      },
    },
    {
      confirm: {
        ask: "Merge #7 (APP-12) without Skelcrew's approval? CI must still pass. y/n",
        working: "Merge without approval…",
        request: request(...limit, "b"),
        queues: false,
      },
    },
    {
      run: {
        ask: "",
        working: "Stop the builder…",
        request: request(...limit, "c"),
        queues: false,
      },
    },
  ]);
  const question = [
    "Its builder asked a question",
    "Its builder asked a question in its session.",
  ] as const;
  expect(seen.asking).toEqual([
    {
      open: {
        ask: "",
        working: "Open the builder…",
        request: request(...question, "a"),
        queues: false,
      },
    },
    null,
  ]);
  expect(seen.merging).toEqual([
    {
      confirm: {
        ask: "Merge app#7 into main? y/n",
        working: "Merge it…",
        request: request("Ready to merge", "#7 is ready.", "a", { commit: "a".repeat(40) }),
        queues: false,
      },
    },
    {
      run: {
        ask: "",
        working: "Not yet…",
        request: request("Ready to merge", "#7 is ready.", "b"),
        queues: false,
      },
    },
  ]);
  expect(seen.refused).toEqual({ refused: "app#7's checks haven't passed" });
});

// A merge without approval merges only the PR you were shown, so the pick carries its number,
// when its thread started and its head as the item was read, and the daemon refuses it once any
// of them changed, as sc merge does: here a task started over with a PR of the same number and
// head. Its question says what the review asks and that it changes .agents/, as sc merge
// --skip-review's does.
test("a merge without approval picked on the screen carries the PR you saw, and says what it changes", () => {
  const seen = inProcess(`
const { picked } = await import(${JSON.stringify(source("list/actions.ts"))});
const { armMerge } = await import(${JSON.stringify(source("flow/merging.ts"))});
db.run(\`${itemSql("app", "pr", 7, "Add export", "2026-11-20T10:00:00Z", { head: "b".repeat(40) })}\`);
db.run("UPDATE repositories SET forge = 'github'");
db.run("UPDATE threads SET started = 1000 WHERE folder = 'app-12'");
db.run("INSERT INTO pr_agents (owner, repo, pr, head, base, changed) VALUES ('simon', 'app', '7', '${"b".repeat(40)}', 'main', 1)");
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it.", needs_you: true, pr: 7 });
const limit = row("APP-12");
const pick = picked(limit, "b", "simon/app");
const { stillOffered } = await import(${JSON.stringify(source("list/actions.ts"))});
db.run("UPDATE pr_agents SET changed = 0");
const stale = stillOffered({ question: pick.confirm, row: "APP-12", offer: "pick" }, all());
const startedBefore = thread().started;
db.run("UPDATE threads SET started = 2000 WHERE folder = 'app-12'");
const restarted = (() => { try { return armMerge(db, "none", thread(), { seen: pick.confirm.request.merging }, true); } catch (error) { return error.message; } })();
console.log(JSON.stringify({ merging: limit.ask.merging, started: startedBefore, request: pick.confirm.request, ask: pick.confirm.ask, restarted, stale }));`);
  const merging = { pr: 7, started: seen.started, head: "b".repeat(40) };
  expect(seen.merging).toEqual(merging);
  expect(seen.request).toMatchObject({ command: "pick", pick: "b", merging });
  expect(seen.ask).toBe(
    "Merge #7 (APP-12 Add export) without Skelcrew's approval? CI must still pass. Its reviewer hasn't approved it It changes .agents/ (roles, flows or skills): the changes wait for sc repo trust. y/n",
  );
  expect(seen.restarted).toContain("APP-12 changed since you said y, so it won't merge by itself");
  // A y to a question that no longer says what the row says, such as once a retargeted PR
  // changes what it says of .agents/, does nothing.
  expect(seen.stale).toBe("APP-12 changed while you were asked, so nothing was done");
});

// An item handed to the lead stays gone only while the thread still needs you for it: the same
// question asked again later shows again.
test("a handed item shows again when the same thing happens again", () => {
  const seen = inProcess(`
const { questionAsked } = await import(${JSON.stringify(source("flow/status.ts"))});
questionAsked(db, "none", "app-12", "CSV or JSON?");
await pickOwnItem(db, "none", "app", "t12", row("APP-12").ask, "b", async () => "ran");
const handed = row("APP-12").section;
record(db, "app-12", { asking: false });
questionAsked(db, "none", "app-12", "CSV or JSON?");
console.log(JSON.stringify({ handed, again: row("APP-12").section, ask: row("APP-12").ask?.text }));`);
  expect(seen).toEqual({ handed: "building", again: "needs you", ask: "CSV or JSON?" });
});

// The lead has the builder's own words already, as a message from it, so it gets no note that
// the thread needs you. sc ps and a host's status say it does, as the sidebar shows.
test("a builder that stops without submitting needs you at once, with no note for the lead", () => {
  const seen = inProcess(`
turnEnded(db, "none", "app-12", { message: "Should I delete the old exports?" });
const ps = listThreads(db, "app")[0];
console.log(JSON.stringify({ section: row("APP-12").section, says: row("APP-12").says, ps: { needsYou: ps.needsYou, needsYouFor: ps.needsYouFor }, noting: thread().noting }));`);
  expect(seen).toEqual({
    section: "needs you",
    says: "turn ended",
    ps: { needsYou: true, needsYouFor: "turn ended" },
    noting: null,
  });
});

// The lead already asks you, so hearing the thread needs you for the same thing again would only
// make it repeat the question. A new review round is news, so it still reaches the lead, as does a
// question its builder asks.
test("the round limit title uses the review number after earlier changes were allowed", () => {
  const seen =
    inProcess(`record(db, "app-12", { status: "waiting", rounds: 4, review_round: 5, verdict: "changes", held: "Fix it.", needs_you: true });
console.log(JSON.stringify({ title: row("APP-12").ask.title }));`);
  expect(seen.title).toBe("Review still wants changes after 5 rounds");
});

test("while an item is open, the round limit brings no note, but a new round and a question do", () => {
  const seen = inProcess(`
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", held: "Fix it." });
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
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

// A later review that reaches the round limit again is news, though the item about the last one
// is still open.
test("while an item is open, a new review reaching the round limit still brings a note", () => {
  const seen = inProcess(`
db.run("UPDATE repositories SET forge = 'github'");
record(db, "app-12", { status: "waiting", rounds: 3, verdict: "changes", pr: 7 });
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const review = { verdict: "changes", body: "Fix it.", findings: ["Fix it."] };
const reached = { review, by: "claude", sha: "a".repeat(40), maxRounds: 3, ready: null, forge: true, kept: null, now: Date.now() };
const o = verdictReached(thread(), reached);
record(db, "app-12", o.change, o.why);
console.log(JSON.stringify({ needs: thread().needs_you, noting: thread().noting }));`);
  expect(seen.needs).toBe(true);
  expect(seen.noting).toEqual(expect.stringContaining("round limit"));
});

test("an item is refused for a task the list doesn't show, as nobody could answer it", () => {
  const seen = inProcess(`
const tried = () => { try { ask("app", "99", "Start APP-99?", ["yes", "no"]); return "posted"; } catch (error) { return error.message; } };
console.log(JSON.stringify({ said: tried(), left: db.query("SELECT COUNT(*) AS n FROM asks").get().n }));`);
  expect(seen).toEqual({ said: "there is no task APP-99", left: 0 });
});

// The answer's file and the lead's note are saved before the item goes, so an answer that fails on
// the way, such as on a full disk, leaves the item to answer again.
test("an answer that can't be saved keeps its item", () => {
  const seen = inProcess(`
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const answers = ${JSON.stringify(join(data(), "leads", "simon", "app", "answers"))};
mkdirSync(dirname(answers), { recursive: true });
writeFileSync(answers, "not a folder");
const said = (() => { try { answerItem(db, "none", "app", "t12", asSeen("t12"), { pick: "a" }); return "answered"; } catch { return "failed"; } })();
console.log(JSON.stringify({ said, kept: itemOf(db, "simon", "app", "t12") !== null, notes: notes() }));`);
  expect(seen).toEqual({ said: "failed", kept: true, notes: [] });
});

// The lead is asking you now, so the note it was about to get that the thread needs you would only
// make it ask again.
test("posting an item drops the needs-you note still waiting for the lead", () => {
  const seen = inProcess(`
record(db, "app-12", { asking: true }, "its builder asked a question");
const before = thread().noting;
ask("app", "t12", "Should the export include archived rows?", ["yes", "no"]);
console.log(JSON.stringify({ before, after: thread().noting }));`);
  expect(seen).toEqual({ before: "its builder asked a question", after: null });
});

// A task whose thread is done shows again by its open issue, which the lead may propose to start.
test("an item can ask whether to start again a task whose thread is done", () => {
  const seen = inProcess(`
db.run(\`${itemSql("app", "task", 12, "Add export", "2026-11-20T10:00:00Z")}\`);
record(db, "app-12", { status: "done" });
ask("app", "t12", "Start APP-12 again?", ["yes", "no"]);
record(db, "app-12", { changed: Date.now() }, "looked at it again");
console.log(JSON.stringify({ item: itemOf(db, "simon", "app", "t12")?.text, section: row("APP-12").section }));`);
  expect(seen).toEqual({ item: "Start APP-12 again?", section: "needs you" });
});

// A long item takes two lines in the sidebar at any width, each cut with … to fit, never
// wrapped: the task, then the item's title and how many options it has.
test("a long item's row is two lines cut to a narrow sidebar", () => {
  const seen = inProcess(`
ask("app", "t12", "word ".repeat(200), ${options}, "Pi sign-ins expire every few hours on the server");
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.name === "APP-12");
const narrow = drawRows(rows, sectionHeadings(all(), sections), at, 0, 24, 20);
const plain = narrow.lines.map((line) => Bun.stripANSI(line).trimEnd());
const ours = plain.filter((_, line) => narrow.targets[line] && narrow.targets[line].row === at);
console.log(JSON.stringify({ ours, widest: Math.max(...plain.map((line) => Bun.stringWidth(line))) }));`);
  expect(seen.ours).toEqual([" ▸ ● 12  Add export", "     Pi sign-ins expire…"]);
  expect(seen.widest).toBeLessThanOrEqual(24);
});

test("opening an item beside the list keeps its selected row and puts the text on the right", () => {
  const seen = inProcess(`
const { drawList } = await import(${JSON.stringify(source("list/layout.ts"))});
const { itemKey } = await import(${JSON.stringify(source("list/actions.ts"))});
const { drawPane } = await import(${JSON.stringify(source("list/pane.ts"))});
const { readDetails } = await import(${JSON.stringify(source("list/details.ts"))});
ask("app", "t12", "The full decision text belongs on the right.", ["Go ahead", "Wait"], "Decision needed");
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.name === "APP-12");
const selectedRow = rows[at];
const pane = drawPane(selectedRow, readDetails(db, open, selectedRow.task, Date.now(), selectedRow.changed), null, 80, 35);
const frame = drawList(rows, sectionHeadings(all(), sections), at, 0, { versions: ["test"], where: "", name: "app", tabs: [], notice: "", bottom: "", load: "" }, { width: 160, height: 40 }, pane.lines, 0);
const frameLines = frame.lines.map(Bun.stripANSI);
console.log(JSON.stringify({ left: frameLines.map((line) => line.split(" │ ")[0]).join("\\n"), right: pane.lines.map(Bun.stripANSI).join("\\n"), pick: itemKey(selectedRow, at, frame.targets, "b", pane.picks) }));`);
  expect(seen.left).toContain("Needs you");
  expect(seen.left).toContain("▸ ● 12");
  expect(seen.left).not.toContain("The full decision text");
  expect(seen.right).toContain("The full decision text belongs on the right.");
  expect(seen.right).toContain("a) Go ahead");
  expect(seen.right).toContain("b) Wait");
  expect(seen.pick).toBe("b");
});

// Enter opens the item full-size, where scrolling reaches every line however short the screen,
// for an item on the repository as for one on a thread.
test("an item opened full-size scrolls to its every option, on any height", () => {
  const seen = inProcess(`
const { drawItem } = await import(${JSON.stringify(source("list/layout.ts"))});
const { itemKey } = await import(${JSON.stringify(source("list/actions.ts"))});
ask("app", null, "word ".repeat(100), ["first choice", "second choice", "third choice", "fourth choice"]);
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.part === "ask");
const reached = [];
const keys = new Set();
let scroll = 0;
for (let step = 0; step < 40; step++) {
  const drawn = drawItem(rows[at], at, 30, 4, scroll);
  reached.push(...drawn.lines.map((line) => Bun.stripANSI(line).replace(/│/g, "").trim()));
  for (const key of ["a", "b", "c", "d", "r"]) if (itemKey(rows[at], at, drawn.targets, key)) keys.add(key);
  scroll = drawn.scroll + 1;
}
console.log(JSON.stringify({ reached, keys: [...keys], first: Bun.stripANSI(drawItem(rows[at], at, 30, 4, 0).lines[1]).trim() }));`);
  const reached = seen.reached as string[];
  for (const line of [
    "a) first choice",
    "b) second choice",
    "c) third choice",
    "d) fourth choice",
    "r) reply",
  ])
    expect(reached).toContain(line);
  expect(seen.keys).toEqual(["a", "b", "c", "d", "r"]);
  expect(seen.first).toBe("app");
});

// Under 3 lines there is no room to scroll, so the item says only to make the screen taller, and
// nothing on it answers.
test("an item opened on a screen under 3 lines tall asks for a taller screen", () => {
  const seen = inProcess(`
const { drawItem } = await import(${JSON.stringify(source("list/layout.ts"))});
ask("app", null, "Add simon/web?", ["yes", "no"]);
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.part === "ask");
const on = (height) => {
  const drawn = drawItem(rows[at], at, 50, height, 0);
  return { lines: drawn.lines.map((line) => Bun.stripANSI(line).trim()), answers: drawn.targets.some(Boolean) };
};
console.log(JSON.stringify({ one: on(1), two: on(2), three: on(3).answers }));`);
  expect(seen).toEqual({
    one: { lines: ["make the screen taller to read this item"], answers: false },
    two: { lines: ["make the screen taller to read this item", ""], answers: false },
    three: true,
  });
});

// A phone has taps alone, so tapping ↓ more, then ↑ more, reaches every line too.
test("taps on an opened item's more lines scroll it to every option", () => {
  const seen = inProcess(`
const { drawItem } = await import(${JSON.stringify(source("list/layout.ts"))});
ask("app", null, "word ".repeat(100), ["first choice", "second choice", "third choice"]);
const rows = shownRows(all(), sections, true);
const at = rows.findIndex((r) => r.part === "ask");
const tap = (drawn, sign) => drawn.targets.find((target, line) => target && "scroll" in target && Bun.stripANSI(drawn.lines[line]).includes(sign));
const reached = [];
let scroll = 0;
let down = drawItem(rows[at], at, 30, 6, scroll);
while (true) {
  reached.push(...down.lines.map((line) => Bun.stripANSI(line).replace(/│/g, "").trim()));
  const more = tap(down, "↓ more");
  if (!more) break;
  scroll = down.scroll + more.scroll;
  down = drawItem(rows[at], at, 30, 6, scroll);
}
const up = tap(down, "↑ more");
const back = drawItem(rows[at], at, 30, 6, down.scroll + up.scroll);
console.log(JSON.stringify({ reached, moved: back.scroll < down.scroll, top: Bun.stripANSI(drawItem(rows[at], at, 30, 6, 0).lines.at(-1)).trim() }));`);
  const reached = seen.reached as string[];
  for (const line of ["a) first choice", "b) second choice", "c) third choice", "r) reply"])
    expect(reached).toContain(line);
  expect(seen.moved).toBe(true);
  expect(seen.top).toBe("↓ more");
});

test("an item goes when its thread ends, and the lead can take one off", () => {
  const seen = inProcess(`
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
record(db, "app-12", { status: "done" });
const ended = itemOf(db, "simon", "app", "t12");
ask("app", null, "Add simon/web too?", ["yes", "no"]);
const about = clearItem(db, "app", null);
const done = (() => { try { ask("app", "t12", "Again?", ["yes", "no"]); return "posted"; } catch (error) { return error.message; } })();
console.log(JSON.stringify({ ended, about, left: db.query("SELECT COUNT(*) AS n FROM asks").get().n, done }));`);
  expect(seen).toEqual({ ended: null, about: "app", left: 0, done: "APP-12 is done already" });
});

// What sc ask start and sc ask repo add once asked with y or n is an item with yes and no now: one
// about a task not started yet, or about the repository itself.
test("a yes or no proposal is an item, on a task not started or on the repository", () => {
  const seen = inProcess(`
db.run("INSERT INTO backlog (owner, repo, task, title, body, created, by, filed_commit) VALUES ('simon', 'app', 't3', 'Dark mode', 'Add it', '2026-11-22T10:00:00Z', 'simon', 'c')");
ask("app", "t3", "Start APP-3, Dark mode?", ["yes", "no"]);
ask("app", null, "Add simon/web, which the export calls?", ["yes", "no"]);
const task = row("APP-3");
const repository = row("ask");
answerItem(db, "none", "app", "t3", asSeen("t3"), { pick: "a" });
console.log(JSON.stringify({
  task: { section: task.section, part: task.part, ask: task.ask, starts: task.start !== null },
  repository: { section: repository.section, label: repository.label, ask: repository.ask },
  notes: notes(),
}));`);
  expect(seen.task).toEqual({
    section: "needs you",
    part: "backlog",
    ask: {
      title: "Start APP-3, Dark mode?",
      text: "Start APP-3, Dark mode?",
      options: ["yes", "no"],
      acts: null,
    },
    starts: true,
  });
  expect(seen.repository).toEqual({
    section: "needs you",
    label: "app",
    ask: {
      title: "Add simon/web, which the…",
      text: "Add simon/web, which the export calls?",
      options: ["yes", "no"],
      acts: null,
    },
  });
  expect(seen.notes).toEqual([
    expect.stringContaining("You picked a (yes) on APP-3: Start APP-3, Dark mode?"),
  ]);
});

// Each item waits on you, whatever its thread shows, so its row's mark is filled and the
// repository's tab counts it, on a thread, a task not started or the repository itself.
test("an item fills its row's mark, and the repository's tab counts each one", () => {
  const seen = inProcess(`
db.run("INSERT INTO backlog (owner, repo, task, title, body, created, by, filed_commit) VALUES ('simon', 'app', 't3', 'Dark mode', 'Add it', '2026-11-22T10:00:00Z', 'simon', 'c')");
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
ask("app", "t3", "Start APP-3?", ["yes", "no"]);
ask("app", null, "Add simon/web?", ["yes", "no"]);
const { repositoryTabs } = await import(${JSON.stringify(source("list/rows.ts"))});
console.log(JSON.stringify({ mark: row("APP-12").mark, tab: repositoryTabs(db, null)[0] }));`);
  expect(seen).toEqual({
    mark: { sign: "●", colour: "yellow" },
    tab: { name: "app", fullName: "simon/app", needYou: 3, colour: "yellow", ready: 0 },
  });
});

test("sc ps and sc show say an item waits, and sc show gives its text and options", () => {
  const seen = inProcess(`
ask("app", "t12", ${JSON.stringify(asked)}, ${options});
const ps = listThreads(db, "app")[0];
const show = readTask(db, { repo: "app", task: "t12" });
console.log(JSON.stringify({ ps: { needsYou: ps.needsYou, needsYouFor: ps.needsYouFor }, item: show.item }));`);
  expect(seen).toEqual({
    ps: { needsYou: true, needsYouFor: "item waits" },
    item: {
      title: "T12 has gone 8 rounds.…",
      text: asked,
      options: ["force merge (recommended)", "keep going"],
    },
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
      { task: "t12", text: "apply the check.yml split in PR #463", options: "[]" },
      { task: "t13", text: "check the design", options: "[]" },
    ],
    marks: [
      { task: "t12", needs_you_for: null },
      { task: "t13", needs_you_for: "run sc install: its session host herdr is missing" },
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
  const posted = await skel(["ask", "app-12", "Ship it?", "--yes-no"]);
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
    expect(posted.out).toContain("Posted your question about APP-12 in Needs you.");
    await untilNeedsYou(true);
    expect(await needsYouFor()).toBe("item waits");
    expect((await skel(["show", "app-12"])).out).toContain("a) force merge");
    const code = `import { answerItem } from ${JSON.stringify(source("client.ts"))};
const seen = { title: "T12 has gone 8 rounds.…", text: ${JSON.stringify(asked)}, options: ["force merge", "keep going"] };
console.log(await answerItem("simon/app", "12", seen, { pick: "a" }));`;
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
    await asLead(["ask", "app-12", "Ship it?", "--yes-no"]);
    await untilNeedsYou(true);
    expect((await asLead(["ask", "--clear", "app-12"])).out).toContain(
      "Took the item on APP-12 off.",
    );
    await untilNeedsYou(false);
  }, 60_000);

  // The builder's question shows as Skelcrew's own item, and its pick reaches the lead. An error
  // offers to start the builder again, which the pick does as the screen's restart would.
  test("each pick on Skelcrew's own item runs its command: a hand-off, start again, go on and stop", async () => {
    addApp();
    await startApp12();
    const pick = (title: string, text: string, letter: string) => {
      const code = `import { startOrMerge } from ${JSON.stringify(source("client.ts"))};
const seen = { title: ${JSON.stringify(title)}, text: ${JSON.stringify(text)} };
console.log(await startOrMerge({ command: "pick", repo: "simon/app", task: "12", seen, pick: ${JSON.stringify(letter)} }));`;
      const run = Bun.spawnSync([process.execPath, "-e", code], {
        env: env(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return `${run.stdout}${run.stderr}`;
    };
    await hook(
      "ask",
      JSON.stringify({ tool_input: { questions: [{ question: "CSV or JSON?" }] } }),
    );
    await until(() => thread().said === "CSV or JSON?");
    expect((await skel(["show", "app-12"])).out).toContain("b) Let the lead handle it");
    expect(pick("Its builder asked a question", "CSV or JSON?", "b")).toContain(
      "Handed APP-12 to the lead.",
    );
    await until(() =>
      read(join(lead(), "typed")).includes(
        "You picked b (Let the lead handle it) on APP-12: Its builder asked a question",
      ),
    );
    expect(thread().handed).toBe("Its builder asked a question\nCSV or JSON?");
    await hook("answer");
    await hook("fail");
    await until(() => thread().erred === 1);
    const error = "Its builder's harness stopped on an error.";
    expect(pick("Its harness stopped on an error", error, "a")).toContain(
      "Restarted APP-12's builder.",
    );
    await until(() =>
      read(join(lead(), "typed")).includes("You picked a (Start it again) on APP-12"),
    );
    // A builder whose session ended on its error is started again too, by a stop and a start.
    await hook("fail");
    await until(() => thread().erred === 1);
    const tmux = (...args: string[]) =>
      Bun.spawnSync(["tmux", "-L", socket, ...args], { stdout: "pipe", stderr: "pipe" });
    tmux("kill-session", "-t", "=app-12");
    expect(pick("Its harness stopped on an error", error, "a")).toContain("Started APP-12 again");
    await until(
      () => thread().status === "working" && tmux("has-session", "-t", "=app-12").success,
    );
    // At the round limit, going on lets it go on, as sc start does, and stopping stops the
    // builder, as sc stop does.
    const atLimit = () =>
      sql(`UPDATE tasks SET round_log = NULL, rounds = 4, verdict = 'changes', held = 'Fix it.', review_findings = NULL;
UPDATE threads SET erred = 0, asking = 0, turn_ended = 0, needs_you = 1, limit_decided = 0, handed = NULL WHERE folder = 'app-12'`);
    const limit = ["Review still wants changes after 4 rounds", "The latest review asks:"] as const;
    atLimit();
    expect((await skel(["show", "app-12"])).out).toContain(limit[0]);
    expect(pick(...limit, "a")).toContain("APP-12 goes on past the round limit.");
    // Going on stops it needing you, and sets its rounds of changes back to the limit.
    await until(() => thread().needs_you === 0 && thread().rounds === 3);
    atLimit();
    expect(pick(...limit, "c")).toContain("Stopped APP-12.");
    await until(() => thread().status === "stopped");
    await until(() =>
      read(join(lead(), "typed")).includes("You picked c (Stop the builder) on APP-12"),
    );
  }, 90_000);
});
