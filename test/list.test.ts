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
import { drawList, keysFor } from "../src/list/layout.ts";
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
// started 5 minutes before the rows' clock.
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
${threadSql({ task: "9", title: "Old work", status: "stopped" })}
${threadSql({ task: "14", title: "Fix the export header", status: "waiting", needs_you: 1, verdict: "approve", checks: "passing", ci_passed: 1, ci_seen: 1, pr: 41, review_round: 1, reviewed_commit: approved })}
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

test("the lead comes first, then each stage's tasks, those that need you first", () => {
  const shown = rows().map((row) => [row.part, row.name, row.title, row.says, row.about]);
  // The approved task first on its own, so a failure says in one line where it went and why.
  const ready = shown.find(([, name]) => name === "app-14");
  expect(ready?.join(" | ")).toBe("ready | app-14 | Fix the export header | approved | #41");
  expect(shown).toEqual([
    ["lead", "lead", "", "running · claude", ""],
    ["backlog", "app-31", "Export as CSV", "", "5 Nov"],
    ["building", "app-12", "Rate limit the API", "needs you: question", ""],
    ["building", "app-9", "Old work", "stopped", ""],
    ["building", "app-7", "Login redirect", "working", "14:55"],
    ["ready", "app-14", "Fix the export header", "approved", "#41"],
  ]);
});

// The stage is where the work is, and needs you is only a mark, so a question on an approved task
// keeps it under Ready, where Enter reaches its builder.
test("an approved task whose builder asks a question stays under Ready, marked as needing you", () => {
  sql("UPDATE threads SET asking = 1 WHERE folder = 'app-14';");
  const row = rows().find((candidate) => candidate.name === "app-14");
  expect(row).toMatchObject({
    part: "ready",
    says: "needs you: question",
    needsYou: true,
    merge: null,
  });
  expect(row?.session).toBe("app-14");
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
    about: "#100 · 14:00",
    mark: { sign: "○", colour: "dim" },
    needsYou: false,
    session: null,
  });
  expect(done()[1]?.says).toBe("closed");
  expect(done()[3]?.about).toBe("#200 · 18 Nov");
  // Twelve today: every one of them, and none from before.
  sql(ended(300, 9, 4));
  expect(done()).toHaveLength(12);
  expect(done().every((row) => /^#\d+ · \d\d:\d\d$/.test(row.about))).toBe(true);
});

test("a row shows its armed merge when ready and what it waits on, and a ready one shows it too", () => {
  sql(`UPDATE threads SET merge_plan = 'armed', merge_waits = 'its checks' WHERE folder = 'app-7';
UPDATE threads SET merge_plan = 'armed' WHERE folder = 'app-14';`);
  const says = (name: string) => rows().find((row) => row.name === name)?.about;
  expect(says("app-7")).toBe("14:55 · merges when ready · waiting on its checks");
  expect(says("app-14")).toBe("#41 · merges when ready");
});

test("a row counts the messages waiting for its builder, so a stuck delivery shows", () => {
  sql(`INSERT INTO messages (folder, sender, text, said, at) VALUES
  ('app-7', 'lead', 'one', 'one', 0), ('app-7', 'lead', 'two', 'two', 0);`);
  const row = rows().find((candidate) => candidate.name === "app-7");
  expect(row?.about).toBe("14:55 · 2 messages waiting");
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
  expect(merge && "ask" in merge ? merge.ask : "").toBe("Merge app#41 into main ]0;evil ? y/n");
});

// The list reads only the database: a builder runs while its thread works or waits, and a lead
// while its tab is open, as the daemon keeps it running.
test("a row knows whether its agent runs, and the lead says what its hooks last said", () => {
  sql("UPDATE repositories SET lead_state = 'asking' WHERE repo = 'app';");
  const running = rows();
  expect(running.find((row) => row.name === "lead")).toMatchObject({
    says: "asks you · claude",
    colour: "yellow",
    running: true,
  });
  expect(running.find((row) => row.name === "app-7")?.running).toBe(true);
  expect(running.find((row) => row.name === "app-9")?.running).toBe(false);
  sql("UPDATE repositories SET tab_closed = 1 WHERE repo = 'app';");
  expect(rows().find((row) => row.name === "lead")).toMatchObject({
    says: "stopped · claude",
    running: false,
  });
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

// The list reads no settings file, so it knows a thread is past its round limit from the changes
// the review held back for you.
test("a task past its round limit says so, from the changes its review held", () => {
  sql(
    "UPDATE tasks SET rounds = 4, held = 'Rename it.' WHERE task = '7'; UPDATE threads SET needs_you = 1, status = 'waiting' WHERE folder = 'app-7';",
  );
  expect(rows().find((row) => row.name === "app-7")?.says).toBe("needs you: round limit");
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
  const lines = drawn(1);
  expect(lines[0]).toBe(` Skelcrew v0.6.0 · app${" ".repeat(50)}site •1 `);
  expect(lines.slice(2, 14).map((line) => line.trimEnd())).toEqual([
    expect.stringMatching(/^ {3}◆ lead +running · claude$/),
    "",
    " 1 Backlog 1",
    " 2 Building 3 · 1 needs you",
    expect.stringMatching(/^ ▸ ● app-12 +Rate limit the API +needs you: question$/),
    expect.stringMatching(/^ {3}○ app-9 +Old work +stopped$/),
    expect.stringMatching(/^ {3}○ app-7 +Login redirect +working · 14:55$/),
    "",
    " 3 Reviewing 0",
    " 4 Checks 0",
    " 5 Ready 1",
    " 6 Done 0",
  ]);
  // The bottom line has the keys, and the load at its right end.
  expect(lines.at(-1)).toBe(` ↑↓ move  ⏎ open  1-6 stages  q quit${" ".repeat(36)}cpu 12% `);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(lines).toHaveLength(20);
});

test("an open stage shows its rows, and its heading is bright while a closed one is dim", () => {
  const lines = drawn(1, 24, 80, ["backlog", "ready"]);
  expect(lines.slice(4, 12).map((line) => line.trimEnd())).toEqual([
    " 1 Backlog 1",
    expect.stringMatching(/^ ▸ ○ app-31 +Export as CSV +5 Nov$/),
    "",
    " 2 Building 3 · 1 needs you",
    " 3 Reviewing 0",
    " 4 Checks 0",
    " 5 Ready 1",
    expect.stringMatching(/^ {3}● app-14 +Fix the export header +approved · #41$/),
  ]);
  const coloured = drawnWith(1, frame, { width: 80, height: 24 }, ["backlog"]);
  expect(coloured).toContain(" \x1b[90m1\x1b[22;39m \x1b[1mBacklog 1\x1b[22;39m");
  expect(coloured).toContain(
    " \x1b[90m2\x1b[22;39m \x1b[90mBuilding 3\x1b[22;39m\x1b[38;5;221m · 1 needs you\x1b[22;39m",
  );
});

test("a row's word is in its colour and what follows it is dim", () => {
  const coloured = drawnWith(1, frame, { width: 80, height: 20 });
  const row = coloured.find((line) => line.includes("app-7")) ?? "";
  expect(row).toContain("\x1b[1mworking\x1b[22;39m\x1b[90m · 14:55\x1b[22;39m");
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
  expect(Bun.stripANSI(top)).toEndWith("docs •1  site •2 •1 ");
  expect(top).toContain("\x1b[38;5;120m•1");
  expect(top).toContain("\x1b[38;5;221m•2");
});

test("a list taller than the terminal scrolls to keep the row you are on in view", () => {
  const lines = drawn(4, 8, 80, ["building", "ready"]);
  expect(lines).toHaveLength(8);
  expect(lines.some((line) => line.includes("▸ ● app-14"))).toBe(true);
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
// which leaves its session behind with its last screen.
function agent(name: string, labels: Labels): void {
  const script = join(home, `${name}.sh`);
  writeFileSync(
    script,
    `#!/bin/sh
cd ${JSON.stringify(home)}
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
  agent("app-7", { repository: "simon/app", role: "builder", task: "app-7" });
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
  await until(() => seen().includes("q quit"), "the list");
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

test("Enter attaches to the builder, every key reaches it, and Alt-Q comes back on the same row", async () => {
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
  press("M-q");
  await until(() => seen().includes("q quit"), "the list again");
  expect(here()).toStartWith("▸ ○ app-7");
  expect(read(join(home, "left"))).toBe("");
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
  await until(() => seen().includes("q quit"), "the list again");
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
  press("M-q");
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
  await until(() => seen().includes("q quit"), "the list again");
  expect(clients()).toBe("app-7");
});

// Over ssh an arrow's escape sequence can arrive in two reads.
test("an arrow whose escape sequence comes in two pieces still moves", async () => {
  await open();
  type("\x1b[");
  type("B");
  await until(() => here().startsWith("▸ ○ app-9"), "the row below");
  // Esc alone is still a key, which moves nothing.
  type("\x1b");
  await Bun.sleep(300);
  type("\x1b[A");
  await until(() => here().startsWith("▸ ● app-12"), "the row above");
});

// Only Building is open at first, so a task ready for review waits under its closed heading.
test("with nothing in Building needing you, the list opens on the lead", async () => {
  sql("UPDATE threads SET asking = 0, needs_you = 0 WHERE folder = 'app-12';");
  await open();
  expect(here()).toStartWith("▸ ◆ lead");
  expect(seen()).toContain(" 5 Ready 1");
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
  await until(() => seen().includes("· site"), "site's list");
  press("Tab");
  await until(() => seen().includes("· app"), "app's list again");
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
  await until(
    () => here().startsWith("▸ ◆ lead") && here().includes("stopped"),
    "the lead stopped",
  );
  press("Enter");
  await until(
    () => seen().includes("The lead didn't start: Claude Code's login for agents is gone"),
    "why the lead didn't start",
  );
});

test("Enter on the lead attaches to it", async () => {
  await open();
  for (const _ of [1, 2, 3]) press("Up");
  await until(() => here().startsWith("▸ ◆ lead"), "the lead's row");
  press("Enter");
  await until(() => seen().includes("I am lead"), "the lead");
  press("M-q");
  await until(() => here().startsWith("▸ ◆ lead"), "the list on the lead's row");
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
  press("Enter");
  await until(() => seen().includes("I am fake-app-12 on fake"), "the host's attach");
  press("Enter");
  await until(() => seen().includes("q quit"), "the list again");
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
  await until(() => seen().includes("q quit"), "the keys again");
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
  await until(() => seen().includes("· site"), "site's list");
  expect(seen()).toContain("site-3");
  await until(() => asked.includes("open simon/site from a tab"), "site opened");
});
