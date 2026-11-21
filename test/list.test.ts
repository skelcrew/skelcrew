// The list that sc shows: its rows, read from a database of the test's own, and the list itself in
// a terminal, on tmux servers of the test's own. One holds the agents, and a second stands in for
// your terminal, so a test can press keys and read what you see.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Labels, startSession } from "../src/agents/sessions.ts";
import { drawList, drawRows, type Frame, keysFor, paneWidth, tabAt } from "../src/list/layout.ts";
import {
  cutBacklog,
  type Row,
  type Section,
  sectionHeadings,
  sections,
  shownRows,
} from "../src/list/rows.ts";
import {
  fakePlugin,
  itemSql,
  asked as pluginAsked,
  read,
  source,
  threadSql,
  until as wait,
} from "./harness.ts";

let home = "";
let agents = "";
let terminal = "";
let standIn: Server | null = null;
// The commit Skelcrew's reviewer approved for app-14, which is its PR's head.
const approved = "9fc11d177dbffac496ad6b3496b3f91775d9057f";
// What the stand-in daemon was asked, as one line each.
const asked: string[] = [];
// A CI check that passed, as the forge's copy of a PR has it.
const passed = [{ name: "test", id: "1", state: "passed" }];
// What the stand-in daemon answers when asked for a lead, and to merge.
let leadAnswer: object = {};
let mergeAnswer: object = { merged: "Merged." };
// The clock the rows are read at: 19 November 2026, 15:00, in this machine's time zone.
const now = new Date(2026, 10, 19, 15, 0).getTime();

const env = () => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: join(home, "run") });

// Runs SQL on the test's database, in a process of its own: homedir() keeps the HOME this
// process started with, so opening the database from here would reach your real one.
function sql(statements: string): void {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
openDb().run(${JSON.stringify(statements)});`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
}

// app has the fake plugin as its tracker and forge, and its lead is the one Skelcrew kept from
// before, so its session is named lead. site is a second repository, with a thread that needs
// you. In app: issue 31 has no thread, app-7 works, app-12 asks a question, app-9 stopped, and
// app-14 is approved on PR 41, whose checks a poll found green, so it is ready for review. app-7
// started 5 minutes before the rows' clock, app-12 last changed 2 minutes before it, and app-9 a
// minute before it.
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-list-test-")));
  agents = `skel-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  terminal = `${agents}-terminal`;
  fakePlugin(home);
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  sql(`INSERT INTO repositories (name, owner, repo, kept_lead, lead_session, lead_harness, forge)
  VALUES ('app', 'simon', 'app', 1, 's', 'claude', 'github');
INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${itemSql("app", "task", 31, "Export as CSV", "2026-11-05T10:00:00Z")}
${itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", { head: approved, checks: passed })}
${threadSql({ task: "7", title: "Login redirect", harness: "claude", started: now - 300_000 })}
${threadSql({ task: "12", title: "Rate limit the API", harness: "codex", asking: 1, needs_you: 1, changed: now - 120_000 })}
${threadSql({ task: "9", title: "Old work", status: "stopped", changed: now - 60_000 })}
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, pr: 41, review_round: 1, reviewed_commit: approved })}
INSERT INTO pr_agents (owner, repo, pr, head, base, changed)
  VALUES ('simon', 'app', '41', '${approved}', 'main', 0);
${threadSql({ repo: "site", task: "3", title: "Docs", asking: 1, needs_you: 1 })}`);
});
afterEach(() => {
  standIn?.close();
  standIn = null;
  asked.length = 0;
  leadAnswer = {};
  mergeAnswer = { merged: "Merged." };
  for (const socket of [terminal, agents]) {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "ignore" });
    // tmux leaves the socket file behind after kill-server.
    const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
    rmSync(join(folder, socket), { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// Returns app's rows as the list reads them at the rows' clock, with `bin` a folder of programs
// found before the real ones.
function rows(bin = ""): Row[] {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { listRows } from ${JSON.stringify(source("list/rows.ts"))};
console.log(JSON.stringify(listRows(openDb(), { owner: "simon", repo: "app" }, ${now})));`;
  const path = bin ? `${bin}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...env(), PATH: path },
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

// Returns what sc show prints of one of app's tasks.
function shown(task: string): string {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { printTask, showTask } from ${JSON.stringify(source("flow/list.ts"))};
printTask(await showTask(openDb(), { repo: "app", task: ${JSON.stringify(task)} }), false);`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

test("the lead comes first, then what needs you, then what is up next, then each stage's tasks", () => {
  const shown = rows().map((row) => [
    row.section,
    row.part,
    row.name,
    row.title,
    row.says,
    row.pr,
    row.when,
  ]);
  // The approved task first on its own, so a failure says in one line where it went and why.
  const ready = shown.find(([, , name]) => name === "APP-14");
  expect(ready?.join(" | ")).toBe(
    "needs you | ready | APP-14 | Fix the export header | ready to merge | #41 | ",
  );
  expect(shown).toEqual([
    ["lead", "lead", "lead", "claude", "running", "", ""],
    ["needs you", "building", "APP-12", "Rate limit the API", "question", "", "14:58"],
    ["needs you", "ready", "APP-14", "Fix the export header", "ready to merge", "#41", ""],
    ["up next", "building", "APP-9", "Old work", "paused", "", "14:59"],
    ["backlog", "backlog", "APP-31", "Export as CSV", "", "", "5 Nov"],
    ["building", "building", "APP-7", "Login redirect", "working", "", "14:55"],
  ]);
});

// A task that waits on you shows under Needs you, whatever its stage, and keeps its stage, so a
// question on an approved task still reaches its builder, and offers no merge.
// The lead's requests that wait for your yes, saved as sc ask saves them.
function leadRequests(): void {
  sql(`INSERT INTO lead_requests (owner, repo, action, says, made) VALUES
  ('simon', 'app', '{"kind":"start","task":"31"}', 'Start APP-31 Export as CSV?', 1),
  ('simon', 'app', '{"kind":"repo add","repository":"simon/site"}', 'Add the repository simon/site?', 2),
  ('simon', 'app', '{"kind":"no such kind"}', 'Unreadable', 3),
  ('simon', 'app', '{"kind":"start new","title":"CSV \\u001b[31mexport","body":"As CSV"}', 'Start a new task: CSV \u001b[31mexport?', 4),
  ('simon', 'site', '{"kind":"start","task":"3"}', 'Start SITE-3 Docs?', 5);
INSERT INTO lead_requests (owner, repo, action, says, made, answered) VALUES
  ('simon', 'app', '{"kind":"start","task":"31"}', 'Being answered?', 6, 1);`);
}

test("the lead's requests show under the lead, newest first, each by its ID, with no control codes", () => {
  leadRequests();
  const shown = rows()
    .filter((row) => row.section === "lead")
    .map((row) => [row.part, row.request, row.title, row.mark.sign, row.mark.colour]);
  // A request whose action can't be read shows nothing, nor does one being answered, and another
  // repository's stays there.
  expect(shown).toEqual([
    ["lead", null, "claude", "○", "bright"],
    ["request", 4, "Start a new task: CSV  [31mexport?", "●", "yellow"],
    ["request", 2, "Add the repository simon/site?", "●", "yellow"],
    ["request", 1, "Start APP-31 Export as CSV?", "●", "yellow"],
  ]);
  // A request is none of the sections' rows, so no heading counts it.
  const headings = sectionHeadings(rows(), new Set(sections));
  expect(headings.reduce((sum, heading) => sum + heading.count, 0)).toBe(rows().length - 4);
});

test("an approved task whose builder asks a question shows under Needs you, still in Ready", () => {
  sql("UPDATE threads SET asking = 1 WHERE folder = 'app-14';");
  const row = rows().find((candidate) => candidate.name === "APP-14");
  expect(row).toMatchObject({
    section: "needs you",
    part: "ready",
    says: "question",
    needsYou: true,
    merge: null,
  });
  expect(row?.session).toBe("app-14");
});

// A mark is an action for you whatever its words, so one that reads like a state's word still
// puts the task under Needs you, where a closed stage can't hide it.
test("a task marked with an action that reads like a state's word shows under Needs you", () => {
  sql("UPDATE threads SET needs_you = 1, needs_you_for = 'review failed' WHERE folder = 'app-9';");
  const row = rows().find((candidate) => candidate.name === "APP-9");
  expect(row).toMatchObject({ section: "needs you", says: "review failed", needsYou: true });
  expect(row?.mark).toEqual({ sign: "●", colour: "yellow" });
});

// With a merge armed, an approved task merges by itself, so it waits on nobody and shows under
// Ready, saying approved.
test("an approved task with a merge armed shows under Ready, not Needs you", () => {
  sql("UPDATE threads SET merge_plan = 'armed' WHERE folder = 'app-14';");
  const row = rows().find((candidate) => candidate.name === "APP-14");
  expect(row).toMatchObject({ section: "ready", part: "ready", says: "approved" });
});

// A task whose flow has no review stage is never called approved: its word says it wasn't
// reviewed, while it waits on CI and once it is ready, and m merges the commit last submitted.
test("a task on a flow with no review shows not reviewed, and merges at its last submit", () => {
  sql(
    "UPDATE tasks SET verdict = 'not reviewed', review_round = NULL, flow = 'noreview' WHERE task = '14';",
  );
  const row = rows().find((candidate) => candidate.name === "APP-14");
  // It waits on you to merge it, so it is under Needs you, saying so and that nobody reviewed it.
  expect(row).toMatchObject({
    section: "needs you",
    part: "ready",
    says: "ready to merge, not reviewed",
    needsYou: false,
  });
  expect(row?.merge && "ask" in row.merge ? row.merge.request : null).toMatchObject({
    command: "merge",
    pr: 41,
    commit: approved,
  });
  expect(shown("14")).toContain("\nReview  not reviewed\n");
  // A push Skelcrew didn't make is never merged here.
  const moved = { head: "f00d", checks: passed };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", moved));
  expect(rows().find((candidate) => candidate.name === "APP-14")?.merge).toEqual({
    refused: "app#41 has a newer commit than the one submitted: wait for its builder to submit it",
  });
  // Waiting on CI, it is under Checks.
  sql(`UPDATE threads SET needs_you = 0 WHERE folder = 'app-14';
UPDATE tasks SET checks = 'pending', ci_passed = 0 WHERE task = '14';`);
  expect(rows().find((candidate) => candidate.name === "APP-14")).toMatchObject({
    part: "checks",
    says: "checks",
  });
});

// A submit on a flow with no review stage whose push or check failed has no review round to
// have failed, so sc ps, sc ls and sc show say it isn't reviewed. Like a failed review, the
// lead hears of it and can run it again, so it doesn't need you.
test("a failed submit on a flow with no review shows as not reviewed, never a failed round", () => {
  sql(`UPDATE threads SET review_failed = 1, needs_you = 0 WHERE folder = 'app-14';
UPDATE tasks SET verdict = 'not reviewed', review_round = NULL, flow = 'noreview',
  submitting = 'Round 2' WHERE task = '14';`);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { listTasks, listThreads, printTasks, printThreads } from ${JSON.stringify(source("flow/list.ts"))};
const db = openDb();
printThreads(listThreads(db, "app"), false);
printTasks(listTasks(db, "app"), false);`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  const lines = run.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes("APP-14"));
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line).toContain("not reviewed");
    expect(line).not.toContain("failed");
  }
  expect(shown("14")).toContain("\nReview  not reviewed\n");
  expect(rows().find((row) => row.name === "APP-14")?.says).toBe("submit failed");
});

// sc ps shows no review in a repository with no forge, but a task its flow didn't review is
// ready on its branch with nobody having looked at it, so it says so.
test("sc ps says not reviewed for a task on a flow with no review, in a repository with no forge", () => {
  sql(`${threadSql({ repo: "site", task: "5", status: "waiting", needs_you: 1, verdict: "not reviewed", flow: "noreview" })}
${threadSql({ repo: "site", task: "6", status: "waiting", needs_you: 1, verdict: "approve", review_round: 1 })}`);
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { listThreads } from ${JSON.stringify(source("flow/list.ts"))};
console.log(JSON.stringify(listThreads(openDb(), "site")));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  if (!run.success) throw new Error(run.stderr.toString());
  const threads: { thread: string; review: unknown }[] = JSON.parse(run.stdout.toString());
  const review = (name: string) => threads.find((t) => t.thread === name)?.review;
  expect(review("SITE-5")).toEqual({ state: "not reviewed", round: null, at: null });
  expect(review("SITE-6")).toBeNull();
});

// The default flow gives 3 rounds of changes, so 4 is past the limit. A review run again after it
// approved, so the task is ready to merge, and the round limit no longer needs you.
test("a task approved past the round limit waits on you to merge, not on the limit", () => {
  sql("UPDATE tasks SET rounds = 4 WHERE task = '14';");
  const row = rows().find((candidate) => candidate.name === "APP-14");
  expect(row).toMatchObject({ section: "needs you", says: "ready to merge", needsYou: false });
});

test("each section's heading counts its tasks, open or closed", () => {
  const opened = new Set<Section>(["needs you", "up next", "building"]);
  expect(sectionHeadings(rows(), opened, "Building 1/1")).toEqual([
    { section: "needs you", count: 2, open: true, note: "" },
    { section: "up next", count: 1, open: true, note: "Building 1/1" },
    { section: "backlog", count: 1, open: false, note: "" },
    { section: "building", count: 1, open: true, note: "" },
    { section: "reviewing", count: 0, open: false, note: "" },
    { section: "checks", count: 0, open: false, note: "" },
    { section: "ready", count: 0, open: false, note: "" },
    { section: "done", count: 0, open: false, note: "" },
  ]);
});

// app runs three builders at most, and all three run, so app-20 and app-21 wait in its queue.
// app-21 joined first, so it starts first, though app-20 changed last.
function queueTwo(): void {
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\nlimits: { threads: 3 }\n");
  sql(`${threadSql({ task: "20", title: "Dark mode", status: "queued", queued_since: 2000, changed: now - 10_000 })}
${threadSql({ task: "21", title: "Search", status: "queued", queued_since: 1000, changed: now - 50_000 })}`);
}

test("Up next has the queued tasks in the order they start, then the paused ones", () => {
  queueTwo();
  const upNext = rows().filter((row) => row.section === "up next");
  expect(upNext.map((row) => [row.name, row.says, row.place, row.waits])).toEqual([
    ["APP-21", "starts next", 1, "Starts next: 3 of 3 builders busy"],
    ["APP-20", "2nd in line", 2, "2nd in line: 3 of 3 builders busy"],
    ["APP-9", "paused", null, "Paused with sc stop: sc start APP-9 brings it back"],
  ]);
  // A paused task waits on nobody but you, and nothing is wrong with it, so its mark is quiet.
  expect(upNext[2]?.mark).toEqual({ sign: "○", colour: "dim" });
});

// A queued task whose issue's claim hasn't reached the tracker holds back the queue, though
// builders are free, so it and every task after it say that is what they wait on.
test("a claim the tracker hasn't taken yet is what the queue waits on, with builders free", () => {
  queueTwo();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\nlimits: { threads: 5 }\n");
  sql("INSERT INTO claims (owner, repo, task) VALUES ('simon', 'app', '21');");
  const all = rows();
  const waits = all.filter((row) => row.place !== null).map((row) => [row.name, row.waits]);
  expect(waits).toEqual([
    ["APP-21", "Starts next: APP-21 waits for its issue's claim to reach the tracker"],
    ["APP-20", "2nd in line: APP-21 waits for its issue's claim to reach the tracker"],
  ]);
  expect(all.find((row) => row.name === "APP-31")?.start?.ask).toBe(
    "Queue APP-31? APP-21 waits for its issue's claim to reach the tracker, so it starts after the 2 queued. y/n",
  );
});

// A paused thread's last change can come from a poll, such as its CI, so the newest task comes
// first, however lately each changed.
test("Up next has the paused tasks newest first, whenever each last changed", () => {
  sql(
    threadSql({
      task: "22",
      title: "Newer work",
      status: "stopped",
      started: now - 1000,
      changed: now - 90_000,
    }),
  );
  sql(`UPDATE threads SET started = ${now - 9000} WHERE folder = 'app-9';`);
  const upNext = rows().filter((row) => row.section === "up next");
  expect(upNext.map((row) => row.name)).toEqual(["APP-22", "APP-9"]);
});

// A paused task that needs you shows under Needs you, with its mark as its word, and its details
// still say it is paused.
test("a paused task under Needs you still says what it waits on", () => {
  sql(
    `UPDATE threads SET needs_you = 1, needs_you_for = 'check the login' WHERE folder = 'app-9';`,
  );
  const row = rows().find((candidate) => candidate.name === "APP-9");
  expect(row).toMatchObject({
    section: "needs you",
    says: "check the login",
    waits: "Paused with sc stop: sc start APP-9 brings it back",
  });
});

test("with every builder busy, Up next's heading says how full they are, and s queues at the end", () => {
  queueTwo();
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { buildersNote } from ${JSON.stringify(source("list/rows.ts"))};
console.log(buildersNote(openDb(), { owner: "simon", repo: "app" }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(run.stdout.toString().trim()).toBe("Building 3/3 · 2 queued");
  const all = rows();
  const headings = sectionHeadings(all, new Set(sections), "Building 3/3 · 2 queued");
  const frame: Frame = {
    versions: ["v0.6.0"],
    where: "",
    name: "app",
    tabs: [],
    notice: "",
    bottom: "",
    load: "",
  };
  const drawn = drawList(all, headings, 0, 0, frame, { width: 80, height: 40 }).lines;
  expect(drawn.map((line) => Bun.stripANSI(line).trimEnd())).toContain(
    "   Up next   3  Building 3/3 · 2 queued",
  );
  expect(all.find((row) => row.name === "APP-31")?.start).toEqual({
    ask: "Queue APP-31? 3 of 3 builders busy, so it starts after the 2 queued. y/n",
    working: "Queueing APP-31…",
    request: { command: "start", repo: "simon/app", task: "31" },
    queues: true,
  });
  // Only a queued task in Up next can be moved in the queue, and only it offers the key.
  const queued = all.find((row) => row.name === "APP-20");
  expect(keysFor(queued, 1)).toContain("shift+↑↓ reorder");
  expect(
    keysFor(
      all.find((row) => row.name === "APP-9"),
      1,
    ),
  ).not.toContain("reorder");
  expect(
    keysFor(
      all.find((row) => row.name === "APP-31"),
      1,
    ),
  ).toContain("s queue");
});

test("without limits.threads, Up next's heading says nothing of the builders and s starts", () => {
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { buildersNote } from ${JSON.stringify(source("list/rows.ts"))};
console.log(JSON.stringify(buildersNote(openDb(), { owner: "simon", repo: "app" })));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(run.stdout.toString().trim()).toBe('""');
  expect(rows().find((row) => row.name === "APP-31")?.start?.queues).toBe(false);
});

// The copy of the forge drops a closed PR once its thread is done, so the task keeps the link.
test("a merged task keeps its PR's link after the copy of the forge drops the PR", () => {
  sql(
    "UPDATE threads SET status = 'done' WHERE folder = 'app-14'; UPDATE tasks SET merged = 1 WHERE task = '14';",
  );
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { prOf, saveItems } from ${JSON.stringify(source("flow/copy.ts"))};
const db = openDb();
saveItems(db, "simon", "app", [], ["pr"]);
console.log(prOf(db, "simon", "app", 41) === null ? "dropped" : "kept");`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(run.stdout.toString()).toBe("dropped\n");
  expect(rows().find((row) => row.name === "APP-14")).toMatchObject({
    part: "done",
    link: "https://github.com/simon/app/pull/41",
  });
});

// Starting a task over clears its PR, and the link saved for the earlier attempt's must not
// stand in for the new attempt's, which has none yet.
test("a task with no PR this attempt opens no saved link from an earlier one", () => {
  sql(
    `UPDATE tasks SET pr = NULL, pr_link = 'https://github.com/simon/app/pull/1' WHERE task = '14';`,
  );
  expect(rows().find((row) => row.name === "APP-14")?.link).toBeNull();
});

// A task that changed lately is what you are likely to look for, whenever it started.
test("within a section the task that changed last comes first", () => {
  // app-9 failed, so it stays under Building, as a paused one would be up next.
  sql(`UPDATE threads SET changed = ${now - 30_000} WHERE folder = 'app-7';
UPDATE threads SET status = 'failed' WHERE folder = 'app-9';`);
  const building = rows().filter((row) => row.section === "building");
  expect(building.map((row) => row.name)).toEqual(["APP-7", "APP-9"]);
  sql(`UPDATE threads SET changed = ${now - 10_000} WHERE folder = 'app-14';`);
  const needing = rows().filter((row) => row.section === "needs you");
  expect(needing.map((row) => row.name)).toEqual(["APP-14", "APP-12"]);
});

test("tasks under review and waiting on checks show in their own stages", () => {
  sql(`${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}`);
  const shown = rows().map((row) => [row.part, row.name, row.says]);
  expect(shown).toContainEqual(["reviewing", "APP-15", "reviewing"]);
  expect(shown).toContainEqual(["checks", "APP-16", "checks"]);
});

// The clock is 15:00 on 19 November. Ended tasks are saved as merged or closed, each with when
// it last changed.
test("Done shows the tasks that ended today, or the last ten when fewer ended today", () => {
  const hour = 3_600_000;
  // Returns SQL for tasks from `first` on, ended an hour apart, the first `back` hours ago.
  const ended = (first: number, count: number, back: number) =>
    Array.from({ length: count }, (_, i) =>
      threadSql({
        task: String(first + i),
        title: `Ended ${first + i}`,
        status: "done",
        merged: i % 2 === 0 ? 1 : 0,
        pr: first + i,
        changed: now - (back + i) * hour,
      }),
    ).join("\n");
  // Three today and twelve on earlier days: the three, then the latest seven before them.
  sql(`${ended(100, 3, 1)}\n${ended(200, 12, 24)}`);
  const done = () => rows().filter((row) => row.part === "done");
  expect(done().map((row) => row.name)).toEqual([
    ...["APP-100", "APP-101", "APP-102"],
    ...["APP-200", "APP-201", "APP-202", "APP-203", "APP-204", "APP-205", "APP-206"],
  ]);
  expect(done()[0]).toMatchObject({
    says: "merged",
    pr: "#100",
    when: "14:00",
    mark: { sign: "○", colour: "dim" },
    needsYou: false,
    session: null,
  });
  expect(done()[1]?.says).toBe("closed");
  expect(done()[3]).toMatchObject({ pr: "#200", when: "18 Nov" });
  // Twelve today: every one of them, and none from before.
  sql(ended(300, 9, 4));
  expect(done()).toHaveLength(12);
  expect(done().every((row) => /^\d\d:\d\d$/.test(row.when))).toBe(true);
  // Each takes one line: its mark, name and title, then when it ended, lined up.
  const lines = drawn(0, 40, 80, ["done"]).map((line) => line.trimEnd());
  expect(lines).toContain("   ○ APP-100  Ended 100  14:00");
  expect(lines).toContain("   ○ APP-308  Ended 308  03:00");
});

// A row stays short enough to read across: a merge when ready or messages waiting are for sc show.
test("a row says one short word, with no merge when ready or messages waiting after it", () => {
  sql(`UPDATE threads SET merge_plan = 'armed', merge_waits = 'its checks' WHERE folder = 'app-7';
INSERT INTO messages (folder, sender, text, said, at) VALUES ('app-7', 'lead', 'one', 'one', 0);`);
  const row = rows().find((candidate) => candidate.name === "APP-7");
  expect(row).toMatchObject({ says: "working", pr: "", when: "14:55" });
});

test("an issue whose work ended is back under Backlog, to start again", () => {
  sql("UPDATE threads SET status = 'done' WHERE folder = 'app-7';");
  sql(itemSql("app", "task", 7, "Login redirect", "2026-11-01T10:00:00Z"));
  expect(
    rows()
      .filter((row) => row.part === "backlog")
      .map((row) => row.name),
  ).toEqual(["APP-31", "APP-7"]);
});

// A task filed in Skelcrew's backlog waits beside the issues, by when it was filed, and Enter asks
// to start it as it does an issue.
test("a task in Skelcrew's backlog shows under Backlog beside the issues, newest first", () => {
  sql(`INSERT INTO backlog (owner, repo, task, title, body, created, by, filed_commit)
  VALUES ('simon', 'app', 't5', 'Add export', 'As JSON', '2026-11-07T10:00:00.000Z', 'simon', 'c1'),
    ('simon', 'app', 't6', 'Add import', 'From CSV', '2026-11-01T10:00:00.000Z', 'simon', 'c2');`);
  const backlog = rows().filter((row) => row.part === "backlog");
  expect(backlog.map((row) => [row.name, row.title, row.when])).toEqual([
    ["APP-T5", "Add export", "7 Nov"],
    ["APP-31", "Export as CSV", "5 Nov"],
    ["APP-T6", "Add import", "1 Nov"],
  ]);
  expect(backlog[0]?.start).toEqual({
    ask: "Start APP-T5? y/n",
    working: "Starting APP-T5…",
    request: { command: "start", repo: "simon/app", task: "t5" },
    queues: false,
  });
  expect(shown("t5")).toContain("Filed   by simon on 7 November 2026");
});

// Returns SQL for open issues from 100 on, each a day older than the one before.
const issuesSql = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    itemSql(
      "app",
      "task",
      100 + i,
      `Issue ${100 + i}`,
      `2026-11-${String(18 - i).padStart(2, "0")}T10:00:00Z`,
    ),
  ).join("\n");

// A long backlog would fill the list, so it shows its newest ten, and a row standing for the rest.
test("Backlog shows its newest ten issues, then a row for the rest, and every one when asked", () => {
  sql(issuesSql(12));
  const all = rows();
  const cut = cutBacklog(all, false).filter((row) => row.part === "backlog");
  expect(cut.map((row) => row.name)).toEqual([
    ...Array.from({ length: 10 }, (_, i) => `APP-${100 + i}`),
    "3 more",
  ]);
  expect(cut.at(-1)).toMatchObject({ more: 3, start: null, session: null });
  expect(keysFor(cut.at(-1), 1)).toContain("⏎ show all");
  // Its heading still counts every issue.
  expect(sectionHeadings(all, new Set())[2]).toMatchObject({ section: "backlog", count: 13 });
  // Asked for, Backlog is whole. One of ten or fewer always is.
  expect(cutBacklog(all, true)).toEqual(all);
  const few = all.filter((row) => row.part !== "backlog" || row.name < "APP-105");
  expect(cutBacklog(few, false)).toEqual(few);
  // It takes one line, under the issues.
  const shown = cutBacklog(all, false).filter((row) => ["lead", "backlog"].includes(row.part));
  const headings = sectionHeadings(all, new Set<Section>(["backlog"]));
  const drawnLines = drawList(shown, headings, 0, 0, frame, { width: 80, height: 40 }).lines;
  expect(drawnLines.map((line) => Bun.stripANSI(line).trimEnd())).toContain("   … 3 more");
});

test("Enter asks to start an issue, and m to merge a ready task at the commit you saw", () => {
  const [issue] = rows().filter((row) => row.part === "backlog");
  expect(issue?.start).toEqual({
    ask: "Start APP-31? y/n",
    working: "Starting APP-31…",
    request: { command: "start", repo: "simon/app", task: "31" },
    queues: false,
  });
  const [ready] = rows().filter((row) => row.part === "ready");
  expect(ready?.merge).toEqual({
    ask: "Merge app#41 into main? y/n",
    working: "Merging app#41…",
    request: { command: "merge", repo: "simon/app", pr: 41, commit: approved },
    queues: false,
  });
  expect(ready?.link).toBe("https://github.com/simon/app/pull/41");
  // A working task has nothing to merge.
  expect(rows().find((row) => row.name === "APP-7")?.merge).toBeNull();
});

// Merging approves no change to .agents/, so the question says when the approved commit makes one,
// from what a poll saved. A commit, or a base, no poll has looked at yet doesn't pass for one with
// no change: a PR retargeted at another base can bring other changes with the same head.
test("m's question says when the PR changes .agents/, or that Skelcrew hasn't checked yet", () => {
  const ask = () => {
    const merge = rows().find((row) => row.name === "APP-14")?.merge;
    return merge && "ask" in merge ? merge.ask : "";
  };
  sql("UPDATE pr_agents SET changed = 1 WHERE pr = '41';");
  expect(ask()).toBe(
    "Merge app#41 into main? It changes .agents/ (roles, flows or skills): the changes wait for sc repo trust. y/n",
  );
  const unchecked =
    "Merge app#41 into main? Skelcrew hasn't checked yet whether it changes .agents/. y/n";
  sql("UPDATE pr_agents SET base = 'next', changed = 0 WHERE pr = '41';");
  expect(ask()).toBe(unchecked);
  sql("UPDATE pr_agents SET base = 'main', head = 'f00d' WHERE pr = '41';");
  expect(ask()).toBe(unchecked);
});

// The list reads only the database, so it opens at once however many tasks are ready, and starts
// no git. A git that logs each call stands in for the real one.
test("a list with many tasks ready for review asks git nothing", () => {
  const more = [20, 21, 22, 23, 24].map(
    (
      task,
    ) => `${threadSql({ task: String(task), status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, pr: task + 100, review_round: 1, reviewed_commit: approved })}
${itemSql("app", "pr", task + 100, `PR ${task}`, "2026-11-06T10:00:00Z", { head: approved, checks: passed })}`,
  );
  sql(more.join("\n"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${join(home, "git-calls")}\n`, {
    mode: 0o755,
  });
  const ready = rows(bin).filter((row) => row.part === "ready");
  expect(ready).toHaveLength(6);
  expect(ready.every((row) => row.merge !== null && "ask" in row.merge)).toBe(true);
  expect(read(join(home, "git-calls"))).toBe("");
});

// An approval from before Skelcrew saved its commit can't say which commit it stands for.
test("an approval with no saved commit can't be merged here, and says so", () => {
  sql("UPDATE tasks SET reviewed_commit = NULL WHERE task = '14';");
  const merge = rows().find((row) => row.name === "APP-14")?.merge;
  expect(merge).toEqual({
    refused:
      "app#41's approval has no commit saved: merge it on the forge, or run sc review APP-14",
  });
});

test("a ready task whose forge sent no head commit can't be merged here, and says why", () => {
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z"));
  expect(rows().find((row) => row.name === "APP-14")?.merge).toEqual({
    refused: "app#41 needs a newer forge plugin to merge here: run sc plugin update",
  });
});

// The thread's verdict and checks can still describe the approved commit after a push moved the
// PR, so the list goes by the approved commit and the checks on the head.
test("a ready task whose PR moved past the approved commit, or whose checks there failed, can't be merged", () => {
  const moved = { head: "f00d", checks: [{ name: "test", id: "1", state: "passed" }] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", moved));
  expect(rows().find((row) => row.name === "APP-14")?.merge).toEqual({
    refused: "app#41 has a newer commit than the one approved: wait for its review",
  });
  const failed = { head: approved, checks: [{ name: "test", id: "1", state: "failed" }] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", failed));
  expect(rows().find((row) => row.name === "APP-14")?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
});

// The thread can still say CI passed while the forge's copy of the approved head has no checks
// yet, and a poll sets its checks back to none when they vanish. Only a head whose wait for CI's
// first check ended with none merges without checks, and its row says "no CI".
test("a ready task whose approved head has no checks yet can't be merged, unless no CI runs on it", () => {
  const unchecked = { head: approved, checks: [] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", unchecked));
  const row = () => rows().find((r) => r.name === "APP-14");
  expect(row()?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
  sql("UPDATE tasks SET checks = NULL WHERE task = '14';");
  expect(row()?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
  expect(row()?.checks).toBe("");
  // A wait that ended with no CI on another commit says nothing of this one.
  sql("UPDATE tasks SET no_ci = 'f00d' WHERE task = '14';");
  expect(row()?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
  // Once the wait for CI's first check on the approved head ended with none, it merges.
  sql(`UPDATE tasks SET no_ci = '${approved}' WHERE task = '14';`);
  const merge = row()?.merge;
  expect(merge && "ask" in merge ? merge.ask : "").toBe("Merge app#41 into main? y/n");
  expect(row()?.checks).toBe("no CI");
});

test("a forge's base branch reaches the merge question without its control codes", () => {
  const base = { head: approved, checks: passed, base: "main\x1b]0;evil\x07" };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", base));
  const merge = rows().find((row) => row.name === "APP-14")?.merge;
  // No poll has looked at the PR with this base, so the question says so too.
  expect(merge && "ask" in merge ? merge.ask : "").toBe(
    "Merge app#41 into main ]0;evil ? Skelcrew hasn't checked yet whether it changes .agents/. y/n",
  );
});

// The list's rows leave an armed merge out to stay short, so sc show says it, with what it waits
// on.
test("sc show says a task's armed merge and what it waits on", () => {
  expect(shown("7")).not.toContain("\nMerge ");
  sql(
    "UPDATE threads SET merge_plan = 'armed', merge_pinned = 'x', merge_waits = 'its checks' WHERE folder = 'app-7';",
  );
  expect(shown("7")).toContain("\nMerge   merges without approval · waiting on its checks\n");
});

// The list reads only the database: a builder runs while its thread works or waits, and a lead
// while its tab is open, as the daemon keeps it running.
test("a row knows whether its agent runs, and the lead says what its hooks last said", () => {
  sql("UPDATE repositories SET lead_state = 'asking' WHERE repo = 'app';");
  const running = rows();
  expect(running.find((row) => row.name === "lead")).toMatchObject({
    says: "asks you",
    title: "claude",
    mark: { sign: "●", colour: "yellow" },
    colour: "yellow",
    running: true,
  });
  expect(running.find((row) => row.name === "APP-7")?.running).toBe(true);
  expect(running.find((row) => row.name === "APP-9")?.running).toBe(false);
  sql("UPDATE repositories SET tab_closed = 1 WHERE repo = 'app';");
  expect(rows().find((row) => row.name === "lead")).toMatchObject({
    says: "stopped",
    mark: { sign: "○", colour: "dim" },
    running: false,
  });
});

// Ctrl-\ comes back only from tmux, so the list offers it only where Enter attaches there.
test("a row knows whether Enter attaches to its agent on tmux", () => {
  const onTmux = () => Object.fromEntries(rows().map((row) => [row.name, row.tmux]));
  expect(onTmux()).toMatchObject({ lead: true, "APP-7": true, "APP-14": false, "APP-31": false });
  sql("UPDATE threads SET host = 'fake' WHERE folder = 'app-7';");
  expect(onTmux()["APP-7"]).toBe(false);
});

// The notice of a release installed in the background comes from the database too, never from a
// file. The list, printed once as there is no terminal, shows only the database's.
test("the notice of an installed release comes from the database, not a file", () => {
  writeFileSync(join(home, ".local", "share", "skelcrew", "installed"), "9.9.8\n");
  const printed = () => {
    const code = `import { runList } from ${JSON.stringify(source("list/list.ts"))};
await runList("skel-test-${process.pid}-none", "simon/app");`;
    const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
    return run.stdout.toString();
  };
  expect(printed()).not.toContain("installed");
  sql("INSERT INTO installed (release) VALUES ('9.9.9');");
  expect(printed()).toContain("Skelcrew 9.9.9 installed · restart to use it");
});

// Printed, the list is whole: a task at work takes two lines, and none may scroll out of sight.
test("the list printed without a terminal has every task, however many are at work", () => {
  const more = Array.from({ length: 30 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - i * 60_000 }),
  );
  sql(more.join("\n"));
  const code = `import { runList } from ${JSON.stringify(source("list/list.ts"))};
await runList("skel-test-${process.pid}-none", "simon/app");`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  const printed = run.stdout.toString();
  for (let task = 50; task < 80; task += 1) expect(printed).toContain(`APP-${task}  Task ${task}`);
  expect(printed).toContain("APP-14  Fix the export header");
  expect(printed).toContain("APP-31  Export as CSV");
});

// The list reads no settings file, so it knows a thread is past its round limit from the changes
// the review held back for you.
test("a task past its round limit says so, from the changes its review held", () => {
  sql(
    "UPDATE tasks SET rounds = 4, held = 'Rename it.' WHERE task = '7'; UPDATE threads SET needs_you = 1, status = 'waiting' WHERE folder = 'app-7';",
  );
  expect(rows().find((row) => row.name === "APP-7")?.says).toBe("round limit");
});

// sc submit past the round limit drops the held changes and starts a review, and the thread
// still needs you while it runs. The task is where its work is: under review. The built-in
// round limit is 3.
test("a review running past the round limit is under Reviewing, and says round limit", () => {
  sql(
    threadSql({
      task: "42",
      title: "Past the limit",
      status: "waiting",
      rounds: 6,
      needs_you: 1,
      verdict: "changes",
      reviewing: "abc",
      pr: 42,
    }),
  );
  expect(rows().find((row) => row.name === "APP-42")).toMatchObject({
    part: "reviewing",
    says: "round limit",
    needsYou: true,
  });
});

// A thread within its round limit can need you during a review for another reason, such as a
// message that couldn't be typed in, which is never the round limit.
test("a review within the round limit that needs you for another reason never says round limit", () => {
  sql(
    threadSql({
      task: "44",
      title: "Within the limit",
      status: "waiting",
      rounds: 1,
      needs_you: 1,
      verdict: "changes",
      reviewing: "abc",
      pr: 44,
    }),
  );
  const row = rows().find((candidate) => candidate.name === "APP-44");
  expect(row?.part).toBe("reviewing");
  expect(row?.says).not.toBe("round limit");
});

// The changes held at the round limit say why the task waits, even once CI passed and something
// else cleared its need of you. Checks is only for an approval waiting on CI.
test("changes held at the round limit say round limit under Building, never checks", () => {
  sql(
    threadSql({
      task: "43",
      title: "Held",
      status: "waiting",
      rounds: 6,
      needs_you: 0,
      verdict: "changes",
      held: "Rename it.",
      checks: "passing",
      ci_passed: 1,
      pr: 43,
    }),
  );
  expect(rows().find((row) => row.name === "APP-43")).toMatchObject({
    part: "building",
    says: "round limit",
    checks: "CI passed",
  });
});

// A git that fails stands in for tmux and settings too: drawing must never need either.
test("the rows come from the database alone, with no tmux and no settings file", () => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const program of ["tmux", "git"])
    writeFileSync(
      join(bin, program),
      `#!/bin/sh\necho "${program} $@" >> ${join(home, "calls")}\nexit 1\n`,
      { mode: 0o755 },
    );
  writeFileSync(
    join(home, ".local", "share", "skelcrew", "repos", "simon", "app", "skelcrew.yaml"),
    "max_rounds: [not a number\n",
  );
  expect(rows(bin).map((row) => row.name)).toContain("APP-14");
  expect(read(join(home, "calls"))).toBe("");
});

// The list as drawn, given its rows, at 80 columns and 20 lines.
const frame = {
  versions: ["v0.6.0"],
  where: "",
  name: "app",
  tabs: [
    { name: "app", fullName: "simon/app", needYou: 1, colour: "yellow" as const, ready: 1 },
    { name: "site", fullName: "simon/site", needYou: 1, colour: "yellow" as const, ready: 0 },
  ],
  notice: "",
  bottom: keysFor(undefined, 1),
  load: "cpu 12%",
};
// Returns the list as drawn at the rows' clock, with only `open` sections showing their rows, as
// the list keeps them, on the row at `here` among those that show. Needs you and Building are
// open, as the list starts, unless `open` says otherwise.
function drawnWith(
  here: number,
  frameShown: typeof frame,
  size: { width: number; height: number },
  open: Section[] = ["needs you", "up next", "building"],
) {
  const all = rows();
  const opened = new Set(open);
  const shown = all.filter((row) => row.section === "lead" || opened.has(row.section));
  return drawList(shown, sectionHeadings(all, opened), here, 0, frameShown, size).lines;
}
const drawn = (here: number, height = 20, width = 80, open?: Section[]) =>
  drawnWith(here, frame, { width, height }, open).map((line) => Bun.stripANSI(line));

test("every section has its heading with its count, only open ones show rows, and every line fits", () => {
  const lines = drawn(1, 26);
  expect(lines[0]).toBe(" Skelcrew v0.6.0   app    site •1 ");
  // The lead and each task at work take two lines: mark, name and title, then the word with a
  // task's PR, CI and when it changed. So what it does sits under its title.
  expect(lines.slice(2, 24).map((line) => line.trimEnd())).toEqual([
    "   ○ lead    claude",
    "     running",
    "",
    "   Needs you 2",
    " ▸ ● APP-12  Rate limit the API",
    "     question · 14:58",
    "   ● APP-14  Fix the export header",
    "     ready to merge · #41 · CI passed",
    "",
    "   Up next   1",
    "   ○ APP-9   Old work",
    "     paused · 14:59",
    "",
    " 1 Backlog   1",
    " 2 Building  1",
    "   ○ APP-7   Login redirect",
    "     working · 14:55",
    "",
    " 3 Reviewing 0",
    " 4 Checks    0",
    " 5 Ready     0",
    " 6 Done      0",
  ]);
  // The bottom line has the keys, and the load at its right end, short of the last column.
  expect(lines.at(-1)).toBe(` ↑↓ move  ⏎ open  1-6 stages  q/esc quit${" ".repeat(32)}cpu 12%`);
  // Nothing reaches the last column, where a terminal would wait to wrap.
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(79);
  expect(lines).toHaveLength(26);
});

// Requests are pinned nowhere, so however many wait, the list keeps to the terminal's height, its
// bottom line shows, and the one you are on is in view, the oldest included.
test("many requests of the lead's scroll with the sections, and the one you are on stays in view", () => {
  sql(
    `INSERT INTO lead_requests (owner, repo, action, says, made) VALUES ${Array.from(
      { length: 30 },
      (_, at) => `('simon', 'app', '{"kind":"start","task":"31"}', 'Request ${at + 1}?', ${at})`,
    ).join(", ")};`,
  );
  const lines = drawn(1, 20);
  expect(lines).toHaveLength(20);
  expect(lines.slice(2, 6).map((line) => line.trimEnd())).toEqual([
    "   ○ lead    claude",
    "     running",
    "",
    " ▸ ● Request 30?",
  ]);
  expect(lines.at(-1)).toStartWith(" ↑↓ move");
  const oldest = drawn(30, 20);
  expect(oldest).toHaveLength(20);
  expect(oldest.some((line) => line.startsWith(" ▸ ● Request 1?"))).toBe(true);
  expect(oldest.at(-1)).toStartWith(" ↑↓ move");
});

test("an open section shows its rows, and its heading is bright while a closed one is dim", () => {
  const lines = drawn(1, 24, 80, ["backlog", "ready"]);
  // A task in Backlog or Done takes one line, in columns: mark, name, title, when it changed.
  expect(lines.slice(5, 15).map((line) => line.trimEnd())).toEqual([
    "   Needs you 2",
    "   Up next   1",
    " 1 Backlog   1",
    " ▸ ○ APP-31  Export as CSV  5 Nov",
    "",
    " 2 Building  1",
    " 3 Reviewing 0",
    " 4 Checks    0",
    " 5 Ready     0",
    " 6 Done      0",
  ]);
  const coloured = drawnWith(1, frame, { width: 80, height: 24 }, ["backlog"]);
  expect(coloured).toContain(" \x1b[90m1\x1b[22;39m \x1b[1mBacklog  \x1b[22;39m 1");
  expect(coloured).toContain(" \x1b[90m2\x1b[22;39m \x1b[90mBuilding \x1b[22;39m 1");
  // Needs you has no number key, and its count is yellow while any task waits on you.
  expect(coloured).toContain(
    " \x1b[90m \x1b[22;39m \x1b[90mNeeds you\x1b[22;39m \x1b[38;5;221m2\x1b[22;39m",
  );
});

// Each heading is a place you can be on, so Enter there can open or close its stage. Drawn while
// your typing goes elsewhere, as the screen's sidebar does, the row you are on is only outlined.
test("the rows shown have every heading among them, a heading you are on is shaded, and its keys say open/close", () => {
  const all = rows();
  const opened = new Set<Section>(["needs you", "up next", "building"]);
  const shown = shownRows(all, opened, false);
  const names = shown.map((row) => (row.part === "heading" ? `# ${row.section}` : row.name));
  expect(names).toEqual([
    "lead",
    "# needs you",
    "APP-12",
    "APP-14",
    "# up next",
    "APP-9",
    "# backlog",
    "# building",
    "APP-7",
    "# reviewing",
    "# checks",
    "# ready",
    "# done",
  ]);
  const at = names.indexOf("# building");
  const size = { width: 80, height: 26 };
  const { lines } = drawList(shown, sectionHeadings(all, opened), at, 0, frame, size);
  expect(lines.find((line) => Bun.stripANSI(line).startsWith(" 2 Building"))).toContain(
    "\x1b[48;5;238m",
  );
  expect(lines.some((line) => line.includes("▸"))).toBe(false);
  expect(keysFor(shown[at], 1)).toBe("↑↓ move  ⏎ open/close  1-6 stages  q/esc quit");
  // Needs you never closes, so Enter offers nothing on its heading.
  expect(keysFor(shown[1], 1)).toBe("↑↓ move  1-6 stages  q/esc quit");
  const outlined = drawRows(shown, sectionHeadings(all, opened), 0, 0, 60, 20, false).lines;
  expect(Bun.stripANSI(outlined[0] ?? "")).toStartWith(" ▹ ○ lead");
  expect(outlined[0]).not.toContain("48;5;238");
});

// Scrolling down onto a heading can leave it on the last line before the bottom edge, with its
// rows all below. A heading there is pinned at the edge, but not the one you are on, which must
// stay where you see it, shaded, with a row of its section under it.
test("the heading you are on never hides at the bottom edge, as the view goes down to its first row", () => {
  const all = rows();
  const opened = new Set<Section>(["needs you", "up next", "building"]);
  const shown = shownRows(all, opened, false);
  const at = shown.findIndex((row) => row.part === "heading" && row.section === "building");
  // The lead's 3 lines, then 10 lines of sections between the edges, end on Building's heading.
  const { lines } = drawRows(shown, sectionHeadings(all, opened), at, 0, 60, 15);
  const plain = lines.map((line) => Bun.stripANSI(line).trimEnd());
  const heading = plain.findIndex((line) => line.startsWith(" 2 Building"));
  expect(heading).toBeGreaterThan(0);
  expect(lines[heading]).toContain("\x1b[48;5;238m");
  expect(plain[heading + 1]).toContain("APP-7");
  expect(plain.at(-1)).toStartWith(" ↓");
  expect(plain.at(-1)).not.toContain("Building");
});

// Returns SQL for the tasks of the stages 1 to 4 test: more at work, one under review and two
// approved and waiting on CI.
const fourStagesSql = () => `${Array.from({ length: 6 }, (_, i) =>
  threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
).join("\n")}
${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}
${threadSql({ task: "17", title: "Approved too", status: "waiting", verdict: "approve", checks: "pending", pr: 47 })}`;

// However tall the terminal and wherever you are, an open stage's heading never shows with its
// rows out of view below it, and every stage's count stays in sight, on a narrow terminal too.
test("no open heading ends the view without its rows, and every count shows, at any size", () => {
  sql(fourStagesSql());
  const all = rows();
  const opened = new Set<Section>([
    "needs you",
    "up next",
    "backlog",
    "building",
    "reviewing",
    "checks",
  ]);
  const shown = all.filter((row) => row.section === "lead" || opened.has(row.section));
  const headings = sectionHeadings(all, opened);
  for (const width of [41, 80])
    for (let height = 9; height <= 30; height += 1)
      for (let here = 0; here < shown.length; here += 1) {
        const size = { width, height };
        const { lines, targets } = drawList(shown, headings, here, 0, frame, size);
        const plain = lines.map((line) => Bun.stripANSI(line));
        const where = `at ${width}x${height} on row ${here}:\n${plain.join("\n")}`;
        // The last line of the stages is the one before the bottom edge, two blank lines and
        // the keys, and a heading of an open stage with rows is never that line.
        targets.forEach((target, at) => {
          if (target === null || !("section" in target)) return;
          const hasRows = shown.some((row) => row.section === target.section);
          const after = targets[at + 1];
          if (opened.has(target.section) && hasRows)
            expect(after !== null && after !== undefined && "row" in after, where).toBe(true);
        });
        // Every heading shows, in full or pinned at an edge, in full or short words or by its
        // number key, once there is room for the edges.
        const text = plain.join("\n");
        if (height >= 12)
          ["Need", "Back", "Build", "Rev", "Chk", "Ready", "Done"].forEach((stage, at) => {
            const full =
              ["Needs you", "Backlog", "Building", "Reviewing", "Checks", "Ready", "Done"][at] ??
              "";
            const key = at === 0 ? "!:" : `${at}:`;
            const seenHere = [stage, full, key].some((name) => text.includes(name));
            expect(seenHere, `${stage} ${where}`).toBe(true);
          });
      }
});

test("an edge too wide for the terminal says its counts in fewer letters", () => {
  sql(fourStagesSql());
  const open: Section[] = ["needs you", "up next", "backlog", "building", "reviewing", "checks"];
  const lines = drawn(14, 16, 48, open).map((line) => line.trimEnd());
  expect(lines[5]).toBe(" ↑ +11  Need 2  Next 1  Back 1  Build 7  Rev 1");
  expect(lines[13]).toBe(" ↓ Ready 0   Done 0");
  // Narrower still, each stage goes by its number key, and how many rows are hidden stays.
  const narrow = drawn(14, 16, 28, open).map((line) => line.trimEnd());
  expect(narrow[5]).toBe(" ↑ +11 !:2 >:1 1:1 2:7 3:1");
});

// A heading pinned at an edge is clicked as the heading itself, by the columns it was drawn at.
test("a click on a heading pinned at an edge reaches its stage, by its columns", () => {
  sql(fourStagesSql());
  const all = rows();
  const opened = new Set<Section>([
    "needs you",
    "up next",
    "backlog",
    "building",
    "reviewing",
    "checks",
  ]);
  const shown = all.filter((row) => row.section === "lead" || opened.has(row.section));
  const headings = sectionHeadings(all, opened);
  const expected: [number, string[]][] = [
    [80, ["Needs you 2", "Up next 1", "Backlog 1", "Building 7", "Reviewing 1"]],
    [48, ["Need 2", "Next 1", "Back 1", "Build 7", "Rev 1"]],
    [28, ["!:2", ">:1", "1:1", "2:7", "3:1"]],
  ];
  for (const [width, names] of expected) {
    const size = { width, height: 16 };
    const { lines, targets } = drawList(shown, headings, 14, 0, frame, size);
    const edge = lines.findIndex((line) => Bun.stripANSI(line).startsWith(" ↑"));
    const target = targets[edge];
    if (!target || !("pinned" in target)) throw new Error(`no pinned headings at ${width}`);
    expect(target.pinned.map((span) => span.section)).toEqual([
      "needs you",
      "up next",
      "backlog",
      "building",
      "reviewing",
    ]);
    // Each span covers what is drawn for its stage, counted from 1.
    const text = Bun.stripANSI(lines[edge] ?? "");
    const drawnAt = target.pinned.map((span) => text.slice(span.from - 1, span.to));
    expect(drawnAt).toEqual(names);
  }
});

// A click reaches what was drawn where it lands, so the list hit-tests from its own layout.
test("each line drawn says what a click on it reaches", () => {
  const all = rows();
  const opened = new Set<Section>(["building"]);
  const shown = all.filter((row) => row.section === "lead" || opened.has(row.section));
  const { lines, targets } = drawList(shown, sectionHeadings(all, opened), 1, 0, frame, {
    width: 80,
    height: 24,
  });
  expect(targets).toHaveLength(lines.length);
  // Returns what a click reaches on the first line that shows `text`.
  const at = (text: string) =>
    targets[lines.findIndex((line) => Bun.stripANSI(line).includes(text))];
  expect(at("○ lead")).toEqual({ row: 0 });
  expect(at("running")).toEqual({ row: 0 });
  expect(at("Backlog")).toEqual({ section: "backlog" });
  expect(at("Ready")).toEqual({ section: "ready" });
  expect(at("APP-7")).toEqual({ row: shown.findIndex((row) => row.name === "APP-7") });
  expect(at("working · 14:55")).toEqual(at("APP-7"));
  expect(targets[0]).toBeNull();
  expect(targets.at(-1)).toBeNull();
});

test("a row's word is in its colour, its step and what follows it are dim, and its title is plain", () => {
  const all = rows().map((row) =>
    row.name === "APP-7"
      ? { ...row, step: "Editing rows.ts", pr: "#40", checks: "CI running" }
      : row,
  );
  const shown = all.filter((row) => row.part === "lead" || row.part === "building");
  const headings = sectionHeadings(all, new Set<Section>(["building"]));
  const size = { width: 80, height: 24 };
  const { lines } = drawList(shown, headings, 1, 0, frame, size);
  const at = lines.findIndex((line) => line.includes("APP-7"));
  expect(lines.slice(at, at + 3)).toEqual([
    "   \x1b[1m○\x1b[22;39m APP-7   Login redirect",
    "     \x1b[1mworking\x1b[22;39m\x1b[90m · Editing rows.ts · #40 · CI running · 14:55\x1b[22;39m",
    "",
  ]);
});

// A wide terminal used to lose the last letter of whatever reached its right edge.
test("a row as wide as the terminal stops short of its last column, cutting only its title", () => {
  const long = "A title long enough to run past the right edge of any terminal here";
  sql(`UPDATE tasks SET title = '${long}' WHERE task = '7';`);
  for (const width of [60, 61, 80]) {
    const lines = drawnWith(1, frame, { width, height: 24 }).map((line) => Bun.stripANSI(line));
    const row = lines.find((line) => line.includes("APP-7")) ?? "";
    expect(Bun.stringWidth(row)).toBe(width - 1);
    expect(row).toContain("APP-7   A title");
    expect(row).toEndWith("…");
  }
});

test("on a narrow terminal every line fits, the row you are on and a question included", () => {
  const asking = { ...frame, bottom: "Merge app#41 into main? y/n, a question longer than this" };
  for (const width of [1, 5, 8, 9, 10, 20, 30, 45]) {
    const lines = drawnWith(1, asking, { width, height: 20 }).map((line) => Bun.stripANSI(line));
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    // The row you are on shows its ▸ wherever there is room for it.
    if (width >= 3) expect(lines.filter((line) => line.includes("▸"))).toHaveLength(1);
    if (width >= 7) expect(lines.at(-1)).toStartWith(width > 20 ? " Merge app#41" : " Merge");
  }
});

test("another repository's badge counts what needs you in yellow and what is ready to merge in green", () => {
  const tabs = [
    { name: "app", fullName: "simon/app", needYou: 0, colour: "yellow" as const, ready: 0 },
    { name: "docs", fullName: "simon/docs", needYou: 0, colour: "yellow" as const, ready: 1 },
    { name: "site", fullName: "simon/site", needYou: 2, colour: "yellow" as const, ready: 1 },
  ];
  const [top = ""] = drawnWith(0, { ...frame, tabs }, { width: 80, height: 20 });
  // Every tab is on the left, the open one without its badge, each with a space inside it.
  expect(Bun.stripANSI(top)).toBe(" Skelcrew v0.6.0   app    docs •1    site •2 •1 ");
  expect(top).toContain("\x1b[38;5;120m•1");
  expect(top).toContain("\x1b[38;5;221m•2");
});

// The open repository's tab tells which one the list shows, so it keeps its place when others
// don't fit.
test("the open repository's tab shows when other tabs don't fit", () => {
  const tabs = ["alpha", "beta", "gamma", "app"].map((name) => ({
    name,
    fullName: `simon/${name}`,
    needYou: 0,
    colour: "yellow" as const,
    ready: 0,
  }));
  const [top = ""] = drawnWith(0, { ...frame, tabs }, { width: 40, height: 20 });
  expect(Bun.stripANSI(top)).toBe(" Skelcrew v0.6.0   alpha    app ");
  expect(top).toContain("\x1b[48;5;238m \x1b[1;38;5;231mapp");
  expect(tabAt({ ...frame, tabs }, 40, 30)).toBe("simon/app");
});

// A narrow list shows the longest name of the version that fits, so words around a checkout's
// commit give way before the commit is cut.
test("a narrow list shows a shorter name of the version, keeping the whole commit", () => {
  const versions = ["6f1c2ab* (checkout, * = uncommitted changes)", "checkout 6f1c2ab+changes"];
  const shown = { ...frame, versions, tabs: [] };
  const top = (width: number) =>
    Bun.stripANSI(drawnWith(0, shown, { width, height: 20 })[0] ?? "").trimEnd();
  expect(top(80)).toBe(" Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)");
  expect(top(40)).toBe(" Skelcrew checkout 6f1c2ab+changes");
  // The open repository's tab keeps its room, so the name gives way for it too.
  const app = [
    { name: "app", fullName: "simon/app", needYou: 0, colour: "yellow" as const, ready: 0 },
  ];
  const withTab = (width: number) =>
    Bun.stripANSI(drawnWith(0, { ...shown, tabs: app }, { width, height: 20 })[0] ?? "").trimEnd();
  expect(withTab(56)).toBe(" Skelcrew checkout 6f1c2ab+changes   app");
  expect(withTab(80)).toBe(" Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)   app");
  // On a remote, where it runs gives way before the version is cut.
  const far = { ...shown, where: "simon@a-long-server-name.example.com" };
  const remote = Bun.stripANSI(drawnWith(0, far, { width: 36, height: 20 })[0] ?? "").trimEnd();
  expect(remote).toBe(" Skelcrew checkout 6f1c2ab+changes");
  // A clean checkout keeps (checkout) over the place, so it never looks like a release.
  const clean = { ...far, versions: ["6f1c2ab (checkout)", "6f1c2ab"], where: "workbox" };
  const cleanTop = Bun.stripANSI(drawnWith(0, clean, { width: 30, height: 20 })[0] ?? "");
  expect(cleanTop.trimEnd()).toBe(" Skelcrew 6f1c2ab (checkout)");
});

test("a list taller than the terminal scrolls its stages, and its edges say what is hidden", () => {
  const more = Array.from({ length: 10 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  sql(more.join("\n"));
  // Needs you has app-12 and app-14. Building has by latest change app-9, app-7, then app-50 to
  // app-59. The last of them is the 14th task, at 14 among the rows after the lead.
  const lines = drawn(14, 16, 80, ["needs you", "up next", "building"]);
  // The lead stays. The headings scroll with their rows, and those out of sight are pinned
  // at the edge they went past, with their counts, so none goes out of sight.
  expect(lines.slice(2, 14).map((line) => line.trimEnd())).toEqual([
    "   ○ lead    claude",
    "     running",
    "",
    " ↑ 11 more   Needs you 2   Up next 1   Backlog 1   Building 11",
    "   ○ APP-57  Task 57",
    "     working · 14:43",
    "   ○ APP-58  Task 58",
    "     working · 14:42",
    " ▸ ○ APP-59  Task 59",
    "     working · 14:41",
    " 3 Reviewing  0",
    " ↓ Checks 0   Ready 0   Done 0",
  ]);
  expect(lines).toHaveLength(16);
});

test("on the lead, the list starts at Needs you, with what is below at the bottom edge", () => {
  const lines = drawn(0, 13, 80).map((line) => line.trimEnd());
  expect(lines.slice(5, 11)).toEqual([
    "",
    "   Needs you 2",
    "   ● APP-12  Rate limit the API",
    "     question · 14:58",
    "   ● APP-14  Fix the export header",
    " ↓ +3  Next 1  Back 1  Build 1  Rev 0  Chk 0  Ready 0  Done 0",
  ]);
});

// With several stages open on a short terminal, a stage's heading must never sit apart from its
// rows: one that shows with no rows under it reads as closed.
test("with stages 1 to 4 open, each heading in view sits right above its own rows", () => {
  const more = Array.from({ length: 6 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  sql(`${more.join("\n")}
${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}
${threadSql({ task: "17", title: "Approved too", status: "waiting", verdict: "approve", checks: "pending", pr: 47 })}`);
  const open: Section[] = ["needs you", "up next", "backlog", "building", "reviewing", "checks"];
  const at = (height: number, here: number) =>
    drawn(here, height, 80, open).map((line) => line.trimEnd());
  // On the first task in Building, the stages below it are pinned at the bottom edge.
  const top = at(16, 5);
  expect(top.slice(5, 14)).toEqual([
    " ↑ 2 more in Needs you   Needs you 2   Up next 1",
    "   ○ APP-9   Old work",
    "     paused · 14:59",
    " 1 Backlog   1",
    "   ○ APP-31  Export as CSV  5 Nov",
    " 2 Building  7",
    " ▸ ○ APP-7   Login redirect",
    "     working · 14:55",
    " ↓ 9 more   Reviewing 1   Checks 2   Ready 0   Done 0",
  ]);
  // On the last task in Checks, its heading and both its rows show, and the stages above it are
  // pinned at the top edge.
  const bottom = at(16, 14);
  expect(bottom.slice(5, 14)).toEqual([
    " ↑ 11 more   Needs you 2   Up next 1   Backlog 1   Building 7   Reviewing 1",
    "   ○ APP-15  Under review",
    "     reviewing · #45",
    " 4 Checks    2",
    "   ○ APP-17  Approved too",
    "     checks · #47 · CI running",
    " ▸ ○ APP-16  Approved",
    "     checks · #46 · CI running",
    " ↓ Ready 0   Done 0",
  ]);
  // The edges' counts keep their colours: what needs you is yellow.
  const coloured = drawnWith(14, frame, { width: 80, height: 16 }, open);
  expect(coloured).toContain(
    ` \x1b[90m↑\x1b[22;39m \x1b[90m11 more\x1b[22;39m   \x1b[38;5;221mNeeds you 2\x1b[22;39m   \x1b[90mUp next 1\x1b[22;39m   \x1b[90mBacklog 1\x1b[22;39m   \x1b[90mBuilding 7\x1b[22;39m   \x1b[90mReviewing 1\x1b[22;39m`,
  );
});

test("a terminal too short for every heading still shows the row you are on", () => {
  const more = Array.from({ length: 10 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  sql(more.join("\n"));
  // Nine lines leave two for the stages: the row you are on, whole, and no heading.
  const lines = drawn(14, 9, 80, ["needs you", "up next", "building"]);
  expect(lines).toHaveLength(9);
  expect(lines[2]).toMatch(/^ {3}○ lead/);
  expect(lines.slice(5, 7).map((line) => line.trim())).toEqual([
    "▸ ○ APP-59  Task 59",
    "working · 14:41",
  ]);
  // Eight leave one: the first line of the row you are on, with its ▸.
  const fewer = drawn(14, 8, 80, ["needs you", "up next", "building"]);
  expect(fewer.filter((line) => line.includes("▸"))).toEqual([
    expect.stringMatching(/^ ▸ ○ APP-59 +Task 59 *$/),
  ]);
});

// Stands in for the daemon on the test's own socket: it logs each request and answers a start, a
// move in the queue or a merge as the daemon would, and a lead or a merge with what a test sets.
function daemon(): void {
  const Request = z.object({
    command: z.string(),
    from: z.string().default(""),
    tab: z.boolean().default(false),
    repo: z.string().default(""),
    task: z.string().default(""),
    pr: z.number().default(0),
    commit: z.string().default(""),
    by: z.number().default(0),
    id: z.number().default(0),
    yes: z.boolean().default(false),
  });
  standIn = createServer((connection) =>
    connection.on("data", (data) => {
      const { command, from, tab, repo, task, pr, commit, by, id, yes } = Request.parse(
        JSON.parse(data.toString()),
      );
      if (command === "answer") asked.push(`answer ${repo} ${id} ${yes ? "yes" : "no"}`);
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      if (command === "start") asked.push(`start ${repo} ${task}`);
      if (command === "merge") asked.push(`merge ${repo} ${pr} ${commit}`);
      if (command === "queue move") asked.push(`queue move ${repo} ${task} ${by}`);
      const said =
        command === "lead"
          ? leadAnswer
          : command === "start"
            ? { started: "Started." }
            : command === "queue move"
              ? { said: `APP-${task} starts next` }
              : command === "answer"
                ? { said: yes ? "Started APP-31." : "Told the lead no." }
                : mergeAnswer;
      connection.end(`${JSON.stringify(said)}\n`);
    }),
  );
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  standIn.listen(join(home, "run", "skelcrew.sock"));
}

// Starts an agent that says its name and logs each line you type into it. It fails when told bye,
// which leaves its session behind with its last screen. It asks for extended keys as Claude Code
// does, with CSI > 4;2 m, or `asks` as given. It prints `says` first, as printf takes it.
const asClaude = "\\033[>4;2m";
// Codex asks as Claude Code does, and pushes kitty's keyboard flags too.
const asCodex = "\\033[>4;2m\\033[>1u";
function agent(name: string, labels: Labels, asks = asClaude, says = ""): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
printf '${asks}'
printf '${says}'
echo "I am ${name}"
while test -d ${JSON.stringify(home)}; do
  read -r line && echo "$line" >> ${name}.typed
  test "$line" = bye && exit 3
done
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH ?? "";
  startSession(agents, name, { folder: home, command: [script], env: { PATH: path }, labels });
}

// Runs tmux on the test's terminal.
const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", terminal, "-f", "/dev/null", ...args], {
    env: { ...env(), TMUX: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
// What you see in the terminal.
const seen = () => tmux("capture-pane", "-p", "-t", "=one:").stdout.toString();
// The row you are on, as the line with ▸ shows it.
const here = () =>
  seen()
    .split("\n")
    .find((line) => line.includes("▸"))
    ?.trim() ?? "";
// The line under the one with ▸, where a row at work says what it does.
const below = () => {
  const lines = seen().split("\n");
  return lines[lines.findIndex((line) => line.includes("▸")) + 1]?.trim() ?? "";
};
const until = (done: () => boolean, what: string) =>
  wait(done, { every: 30, what: () => `${what}:\n${seen()}` });
// Presses a key in the terminal, as tmux names it, or types text with `literal`.
const press = (key: string) => tmux("send-keys", "-t", "=one:", key);
const type = (text: string) => tmux("send-keys", "-t", "=one:", "-l", text);
// Presses Down, or Up as `key` says, one press at a time, until you are on the row that starts
// with `row`. The arrows stop on each heading too, so how many presses a row takes depends on the
// sections between. Each press waits for the grey of the row or heading you are on to move to
// another, as the next moves from there.
async function arrowTo(row: string, key: "Down" | "Up" = "Down"): Promise<void> {
  const at = () => {
    const lines = tmux("capture-pane", "-p", "-e", "-t", "=one:").stdout.toString().split("\n");
    const line = lines.findIndex((text, y) => y > 0 && text.includes("48;5;238"));
    return `${line} ${lines[line]}`;
  };
  for (let presses = 0; presses < 40 && !here().startsWith(row); presses++) {
    const before = at();
    press(key);
    await until(() => at() !== before, `a move ${key} towards ${row}`);
  }
  expect(here()).toStartWith(row);
}

// Opens the list of app in a terminal of its own, 100 columns wide unless `width` says, with the
// agents app-7, app-12 and the lead running. app-12 prints `says` first. `bin` is a folder of
// programs the list finds before the real ones. The terminal logs when the list returned, and its
// program waits `linger` milliseconds after that before it ends.
async function open({
  width = 100,
  bin = "",
  says = "",
  linger = 0,
}: {
  width?: number;
  bin?: string;
  says?: string;
  linger?: number;
} = {}): Promise<void> {
  daemon();
  agent("lead", { repository: "simon/app", role: "lead" });
  agent("app-7", { repository: "simon/app", role: "builder", task: "app-7" }, asCodex);
  agent("app-12", { repository: "simon/app", role: "builder", task: "app-12" }, asClaude, says);
  const script = join(home, "open.ts");
  writeFileSync(
    script,
    `import { runList } from ${JSON.stringify(source("list/list.ts"))};
await runList(${JSON.stringify(agents)}, "simon/app");
await Bun.write(${JSON.stringify(join(home, "left"))}, "left");
await Bun.sleep(${linger});
process.exit(0);`,
  );
  const path = bin ? `PATH=${bin}:${process.env.PATH ?? ""}` : "";
  const vars = `HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")} SKELCREW_FIXED_LOAD='cpu 12%' ${path}`;
  const command = `${vars} TERM=xterm-256color ${process.execPath} ${script}; sleep 300`;
  tmux("new-session", "-d", "-s", "one", "-x", String(width), "-y", "24", command);
  await until(() => seen().includes("q/esc quit"), "the list");
}

test("the list opens on the first task that needs you, and q leaves it with every agent running", async () => {
  await open();
  expect(seen()).toContain(" Skelcrew ");
  expect(seen()).toContain("site •1");
  expect(here()).toStartWith("▸ ● APP-12");
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  expect(seen()).toContain("Your agents keep running. Run sc --list to come back.");
  const sessions = Bun.spawnSync(["tmux", "-L", agents, "list-sessions", "-F", "#S"]);
  expect(sessions.stdout.toString().trim().split("\n").sort()).toEqual(["app-12", "app-7", "lead"]);
});

// A mark moves a task under Needs you, and clearing it moves it back, with you still on it.
test("a task moves into Needs you and back as its mark comes and goes, and you stay on it", async () => {
  await open();
  expect(seen()).toContain(" Needs you 2");
  // From app-12 down past app-14 and app-9 to app-7, under Building.
  await arrowTo("▸ ○ APP-7");
  sql(
    `UPDATE threads SET needs_you = 1, needs_you_for = 'apply the split', changed = ${now} WHERE folder = 'app-7';`,
  );
  await until(() => seen().includes(" Needs you 3"), "app-7 under Needs you");
  expect(here()).toStartWith("▸ ● APP-7");
  expect(below()).toStartWith("apply the split");
  // It is first under Needs you, as the one that changed last, right under its heading.
  const lines = seen().split("\n");
  expect(lines[lines.findIndex((line) => line.includes("Needs you")) + 1]).toContain("APP-7");
  sql("UPDATE threads SET needs_you = 0, needs_you_for = NULL WHERE folder = 'app-7';");
  await until(() => seen().includes(" Needs you 2"), "app-7 back under Building");
  expect(here()).toStartWith("▸ ○ APP-7");
  expect(below()).toStartWith("working");
});

// Reviewing is closed when the list starts, so a task that leaves Needs you for it opens it,
// rather than leave the list from under you.
test("a task leaving Needs you for a closed stage opens it, and you stay on it", async () => {
  sql(
    threadSql({
      task: "15",
      title: "Under review",
      status: "waiting",
      reviewing: "abc",
      pr: 45,
      needs_you: 1,
      needs_you_for: "apply the split",
      changed: now,
    }),
  );
  await open();
  await until(() => here().startsWith("▸ ● APP-15"), "APP-15 first under Needs you");
  expect(seen()).not.toContain("○ APP-15");
  sql("UPDATE threads SET needs_you = 0, needs_you_for = NULL WHERE folder = 'app-15';");
  await until(() => here().startsWith("▸ ○ APP-15"), "APP-15 under Reviewing");
  expect(below()).toStartWith("reviewing");
  const lines = seen().split("\n");
  expect(lines[lines.findIndex((line) => line.includes("▸")) - 1]).toMatch(/^ 3 Reviewing/);
});

// Leaving gives the terminal back, so a key that came with q must never act after it.
test("a key that comes with q in one read does nothing once the list has left", async () => {
  await open();
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  type("q\r");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  await Bun.sleep(500);
  const clients = Bun.spawnSync(["tmux", "-L", agents, "list-clients"]).stdout.toString();
  expect(clients).toBe("");
});

for (const [key, name] of [
  ["q", "q"],
  ["\x03", "Ctrl-C"],
] as const)
  test(`${name} leaves the list while a question is open, and answers nothing`, async () => {
    await open();
    type("1");
    await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
    press("Enter");
    await until(() => seen().includes("Start APP-31? y/n"), "the question");
    type(key);
    await until(() => read(join(home, "left")) === "left", "the list to leave");
    expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  });

test("Enter attaches to the builder, every key reaches it, and Ctrl-\\ comes back on the same row", async () => {
  await open();
  await arrowTo("▸ ○ APP-7");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  // q and m are the list's keys, but the agent has the keyboard now.
  type("q m hello");
  press("Enter");
  await until(() => read(join(home, "app-7.typed")) === "q m hello\n", "what was typed");
  press("C-\\");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ○ APP-7");
  expect(read(join(home, "left"))).toBe("");
});

// Ctrl-\ as your terminal sends it: one byte, or as an extended key in the kitty or the xterm
// form once a program asked for those, in hex as tmux takes it.
const back = {
  byte: ["1c"],
  kitty: "1b 5b 39 32 3b 35 75".split(" "),
  xterm: "1b 5b 32 37 3b 35 3b 39 32 7e".split(" "),
};
// Types bytes into the terminal as they are, in two reads when `split`, as over a slow link.
const sendBytes = async (bytes: string[], split: boolean) => {
  const half = split ? Math.ceil(bytes.length / 2) : bytes.length;
  tmux("send-keys", "-t", "=one:", "-H", ...bytes.slice(0, half));
  if (half === bytes.length) return;
  await Bun.sleep(50);
  tmux("send-keys", "-t", "=one:", "-H", ...bytes.slice(half));
};

// You may have scrolled an agent back, which puts its session in tmux's copy mode, where keys
// have a table of their own. Ctrl-\ must leave from there too, and never reach the agent. The
// lead stands in for Claude Code and app-7 for Codex. Each has its session's name and the name
// its row shows. APP-7 is six stops down, past Up next's row and the headings between.
for (const [form, bytes] of Object.entries(back))
  for (const [agent, shown, arrows, mark] of [
    ["app-7", "APP-7", ["Down", "Down", "Down", "Down", "Down", "Down"], "○"],
    ["lead", "lead", ["Up", "Up", "Up"], "○"],
  ] as const)
    test(`Ctrl-\\ as ${form} comes back from ${agent} on its row, in pieces or scrolled back`, async () => {
      await open();
      for (const arrow of arrows) press(arrow);
      await until(() => here().startsWith(`▸ ${mark} ${shown}`), `${agent}'s row`);
      for (const way of ["whole", "in pieces", "scrolled back"]) {
        press("Enter");
        await until(() => seen().includes(`I am ${agent}`), agent);
        if (way === "scrolled back")
          Bun.spawnSync(["tmux", "-L", agents, "copy-mode", "-t", `=${agent}:`]);
        await sendBytes(bytes, way === "in pieces");
        await until(() => here().startsWith(`▸ ${mark} ${shown}`), `the list again, ${way}`);
      }
      // A line typed now shows the agent got nothing of the keys that left it.
      press("Enter");
      await until(() => seen().includes(`I am ${agent}`), agent);
      type("done");
      press("Enter");
      await until(() => read(join(home, `${agent}.typed`)) !== "", "what was typed");
      expect(read(join(home, `${agent}.typed`))).toBe("done\n");
      expect(read(join(home, "left"))).toBe("");
    });

// Ctrl-\ is herdr's key to detach, and the only one on tmux. Ctrl-Q, which came back before,
// now stays with the agent.
test("Ctrl-Q no longer comes back from an agent", async () => {
  await open();
  await arrowTo("▸ ○ APP-7");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  press("C-q");
  await Bun.sleep(500);
  expect(seen()).toContain("I am app-7");
  expect(seen()).not.toContain("q/esc quit");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ APP-7"), "the list again");
});

// Ctrl-\ pressed once too often lands on the list, in whatever form your terminal sends it, and
// only q leaves the list. Alt-Q and Ctrl-Q, which once came back from an agent, leave nothing
// either.
test("Ctrl-\\ in every form, Alt-Q and Ctrl-Q do nothing on the list", async () => {
  await open();
  for (const bytes of Object.values(back)) {
    await sendBytes(bytes, false);
    await sendBytes(bytes, true);
  }
  press("M-q");
  press("C-q");
  await Bun.sleep(500);
  expect(here()).toStartWith("▸ ● APP-12");
  expect(read(join(home, "left"))).toBe("");
});

// A question takes y or n, and any other key is a no, but Ctrl-\ pressed once too often must
// not drop it.
test("Ctrl-\\ in every form leaves a question open, and y then answers it", async () => {
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start APP-31? y/n"), "the question");
  for (const bytes of Object.values(back)) await sendBytes(bytes, true);
  await Bun.sleep(300);
  expect(seen()).toContain("Start APP-31? y/n");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

// s starts a task not started yet as Enter does there, and the bottom line offers it, then says
// what the daemon answered.
test("s asks to start a task in Backlog, and y starts it", async () => {
  sql(`INSERT INTO backlog (owner, repo, task, title, body, created, by, filed_commit)
  VALUES ('simon', 'app', 't5', 'Add export', 'As JSON', '2026-11-07T10:00:00.000Z', 'simon', 'c1');`);
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-T5"), "the backlog task's row");
  expect(seen()).toContain("s start");
  type("s");
  await until(() => seen().includes("Start APP-T5? y/n"), "the question");
  type("y");
  await until(() => asked.includes("start simon/app t5"), "the start");
  // The line says what the daemon did, as the task could have been queued meanwhile.
  await until(() => seen().includes("Started."), "the daemon's answer");
});

// A request of the lead's is a line under the lead that never scrolls, y and n answer it at once
// by its ID, and the line then says what the daemon did.
test("y and n answer the lead's request you are on, and Enter says to use them", async () => {
  leadRequests();
  await open();
  const lines = seen().split("\n");
  const lead = lines.findIndex((line) => /○ lead +claude/.test(line));
  // The sections scroll here, so their top edge comes first, blank while nothing is above it.
  expect(lines[lead + 2]?.trim()).toBe("");
  expect(lines[lead + 3]).toMatch(/^ {3}● Start a new task: CSV {2}\[31mexport\? *$/);
  expect(lines[lead + 4]).toMatch(/^ {3}● Add the repository simon\/site\? *$/);
  expect(lines[lead + 5]).toMatch(/^ {3}● Start APP-31 Export as CSV\? *$/);
  expect(lines[lead + 6]?.trim()).toBe("");
  // The list starts on what needs you, right below the requests and Needs you's heading.
  await arrowTo("▸ ● Start APP-31", "Up");
  expect(seen()).toContain("y yes  n no");
  press("Enter");
  await until(() => seen().includes("Press y to say yes to the lead, or n to say no."), "how");
  type("y");
  await until(() => asked.includes("answer simon/app 1 yes"), "the yes");
  await until(() => seen().includes("Started APP-31."), "the daemon's answer");
  press("Up");
  await until(() => here().startsWith("▸ ● Add the repository"), "the next request");
  type("n");
  await until(() => asked.includes("answer simon/app 2 no"), "the no");
  await until(() => seen().includes("Told the lead no."), "the daemon's answer");
  // y and n on any other row do nothing.
  press("Up");
  press("Up");
  await until(() => here().startsWith("▸ ○ lead"), "the lead's row");
  type("y");
  await Bun.sleep(300);
  expect(asked.filter((line) => line.startsWith("answer"))).toHaveLength(2);
});

// The details pane on a request's row shows the lead at work, read without attaching, as the
// request is the lead's.
test("the details pane on a request of the lead's shows the lead's screen, with no details", async () => {
  leadRequests();
  await open({ width: 140 });
  await arrowTo("▸ ● Start APP-31", "Up");
  await until(() => seen().includes("I am lead"), "the lead's screen in the pane");
  expect(seen()).not.toContain("issue ");
  type("x");
  await Bun.sleep(300);
  expect(read(join(home, "lead.typed"))).toBe("");
});

// Shift with an arrow moves a queued task in its queue, through the daemon, and the bottom line
// says its new place. A paused task has no place, so nothing is asked.
test("shift+up on a queued task moves it earlier in the queue, and the line says its place", async () => {
  queueTwo();
  await open();
  await arrowTo("▸ ○ APP-20");
  expect(seen()).toContain("shift+↑↓ reorder");
  press("S-Up");
  await until(() => asked.includes("queue move simon/app 20 -1"), "the move");
  await until(() => seen().includes("APP-20 starts next"), "its place");
  press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "the paused row");
  press("S-Down");
  await until(() => seen().includes("APP-9 is paused: sc start APP-9 brings it back"), "why not");
  expect(asked.filter((line) => line.startsWith("queue move"))).toHaveLength(1);
});

// With every builder busy, s on Backlog asks to queue the task, and once queued the line keeps
// what the daemon said.
test("s on Backlog with every builder busy asks to queue it, and says what the daemon said", async () => {
  queueTwo();
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  expect(seen()).toContain("s queue");
  type("s");
  await until(() => seen().includes("Queue APP-31? 3 of 3 builders busy"), "the question");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
  await until(() => seen().includes("Started."), "the daemon's answer");
});

// Nothing on an agent's screen is Skelcrew's, so the title says how to come back, and the one
// you had comes back with you.
test("while attached the title names the agent and the key back, and the list shows the key", async () => {
  await open();
  expect(seen()).toContain("⏎ attach · ctrl+\\ back");
  const title = () =>
    tmux("display-message", "-p", "-t", "=one:", "#{pane_title}").stdout.toString();
  tmux("select-pane", "-t", "=one:", "-T", "my shell");
  press("Enter");
  await until(() => seen().includes("I am app-12"), "app-12's agent");
  await until(() => title() === "APP-12 · ctrl+\\ back\n", "the title");
  press("C-\\");
  await until(() => seen().includes("q/esc quit"), "the list again");
  await until(() => title() === "my shell\n", "the title you had");
});

test("an agent that ends while you are attached brings you back to the list, on its row", async () => {
  await open();
  await arrowTo("▸ ○ APP-7");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  type("bye");
  press("Enter");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ○ APP-7");
  expect(read(join(home, "left"))).toBe("");
});

// Keys typed fast, or over a slow link, can reach the list in one read with the Enter before them.
test("keys that come with Enter reach the agent, not the list", async () => {
  await open();
  await arrowTo("▸ ○ APP-7");
  // q and m would leave the list or merge, were the list to read them.
  type("\rq m now\r");
  await until(() => read(join(home, "app-7.typed")) === "q m now\n", "what was typed");
  expect(read(join(home, "left"))).toBe("");
  // The keys are typed into the agent before the list attaches, so Ctrl-\ waits for the agent's
  // screen: pressed earlier, it would land on the list, where it does nothing.
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ APP-7"), "the list again");
});

// You may have the agent open in a terminal of your own too, which isn't the list's to close.
test("an agent that ends detaches only the list's own client", async () => {
  await open();
  tmux(
    "new-session",
    "-d",
    "-s",
    "two",
    "-x",
    "80",
    "-y",
    "24",
    `TMUX= tmux -L ${agents} attach -t =app-7`,
  );
  const clients = () =>
    Bun.spawnSync(["tmux", "-L", agents, "list-clients", "-F", "#S"]).stdout.toString().trim();
  await until(() => clients() === "app-7", "the other client");
  await arrowTo("▸ ○ APP-7");
  press("Enter");
  await until(() => clients() === "app-7\napp-7", "both clients");
  type("bye");
  press("Enter");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(clients()).toBe("app-7");
});

// Over ssh an arrow's escape sequence can arrive in two reads, even split right after its Esc,
// which alone would leave the list. The pause between the pieces makes the list read the first
// on its own, yet is shorter than the wait that tells a lone Esc from an arrow.
test("an arrow whose escape sequence comes in two pieces still moves, and never leaves", async () => {
  await open();
  type("\x1b[");
  await Bun.sleep(40);
  type("B");
  await until(() => here().startsWith("▸ ● APP-14"), "the row below");
  type("\x1b");
  await Bun.sleep(40);
  type("[A");
  await until(() => here().startsWith("▸ ● APP-12"), "the row above");
  await Bun.sleep(300);
  expect(read(join(home, "left"))).toBe("");
});

test("Esc leaves the list", async () => {
  await open();
  type("\x1b");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
});

// Keys the list doesn't read, such as Left or PageUp, also start with Esc, and so do the answers
// a terminal sends to tmux's questions, which can reach the list once you leave an agent. None
// of them is an Esc.
test("keys the list doesn't read, and a terminal's answers, never leave it", async () => {
  await open();
  for (const key of ["Left", "Right", "Home", "End", "PPage", "F5", "M-x"]) press(key);
  type("\x1b[?1;2;4c\x1b[>84;0;0c\x1bP>|tmux 3.6\x1b\\");
  // APP-9 is past APP-14 and Up next's heading.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "the row below");
  await Bun.sleep(300);
  expect(read(join(home, "left"))).toBe("");
  expect(seen()).not.toContain("y/n");
});

// A stray Esc while you answer must not leave the list.
test("Esc with a question open answers no and stays, and a second Esc leaves", async () => {
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start APP-31? y/n"), "the question");
  type("\x1b");
  await until(() => !seen().includes("y/n"), "the question to close");
  await Bun.sleep(300);
  expect(read(join(home, "left"))).toBe("");
  expect(here()).toStartWith("▸ ○ APP-31");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  type("\x1b");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
});

// Ready is closed at first, so a task ready for review waits under its closed heading.
test("with nothing needing you, the list opens on the lead", async () => {
  sql(`UPDATE threads SET asking = 0, needs_you = 0 WHERE folder = 'app-12';
UPDATE threads SET merge_plan = 'armed' WHERE folder = 'app-14';`);
  await open();
  expect(here()).toStartWith("▸ ○ lead");
  expect(seen()).toContain("   Needs you 0");
  expect(seen()).toContain(" 5 Ready     1");
});

test("Building, Reviewing and Checks are open at first, and Backlog, Ready and Done closed", async () => {
  // Nothing waits under Needs you or Up next, so every open stage fits the terminal.
  sql(`UPDATE threads SET asking = 0, needs_you = 0 WHERE folder = 'app-12';
DELETE FROM threads WHERE folder IN ('app-9', 'app-14');
${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}
${threadSql({ task: "18", title: "Shipped", status: "done", changed: now })}`);
  await open();
  await until(() => seen().includes("○ APP-16"), "Checks' rows");
  expect(seen()).toContain("○ APP-7");
  expect(seen()).toContain("○ APP-15");
  expect(seen()).not.toContain("APP-31");
  expect(seen()).not.toContain("APP-18");
  // They stay toggles: 3 closes Reviewing and opens it again.
  type("3");
  await until(() => !seen().includes("APP-15"), "Reviewing closed");
  expect(seen()).toContain("○ APP-16");
  type("3");
  await until(() => seen().includes("○ APP-15"), "Reviewing open again");
});

test("the number keys open and close the stages, which stay so in another repository", async () => {
  await open();
  expect(seen()).not.toContain("APP-31");
  type("1");
  await until(() => seen().includes("○ APP-31"), "Backlog's rows");
  // Opening a stage moves you to its first row, so it shows wherever the list had scrolled.
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  type("2");
  await until(() => !seen().includes("APP-7"), "Building closed");
  expect(seen()).toContain("○ APP-31");
  press("Tab");
  // The open repository's tab has no badge, so another's shows only while it is open.
  await until(() => seen().includes(" app •"), "site's list");
  press("Tab");
  await until(() => seen().includes(" site •1"), "app's list again");
  expect(seen()).toContain("○ APP-31");
  expect(seen()).not.toContain("APP-7");
});

// The arrows stop on a heading, and Enter there opens or closes its stage, as a click does.
test("Enter on a stage's heading closes it, keeping you there, and opens it on its first row", async () => {
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "Backlog's first row");
  press("Up");
  await until(() => seen().includes("⏎ open/close"), "Backlog's heading");
  press("Enter");
  await until(() => !seen().includes("APP-31"), "Backlog to close");
  expect(seen()).toContain("⏎ open/close");
  press("Enter");
  await until(() => here().startsWith("▸ ○ APP-31"), "Backlog to open, on its first row");
});

test("a forge's refusal shows as words, its control codes never reaching your terminal", async () => {
  mergeAnswer = { error: "Refused:\x1b]0;evil\x07 the branch conflicts" };
  await open();
  // app-14 waits on you to merge it, under Needs you, right below app-12.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "the ready row");
  type("m");
  await until(() => seen().includes("y/n"), "the question");
  type("y");
  await until(() => seen().includes("the branch conflicts"), "the refusal");
  expect(seen()).toContain("Refused: ]0;evil  the branch conflicts");
  const title = tmux("display-message", "-p", "-t", "=one:", "#{pane_title}").stdout.toString();
  expect(title).not.toContain("evil");
});

test("Enter on a lead that can't start says why, and attaches to nothing", async () => {
  leadAnswer = { error: "Claude Code's login for agents is gone: run sc to set it up" };
  // You exited the lead, which closed its tab.
  sql("UPDATE repositories SET tab_closed = 1 WHERE repo = 'app';");
  await open();
  Bun.spawnSync(["tmux", "-L", agents, "kill-session", "-t", "=lead"]);
  for (const _ of [1, 2, 3]) press("Up");
  await until(() => here().startsWith("▸ ○ lead") && below() === "stopped", "the lead stopped");
  press("Enter");
  await until(
    () => seen().includes("The lead didn't start: Claude Code's login for agents is gone"),
    "why the lead didn't start",
  );
});

// A task that ended before Skelcrew saved PR links has none once its PR leaves the forge's copy.
test("Enter on a done task with a PR but no saved link names its PR", async () => {
  sql(`UPDATE threads SET status = 'done' WHERE folder = 'app-14';
UPDATE tasks SET merged = 1 WHERE task = '14';
DELETE FROM items WHERE kind = 'pr';`);
  await open();
  type("6");
  await until(() => here().startsWith("▸ ○ APP-14"), "the done row");
  press("Enter");
  await until(() => seen().includes("APP-14's PR #41 has no link saved"), "what Enter says");
});

test("Enter on the lead attaches to it", async () => {
  await open();
  for (const _ of [1, 2, 3]) press("Up");
  await until(() => here().startsWith("▸ ○ lead"), "the lead's row");
  press("Enter");
  await until(() => seen().includes("I am lead"), "the lead");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ lead"), "the list on the lead's row");
});

// A builder on a runtime plugin's host isn't in tmux, so Enter runs the host's own attach on its
// ID there, and leaving that comes back to the list on the same row.
test("Enter on a builder on a plugin's host attaches to it through that host", async () => {
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "attach.sh"), 'echo "I am $1 on fake"; read -r line\n');
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, attach.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('fake', '${plugin}');
UPDATE threads SET host = 'fake', host_id = 'fake-app-12' WHERE folder = 'app-12'`);
  await open();
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  // The host has a key of its own to come back, so the list doesn't offer tmux's.
  expect(seen()).toContain("⏎ attach  ");
  expect(seen()).not.toContain("ctrl+\\ back");
  press("Enter");
  await until(() => seen().includes("I am fake-app-12 on fake"), "the host's attach");
  press("Enter");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ● APP-12");
  expect(read(join(home, "left"))).toBe("");
});

test("Enter on a builder that isn't running says so, and attaches to nothing", async () => {
  sql(`UPDATE threads SET status = 'failed' WHERE folder = 'app-7'`);
  await open();
  await arrowTo("▸ ○ APP-7");
  press("Enter");
  await until(
    () => seen().includes("APP-7's builder isn't running: sc start APP-7 brings it back"),
    "why it can't attach",
  );
});

// A paused task is up next, with no builder running, so Enter says how to bring it back.
test("Enter on a paused task says how to bring it back, and attaches to nothing", async () => {
  await open();
  // Past APP-14 and Up next's heading.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "APP-9's row");
  press("Enter");
  await until(
    () => seen().includes("Paused with sc stop: sc start APP-9 brings it back"),
    "what it waits on",
  );
});

test("Enter on an issue asks first: any key but y starts nothing, and y starts it", async () => {
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start APP-31? y/n"), "the question");
  type("n");
  await until(() => seen().includes("q/esc quit"), "the keys again");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  press("Enter");
  await until(() => seen().includes("Start APP-31? y/n"), "the question again");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

// A y typed with Enter, before the question showed, must never answer it.
test("keys that come with Enter on an issue are dropped, so they can't answer its question", async () => {
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-31"), "the issue's row");
  type("\ryq");
  await until(() => seen().includes("Start APP-31? y/n"), "the question");
  await Bun.sleep(300);
  expect(seen()).toContain("Start APP-31? y/n");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  expect(read(join(home, "left"))).toBe("");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

test("a y that comes with m in one read can't answer the merge question", async () => {
  await open();
  // app-14 waits on you to merge it, under Needs you, right below app-12.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "the ready row");
  type("my");
  await until(() => seen().includes("Merge app#41 into main? y/n"), "the question");
  await Bun.sleep(300);
  expect(seen()).toContain("Merge app#41 into main? y/n");
  expect(asked.filter((line) => line.startsWith("merge"))).toEqual([]);
  type("y");
  await until(() => asked.includes(`merge simon/app 41 ${approved}`), "the merge");
});

// The forge only checks that the head is still the commit asked for, so the list must check the
// rest again when you answer.
test("a merge whose checks failed while its question was open merges nothing, and says why", async () => {
  await open();
  // app-14 waits on you to merge it, under Needs you, right below app-12.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "the ready row");
  type("m");
  await until(() => seen().includes("Merge app#41 into main? y/n"), "the question");
  const failed = { head: approved, checks: [{ name: "test", id: "1", state: "failed" }] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", failed));
  type("y");
  await until(
    () => seen().includes("app#41's checks haven't passed on the approved commit yet"),
    "why it didn't merge",
  );
  expect(asked.filter((line) => line.startsWith("merge"))).toEqual([]);
});

test("m on a task ready for review asks first, and y merges it at the commit you saw", async () => {
  await open();
  // app-14 waits on you to merge it, under Needs you, right below app-12.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "the ready row");
  expect(seen()).toContain("m merge");
  type("m");
  await until(() => seen().includes("Merge app#41 into main? y/n"), "the question");
  type("y");
  await until(() => asked.includes(`merge simon/app 41 ${approved}`), "the merge");
});

test("Tab moves to the next repository and has the daemon open it, without reopening a closed tab", async () => {
  await open();
  press("Tab");
  await until(() => seen().includes("SITE-3"), "site's list");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});

// Shift-Tab and Alt-Shift with an arrow move between repositories too, in every form a terminal
// sends them, each way round from the last to the first and back.
test("Shift-Tab and Alt-Shift-Left go back a repository, Alt-Shift-Right on, wrapping round", async () => {
  await open();
  const onSite = () => seen().includes("SITE-3");
  const onApp = () => seen().includes("APP-12");
  // app is the first tab, so back from it wraps round to site, the last.
  press("BTab");
  await until(onSite, "site, back from app");
  type("\x1b[1;4C");
  await until(onApp, "app, on from site");
  type("\x1b[1;4D");
  await until(onSite, "site, back from app");
  type("\x1b[1;4:1C");
  await until(onApp, "app, on from site in kitty's form");
  type("\x1b[9;2u");
  await until(onSite, "site, back from app with kitty's Shift-Tab");
  type("\x1b[27;2;9~");
  await until(onApp, "app, back from site with xterm's Shift-Tab");
  type("\x1b[1;4:1D");
  await until(onSite, "site, back from app in kitty's form");
  // Kitty's keypad arrows, in its CSI-u form, plain and with the press event.
  type("\x1b[57418;4u");
  await until(onApp, "app, on from site, wrapping round, in kitty's CSI-u form");
  type("\x1b[57417;4u");
  await until(onSite, "site, back from app, wrapping round, in kitty's CSI-u form");
  type("\x1b[57418;4:1u");
  await until(onApp, "app, on from site in kitty's CSI-u form with its event");
  type("\x1b[57417;4:1u");
  await until(onSite, "site, back from app in kitty's CSI-u form with its event");
  expect(seen()).toContain("⇥/alt+shift+←→ repository");
});

// Backlog's last row stands for the issues it doesn't show, and Enter shows them.
test("Enter on Backlog's last row shows every issue", async () => {
  sql(issuesSql(12));
  await open();
  type("1");
  await until(() => here().startsWith("▸ ○ APP-100"), "Backlog's first issue");
  for (const _ of Array.from({ length: 10 })) press("Down");
  await until(() => here().startsWith("▸ … 3 more"), "the row for the rest");
  press("Enter");
  await until(() => seen().includes("APP-110"), "every issue");
  expect(seen()).not.toContain("… 3 more");
  // The last issue is a row further down, which moving there scrolls into view.
  press("Down");
  await until(() => here().startsWith("▸ ○ APP-111"), "the last issue");
});

// Opening a stage shows its rows, however far the list had scrolled.
test("opening a stage with its key brings its heading and first rows into view", async () => {
  const more = Array.from({ length: 12 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  // With a merge armed, app-14 waits on nobody, so it is under Ready.
  sql(`${more.join("\n")}
UPDATE threads SET merge_plan = 'armed' WHERE folder = 'app-14';`);
  await open();
  await arrowTo("▸ ○ APP-61");
  type("5");
  await until(() => here().startsWith("▸ ○ APP-14"), "Ready's first task");
  const lines = seen()
    .split("\n")
    .map((line) => line.trimEnd());
  const at = lines.findIndex((line) => line.includes("▸"));
  expect(lines[at - 1]).toMatch(/^ 5 Ready +1$/);
});

// Returns the line, counted from 1 as your terminal reports a click, that shows `text` first.
const lineOf = (text: string) =>
  seen()
    .split("\n")
    .findIndex((line) => line.includes(text)) + 1;
// Presses the left button on a line and lets it go, as your terminal reports it in SGR.
const clickOn = (line: number) => type(`\x1b[<0;10;${line}M\x1b[<0;10;${line}m`);
// Whether the terminal's pane has mouse reporting on, as tmux keeps it for the pane.
const mouseOn = () =>
  tmux("display", "-p", "-t", "=one:", "#{mouse_standard_flag}#{mouse_sgr_flag}")
    .stdout.toString()
    .trim() === "11";

test("a click on a task selects it, and a second click opens it, as Enter does", async () => {
  await open();
  expect(mouseOn()).toBe(true);
  clickOn(lineOf("APP-7"));
  await until(() => here().startsWith("▸ ○ APP-7"), "APP-7 selected");
  expect(seen()).not.toContain("I am app-7");
  // Its second line is part of its row too.
  clickOn(lineOf("APP-7") + 1);
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  // The agent gets the mouse as your terminal would give it: the list's reporting is off.
  expect(mouseOn()).toBe(false);
  press("C-\\");
  await until(() => here().startsWith("▸ ○ APP-7"), "the list on APP-7's row");
  expect(mouseOn()).toBe(true);
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  expect(mouseOn()).toBe(false);
});

// A release comes after its press, often in a read of its own, after the press already asked
// its question. It must not answer it.
test("a click that asks a question isn't answered by its button's release", async () => {
  await open();
  clickOn(lineOf("Backlog"));
  await until(() => here().startsWith("▸ ○ APP-31"), "Backlog open, on its issue");
  const line = lineOf("APP-31");
  type(`\x1b[<0;10;${line}M`);
  await until(() => seen().includes("Start APP-31? y/n"), "the question");
  type(`\x1b[<0;10;${line}m`);
  await Bun.sleep(300);
  expect(seen()).toContain("Start APP-31? y/n");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

// The rest of the click that attaches, and any mouse report after it in the same read, are the
// list's, and never reach the agent's prompt as text.
test("a click that attaches types no mouse report into the agent", async () => {
  await open();
  clickOn(lineOf("APP-7"));
  await until(() => here().startsWith("▸ ○ APP-7"), "APP-7 selected");
  const line = lineOf("APP-7");
  type(`\x1b[<0;10;${line}M\x1b[<0;10;${line}m\x1b[<65;10;3M\x1b[<0;10;${line}M`);
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  type("hello");
  press("Enter");
  await until(() => read(join(home, "app-7.typed")) === "hello\n", "only what was typed");
});

test("a click on a heading pinned at the bottom edge opens its stage", async () => {
  const more = Array.from({ length: 12 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  // With a merge armed, app-14 waits on nobody, so it is under Ready.
  sql(`${more.join("\n")}
UPDATE threads SET merge_plan = 'armed' WHERE folder = 'app-14';`);
  await open();
  const edge = () =>
    seen()
      .split("\n")
      .find((line) => line.startsWith(" ↓")) ?? "";
  await until(() => edge().includes("Ready 1"), "Ready pinned at the bottom edge");
  type(`\x1b[<0;${edge().indexOf("Ready") + 2};${lineOf(" ↓")}M`);
  await until(() => here().startsWith("▸ ○ APP-14"), "Ready open, on its task");
});

test("a click on the lead's row opens the lead at once", async () => {
  await open();
  clickOn(lineOf("lead    claude"));
  await until(() => seen().includes("I am lead"), "the lead");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ lead"), "the list on the lead's row");
});

test("a click on a stage's heading opens or closes it, and the wheel moves a row", async () => {
  await open();
  // Needs you and Up next have no key to open them again, so a click on their heading leaves
  // them open.
  clickOn(lineOf("Needs you"));
  clickOn(lineOf("Up next"));
  await Bun.sleep(300);
  expect(seen()).toContain("● APP-12");
  expect(seen()).toContain("○ APP-9");
  clickOn(lineOf("Backlog"));
  await until(() => here().startsWith("▸ ○ APP-31"), "Backlog open, on its issue");
  clickOn(lineOf("Building"));
  await until(() => !seen().includes("APP-7"), "Building closed");
  clickOn(lineOf("Building"));
  await until(() => seen().includes("APP-7"), "Building open again");
  // The wheel down, then up, as SGR reports it, with the pointer anywhere.
  await until(() => here().startsWith("▸ ○ APP-7"), "Building's first task");
  // A row up from Building's first task is Building's heading.
  type("\x1b[<64;10;3M");
  await until(() => seen().includes("⏎ open/close"), "a row up");
  type("\x1b[<65;10;3M");
  await until(() => here().startsWith("▸ ○ APP-7"), "a row down");
  // A click on a blank line reaches nothing.
  clickOn(2);
  expect(here()).toStartWith("▸ ○ APP-7");
});

// A Skelcrew run from a checkout names its commit, read from git as the engine reads it, and says
// when it has changes not committed. A stand-in git names the commit, and passes the rest on.
test("from a checkout, the top line names its commit and its uncommitted changes", async () => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const body = `case "$*" in *"rev-parse --short HEAD"*) echo 6f1c2ab;; *"status --porcelain"*) echo " M src/main.ts";; *) exec ${Bun.which("git")} "$@";; esac`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await open({ bin });
  expect(seen().split("\n")[0]).toStartWith(
    " Skelcrew 6f1c2ab* (checkout, * = uncommitted changes)   app",
  );
});

// The tabs are on the top line, left after Skelcrew's version. Your terminal reports a click by
// its column and row, counted from 1, as typed here.
test("a click on a repository's tab opens it, and a click elsewhere does nothing", async () => {
  await open();
  const top = seen().split("\n")[0] ?? "";
  expect(top).toMatch(/^ Skelcrew .+? {3}app {4}site •1$/);
  type(`\x1b[<0;${top.indexOf("site") + 1};2M`);
  type(`\x1b[<0;${top.indexOf("site") + 1};1M\x1b[<0;${top.indexOf("site") + 1};1m`);
  await until(() => seen().includes("SITE-3"), "site's list");
  // It opens on site's task that needs you, as the list does on any repository.
  expect(here()).toStartWith("▸ ● SITE-3");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});

// The details pane, in a terminal 140 columns wide, which has room for it beside the list.
const wide = 140;
// What the pane shows, as the part of each line right of its edge, between the top line and the
// bottom one.
const paneSeen = () => {
  const from = wide - 1 - paneWidth(wide);
  return seen()
    .split("\n")
    .slice(1, 23)
    .map((line) => line.slice(from).trimEnd());
};
// Returns the pane's lines from the line under the one between the details and the agent's screen.
const liveSeen = () => {
  const lines = paneSeen();
  return lines.slice(lines.findLastIndex((line) => line.startsWith("───")) + 1);
};
// Returns whether the pane shows a task's details from their top, by the task's name and title
// on their first line, such as `APP-12  Rate limit the API`.
const titled = (title: string) => paneSeen()[0]?.startsWith(title) ?? false;

// app-12 asks a question and has an issue's link. app-14's PR has a check that failed, whose log
// sc show would ask the forge for, and Skelcrew's review on it found two things.
test("the pane follows the row you are on, is empty on the lead's, and never asks the forge", async () => {
  sql(`UPDATE tasks SET issue_link = 'https://github.com/simon/app/issues/12', body = 'Limit each client.' WHERE task = '12';
UPDATE tasks SET review_post = '{"pr":41,"id":"9","verdict":"approve","findings":["Name the limit","Test the header"]}' WHERE task = '14';
${itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", { head: approved, checks: [...passed, { name: "build", id: "2", state: "failed" }] })}`);
  await open({ width: wide });
  expect(here()).toStartWith("▸ ● APP-12");
  await until(() => titled("APP-12  Rate limit the API"), "app-12's details");
  expect(paneSeen().slice(0, 10)).toEqual([
    `APP-12  Rate limit the API${" ".repeat(62)}Building`,
    "─".repeat(paneWidth(wide)),
    "Needs you: question",
    "",
    "Now      question · 1d ago",
    "Issue    #12  https://github.com/simon/app/issues/12",
    "",
    "Task",
    "Limit each client.",
    "",
  ]);
  // Its agent runs, so its screen shows below.
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  // Past app-14, under Needs you too, and Up next's heading, to app-9.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => titled("APP-9  Old work"), "app-9's details");
  expect(liveSeen()[0]).toBe("Builder not running");
  // The lead's row isn't a task, so the pane is empty, its edge alone showing. It is five stops
  // up, past the headings of Up next and Needs you.
  for (const _ of [1, 2, 3, 4, 5]) press("Up");
  await until(() => here().startsWith("▸ ○ lead"), "the lead's row");
  await until(() => paneSeen().every((line) => line === ""), "an empty pane");
  // Past Needs you's heading and APP-12.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  await until(() => titled("APP-14  Fix the export header"), "app-14's details");
  expect(paneSeen()).toContain("PR       #41  https://github.com/simon/app/pull/41");
  expect(paneSeen()).toContain("CI       ✓ test  ✗ build");
  expect(paneSeen()).toContain("Review   Round 1 · approved");
  expect(paneSeen()).toContain("         1. Name the limit");
  // Nothing in the pane asked the forge, not even for the failed check's log.
  expect(pluginAsked(join(home, ".config", "skelcrew", "plugins", "github"))).toEqual([]);
});

// A review in a repository with no forge, or one whose posting failed, has no review on a PR,
// and its findings are still the task's.
test("the pane shows the latest review's findings though it was never posted", async () => {
  sql(`UPDATE tasks SET review_round = 1, verdict = 'changes',
  review_findings = '["Name the limit","Test the header"]' WHERE task = '12'`);
  await open({ width: wide });
  await until(() => titled("APP-12  Rate limit the API"), "app-12's details");
  expect(paneSeen()).toContain("Review   Round 1 · changes asked");
  expect(paneSeen()).toContain("         1. Name the limit");
  expect(paneSeen()).toContain("         2. Test the header");
});

test("o shows the agent's whole screen in the pane and back, and Enter still attaches", async () => {
  await open({ width: wide, says: "step one\\nstep two\\nstep three\\nstep four\\n" });
  // By default the pane shows a strip of the agent's last three lines under the details.
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  expect(liveSeen().filter((line) => line !== "")).toEqual([
    "step three",
    "step four",
    "I am app-12",
  ]);
  expect(seen()).toContain("⏎ attach · ctrl+\\ back · o output");
  type("o");
  await until(() => liveSeen().includes("step one"), "the whole screen");
  expect(liveSeen().slice(0, 5)).toContain("step two");
  // It stays as you move, and o brings the strip back.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  press("Up");
  await until(() => liveSeen().includes("step one"), "the whole screen on app-12 again");
  type("o");
  await until(() => !liveSeen().includes("step one"), "the strip again");
  // Enter still attaches to the builder.
  press("Enter");
  await until(() => !seen().includes("q/esc quit"), "app-12's agent");
  type("hello");
  press("Enter");
  await until(() => read(join(home, "app-12.typed")) === "hello\n", "what was typed");
  press("C-\\");
  await until(() => seen().includes("q/esc quit"), "the list again");
});

// app-12's description is far taller than the pane: 30 short paragraphs, the last one ending it.
const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");

test("a long description scrolls in the pane by Page Down, Page Up and the wheel, the strip staying put", async () => {
  sql(`UPDATE tasks SET body = '${paragraphs}' WHERE task = '12'`);
  await open({ width: wide, says: "step one\\nstep two\\n" });
  await until(() => titled("APP-12  Rate limit the API"), "app-12's details");
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  expect(seen()).toContain("o output · pgup/pgdn scroll");
  // The details fill the pane down to the strip, their last line saying there is more.
  const strip = liveSeen();
  const rule = paneSeen().findLastIndex((line) => line.startsWith("───"));
  expect(paneSeen()[rule - 1]).toBe("↓ more");
  // Page Down shows the details further down, and the strip stays under them, as it was.
  press("NPage");
  // A page can end on the blank line between two paragraphs, so either of the top two lines may
  // be the paragraph.
  await until(
    () =>
      paneSeen()
        .slice(0, 2)
        .some((line) => line.startsWith("Paragraph")),
    "the details scrolled",
  );
  expect(paneSeen().findLastIndex((line) => line.startsWith("───"))).toBe(rule);
  expect(liveSeen()).toEqual(strip);
  // At the end, the last paragraph shows, with nothing more below.
  for (const _ of [1, 2, 3]) press("NPage");
  await until(() => paneSeen()[rule - 1] === "Paragraph 30.", "the end of the description");
  // The wheel over the pane scrolls it back, a few lines each turn, and Page Up a page, while
  // you stay on the same row.
  const atEnd = paneSeen()[0];
  type(`\x1b[<64;${wide - 10};5M`);
  await until(() => paneSeen()[0] !== atEnd, "the wheel to scroll up");
  expect(here()).toStartWith("▸ ● APP-12");
  for (const _ of [1, 2, 3, 4]) press("PPage");
  await until(() => titled("APP-12  Rate limit the API"), "the top again");
  // Another row starts at the top of its details, and so does coming back.
  press("NPage");
  await until(() => !titled("APP-12  Rate limit the API"), "the details scrolled");
  press("Down");
  await until(() => titled("APP-14  Fix the export header"), "app-14's details from the top");
  press("Up");
  await until(() => titled("APP-12  Rate limit the API"), "app-12's details from the top");
});

test("the pane shows only while the terminal is wide enough, and the keys do the same", async () => {
  await open();
  expect(seen()).not.toContain(" │ ");
  tmux("resize-window", "-t", "=one:", "-x", String(wide));
  await until(() => titled("APP-12  Rate limit the API"), "the pane");
  // Past APP-14 and Up next's heading.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "APP-9's row");
  tmux("resize-window", "-t", "=one:", "-x", "100");
  await until(() => !seen().includes(" │ "), "no pane");
  expect(here()).toStartWith("▸ ○ APP-9");
});

// A thread's log holds the thread as it was at each change, so its events are where it changed.
test("the pane's events come from the thread's log: started, submitted, verdicts, CI and merged", () => {
  const at = (minute: number) => new Date(2026, 10, 19, 13, minute).toISOString();
  const line = (minute: number, change: object) =>
    JSON.stringify({
      at: at(minute),
      status: "working",
      submitting: null,
      verdict: null,
      review_round: null,
      reviewed_commit: null,
      merged: false,
      ...change,
    });
  const logs = join(home, ".local", "share", "skelcrew", "threads");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    join(logs, "app-12.log"),
    `${[
      line(0, {}),
      line(5, { submitting: "Add it" }),
      line(10, { submitting: "Add it", verdict: "changes", review_round: 1, reviewed_commit: "a" }),
      line(20, { verdict: "changes", review_round: 1, reviewed_commit: "a" }),
      line(30, { submitting: "Fix it", verdict: "changes", review_round: 1, reviewed_commit: "a" }),
      line(40, { verdict: "approve", review_round: 2, reviewed_commit: "b" }),
      line(45, { verdict: "approve", review_round: 2, reviewed_commit: "b", checks: "passing" }),
      line(50, {
        verdict: "approve",
        review_round: 2,
        reviewed_commit: "b",
        checks: "passing",
        merged: true,
        status: "done",
      }),
    ].join("\n")}\n`,
  );
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readDetails } from ${JSON.stringify(source("list/details.ts"))};
console.log(JSON.stringify(readDetails(openDb(), { owner: "simon", repo: "app" }, "12", ${now})?.events));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(JSON.parse(run.stdout.toString())).toEqual([
    { ago: "2h ago", text: "started" },
    { ago: "1h ago", text: "submitted" },
    { ago: "1h ago", text: "review round 1: changes asked" },
    { ago: "1h ago", text: "submitted" },
    { ago: "1h ago", text: "review round 2: approved" },
    { ago: "1h ago", text: "CI passed" },
    { ago: "1h ago", text: "merged" },
  ]);
});

// The lead's updates are part of the task the reviewer gets, but the pane shows them apart.
test("the pane's details keep the lead's updates out of the description, each with how long ago", () => {
  const updates = [
    { from: "lead", at: now - 3 * 3_600_000, text: "Use a sliding window." },
    { from: "lead", at: now - 4 * 60_000, text: "Keep it per repository." },
  ];
  sql(
    `UPDATE tasks SET body = 'Limit each client.', updates = '${JSON.stringify(updates)}' WHERE task = '12'`,
  );
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { readDetails } from ${JSON.stringify(source("list/details.ts"))};
const details = readDetails(openDb(), { owner: "simon", repo: "app" }, "12", ${now});
console.log(JSON.stringify({ body: details?.view.body, updates: details?.updates }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  const said = {
    body: "Limit each client.",
    updates: [
      { ago: "3h ago", text: "Use a sliding window." },
      { ago: "4m ago", text: "Keep it per repository." },
    ],
  };
  expect(JSON.parse(run.stdout.toString())).toEqual(said);
  // A task that is done keeps its updates in the pane, as part of its history.
  sql("UPDATE threads SET status = 'done' WHERE folder = 'app-12'");
  const done = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  expect(done.stderr.toString()).toBe("");
  expect(JSON.parse(done.stdout.toString()).updates).toEqual(said.updates);
});

// app-12's agent prints a line in red, then one wider than the pane, which fits its own screen.
test("the live view shows the agent's screen as it changes, colours kept and long lines cut", async () => {
  const long = "0123456789".repeat(7);
  await open({ width: wide, says: `\\033[31mred words\\033[0m\\n${long}\\n` });
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  // The colour reaches your terminal as the agent drew it.
  const coloured = tmux("capture-pane", "-p", "-e", "-t", "=one:").stdout.toString();
  expect(coloured).toContain("\x1b[31mred words");
  // The long line is cut at the pane's right edge, and doesn't wrap onto the next line.
  const cut = liveSeen().filter((line) => line.includes("0123456789"));
  expect(cut).toEqual([long.slice(0, paneWidth(wide))]);
  // What the agent shows next reaches the pane, without its session changing size.
  const size = () =>
    Bun.spawnSync([
      "tmux",
      "-L",
      agents,
      "display",
      "-p",
      "-t",
      "=app-12:",
      "#{window_width}x#{window_height}",
    ]).stdout.toString();
  const before = size();
  Bun.spawnSync(["tmux", "-L", agents, "send-keys", "-t", "=app-12:", "-l", "hello there"]);
  await until(
    () => liveSeen().some((line) => line.endsWith("hello there")),
    "what the agent shows",
  );
  expect(size()).toBe(before);
  // Keys typed in the list never reach the agent, whose line stays as it was.
  type("abc");
  await Bun.sleep(600);
  expect(liveSeen().some((line) => line.endsWith("hello there"))).toBe(true);
  expect(seen()).not.toContain("abc");
});

// A tmux that logs each read of a screen with its colours, as the live view reads, then runs the
// real one. Returns the folder it is in, for the list's PATH, and a count of the reads so far.
function countedTmux(): { bin: string; reads: () => number } {
  const bin = join(home, "bin");
  const log = join(home, "reads");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
case "$*" in *"capture-pane -p -e"*) echo read >> ${JSON.stringify(log)} ;; esac
exec ${JSON.stringify(Bun.which("tmux") ?? "tmux")} "$@"
`,
    { mode: 0o755 },
  );
  return { bin, reads: () => read(log).split("\n").filter(Boolean).length };
}

// A tmux whose capture of a screen takes 3 seconds, as a busy or stalled tmux server can, which
// does all else at once. Each slow capture notes its start and end, for slowReadsEnded.
function slowTmux(): string {
  const bin = join(home, "slow-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh
case "$*" in *"capture-pane -p -e"*)
  echo >> ${JSON.stringify(join(home, "slow-started"))}
  sleep 3
  ${JSON.stringify(Bun.which("tmux") ?? "tmux")} "$@"
  code=$?
  echo >> ${JSON.stringify(join(home, "slow-ended"))}
  exit $code ;;
esac
exec ${JSON.stringify(Bun.which("tmux") ?? "tmux")} "$@"
`,
    { mode: 0o755 },
  );
  return bin;
}

// How many slow reads slowTmux or slowHost started, or ended, so far.
const slowReads = (which: "started" | "ended") =>
  read(join(home, `slow-${which}`)).split("\n").length - 1;

// Reports whether the first `count` slow reads have answered, and no read after them is under
// way. A test counts the reads started once it has reached a state where the read it cares about
// was surely asked for, so a read that hasn't begun can't pass for one that ended. A read can't
// start on its own row while another is under way, so a test counts what started rather than
// expecting a read of its own.
const slowReadsDone = (count: number) =>
  count > 0 && slowReads("ended") >= count && slowReads("ended") === slowReads("started");

// Waits until slowReadsDone, so no read outlives the test that started it.
async function slowReadsEnded(count: number): Promise<void> {
  await until(() => slowReadsDone(count), "the slow reads to end");
}

test("a tmux slow to capture an agent's screen never holds up the keys", async () => {
  await open({ width: wide, bin: slowTmux() });
  await until(() => titled("APP-12  Rate limit the API"), "app-12's details");
  // Each read of app-12's screen takes 3 seconds. The moves meanwhile still show at once.
  const start = performance.now();
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  press("Up");
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  expect(performance.now() - start).toBeLessThan(1000);
  // Its screen shows once tmux answers. Then app-9 has no agent to read, and the read under way
  // ends, as the test started it.
  press("Up");
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  // Past APP-14 and Up next's heading.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "APP-9's row");
  const reads = slowReads("started");
  await slowReadsEnded(reads);
});

// Returns whether no read came for a second, as the live view reads 4 times a second.
async function noReads(reads: () => number): Promise<boolean> {
  const before = reads();
  await Bun.sleep(1000);
  return reads() === before;
}

test("the live view reads only while the list shows with its pane", async () => {
  const { bin, reads } = countedTmux();
  await open({ width: wide, bin });
  await until(() => reads() >= 4, "the live view's reads");
  // On a row with no agent running, there is nothing to read.
  // Past APP-14 and Up next's heading.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-9"), "APP-9's row");
  expect(await noReads(reads)).toBe(true);
  // While you are attached to an agent, the list isn't showing. A read that began on APP-7's row
  // just before Enter may still be noted, on a slow machine, so the list must first go a second
  // without a read: one that went on reading never would. Then it stays without. APP-7 is past
  // the headings of Backlog and Building.
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-7"), "APP-7's row");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  await wait(() => noReads(reads), { what: () => "the reads to stop" });
  expect(await noReads(reads)).toBe(true);
  press("C-\\");
  await until(() => here().startsWith("▸ ○ APP-7"), "the list again");
  const back = reads();
  await until(() => reads() > back, "reads again");
  // In a terminal too narrow for the pane, nothing is read. A read under way as the pane went
  // can still be noted, as after the attach above, so the list first goes a second without one.
  tmux("resize-window", "-t", "=one:", "-x", "100");
  await until(() => !seen().includes(" │ "), "no pane");
  await wait(() => noReads(reads), { what: () => "the reads to stop without the pane" });
  expect(await noReads(reads)).toBe(true);
  // Nor once the list has left.
  tmux("resize-window", "-t", "=one:", "-x", String(wide));
  await until(() => seen().includes(" │ "), "the pane");
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  await wait(() => noReads(reads), { what: () => "the reads to stop once the list left" });
  expect(await noReads(reads)).toBe(true);
});

// A host can take seconds to find a builder's session before its screen is read. A read whose
// row you left, or whose pane went, in that time reads nothing. Here the host's list of sessions
// takes 2 seconds, and it notes each question it is asked.
test("a live read that waits on its host reads nothing once you moved or the pane went", async () => {
  const plugin = join(home, "plugin-slow");
  const asked = join(home, "slow-host-asked");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "session.sh"),
    `q=$(cat)
case "$q" in
  *'"ask":"list"'*) echo list >> ${JSON.stringify(asked)}; sleep 2; echo '{"sessions":[]}' ;;
  *'"ask":"read"'*) echo read >> ${JSON.stringify(asked)}; echo '{"screen":"I am app-12 on slow"}' ;;
  *) echo null ;;
esac
`,
  );
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: slow\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, session.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('slow', '${plugin}');
UPDATE threads SET host = 'slow', host_id = NULL WHERE folder = 'app-12'`);
  const count = (what: string) =>
    read(asked)
      .split("\n")
      .filter((line) => line === what).length;
  await open({ width: wide });
  await until(() => here().startsWith("▸ ● APP-12") && count("list") === 1, "APP-12's lookup");
  // You move on while the host looks.
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  await Bun.sleep(2500);
  expect(count("read")).toBe(0);
  // Back on APP-12, the pane goes while the host looks.
  press("Up");
  await until(() => count("list") === 2, "APP-12's second lookup");
  tmux("resize-window", "-t", "=one:", "-x", "100");
  await until(() => !seen().includes(" │ "), "no pane");
  await Bun.sleep(2500);
  expect(count("read")).toBe(0);
  // With the pane back and nothing changing, the screen is read.
  tmux("resize-window", "-t", "=one:", "-x", String(wide));
  await until(() => liveSeen().includes("I am app-12 on slow"), "app-12's screen");
});

// The live view reads 4 times a second while you move. A move must still show at once.
test("the list stays quick to move while the live view reads", async () => {
  await open({ width: wide });
  await until(() => liveSeen().includes("I am app-12"), "app-12's screen");
  const took: number[] = [];
  for (const [key, row] of [
    ["Down", "APP-14"],
    ["Up", "APP-12"],
    ["Down", "APP-14"],
    ["Up", "APP-12"],
  ] as const) {
    const start = performance.now();
    press(key);
    await until(() => here().includes(row), `${row}'s row`);
    took.push(performance.now() - start);
  }
  // Each move shows within a fifth of a second, waits for the terminal included.
  expect(Math.max(...took)).toBeLessThan(200);
});

// Puts app-12's builder on a runtime plugin's host whose read of a screen takes 3 seconds, as a
// host on a slow machine can. Each read gives a screen of its own, so each one is drawn, and
// notes its start and end, for slowReadsEnded.
function slowHost(): void {
  const plugin = join(home, "plugin-slow");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "session.sh"),
    `read -r question
case "$question" in *'"read"'*)
  echo >> ${JSON.stringify(join(home, "slow-started"))}
  sleep 3
  printf '{"screen":"slow screen %s"}\\n' "$(date +%s%N)"
  echo >> ${JSON.stringify(join(home, "slow-ended"))} ;;
esac
`,
  );
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: slow\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [sh, session.sh]\nattach: [sh, session.sh]\n",
  );
  sql(`INSERT INTO plugins (name, folder) VALUES ('slow', '${plugin}');
UPDATE threads SET host = 'slow', host_id = 'slow-app-12' WHERE folder = 'app-12'`);
}

test("a host slow to read an agent's screen never holds up the keys", async () => {
  slowHost();
  await open({ width: wide });
  await until(
    () => liveSeen().some((line) => line.startsWith("slow screen")),
    "the slow host's screen",
  );
  // Each move onto app-12 starts a read of 3 seconds. The moves after it still show at once.
  press("Up");
  press("Down");
  const start = performance.now();
  // APP-7 is six stops on, past Up next's row and the headings between.
  for (const _ of [1, 2, 3, 4, 5, 6]) press("Down");
  await until(() => here().startsWith("▸ ○ APP-7"), "APP-7's row");
  const reads = slowReads("started");
  expect(performance.now() - start).toBeLessThan(1000);
  // The read under way ends with the host's answer, which the test waits for, as it started it.
  await slowReadsEnded(reads);
});

test("a read that answers after the list left draws nothing over your terminal", async () => {
  slowHost();
  await open({ width: wide, linger: 5000 });
  await until(
    () => liveSeen().some((line) => line.startsWith("slow screen")),
    "the slow host's screen",
  );
  // A read starts at once on coming back to app-12, and q leaves while it is under way.
  press("Down");
  press("Up");
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  const reads = slowReads("started");
  // The list would draw the answer the moment it came, so a moment after it is long enough.
  await slowReadsEnded(reads);
  await Bun.sleep(300);
  expect(seen()).toContain("Your agents keep running.");
  expect(seen()).not.toContain("q/esc quit");
});

test("a read under way when you move away and back is dropped, as you moved since it was asked", async () => {
  slowHost();
  await open({ width: wide });
  const screen = () => liveSeen().find((line) => line.startsWith("slow screen")) ?? "";
  await until(() => screen() !== "", "the slow host's screen");
  // A new screen shows as a read ends, and the next read starts within a quarter of a second,
  // so a second on it is surely under way, answering 2 seconds or so after the move.
  const first = screen();
  await until(() => screen() !== first, "the next screen");
  await Bun.sleep(1000);
  // Moving away and back while that read is under way: its answer is dropped. A read asked after
  // the move takes 3 seconds, so for 3 seconds from the move the screen stays as it was.
  const moved = performance.now();
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  press("Up");
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  const before = screen();
  while (performance.now() - moved < 3000) {
    expect(screen()).toBe(before);
    await Bun.sleep(20);
  }
  // A read asked after the move shows. Then the test moves to a row with no agent, so no read
  // starts again, and waits for the one under way to end, as it started it.
  await until(() => screen() !== before, "a newer screen");
  press("Down");
  await until(() => here().startsWith("▸ ● APP-14"), "APP-14's row");
  const reads = slowReads("started");
  await slowReadsEnded(reads);
});

test("a slow read of the row you left never holds up the live view of the row you are on", async () => {
  slowHost();
  await open({ width: wide });
  await until(
    () => liveSeen().some((line) => line.startsWith("slow screen")),
    "the slow host's screen",
  );
  // Coming back to app-12 starts a read of 3 seconds. app-7, six stops on, is read at once.
  press("Down");
  press("Up");
  await until(() => here().startsWith("▸ ● APP-12"), "APP-12's row");
  const start = performance.now();
  // app-7 is six stops on, past Up next's row and the headings between.
  for (const _ of [1, 2, 3, 4, 5, 6]) press("Down");
  await until(() => liveSeen().includes("I am app-7"), "app-7's screen");
  const reads = slowReads("started");
  expect(performance.now() - start).toBeLessThan(1000);
  // When app-12's read answers, app-7's screen stays in sight, never blanked by a screen that
  // isn't its own. The test watches until a moment after the answer, which also waits for the
  // read it started to end.
  let answered = 0;
  while (answered === 0 || performance.now() - answered < 300) {
    expect(liveSeen()).toContain("I am app-7");
    if (answered === 0 && slowReadsDone(reads)) answered = performance.now();
    await Bun.sleep(10);
  }
});
