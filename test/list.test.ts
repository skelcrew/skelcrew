// The list that sc shows: its rows, read from a database of the test's own, and the list itself in
// a terminal, on tmux servers of the test's own. One holds the agents, and a second stands in for
// your terminal, so a test can press keys and read what you see.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Labels, startSession } from "../src/agents/sessions.ts";
import type { ListStage } from "../src/flow/stage.ts";
import { drawList, keysFor, tabAt } from "../src/list/layout.ts";
import { type Row, stageHeadings } from "../src/list/rows.ts";
import { fakePlugin, itemSql, read, source, threadSql, until as wait } from "./harness.ts";

// Longer than the waits below, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
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
// started 5 minutes before the rows' clock, and app-9 last changed a minute before it.
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
${threadSql({ task: "12", title: "Rate limit the API", harness: "codex", asking: 1, needs_you: 1 })}
${threadSql({ task: "9", title: "Old work", status: "stopped", changed: now - 60_000 })}
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, ci_seen: 1, pr: 41, review_round: 1, reviewed_commit: approved })}
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

test("the lead comes first, then each stage's tasks, those that need you first", () => {
  const shown = rows().map((row) => [row.part, row.name, row.title, row.says, row.pr, row.when]);
  // The approved task first on its own, so a failure says in one line where it went and why.
  const ready = shown.find(([, name]) => name === "app-14");
  expect(ready?.join(" | ")).toBe("ready | app-14 | Fix the export header | approved | #41 | ");
  expect(shown).toEqual([
    ["lead", "lead", "claude", "running", "", ""],
    ["backlog", "app-31", "Export as CSV", "", "", "5 Nov"],
    ["building", "app-12", "Rate limit the API", "question", "", ""],
    ["building", "app-9", "Old work", "stopped", "", "14:59"],
    ["building", "app-7", "Login redirect", "working", "", "14:55"],
    ["ready", "app-14", "Fix the export header", "approved", "#41", ""],
  ]);
});

// The stage is where the work is, and needs you is only a mark, so a question on an approved task
// keeps it under Ready, where Enter reaches its builder.
test("an approved task whose builder asks a question stays under Ready, marked as needing you", () => {
  sql("UPDATE threads SET asking = 1 WHERE folder = 'app-14';");
  const row = rows().find((candidate) => candidate.name === "app-14");
  expect(row).toMatchObject({
    part: "ready",
    says: "question",
    needsYou: true,
    merge: null,
  });
  expect(row?.session).toBe("app-14");
});

// The default flow gives 3 rounds of changes, so 4 is past the limit. A review run again after it
// approved, so the task is ready, and the round limit no longer needs you.
test("a task approved past the round limit is under Ready, not needing you", () => {
  sql("UPDATE tasks SET rounds = 4 WHERE task = '14';");
  const row = rows().find((candidate) => candidate.name === "app-14");
  expect(row).toMatchObject({ part: "ready", says: "approved", needsYou: false });
  const ready = stageHeadings(rows(), new Set<ListStage>()).find((h) => h.stage === "ready");
  expect(ready).toMatchObject({ count: 1, needYou: 0 });
});

test("each stage's heading counts its tasks and those that need you, open or closed", () => {
  sql("UPDATE threads SET asking = 1 WHERE folder = 'app-14';");
  expect(stageHeadings(rows(), new Set<ListStage>(["building"]))).toEqual([
    { stage: "backlog", count: 1, needYou: 0, open: false },
    { stage: "building", count: 3, needYou: 1, open: true },
    { stage: "reviewing", count: 0, needYou: 0, open: false },
    { stage: "checks", count: 0, needYou: 0, open: false },
    { stage: "ready", count: 1, needYou: 1, open: false },
    { stage: "done", count: 0, needYou: 0, open: false },
  ]);
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
  expect(rows().find((row) => row.name === "app-14")).toMatchObject({
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
  expect(rows().find((row) => row.name === "app-14")?.link).toBeNull();
});

// A task that changed lately is what you are likely to look for, whenever it started.
test("within a stage the task that changed last comes first, after those that need you", () => {
  sql(`UPDATE threads SET changed = ${now - 30_000} WHERE folder = 'app-7';`);
  const building = rows().filter((row) => row.part === "building");
  expect(building.map((row) => row.name)).toEqual(["app-12", "app-7", "app-9"]);
});

test("tasks under review and waiting on checks show in their own stages", () => {
  sql(`${threadSql({ task: "15", title: "Under review", status: "waiting", reviewing: "abc", pr: 45 })}
${threadSql({ task: "16", title: "Approved", status: "waiting", verdict: "approve", checks: "pending", pr: 46 })}`);
  const shown = rows().map((row) => [row.part, row.name, row.says]);
  expect(shown).toContainEqual(["reviewing", "app-15", "reviewing"]);
  expect(shown).toContainEqual(["checks", "app-16", "checks"]);
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
    ...["app-100", "app-101", "app-102"],
    ...["app-200", "app-201", "app-202", "app-203", "app-204", "app-205", "app-206"],
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
  expect(lines).toContain("   ○ app-100  Ended 100  14:00");
  expect(lines).toContain("   ○ app-308  Ended 308  03:00");
});

// A row stays short enough to read across: a merge when ready or messages waiting are for sc show.
test("a row says one short word, with no merge when ready or messages waiting after it", () => {
  sql(`UPDATE threads SET merge_plan = 'armed', merge_waits = 'its checks' WHERE folder = 'app-7';
INSERT INTO messages (folder, sender, text, said, at) VALUES ('app-7', 'lead', 'one', 'one', 0);`);
  const row = rows().find((candidate) => candidate.name === "app-7");
  expect(row).toMatchObject({ says: "working", pr: "", when: "14:55" });
});

test("an issue whose work ended is back under Backlog, to start again", () => {
  sql("UPDATE threads SET status = 'done' WHERE folder = 'app-7';");
  sql(itemSql("app", "task", 7, "Login redirect", "2026-11-01T10:00:00Z"));
  expect(
    rows()
      .filter((row) => row.part === "backlog")
      .map((row) => row.name),
  ).toEqual(["app-31", "app-7"]);
});

test("Enter asks to start an issue, and m to merge a ready task at the commit you saw", () => {
  const [issue] = rows().filter((row) => row.part === "backlog");
  expect(issue?.start).toEqual({
    ask: "Start app-31? y/n",
    working: "Starting app-31…",
    request: { command: "start", repo: "simon/app", task: "31" },
  });
  const [ready] = rows().filter((row) => row.part === "ready");
  expect(ready?.merge).toEqual({
    ask: "Merge app#41 into main? y/n",
    working: "Merging app#41…",
    request: { command: "merge", repo: "simon/app", pr: 41, commit: approved },
  });
  expect(ready?.link).toBe("https://github.com/simon/app/pull/41");
  // A working task has nothing to merge.
  expect(rows().find((row) => row.name === "app-7")?.merge).toBeNull();
});

// Merging approves no change to .agents/, so the question says when the approved commit makes one,
// from what a poll saved. A commit, or a base, no poll has looked at yet doesn't pass for one with
// no change: a PR retargeted at another base can bring other changes with the same head.
test("m's question says when the PR changes .agents/, or that Skelcrew hasn't checked yet", () => {
  const ask = () => {
    const merge = rows().find((row) => row.name === "app-14")?.merge;
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
  const merge = rows().find((row) => row.name === "app-14")?.merge;
  expect(merge).toEqual({
    refused:
      "app#41's approval has no commit saved: merge it on the forge, or run sc review app-14",
  });
});

test("a ready task whose forge sent no head commit can't be merged here, and says why", () => {
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z"));
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41 needs a newer forge plugin to merge here: run sc plugin update",
  });
});

// The thread's verdict and checks can still describe the approved commit after a push moved the
// PR, so the list goes by the approved commit and the checks on the head.
test("a ready task whose PR moved past the approved commit, or whose checks there failed, can't be merged", () => {
  const moved = { head: "f00d", checks: [{ name: "test", id: "1", state: "passed" }] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", moved));
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41 has a newer commit than the one approved: wait for its review",
  });
  const failed = { head: approved, checks: [{ name: "test", id: "1", state: "failed" }] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", failed));
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
});

// The thread can still say CI passed while the forge's copy of the approved head has no checks
// yet, and a poll sets its checks back to none when they vanish. Only a repository whose polls
// never found CI merges without checks.
test("a ready task whose approved head has no checks yet can't be merged, unless it has no CI", () => {
  const unchecked = { head: approved, checks: [] };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", unchecked));
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
  // CI that polls once found, and whose checks then went missing, isn't a repository with no CI.
  sql("UPDATE tasks SET checks = NULL WHERE task = '14';");
  expect(rows().find((row) => row.name === "app-14")?.merge).toEqual({
    refused: "app#41's checks haven't passed on the approved commit yet",
  });
  // Polls that never found any CI checks are a repository with no CI.
  sql("UPDATE tasks SET ci_seen = 0 WHERE task = '14';");
  const merge = rows().find((row) => row.name === "app-14")?.merge;
  expect(merge && "ask" in merge ? merge.ask : "").toBe("Merge app#41 into main? y/n");
});

test("a forge's base branch reaches the merge question without its control codes", () => {
  const base = { head: approved, checks: passed, base: "main\x1b]0;evil\x07" };
  sql(itemSql("app", "pr", 41, "Fix the export header", "2026-11-06T10:00:00Z", base));
  const merge = rows().find((row) => row.name === "app-14")?.merge;
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
  expect(running.find((row) => row.name === "app-7")?.running).toBe(true);
  expect(running.find((row) => row.name === "app-9")?.running).toBe(false);
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
  expect(onTmux()).toMatchObject({ lead: true, "app-7": true, "app-14": false, "app-31": false });
  sql("UPDATE threads SET host = 'fake' WHERE folder = 'app-7';");
  expect(onTmux()["app-7"]).toBe(false);
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

// Printed, the list is whole: a task at work takes three lines, and none may scroll out of sight.
test("the list printed without a terminal has every task, however many are at work", () => {
  const more = Array.from({ length: 30 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - i * 60_000 }),
  );
  sql(more.join("\n"));
  const code = `import { runList } from ${JSON.stringify(source("list/list.ts"))};
await runList("skel-test-${process.pid}-none", "simon/app");`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: env(), stderr: "pipe" });
  const printed = run.stdout.toString();
  for (let task = 50; task < 80; task += 1) expect(printed).toContain(`app-${task}  Task ${task}`);
  expect(printed).toContain("app-14  Fix the export header");
  expect(printed).toContain("app-31  Export as CSV");
});

// The list reads no settings file, so it knows a thread is past its round limit from the changes
// the review held back for you.
test("a task past its round limit says so, from the changes its review held", () => {
  sql(
    "UPDATE tasks SET rounds = 4, held = 'Rename it.' WHERE task = '7'; UPDATE threads SET needs_you = 1, status = 'waiting' WHERE folder = 'app-7';",
  );
  expect(rows().find((row) => row.name === "app-7")?.says).toBe("round limit");
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
  expect(rows(bin).map((row) => row.name)).toContain("app-14");
  expect(read(join(home, "calls"))).toBe("");
});

// The list as drawn, given its rows, at 80 columns and 20 lines.
const frame = {
  version: "0.6.0",
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
// Returns the list as drawn at the rows' clock, with only `open` stages showing their rows, as
// the list keeps them, on the row at `here` among those that show.
function drawnWith(
  here: number,
  frameShown: typeof frame,
  size: { width: number; height: number },
  open: ListStage[] = ["building"],
) {
  const all = rows();
  const opened = new Set(open);
  const shown = all.filter((row) => row.part === "lead" || opened.has(row.part));
  return drawList(shown, stageHeadings(all, opened), here, 0, frameShown, size).lines;
}
const drawn = (here: number, height = 20, width = 80, open?: ListStage[]) =>
  drawnWith(here, frame, { width, height }, open).map((line) => Bun.stripANSI(line));

test("every stage has its heading with its counts, only open ones show rows, and every line fits", () => {
  const lines = drawn(1, 24);
  expect(lines[0]).toBe(" Skelcrew v0.6.0   app    site •1 ");
  // The lead and each task at work take lines as the sidebar's rows do: mark, name and title,
  // then the word, then a task's PR, CI and when it changed. So what it does sits under its title.
  expect(lines.slice(2, 22).map((line) => line.trimEnd())).toEqual([
    "   ○ lead    claude",
    "     running",
    "",
    " 1 Backlog   1",
    " 2 Building  3 · 1 needs you",
    " ▸ ● app-12  Rate limit the API",
    "     question",
    "",
    "   ○ app-9   Old work",
    "     stopped",
    "     14:59",
    "   ○ app-7   Login redirect",
    "     working",
    "     14:55",
    "",
    " 3 Reviewing 0",
    " 4 Checks    0",
    " 5 Ready     1",
    " 6 Done      0",
    "",
  ]);
  // The bottom line has the keys, and the load at its right end, short of the last column.
  expect(lines.at(-1)).toBe(` ↑↓ move  ⏎ open  1-6 stages  q/esc quit${" ".repeat(32)}cpu 12%`);
  // Nothing reaches the last column, where a terminal would wait to wrap.
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(79);
  expect(lines).toHaveLength(24);
});

test("an open stage shows its rows, and its heading is bright while a closed one is dim", () => {
  const lines = drawn(1, 24, 80, ["backlog", "ready"]);
  // A task in Backlog or Done takes one line, in columns: mark, name, title, when it changed.
  expect(lines.slice(5, 16).map((line) => line.trimEnd())).toEqual([
    " 1 Backlog   1",
    " ▸ ○ app-31  Export as CSV  5 Nov",
    "",
    " 2 Building  3 · 1 needs you",
    " 3 Reviewing 0",
    " 4 Checks    0",
    " 5 Ready     1",
    "   ● app-14  Fix the export header",
    "     approved",
    "     #41 · CI passed",
    "",
  ]);
  const coloured = drawnWith(1, frame, { width: 80, height: 24 }, ["backlog"]);
  expect(coloured).toContain(" \x1b[90m1\x1b[22;39m \x1b[1mBacklog  \x1b[22;39m 1");
  expect(coloured).toContain(
    " \x1b[90m2\x1b[22;39m \x1b[90mBuilding \x1b[22;39m 3\x1b[38;5;221m · 1 needs you\x1b[22;39m",
  );
});

test("a row's word is in its colour, its step and what follows it are dim, and its title is plain", () => {
  const all = rows().map((row) =>
    row.name === "app-7"
      ? { ...row, step: "Editing rows.ts", pr: "#40", checks: "CI running" }
      : row,
  );
  const shown = all.filter((row) => row.part === "lead" || row.part === "building");
  const headings = stageHeadings(all, new Set<ListStage>(["building"]));
  const size = { width: 80, height: 24 };
  const { lines } = drawList(shown, headings, 1, 0, frame, size);
  const at = lines.findIndex((line) => line.includes("app-7"));
  expect(lines.slice(at, at + 3)).toEqual([
    "   \x1b[1m○\x1b[22;39m app-7   Login redirect",
    "     \x1b[1mworking\x1b[22;39m\x1b[90m · Editing rows.ts\x1b[22;39m",
    "     \x1b[90m#40 · CI running · 14:55\x1b[22;39m",
  ]);
});

// A wide terminal used to lose the last letter of whatever reached its right edge.
test("a row as wide as the terminal stops short of its last column, cutting only its title", () => {
  const long = "A title long enough to run past the right edge of any terminal here";
  sql(`UPDATE tasks SET title = '${long}' WHERE task = '7';`);
  for (const width of [60, 61, 80]) {
    const lines = drawnWith(1, frame, { width, height: 24 }).map((line) => Bun.stripANSI(line));
    const row = lines.find((line) => line.includes("app-7")) ?? "";
    expect(Bun.stringWidth(row)).toBe(width - 1);
    expect(row).toContain("app-7   A title");
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

test("a list taller than the terminal scrolls only its tasks, keeping the lead and every heading", () => {
  const more = Array.from({ length: 10 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  sql(more.join("\n"));
  // Building has app-12 first, as it needs you, then by latest change: app-9, app-7, then app-50
  // to app-59. The last of them is the 13th task, at 13 among the rows after the lead.
  const lines = drawn(13, 16, 80, ["building", "ready"]);
  expect(lines).toHaveLength(16);
  expect(lines[2]).toMatch(/^ {3}○ lead/);
  expect(lines.filter((line) => /^ \d [A-Z]/.test(line)).map((line) => line.trim())).toEqual([
    "1 Backlog    1",
    "2 Building  13 · 1 needs you",
    "3 Reviewing  0",
    "4 Checks     0",
    "5 Ready      1",
    "6 Done       0",
  ]);
  expect(lines.filter((line) => line.includes("▸"))).toEqual([
    expect.stringMatching(/^ ▸ ○ app-59 /),
  ]);
  // The row you are on shows whole: its title, then its word, then when it changed.
  const at = lines.findIndex((line) => line.includes("▸"));
  expect(lines.slice(at, at + 3).map((line) => line.trim())).toEqual([
    "▸ ○ app-59  Task 59",
    "working",
    "14:41",
  ]);
  expect(lines.some((line) => line.includes("app-12"))).toBe(false);
});

test("on the lead, a terminal with room for the headings but not a task keeps every heading", () => {
  // Thirteen lines leave six for the stages: every heading, and no room for a three-line task.
  const lines = drawn(0, 13, 80, ["building"]);
  expect(lines.filter((line) => /^ \d [A-Z]/.test(line))).toHaveLength(6);
  expect(lines.filter((line) => line.includes("▸"))).toEqual([
    expect.stringMatching(/^ ▸ ○ lead /),
  ]);
});

test("a terminal too short for every heading still shows the row you are on", () => {
  const more = Array.from({ length: 10 }, (_, i) =>
    threadSql({ task: String(50 + i), title: `Task ${50 + i}`, changed: now - (10 + i) * 60_000 }),
  );
  sql(more.join("\n"));
  // Ten lines leave three for the stages: the row you are on, whole, and no heading.
  const lines = drawn(13, 10, 80, ["building", "ready"]);
  expect(lines).toHaveLength(10);
  expect(lines[2]).toMatch(/^ {3}○ lead/);
  expect(lines.slice(5, 8).map((line) => line.trim())).toEqual([
    "▸ ○ app-59  Task 59",
    "working",
    "14:41",
  ]);
  // Eight leave one: the first line of the row you are on, with its ▸.
  const fewer = drawn(13, 8, 80, ["building", "ready"]);
  expect(fewer.filter((line) => line.includes("▸"))).toEqual([
    expect.stringMatching(/^ ▸ ○ app-59 +Task 59 *$/),
  ]);
});

// Stands in for the daemon on the test's own socket: it logs each request and answers a start or
// a merge as the daemon would, and a lead or a merge with what a test sets.
function daemon(): void {
  const Request = z.object({
    command: z.string(),
    from: z.string().default(""),
    tab: z.boolean().default(false),
    repo: z.string().default(""),
    task: z.string().default(""),
    pr: z.number().default(0),
    commit: z.string().default(""),
  });
  standIn = createServer((connection) =>
    connection.on("data", (data) => {
      const { command, from, tab, repo, task, pr, commit } = Request.parse(
        JSON.parse(data.toString()),
      );
      if (command === "lead") asked.push(`open ${from}${tab ? " from a tab" : ""}`);
      if (command === "start") asked.push(`start ${repo} ${task}`);
      if (command === "merge") asked.push(`merge ${repo} ${pr} ${commit}`);
      const said =
        command === "lead"
          ? leadAnswer
          : command === "start"
            ? { started: "Started." }
            : mergeAnswer;
      connection.end(`${JSON.stringify(said)}\n`);
    }),
  );
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  standIn.listen(join(home, "run", "skelcrew.sock"));
}

// Starts an agent that says its name and logs each line you type into it. It fails when told bye,
// which leaves its session behind with its last screen. It asks for extended keys as Claude Code
// does, with CSI > 4;2 m, or `asks` as given.
const asClaude = "\\033[>4;2m";
// Codex asks as Claude Code does, and pushes kitty's keyboard flags too.
const asCodex = "\\033[>4;2m\\033[>1u";
function agent(name: string, labels: Labels, asks = asClaude): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
printf '${asks}'
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

// Opens the list of app in a terminal of its own, 100 columns wide, with the agents app-7,
// app-12 and the lead running. The terminal logs when the list returned.
async function open(): Promise<void> {
  daemon();
  agent("lead", { repository: "simon/app", role: "lead" });
  agent("app-7", { repository: "simon/app", role: "builder", task: "app-7" }, asCodex);
  agent("app-12", { repository: "simon/app", role: "builder", task: "app-12" });
  const script = join(home, "open.ts");
  writeFileSync(
    script,
    `import { runList } from ${JSON.stringify(source("list/list.ts"))};
await runList(${JSON.stringify(agents)}, "simon/app");
await Bun.write(${JSON.stringify(join(home, "left"))}, "left");
process.exit(0);`,
  );
  const vars = `HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")} SKELCREW_FIXED_LOAD='cpu 12%'`;
  const command = `${vars} TERM=xterm-256color ${process.execPath} ${script}; sleep 300`;
  tmux("new-session", "-d", "-s", "one", "-x", "100", "-y", "24", command);
  await until(() => seen().includes("q/esc quit"), "the list");
}

test("the list opens on the first task that needs you, and q leaves it with every agent running", async () => {
  await open();
  expect(seen()).toContain(" Skelcrew v");
  expect(seen()).toContain("site •1");
  expect(here()).toStartWith("▸ ● app-12");
  type("q");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
  expect(seen()).toContain("Your agents keep running. Run sc --list to come back.");
  const sessions = Bun.spawnSync(["tmux", "-L", agents, "list-sessions", "-F", "#S"]);
  expect(sessions.stdout.toString().trim().split("\n").sort()).toEqual(["app-12", "app-7", "lead"]);
});

// Leaving gives the terminal back, so a key that came with q must never act after it.
test("a key that comes with q in one read does nothing once the list has left", async () => {
  await open();
  await until(() => here().startsWith("▸ ● app-12"), "app-12's row");
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
    press("Up");
    await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
    press("Enter");
    await until(() => seen().includes("Start app-31? y/n"), "the question");
    type(key);
    await until(() => read(join(home, "left")) === "left", "the list to leave");
    expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  });

test("Enter attaches to the builder, every key reaches it, and Ctrl-\\ comes back on the same row", async () => {
  await open();
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  // q and m are the list's keys, but the agent has the keyboard now.
  type("q m hello");
  press("Enter");
  await until(() => read(join(home, "app-7.typed")) === "q m hello\n", "what was typed");
  press("C-\\");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ○ app-7");
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
// lead stands in for Claude Code and app-7 for Codex.
for (const [form, bytes] of Object.entries(back))
  for (const [agent, arrows, mark] of [
    ["app-7", ["Down", "Down"], "○"],
    ["lead", ["Up", "Up", "Up"], "○"],
  ] as const)
    test(`Ctrl-\\ as ${form} comes back from ${agent} on its row, in pieces or scrolled back`, async () => {
      await open();
      for (const arrow of arrows) press(arrow);
      await until(() => here().startsWith(`▸ ${mark} ${agent}`), `${agent}'s row`);
      for (const way of ["whole", "in pieces", "scrolled back"]) {
        press("Enter");
        await until(() => seen().includes(`I am ${agent}`), agent);
        if (way === "scrolled back")
          Bun.spawnSync(["tmux", "-L", agents, "copy-mode", "-t", `=${agent}:`]);
        await sendBytes(bytes, way === "in pieces");
        await until(() => here().startsWith(`▸ ${mark} ${agent}`), `the list again, ${way}`);
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
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  press("C-q");
  await Bun.sleep(500);
  expect(seen()).toContain("I am app-7");
  expect(seen()).not.toContain("q/esc quit");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ app-7"), "the list again");
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
  expect(here()).toStartWith("▸ ● app-12");
  expect(read(join(home, "left"))).toBe("");
});

// A question takes y or n, and any other key is a no, but Ctrl-\ pressed once too often must
// not drop it.
test("Ctrl-\\ in every form leaves a question open, and y then answers it", async () => {
  await open();
  type("1");
  press("Up");
  await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question");
  for (const bytes of Object.values(back)) await sendBytes(bytes, true);
  await Bun.sleep(300);
  expect(seen()).toContain("Start app-31? y/n");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

// Nothing on an agent's screen is Skelcrew's, so the title says how to come back, and the one
// you had comes back with you.
test("while attached the title names the agent and the key back, and the list shows the key", async () => {
  await open();
  expect(seen()).toContain("⏎ open · ctrl+\\ back");
  const title = () =>
    tmux("display-message", "-p", "-t", "=one:", "#{pane_title}").stdout.toString();
  tmux("select-pane", "-t", "=one:", "-T", "my shell");
  press("Enter");
  await until(() => seen().includes("I am app-12"), "app-12's agent");
  await until(() => title() === "app-12 · ctrl+\\ back\n", "the title");
  press("C-\\");
  await until(() => seen().includes("q/esc quit"), "the list again");
  await until(() => title() === "my shell\n", "the title you had");
});

test("an agent that ends while you are attached brings you back to the list, on its row", async () => {
  await open();
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
  press("Enter");
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  type("bye");
  press("Enter");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ○ app-7");
  expect(read(join(home, "left"))).toBe("");
});

// Keys typed fast, or over a slow link, can reach the list in one read with the Enter before them.
test("keys that come with Enter reach the agent, not the list", async () => {
  await open();
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
  // q and m would leave the list or merge, were the list to read them.
  type("\rq m now\r");
  await until(() => read(join(home, "app-7.typed")) === "q m now\n", "what was typed");
  expect(read(join(home, "left"))).toBe("");
  // The keys are typed into the agent before the list attaches, so Ctrl-\ waits for the agent's
  // screen: pressed earlier, it would land on the list, where it does nothing.
  await until(() => seen().includes("I am app-7"), "app-7's agent");
  press("C-\\");
  await until(() => here().startsWith("▸ ○ app-7"), "the list again");
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
  press("Down");
  press("Down");
  await until(() => here().startsWith("▸ ○ app-7"), "app-7's row");
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
  await until(() => here().startsWith("▸ ○ app-9"), "the row below");
  type("\x1b");
  await Bun.sleep(40);
  type("[A");
  await until(() => here().startsWith("▸ ● app-12"), "the row above");
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
  press("Down");
  await until(() => here().startsWith("▸ ○ app-9"), "the row below");
  await Bun.sleep(300);
  expect(read(join(home, "left"))).toBe("");
  expect(seen()).not.toContain("y/n");
});

// A stray Esc while you answer must not leave the list.
test("Esc with a question open answers no and stays, and a second Esc leaves", async () => {
  await open();
  type("1");
  press("Up");
  await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question");
  type("\x1b");
  await until(() => !seen().includes("y/n"), "the question to close");
  await Bun.sleep(300);
  expect(read(join(home, "left"))).toBe("");
  expect(here()).toStartWith("▸ ○ app-31");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  type("\x1b");
  await until(() => read(join(home, "left")) === "left", "the list to leave");
});

// Only Building is open at first, so a task ready for review waits under its closed heading.
test("with nothing in Building needing you, the list opens on the lead", async () => {
  sql("UPDATE threads SET asking = 0, needs_you = 0 WHERE folder = 'app-12';");
  await open();
  expect(here()).toStartWith("▸ ○ lead");
  expect(seen()).toContain(" 5 Ready     1");
});

test("the number keys open and close the stages, which stay so in another repository", async () => {
  await open();
  expect(seen()).not.toContain("app-31");
  type("1");
  await until(() => seen().includes("○ app-31"), "Backlog's rows");
  // The row you are on stays the same as the stage above it opens.
  expect(here()).toStartWith("▸ ● app-12");
  type("2");
  await until(() => !seen().includes("app-7"), "Building closed");
  expect(seen()).toContain("○ app-31");
  press("Tab");
  // The open repository's tab has no badge, so another's shows only while it is open.
  await until(() => seen().includes(" app •"), "site's list");
  press("Tab");
  await until(() => seen().includes(" site •1"), "app's list again");
  expect(seen()).toContain("○ app-31");
  expect(seen()).not.toContain("app-7");
});

test("a forge's refusal shows as words, its control codes never reaching your terminal", async () => {
  mergeAnswer = { error: "Refused:\x1b]0;evil\x07 the branch conflicts" };
  await open();
  type("5");
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● app-14"), "the ready row");
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
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ○ app-14"), "the done row");
  press("Enter");
  await until(() => seen().includes("app-14's PR #41 has no link saved"), "what Enter says");
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
  await until(() => here().startsWith("▸ ● app-12"), "app-12's row");
  // The host has a key of its own to come back, so the list doesn't offer tmux's.
  expect(seen()).toContain("⏎ open  ");
  expect(seen()).not.toContain("ctrl+\\ back");
  press("Enter");
  await until(() => seen().includes("I am fake-app-12 on fake"), "the host's attach");
  press("Enter");
  await until(() => seen().includes("q/esc quit"), "the list again");
  expect(here()).toStartWith("▸ ● app-12");
  expect(read(join(home, "left"))).toBe("");
});

test("Enter on a builder that isn't running says so, and attaches to nothing", async () => {
  await open();
  press("Down");
  await until(() => here().startsWith("▸ ○ app-9"), "app-9's row");
  press("Enter");
  await until(
    () => seen().includes("app-9's builder isn't running: sc start app-9 brings it back"),
    "why it can't attach",
  );
});

test("Enter on an issue asks first: any key but y starts nothing, and y starts it", async () => {
  await open();
  type("1");
  press("Up");
  await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question");
  type("n");
  await until(() => seen().includes("q/esc quit"), "the keys again");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  press("Enter");
  await until(() => seen().includes("Start app-31? y/n"), "the question again");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

// A y typed with Enter, before the question showed, must never answer it.
test("keys that come with Enter on an issue are dropped, so they can't answer its question", async () => {
  await open();
  type("1");
  press("Up");
  await until(() => here().startsWith("▸ ○ app-31"), "the issue's row");
  type("\ryq");
  await until(() => seen().includes("Start app-31? y/n"), "the question");
  await Bun.sleep(300);
  expect(seen()).toContain("Start app-31? y/n");
  expect(asked.filter((line) => line.startsWith("start"))).toEqual([]);
  expect(read(join(home, "left"))).toBe("");
  type("y");
  await until(() => asked.includes("start simon/app 31"), "the start");
});

test("a y that comes with m in one read can't answer the merge question", async () => {
  await open();
  type("5");
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● app-14"), "the ready row");
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
  type("5");
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● app-14"), "the ready row");
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
  type("5");
  for (const _ of [1, 2, 3]) press("Down");
  await until(() => here().startsWith("▸ ● app-14"), "the ready row");
  expect(seen()).toContain("m merge");
  type("m");
  await until(() => seen().includes("Merge app#41 into main? y/n"), "the question");
  type("y");
  await until(() => asked.includes(`merge simon/app 41 ${approved}`), "the merge");
});

test("Tab moves to the next repository and has the daemon open it, without reopening a closed tab", async () => {
  await open();
  press("Tab");
  await until(() => seen().includes("site-3"), "site's list");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});

// The tabs are on the top line, left after Skelcrew's version. Your terminal reports a click by
// its column and row, counted from 1, as typed here.
test("a click on a repository's tab opens it, and a click elsewhere does nothing", async () => {
  await open();
  const top = seen().split("\n")[0] ?? "";
  expect(top).toMatch(/^ Skelcrew v\S+ {3}app {4}site •1$/);
  type(`\x1b[<0;${top.indexOf("site") + 1};2M`);
  type(`\x1b[<0;${top.indexOf("site") + 1};1M\x1b[<0;${top.indexOf("site") + 1};1m`);
  await until(() => seen().includes("site-3"), "site's list");
  // It opens on site's task that needs you, as the list does on any repository.
  expect(here()).toStartWith("▸ ● site-3");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});
