// What the lists of issues, PRs and threads have, in their groups, and the counts beside the
// sidebar's entries, read from a database of the test's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedAt, type EntryCount, type Group } from "../src/screen/lists.ts";
import { fakePlugin, itemSql, source } from "./harness.ts";

let home = "";
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-lists-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// app, with the fake plugin as its tracker and forge unless `plugins` is false.
const repository = `INSERT INTO repositories (name, owner, repo, kept_lead, lead_session)
  VALUES ('app', 'simon', 'app', 1, 's');`;

// Returns each list and the entries after running the SQL, at a moment in milliseconds. It takes
// a process of its own with HOME set: homedir() keeps the HOME this process started with, so
// opening the database from here would reach your real one.
function after(
  sql: string,
  now = 0,
  plugins = true,
): { issues: Group[]; threads: Group[]; prs: Group[]; entries: EntryCount[] } {
  if (plugins) {
    fakePlugin(home);
    const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, "skelcrew.yaml"), "tracker: github\n");
  }
  const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { entryCounts, listGroups } from ${JSON.stringify(source("screen/lists.ts"))};
const db = openDb();
db.run(${JSON.stringify(sql)});
db.run("UPDATE repositories SET forge = 'github' WHERE ${plugins ? "1" : "0"}");
const app = { owner: "simon", repo: "app", lead: "lead" };
const list = (entry) => listGroups(db, app, entry, ${now});
console.log(JSON.stringify({ issues: list("issues"), threads: list("threads"), prs: list("prs"),
  entries: entryCounts(db, app) }));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

// Returns a thread's insert, on a task, with more columns as given.
const thread = (task: string, columns = "", values = "") =>
  `INSERT INTO threads (owner, repo, task, folder, branch, status${columns})
    VALUES ('simon', 'app', '${task}', 'app-${task}', 'skelcrew/${task}', ${values || "'working'"});`;

// Returns the groups as headings and, under each, its rows' marks, names and ends.
const shape = (groups: Group[]) =>
  groups.map(({ heading, rows }) => [
    heading,
    rows.map((row) => [row.mark[0], row.name, row.title, ...row.ends.map(([t]) => t)]),
  ]);

test("issues come as not started, then started, newest first, with the thread's word", () => {
  const sql = `${repository}
${itemSql("app", "task", 12, "Fix login", "2026-11-04T10:00:00Z")}
${itemSql("app", "task", 31, "Add CSV export", "2026-11-05T10:00:00Z")}
${itemSql("app", "task", 9, "Old thing", "2026-11-01T10:00:00Z")}
${thread("12")}`;
  expect(shape(after(sql).issues)).toEqual([
    [
      "Not started",
      [
        ["○", "app-31", "Add CSV export"],
        ["○", "app-9", "Old thing"],
      ],
    ],
    ["Started", [["◐", "app-12", "Fix login", "working"]]],
  ]);
});

test("an issue whose thread is approved is full, and one whose thread is done is not started", () => {
  const sql = `${repository}
${itemSql("app", "task", 12, "Fix login", "2026-11-04T10:00:00Z")}
${itemSql("app", "task", 13, "Fix logout", "2026-11-04T10:00:00Z")}
${thread("12", ", needs_you, verdict", "'waiting', 1, 'approve'")}
${thread("13", "", "'done'")}`;
  const { issues } = after(sql);
  expect(shape(issues)).toEqual([
    ["Not started", [["○", "app-13", "Fix logout"]]],
    ["Started", [["●", "app-12", "Fix login", "approved"]]],
  ]);
  // The marks have no colour, and a word that needs you is yellow.
  expect(issues[1]?.rows[0]?.mark[1]).toBeNull();
  expect(issues[1]?.rows[0]?.ends[0]?.[1]).toBe(33);
  expect(issues[1]?.rows[0]?.link).toBe("https://github.com/simon/app/issues/12");
});

test("PRs come as ready to merge, then in review, with the thread's word or the author", () => {
  const passed = { checks: [{ name: "test", id: "1", state: "passed" }] };
  const approved = {
    ...passed,
    reviews: [{ id: "1", text: "", author: null, verdict: "approved", lines: [] }],
    author: { login: "alice", bot: false, you: false },
  };
  const sql = `${repository}
${itemSql("app", "pr", 31, "Fix login", "2026-11-04T10:00:00Z")}
${itemSql("app", "pr", 32, "Bump deps", "2026-11-05T10:00:00Z", approved)}
${itemSql("app", "pr", 33, "Tidy", "2026-11-06T10:00:00Z", { ...passed, author: { login: "bob", bot: false, you: false } })}
${itemSql("app", "pr", 34, "Fix logout", "2026-11-07T10:00:00Z")}
${itemSql("app", "pr", 35, "Fix signup", "2026-11-08T10:00:00Z")}
${thread("12", ", pr, needs_you, verdict, review_round", "'waiting', 31, 1, 'approve', 1")}
${thread("13", ", pr, review_round, verdict", "'working', 34, 1, 'changes'")}
${thread("14", ", pr", "'failed', 35")}`;
  const { prs } = after(sql);
  expect(shape(prs)).toEqual([
    [
      "Ready to merge",
      [
        ["●", "app#32", "Bump deps", "alice"],
        ["●", "app#31", "Fix login", "approved"],
      ],
    ],
    [
      "In review",
      [
        ["○", "app#35", "Fix signup", "failed"],
        ["◐", "app#34", "Fix logout", "working"],
        ["○", "app#33", "Tidy", "bob"],
      ],
    ],
  ]);
  // A PR from a thread takes its colour where that means something, and is plain otherwise.
  expect(prs[0]?.rows.map((row) => row.mark[1])).toEqual([null, 33]);
  expect(prs[1]?.rows.map((row) => row.mark[1])).toEqual([31, null, null]);
});

test("threads come as needs you, working, then stopped, with all THREADS hasn't room for", () => {
  const today = new Date(2026, 10, 13, 16, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 32).getTime();
  const sql = `${repository}
${thread("12", ", pr, harness, title, changed", `'working', 31, 'codex', 'Fix login', ${at(13, 14)}`)}
${thread("t1", ", title, changed, needs_you, asking", `'waiting', 'Tidy up', ${at(12, 9)}, 0, 1`)}
${thread("13", ", title, started", `'stopped', 'Old', ${at(2, 9)}`)}
${thread("14", ", title", "'done', 'Gone'")}
${thread("15", ", title", "'failed', 'Broke'")}`;
  const { threads } = after(sql, today);
  expect(shape(threads)).toEqual([
    [
      "Needs you",
      [
        ["●", "app-15", "Broke", "failed", "claude", "#15", ""],
        ["●", "app-t1", "Tidy up", "question", "claude", "", "12 Nov"],
      ],
    ],
    ["Working", [["●", "app-12", "Fix login", "working", "codex", "#12 #31", "14:32"]]],
    ["Stopped", [["○", "app-13", "Old", "stopped", "claude", "#13", "2 Nov"]]],
  ]);
  // Each mark and word has its colour in THREADS, and a stopped one is dim.
  expect(threads.flatMap((g) => g.rows.map((row) => row.mark[1]))).toEqual([31, 33, 32, 90]);
  expect(threads.flatMap((g) => g.rows.map((row) => row.dim))).toEqual([false, false, false, true]);
  expect(threads[0]?.rows[1]?.session).toBe("app-t1");
});

test("a change is shown by its clock time today and its date before, so it ticks only at midnight", () => {
  const now = new Date(2026, 10, 13, 9, 5).getTime();
  expect(changedAt(new Date(2026, 10, 13, 0, 1).getTime(), now)).toBe("00:01");
  expect(changedAt(new Date(2026, 10, 12, 23, 59).getTime(), now)).toBe("12 Nov");
  expect(changedAt(new Date(2025, 0, 3, 12, 0).getTime(), now)).toBe("3 Jan");
});

test("the entries count what their lists have, and say what to act on only when there is any", () => {
  const sql = `${repository}
${itemSql("app", "task", 12, "Fix login", "2026-11-04T10:00:00Z")}
${itemSql("app", "task", 31, "Add CSV export", "2026-11-05T10:00:00Z")}
${itemSql("app", "pr", 34, "Fix login", "2026-11-05T10:00:00Z")}
${thread("12", ", pr, needs_you, verdict", "'waiting', 34, 1, 'approve'")}
${thread("13", "", "'stopped'")}
${thread("14", "", "'done'")}`;
  expect(after(sql).entries).toEqual([
    { entry: "issues", name: "Issues", total: 2, note: "1 new", warn: false },
    { entry: "threads", name: "Threads", total: 2, note: "1 needs you", warn: true },
    { entry: "prs", name: "PRs", total: 1, note: "1 ready", warn: true },
  ]);
});

test("each entry is there with nothing open, so the threads below never move", () => {
  expect(after(repository).entries).toEqual([
    { entry: "issues", name: "Issues", total: 0, note: "", warn: false },
    { entry: "threads", name: "Threads", total: 0, note: "", warn: true },
    { entry: "prs", name: "PRs", total: 0, note: "", warn: true },
  ]);
});

test("more than one thread need you, and failed ones count with them", () => {
  const sql = `${repository} ${thread("12", ", needs_you", "'waiting', 1")} ${thread("13", "", "'failed'")}`;
  expect(after(sql).entries[1]?.note).toBe("2 need you");
});

test("a repository with no tracker has no Issues, and one with no forge no PRs", () => {
  expect(after(repository, 0, false).entries.map((e) => e.name)).toEqual(["Threads"]);
});

test("only the open repository's issues, PRs and threads are listed", () => {
  const sql = `${repository}
INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${itemSql("site", "task", 1, "Elsewhere", "2026-11-04T10:00:00Z")}
${itemSql("site", "pr", 2, "Elsewhere", "2026-11-04T10:00:00Z")}
INSERT INTO threads (owner, repo, task, folder, branch, status)
  VALUES ('simon', 'site', 1, 'site-1', 'skelcrew/1', 'working');`;
  const { issues, threads, prs } = after(sql);
  expect([issues, threads, prs]).toEqual([[], [], []]);
});
