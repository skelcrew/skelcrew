// What the lists of issues, PRs and threads have, in their groups, and the counts beside the
// sidebar's entries, read from a database of the test's own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedAt,
  type Entry,
  type EntryCount,
  type Group,
  type ListRow,
} from "../src/screen/lists.ts";
import { drawList } from "../src/screen/pane.ts";
import { fakePlugin, itemSql, source, threadSql } from "./harness.ts";

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
${threadSql({ task: "12" })}`;
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
${itemSql("app", "task", 14, "Fix signup", "2026-11-03T10:00:00Z")}
${threadSql({ task: "12", status: "waiting", needs_you: 1, verdict: "approve" })}
${threadSql({ task: "13", status: "done" })}
${threadSql({ task: "14", status: "stopped" })}`;
  const { issues } = after(sql);
  // A stopped thread still holds its issue, so the issue has started.
  expect(shape(issues)).toEqual([
    ["Not started", [["○", "app-13", "Fix logout"]]],
    [
      "Started",
      [
        ["●", "app-12", "Fix login", "approved"],
        ["◐", "app-14", "Fix signup", "stopped"],
      ],
    ],
  ]);
  // The marks have no colour, and a word has its thread's mark colour: green once approved.
  expect(issues[1]?.rows[0]?.mark[1]).toBeNull();
  expect(issues[1]?.rows[0]?.ends[0]?.[1]).toBe("38;5;120");
  expect(issues[1]?.rows[1]?.ends[0]?.[1]).toBe("90");
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
${threadSql({ task: "12", status: "waiting", pr: 31, needs_you: 1, verdict: "approve", review_round: 1 })}
${threadSql({ task: "13", pr: 34, review_round: 1, verdict: "changes" })}
${threadSql({ task: "14", status: "failed", pr: 35 })}
${itemSql("app", "pr", 36, "Fix export", "2026-11-09T10:00:00Z")}
${itemSql("app", "pr", 37, "Fix import", "2026-11-10T10:00:00Z")}
${threadSql({ task: "15", pr: 36, erred: 1 })}
${threadSql({ task: "16", pr: 37, asking: 1 })}`;
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
        ["○", "app#37", "Fix import", "question"],
        ["○", "app#36", "Fix export", "error"],
        ["○", "app#35", "Fix signup", "failed"],
        ["◐", "app#34", "Fix logout", "working"],
        ["○", "app#33", "Tidy", "bob"],
      ],
    ],
  ]);
  // A PR from a thread takes its colour when the thread's mark is filled: green when approved,
  // yellow when it needs you, and red when it failed or hit an error. It is plain otherwise.
  expect(prs[0]?.rows.map((row) => row.mark[1])).toEqual([null, "38;5;120"]);
  expect(prs[1]?.rows.map((row) => row.mark[1])).toEqual([
    "38;5;221",
    "38;5;210",
    "38;5;210",
    null,
    null,
  ]);
  // The word has the thread's mark colour, bright for a working builder, and the author is dim.
  expect(prs[0]?.rows.map((row) => row.ends[0]?.[1])).toEqual(["90", "38;5;120"]);
  expect(prs[1]?.rows.map((row) => row.ends[0]?.[1])).toEqual([
    "38;5;221",
    "38;5;210",
    "38;5;210",
    "1",
    "90",
  ]);
});

// Returns a review on a PR with no thread, by a reviewer, with a verdict.
const review = (id: string, login: string, verdict: string) => ({
  id,
  text: "",
  author: { login, bot: false, you: false },
  verdict,
  lines: [],
});
const passing = { checks: [{ name: "test", id: "1", state: "passed" }] };

test("a PR with no thread is ready only when someone approves, nobody asks for changes, and checks pass", () => {
  const pr = (id: number, more: object) =>
    itemSql("app", "pr", id, `PR ${id}`, `2026-11-0${id}T10:00:00Z`, { ...passing, ...more });
  const sql = `${repository}
${pr(1, { reviews: [review("1", "ana", "approved")] })}
${pr(2, { reviews: [review("1", "ana", "approved"), review("2", "ana", "dismissed")] })}
${pr(3, { reviews: [review("1", "bob", "changes requested"), review("2", "ana", "approved")] })}
${pr(4, { reviews: [review("1", "bob", "changes requested"), review("2", "bob", "approved")] })}
${pr(5, { reviews: [review("1", "ana", "approved"), review("2", "ana", "commented")] })}
${pr(6, { reviews: [review("1", "ana", "approved")], checks: [{ name: "test", id: "1", state: "failed" }] })}
${pr(7, { reviews: [] })}`;
  const { prs, entries } = after(sql);
  expect(shape(prs)).toEqual([
    [
      "Ready to merge",
      [
        ["●", "app#5", "PR 5", ""],
        ["●", "app#4", "PR 4", ""],
        ["●", "app#1", "PR 1", ""],
      ],
    ],
    [
      "In review",
      [
        ["○", "app#7", "PR 7", ""],
        ["○", "app#6", "PR 6", ""],
        ["○", "app#3", "PR 3", ""],
        ["○", "app#2", "PR 2", ""],
      ],
    ],
  ]);
  expect(entries.find((e) => e.entry === "prs")?.notes).toEqual([["3 ready", "38;5;120"]]);
});

// What s on each issue's row, or m on each PR's row, does, in the list's order.
const actions = (groups: Group[]) => groups.flatMap((group) => group.rows.map((row) => row.action));

test("s on an issue no thread works on asks to start one, and on one that has a thread says which", () => {
  const sql = `${repository}
${itemSql("app", "task", 31, "Add CSV export", "2026-11-05T10:00:00Z")}
${itemSql("app", "task", 12, "Fix login", "2026-11-04T10:00:00Z")}
${itemSql("app", "task", 13, "Fix logout", "2026-11-03T10:00:00Z")}
${threadSql({ task: "12" })}
${threadSql({ task: "13", status: "stopped" })}`;
  expect(actions(after(sql).issues)).toEqual([
    {
      key: "s",
      ask: "Start a thread on app#31? y/n",
      working: "Starting app-31…",
      request: { command: "start", repo: "simon/app", task: "31" },
    },
    { key: "s", refused: "app#12 already has app-12" },
    { key: "s", refused: "app#13 already has app-13" },
  ]);
});

// The commit is the PR's head as the forge last sent it, which it merges only while it is still
// the head. A forge too old to send one can't be asked to merge.
test("m on a PR ready to merge asks to merge it into its base, and elsewhere says what it waits on", () => {
  const head = { head: "c".repeat(40) };
  const sql = `${repository}
${itemSql("app", "pr", 31, "Fix login", "2026-11-04T10:00:00Z", head)}
${itemSql("app", "pr", 32, "Bump deps", "2026-11-05T10:00:00Z", { ...passing, ...head, base: "next", reviews: [review("1", "ana", "approved")] })}
${itemSql("app", "pr", 33, "Tidy", "2026-11-06T10:00:00Z", { ...passing, reviews: [review("1", "ana", "approved")] })}
${itemSql("app", "pr", 34, "Fix logout", "2026-11-07T10:00:00Z", { ...head, reviews: [review("1", "ana", "approved")], checks: [{ name: "test", id: "1", state: "running" }] })}
${itemSql("app", "pr", 35, "Fix signup", "2026-11-08T10:00:00Z", { ...passing, ...head })}
${itemSql("app", "pr", 36, "Fix export", "2026-11-09T10:00:00Z", head)}
${itemSql("app", "pr", 37, "Fix import", "2026-11-10T10:00:00Z", head)}
${threadSql({ task: "12", status: "waiting", pr: 31, needs_you: 1, verdict: "approve", review_round: 1 })}
${threadSql({ task: "13", status: "waiting", pr: 36, verdict: "approve", review_round: 1 })}
${threadSql({ task: "14", pr: 37, review_round: 1, verdict: "changes" })}`;
  const { prs } = after(sql);
  expect(prs.map((group) => group.rows.map((row) => row.name))).toEqual([
    ["app#33", "app#32", "app#31"],
    ["app#37", "app#36", "app#35", "app#34"],
  ]);
  expect(actions(prs)).toEqual([
    { key: "m", refused: "app#33 needs a newer forge plugin to merge here: run sc plugin update" },
    {
      key: "m",
      ask: "Merge app#32 into next? y/n",
      working: "Merging app#32…",
      request: { command: "merge", repo: "simon/app", pr: 32, commit: "c".repeat(40) },
    },
    {
      key: "m",
      ask: "Merge app#31 into main? y/n",
      working: "Merging app#31…",
      request: { command: "merge", repo: "simon/app", pr: 31, commit: "c".repeat(40) },
    },
    { key: "m", refused: "app#37 isn't approved yet" },
    { key: "m", refused: "app#36's checks haven't passed yet" },
    { key: "m", refused: "app#35 isn't approved yet" },
    { key: "m", refused: "app#34's checks haven't passed yet" },
  ]);
});

test("a thread's row has nothing for s or m to do", () => {
  const sql = `${repository}
${threadSql({ task: "12" })}`;
  expect(actions(after(sql).threads)).toEqual([null]);
});

test("a PR from a thread is ○ before its first review, and ◐ once a review runs or has run", () => {
  const sql = `${repository}
${itemSql("app", "pr", 31, "Waiting", "2026-11-01T10:00:00Z")}
${itemSql("app", "pr", 32, "Reviewing", "2026-11-02T10:00:00Z")}
${itemSql("app", "pr", 33, "Fixing", "2026-11-03T10:00:00Z")}
${threadSql({ task: "12", pr: 31 })}
${threadSql({ task: "13", status: "waiting", pr: 32, reviewing: "abc" })}
${threadSql({ task: "14", pr: 33, review_round: 1, verdict: "changes" })}`;
  expect(shape(after(sql).prs)).toEqual([
    [
      "In review",
      [
        ["◐", "app#33", "Fixing", "working"],
        ["◐", "app#32", "Reviewing", "reviewing"],
        ["○", "app#31", "Waiting", "working"],
      ],
    ],
  ]);
});

test("threads come as needs you, ready to merge, working, then stopped, with all ACTIVE hasn't room for", () => {
  const today = new Date(2026, 10, 13, 16, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 32).getTime();
  const sql = `${repository}
${threadSql({ task: "12", pr: 31, harness: "codex", title: "Fix login", changed: at(13, 14) })}
${threadSql({ task: "t1", status: "waiting", title: "Tidy up", changed: at(12, 9), needs_you: 0, asking: 1 })}
${threadSql({ task: "13", status: "stopped", title: "Old", started: at(2, 9) })}
${threadSql({ task: "14", status: "done", title: "Gone" })}
${threadSql({ task: "15", status: "failed", title: "Broke" })}
${threadSql({ task: "16", title: "Stuck", erred: 1 })}
${threadSql({ task: "17", status: "waiting", title: "Done", needs_you: 1, verdict: "approve" })}`;
  const { threads } = after(sql, today);
  expect(shape(threads)).toEqual([
    [
      "Needs you",
      [
        ["●", "app-16", "Stuck", "error", "claude", "#16", ""],
        ["●", "app-15", "Broke", "failed", "claude", "#15", ""],
        ["●", "app-t1", "Tidy up", "question", "claude", "", "12 Nov"],
      ],
    ],
    // An approved thread waits only for your merge, so it is ready rather than needing you.
    ["Ready to merge", [["●", "app-17", "Done", "approved", "claude", "#17", ""]]],
    ["Working", [["○", "app-12", "Fix login", "working", "codex", "#12 #31", "14:32"]]],
    ["Stopped", [["○", "app-13", "Old", "stopped", "claude", "#13", "2 Nov"]]],
  ]);
  // Each mark and word has its colour in ACTIVE: bright while its builder works, and dim once
  // it stopped.
  const colours = ["38;5;210", "38;5;210", "38;5;221", "38;5;120", "1", "90"];
  expect(threads.flatMap((g) => g.rows.map((row) => row.mark[1]))).toEqual(colours);
  expect(threads.flatMap((g) => g.rows.map((row) => row.ends[0]?.[1]))).toEqual(colours);
  expect(threads.flatMap((g) => g.rows.map((row) => row.dim))).toEqual([
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
  expect(threads[0]?.rows[2]?.session).toBe("app-t1");
});

test("while a review runs, a thread's harness is its reviewer's", () => {
  const sql = `${repository} ${threadSql({ task: "12", status: "waiting", harness: "claude", reviewing: "abc", reviewer: "codex" })}`;
  expect(shape(after(sql).threads)[0]?.[1]).toEqual([
    ["○", "app-12", "", "reviewing", "codex", "#12", ""],
  ]);
});

test("a review waiting for a place is queued for review, on its reviewer, and its PR in a round", () => {
  const sql = `${repository}
${itemSql("app", "pr", 31, "Waiting", "2026-11-01T10:00:00Z")}
${threadSql({ task: "12", status: "waiting", pr: 31, harness: "claude", reviewing: "abc", reviewer: "codex", queued: 5 })}`;
  const { threads, prs } = after(sql);
  expect(shape(threads)[0]?.[1]).toEqual([
    ["○", "app-12", "", "queued for review", "codex", "#12 #31", ""],
  ]);
  expect(shape(prs)[0]?.[1]).toEqual([["◐", "app#31", "Waiting", "queued for review"]]);
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
${threadSql({ task: "12", status: "waiting", pr: 34, needs_you: 1, verdict: "approve" })}
${threadSql({ task: "13", status: "stopped" })}
${threadSql({ task: "14", status: "done" })}
${threadSql({ task: "15", asking: 1 })}`;
  // The approved thread is ready, so it counts on PRs, and only the question needs you.
  expect(after(sql).entries).toEqual([
    { entry: "issues", name: "Issues", total: 2, notes: [] },
    { entry: "threads", name: "Threads", total: 3, notes: [["1 needs you", "38;5;221"]] },
    { entry: "prs", name: "PRs", total: 1, notes: [["1 ready", "38;5;120"]] },
  ]);
});

test("each entry is there with nothing open, so the threads below never move", () => {
  expect(after(repository).entries).toEqual([
    { entry: "issues", name: "Issues", total: 0, notes: [] },
    { entry: "threads", name: "Threads", total: 0, notes: [] },
    { entry: "prs", name: "PRs", total: 0, notes: [] },
  ]);
});

test("more than one thread need you, and failed ones count with them", () => {
  const sql = `${repository} ${threadSql({ task: "12", status: "waiting", needs_you: 1 })} ${threadSql({ task: "13", status: "failed" })}`;
  expect(after(sql).entries[1]?.notes).toEqual([["2 need you", "38;5;221"]]);
});

test("with no forge, Threads says how many are ready before how many need you", () => {
  const sql = `${repository}
${threadSql({ task: "12", status: "waiting", needs_you: 1, verdict: "approve" })}
${threadSql({ task: "13", asking: 1 })}
${threadSql({ task: "14", erred: 1 })}`;
  expect(after(sql, 0, false).entries).toEqual([
    {
      entry: "threads",
      name: "Threads",
      total: 3,
      notes: [
        ["1 ready", "38;5;120"],
        ["2 need you", "38;5;221"],
      ],
    },
  ]);
});

test("a repository with no tracker has no Issues, and one with no forge no PRs", () => {
  expect(after(repository, 0, false).entries.map((e) => e.name)).toEqual(["Threads"]);
});

test("only the open repository's issues, PRs and threads are listed", () => {
  const sql = `${repository}
INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site');
${itemSql("site", "task", 1, "Elsewhere", "2026-11-04T10:00:00Z")}
${itemSql("site", "pr", 2, "Elsewhere", "2026-11-04T10:00:00Z")}
${threadSql({ repo: "site", task: "1" })}`;
  const { issues, threads, prs } = after(sql);
  expect([issues, threads, prs]).toEqual([[], [], []]);
});

// A row of a list, as the database would give it, with more as given.
const listRow = (name: string, title: string, more: Partial<ListRow> = {}): ListRow => ({
  mark: ["○", null],
  name,
  title,
  ends: [],
  link: `https://github.com/simon/app/issues/${name.slice(4)}`,
  session: null,
  dim: false,
  action: null,
  ...more,
});
const issues: Group[] = [
  { heading: "Not started", rows: [listRow("app-31", "Add CSV export")] },
  {
    heading: "Started",
    rows: [listRow("app-9", "Fix login", { mark: ["◐", null], ends: [["working", "90"]] })],
  },
];
// The list's lines as you read them, without colours or what fills them out.
const lines = (groups: Group[], here: number, width = 60, entry: Entry = "issues") =>
  drawList(groups, entry, here, width).map(({ text }) => Bun.stripANSI(text).trimEnd());

test("a list starts with its keys, then each group under its heading, with the ends lined up", () => {
  // The word ends two columns before the edge of a pane 60 wide.
  expect(lines(issues, 0)).toEqual([
    "  ↑↓ move  ⏎ open",
    "",
    "  Not started",
    "  ○ app-31  Add CSV export",
    "",
    "  Started",
    "  ◐ app-9   Fix login                              working",
  ]);
  const drawn = drawList(issues, "issues", 0, 60).map(({ text }) => text);
  expect(drawn[0]).toContain("\x1b[90m  ↑↓ move  ⏎ open");
  expect(drawn[2]).toContain("\x1b[90m  Not started");
});

test("the threads' ends line up in columns: word, harness, issue and PR, and when it changed", () => {
  const threads: Group[] = [
    {
      heading: "Working",
      rows: [
        listRow("app-12", "Fix login", {
          ends: [
            ["working", "90"],
            ["codex", "90"],
            ["#12 #31", "90"],
            ["14:32", "90"],
          ],
          link: null,
          session: "app-12",
        }),
        listRow("app-t1", "Tidy up", {
          ends: [
            ["question", "38;5;221"],
            ["claude", "90"],
            ["", "90"],
            ["12 Nov", "90"],
          ],
          link: null,
          session: "app-t1",
        }),
      ],
    },
  ];
  expect(lines(threads, 0, 70, "threads").slice(3)).toEqual([
    "  ○ app-12  Fix login              working   codex   #12 #31  14:32",
    "  ○ app-t1  Tidy up                question  claude           12 Nov",
  ]);
});

test("the row you are on is shaded across the whole width, in the light colours", () => {
  const drawn = drawList(issues, "issues", 1, 60);
  const shaded = drawn.filter(({ text }) => text.includes("48;5;238"));
  expect(shaded.map(({ row }) => row)).toEqual([1]);
  expect(Bun.stringWidth(shaded[0]?.text ?? "")).toBe(60);
  expect(shaded[0]?.text).toContain("1;38;5;231");
  expect(shaded[0]?.text).not.toContain("\x1b[90m");
});

// A theme's own colours could look like another one on the grey, so a mark keeps one colour.
test("a mark is the same colour whether or not you are on its row", () => {
  const waiting = listRow("app#34", "Fix login", { mark: ["◐", "38;5;221"] });
  const groups = [{ heading: "In review", rows: [waiting] }];
  for (const here of [0, -1])
    expect(drawList(groups, "prs", here, 60)[3]?.text).toContain("\x1b[38;5;221m◐");
});

test("each line says which row a click on it opens, and other lines open nothing", () => {
  expect(drawList(issues, "issues", 0, 60).map(({ row }) => row)).toEqual([
    null,
    null,
    null,
    0,
    null,
    null,
    1,
  ]);
});

test("an issue's or PR's row is a terminal link, and a thread's isn't", () => {
  const drawn = drawList(issues, "issues", 0, 60).map(({ text }) => text);
  expect(drawn[3]).toContain("\x1b]8;;https://github.com/simon/app/issues/31\x1b\\");
  const thread = listRow("app-12", "Fix", { link: null, session: "app-12" });
  const row = drawList([{ heading: "Working", rows: [thread] }], "threads", 0, 60)[3];
  expect(row?.text).not.toContain("\x1b]8;");
});

test("a title is cut with … only on a pane too narrow for it, and the ends stay", () => {
  const long = "A title long enough to need cutting on a narrow pane";
  const groups = [
    { heading: "Started", rows: [listRow("app-9", long, { ends: [["working", "90"]] })] },
  ];
  expect(lines(groups, 0, 90)[3]).toContain(long);
  const narrow = lines(groups, 0, 40)[3] ?? "";
  expect(narrow).toStartWith("  ○ app-9  A title");
  expect(narrow).toEndWith("…  working");
  expect(Bun.stringWidth(narrow)).toBe(38);
});

test("a stopped thread's row is dim, as opening it does nothing", () => {
  const stopped = listRow("app-13", "Old", { mark: ["○", "90"], dim: true, link: null });
  const row = drawList([{ heading: "Stopped", rows: [stopped] }], "threads", -1, 60)[3];
  expect(row?.text).toContain("\x1b[90mapp-13");
  expect(row?.text).toContain("\x1b[90mOld");
});

test("a list with nothing in it says so", () => {
  expect(lines([], 0, 60, "issues")).toEqual(["", "  No open issues"]);
  expect(lines([], 0, 60, "prs")).toEqual(["", "  No open PRs"]);
  expect(lines([], 0, 60, "threads")).toEqual(["", "  No threads"]);
});

test("control codes from outside never reach your terminal", () => {
  const bad = listRow("app-1", "Bad\x1b[2J\x07title", { ends: [["al\x1b]0;x\x07ice", "90"]] });
  const text = drawList([{ heading: "In review", rows: [bad] }], "prs", 0, 60)
    .map((line) => line.text)
    .join("\n");
  expect(text).not.toContain("\x1b[2J");
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\x1b]0;");
});
