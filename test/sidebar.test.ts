// What the sidebar shows and which row a key or click picks, given the rows it was handed, and
// the word each thread gets.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printThreads, type ThreadRow } from "../src/flow/list.ts";
import { type Status, threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";
import { draw as drawWith, noticeLines } from "../src/screen/layout.ts";
import type { EntryCount } from "../src/screen/lists.ts";
import { nextList, nextRow, rowAtLine } from "../src/screen/moves.ts";
import { type Row, threadAge } from "../src/screen/rows.ts";
import { sidebarWidth } from "../src/screen/screen.ts";
import { source, threadSql } from "./harness.ts";

const row = {
  title: null,
  short: null,
  pr: null,
  checks: null,
  review: null,
  state: "idle",
  running: true,
  harness: "claude",
  agentHarness: "claude",
  age: "",
  tokens: "",
  step: "",
  plan: null,
  waiting: "",
  fullName: null,
} satisfies Partial<Row>;
const lead: Row = {
  ...row,
  name: "lead",
  task: "",
  session: "lead",
  status: null,
  word: "running",
};
const thread = (name: string, more: Partial<Row> = {}): Row => ({
  ...row,
  name,
  task: name.split("-").at(-1) ?? "",
  session: name,
  status: "working",
  word: "working",
  // Only a working builder has a step, as a real row has.
  step: (more.word ?? "working") === "working" ? "working" : "",
  state: stateOf(more.status ?? "working", more.word ?? "working"),
  ...more,
});
// Returns the status a host would show for a thread with this status and word, short of one
// that needs you, which a test says itself.
function stateOf(status: Row["status"], word: string): Status {
  if (status === "failed" || word === "error") return "error";
  if (word === "approved") return "ready";
  return word === "working" ? "working" : "idle";
}

const size = { width: sidebarWidth, height: 12 };
// The sidebar, a click and a move with no entries, as most of these tests need.
const draw = (rows: Row[], shown: string | null, room: typeof size) =>
  drawWith(rows, [], shown, room);
const picked = (rows: Row[], shown: string | null, room: typeof size, y: number) =>
  rowAtLine(rows, [], shown, room, y);
const stepped = (rows: Row[], shown: string | null, by: 1 | -1) =>
  nextRow(rows, [], shown, size, by);
// Removes the colours, to read a row as text.
const plain = (screen: string) => Bun.stripANSI(screen);
// The sidebar's lines as you read them, without what fills them out to the line at its edge.
const read = (screen: string) =>
  plain(screen)
    .split("\n")
    .map((text) => text.slice(0, -1).trimEnd());
// The line between the parts, as you read it.
const rule = "─".repeat(sidebarWidth - 1);
// The sidebar's rows, with the empty lines, the headings and the lines between lists left out.
const listed = (screen: string) =>
  read(screen).filter((line) => line && line !== rule && line !== "  Active");

test("a working thread has three lines: its name and title, harness, time and tokens, then its step", () => {
  const rows = [
    lead,
    thread("skelcrew-t5", {
      short: "Shift+Enter fix",
      title: "Fix Shift+Enter",
      age: "12m",
      tokens: "48k tok",
      step: "Run the sidebar tests",
    }),
    thread("site-7", { title: "Add docs", status: "waiting", word: "reviewing", harness: "codex" }),
  ];
  expect(listed(draw(rows, "lead", { width: sidebarWidth, height: 14 }))).toEqual([
    "  ◆ lead",
    "    running · claude",
    "  ○ t5 Shift+Enter fix",
    "    claude · 12m · 48k tok",
    "    Run the sidebar tests",
    "  ○ 7 Add docs",
    "    reviewing · codex",
  ]);
});

test("a working thread's second line is a light grey and its third is dim, so they read apart", () => {
  const working = thread("app-12", { age: "5m", tokens: "850 tok", step: "Editing rows.ts" });
  const screen = draw([working], "lead", size);
  expect(screen).toContain("\x1b[38;5;250mclaude · 5m · 850 tok");
  expect(screen).toContain("\x1b[90mEditing rows.ts");
});

test("on the grey, a working thread's second line is lighter than its third", () => {
  const working = thread("app-12", { age: "5m", step: "Editing rows.ts" });
  const on = selected(draw([working], "app-12", size)).join("\n");
  expect(on).toContain("\x1b[38;5;253mclaude · 5m");
  expect(on).toContain("\x1b[38;5;250mEditing rows.ts");
});

test("a working thread's plan follows its tokens, as a count, and a bar when there is room", () => {
  const working = thread("app-12", { age: "5m", tokens: "850 tok", plan: { done: 3, total: 7 } });
  expect(listed(draw([working], "lead", size))[1]).toBe("    claude · 5m · 850 tok · 3/7");
  // With room for the bar, it comes before the count.
  const roomy = thread("app-12", { age: "5m", plan: { done: 3, total: 7 } });
  expect(listed(draw([roomy], "lead", size))[1]).toBe("    claude · 5m · ▰▰▰▱▱▱▱ 3/7");
});

test("a plan's bar gives way first, then the harness, then the plan's count", () => {
  const plan = { done: 3, total: 7 };
  const line = (more: Partial<Row>) =>
    listed(
      draw([thread("app-12", { age: "12m", tokens: "48k tok", plan, ...more })], "lead", size),
    )[1];
  expect(line({})).toBe("    claude · 12m · 48k tok · 3/7");
  const review = { round: 2, reviewer: "codex", verdict: "changes" };
  expect(line({ review })).toBe("    round 2 · 12m · 48k tok · 3/7");
  expect(line({ review, tokens: "1.2M tok", plan: { done: 10, total: 12 } })).toBe(
    "    round 2 · 12m · 1.2M tok",
  );
});

test("a long plan's bar has ten cells", () => {
  const working = thread("app-12", { age: "5m", plan: { done: 15, total: 30 } });
  expect(listed(draw([working], "lead", size))[1]).toBe("    claude · 5m · ▰▰▰▰▰▱▱▱▱▱ 15/30");
});

test("once a thread has had a review, its row says the round, working or not", () => {
  const review = { round: 2, reviewer: "codex", verdict: "changes" };
  const rows = [
    thread("app-12", { review, age: "5m" }),
    thread("app-7", { review, status: "waiting", word: "reviewing", harness: "codex" }),
    thread("app-3", { status: "waiting", word: "checks" }),
  ];
  const lines = listed(draw(rows, "lead", { width: sidebarWidth, height: 14 }));
  expect(lines[1]).toBe("    claude · round 2 · 5m");
  expect(lines[4]).toBe("    reviewing · codex · round 2");
  expect(lines[6]).toBe("    checks · claude");
});

test("a step too long for its line is cut with …, and its control codes never reach you", () => {
  const step = "Run every test of the sidebar and the strip\x1b[2J at once";
  const screen = draw([thread("app-12", { step })], "lead", size);
  expect(listed(screen)[2]).toBe("    Run every test of the sidebar …");
  expect(screen).not.toContain("\x1b[2J");
});

// A message that hasn't reached a builder is never held silently: its row says so, after the
// word on a waiting row, and in place of the step on a working one.
test("a thread with messages waiting for its builder says how many on its row", () => {
  const rows = [
    lead,
    thread("app-12", { step: "Run the tests", waiting: "1 message waiting" }),
    thread("app-13", { status: "waiting", word: "approved", waiting: "2 messages waiting" }),
  ];
  expect(listed(draw(rows, "lead", { width: sidebarWidth, height: 14 }))).toEqual([
    "  ◆ lead",
    "    running · claude",
    "  ○ 12 app-12",
    "    claude",
    "    1 message waiting",
    "  ● 13 app-13",
    "    approved · 2 messages waiting …",
  ]);
});

test("the sidebar is 38 columns wide, with room for 31 of a name and title", () => {
  expect(sidebarWidth).toBe(38);
  const title = "Send people back to the page they came from after signing in";
  expect(listed(draw([thread("app-9", { title })], "lead", size))[0]).toBe(
    "  ○ 9 Send people back to the page…",
  );
});

// A row of sc ps for a thread, with no PR or review unless given.
const psRow = (change: Partial<ThreadRow>): ThreadRow => ({
  thread: "app-9",
  short: null,
  title: "Ok",
  status: "working",
  needsYou: false,
  queued: false,
  branch: "skelcrew/9",
  pr: null,
  prUrl: null,
  checks: null,
  review: null,
  waiting: 0,
  merge: null,
  ...change,
});

test("sc ps says how many messages wait for each builder, and --json counts them", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const rows = [
    psRow({ thread: "app-9", short: "Fix", waiting: 1 }),
    psRow({ thread: "app-8", short: "Ok", status: "waiting", needsYou: true }),
  ];
  try {
    printThreads(rows, false);
    printThreads(rows, true);
  } finally {
    log.mockRestore();
  }
  expect(said[0]).toEndWith("NEEDS YOU  WAITING");
  expect(said[1]).toEndWith("1");
  expect(said[2]).toEndWith("yes");
  expect(JSON.parse(said[3] ?? "")).toEqual(rows);
});

// MERGE shows only while a thread has a merge when ready, as WAITING does for messages.
test("sc ps says which threads merge when ready, only while one does", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const rows = [
    psRow({ thread: "app-9", merge: { waits: "its checks" } }),
    psRow({ thread: "app-8", merge: { waits: null } }),
    psRow({ thread: "app-7" }),
  ];
  try {
    printThreads(rows, false);
    printThreads([psRow({ thread: "app-7" })], false);
  } finally {
    log.mockRestore();
  }
  expect(said[0]).toEndWith("NEEDS YOU  MERGE");
  expect(said[1]).toEndWith("when ready");
  expect(said[2]).toEndWith("when ready");
  expect(said[3]).toEndWith("working");
  expect(said[4]).toEndWith("NEEDS YOU");
});

// sc ps shows a thread with no short title by its title, cut so the whole row, with its PR, CI
// and review, fits a terminal 80 columns wide.
test("sc ps cuts a long title so each row fits 80 columns", () => {
  const title = "Send people back to the page they came from after signing in";
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "dotfiles-t12",
          title,
          status: "waiting",
          needsYou: true,
          pr: 242,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(2);
  for (const line of said) expect(line.length).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("dotfiles-t12  Send people");
  expect(said[1]).toContain("…  waiting  #242  running  reviewing r12  yes");
});

// A Japanese title takes two columns for each letter, so it is measured and padded by the
// columns it takes, not its letters, and the columns after it still line up.
test("sc ps lines up and fits rows whose titles mix wide and narrow letters", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ thread: "app-1", title: "ログインのリダイレクトを直して元のページに戻す", pr: 1 }),
        psRow({ thread: "app-2", title: "Send people back to the page they came from", pr: 2 }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  // STATUS starts in the same column on every row.
  const at = (line: string) => Bun.stringWidth(line.slice(0, line.indexOf("working")));
  expect(at(said[1] ?? "")).toBe(at(said[2] ?? ""));
});

// A repository's name can be long, and so its threads' names. The name is cut in its middle, so
// its task, which tells threads apart, still shows, and the row still fits.
test("sc ps cuts a long thread name in its middle, keeping its task", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "a-repository-with-a-perfectly-valid-long-name-t7",
          title: "Send people back to the page they came from",
          status: "waiting",
          needsYou: true,
          pr: 1234,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-repository-wit…-t7  ");
});

test("sc ps says a thread whose review waits for a place is queued for review", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = { short: "Export", title: null, status: "waiting" } as const;
    printThreads(
      [psRow({ ...row, thread: "app-9", queued: true }), psRow({ ...row, thread: "app-8" })],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toEqual([
    "THREAD  TITLE   STATUS             PR  CI  REVIEW  NEEDS YOU",
    "app-9   Export  queued for review",
    "app-8   Export  waiting",
  ]);
});

// With every other column at its widest, a thread queued for review next to one in its twelfth
// round, a long thread name is cut further, to what the row has left, and its task still shows.
test("sc ps fits 80 columns with a long name, a queued review and a late round", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = {
      title: "Send people back to the page they came from",
      status: "waiting",
      needsYou: true,
      pr: 1234,
      checks: "running",
    } as const;
    printThreads(
      [
        psRow({ ...row, thread: "a-repository-with-a-perfectly-valid-long-name-t7", queued: true }),
        psRow({ ...row, thread: "app-8", review: { state: "reviewing", round: 12, at: null } }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-reposi…-t7  Send…  queued for review  #1234  running");
  expect(said[2]).toContain("reviewing r12  yes");
});

// A title comes from the tracker and a short title from the lead, so either could hold a line
// break or a code your terminal would act on.
test("sc ps prints a title or short title with control codes as one clean row", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ title: "Fix\nlogin\x1b[2J" }),
        psRow({ thread: "app-8", short: "Bad\x1b]8;;http://x\x07 one" }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(3);
  for (const line of said) expect(line).not.toMatch(/\p{Cc}/u);
  expect(said[1]).toStartWith("app-9   Fix login [2J");
});

test("the second line is cut with … too, with the word whole before it", () => {
  const long = thread("app-12", { word: "reviewing", harness: "a-harness-with-a-long-name" });
  expect(listed(draw([long], "lead", size))[1]).toBe("    reviewing · a-harness-with-a-l…");
});

test("the harness is dim on the second line, beside the word in its own colour", () => {
  const needing = thread("app-12", { state: "needs you", word: "question", title: "Fix login" });
  const screen = draw([needing], "lead", size);
  expect(screen).toContain("\x1b[38;5;221mquestion\x1b[22;39m\x1b[90m · claude");
});

test("control codes in a short title never reach your terminal", () => {
  const screen = draw([thread("app-12", { short: "evil\x1b[2Jtitle" })], "lead", size);
  expect(screen).not.toContain("\x1b[2J");
});

test("a blank line sits above the lead, so the lead doesn't read as part of the header", () => {
  const lines = read(draw([lead, thread("app-12")], "lead", size));
  expect(lines[0]).toBe("");
  expect(lines[1]).toBe("  ◆ lead");
});

test("rows sit two columns in, and the line below a mark two further", () => {
  const lines = plain(draw([lead, thread("app-12")], "lead", size)).split("\n");
  const y = lines.findIndex((line) => line.includes("○"));
  expect(lines[1]?.indexOf("◆")).toBe(2);
  expect(lines[2]?.indexOf("running")).toBe(4);
  expect(lines[y]?.indexOf("○")).toBe(2);
  expect(lines[y]?.indexOf("12 app-12")).toBe(4);
  expect(lines[y + 1]?.indexOf("claude")).toBe(4);
  expect(lines[y + 2]?.indexOf("working")).toBe(4);
});

test("the harness is grey, so the titles stand out", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[38;5;250mclaude");
  const waiting = thread("app-12", { status: "waiting", word: "checks" });
  expect(draw([waiting], "lead", size)).toContain("\x1b[90m · claude");
});

test("a thread that needs you for anything but an approval has a yellow circle and word", () => {
  for (const status of ["working", "waiting"] as const)
    for (const word of ["question", "round limit", "turn ended", "review timed out", "needs you"]) {
      const needing = thread("app-12", { status, state: "needs you", word });
      const screen = draw([lead, needing], "lead", size);
      expect(read(screen).join("\n")).toContain(`  ● 12 app-12\n    ${word} · claude`);
      expect(screen).toContain("\x1b[38;5;221m●");
      expect(screen).toContain(`\x1b[38;5;221m${word}`);
    }
});

test("an approved thread is green, as it is good news, though it waits on you to merge", () => {
  for (const status of ["working", "waiting"] as const) {
    const screen = draw([thread("app-12", { status, word: "approved" })], "lead", size);
    expect(screen).toContain("\x1b[38;5;120m●");
    expect(screen).toContain("\x1b[38;5;120mapproved");
    expect(screen).not.toContain("\x1b[38;5;221m");
  }
});

test("a thread whose harness stopped on an error, or whose review failed, is red, though it needs you", () => {
  for (const word of ["error", "review failed"]) {
    const screen = draw(
      [thread("app-12", { state: word === "error" ? "error" : "needs you", word })],
      "lead",
      size,
    );
    expect(screen).toContain("\x1b[38;5;210m●");
    expect(screen).toContain(`\x1b[38;5;210m${word}`);
    expect(screen).not.toContain("\x1b[38;5;221m");
  }
});

test("a mark is filled when the thread needs you, and hollow when it doesn't", () => {
  const mark = (more: Partial<Row>) => draw([thread("app-12", more)], "lead", size);
  // A working builder is bright, in the theme's own text in bold, so it reads on any theme.
  expect(mark({ status: "working" })).toContain("\x1b[1m○");
  expect(mark({ status: "failed", word: "failed" })).toContain("\x1b[38;5;210m●");
  for (const word of ["reviewing", "queued for review", "checks", "changes", "limit · 13:59"])
    expect(mark({ status: "waiting", word })).toContain("\x1b[90m○");
  expect(mark({ status: "stopped", word: "stopped" })).toContain("\x1b[90m○");
  expect(mark({ status: "done", word: "done" })).toContain("\x1b[90m○");
});

test("a review under way shows dim while the builder works, with the builder's step below", () => {
  const both = thread("app-12", { status: "working", word: "reviewing", step: "Editing rows.ts" });
  const screen = draw([lead, both], "lead", size);
  expect(listed(screen).slice(2)).toEqual([
    "  ○ 12 app-12",
    "    reviewing · claude",
    "    Editing rows.ts",
  ]);
  expect(screen).toContain("\x1b[90m○");
  expect(screen).toContain("\x1b[90mreviewing");
});

test("a mark looks the same whether or not you are on its row", () => {
  // A theme's own green can be olive, close to the yellow of needs you, so marks never use it.
  const rows = [lead, thread("app-12", { state: "needs you", word: "question" })];
  const markLine = (shown: string) =>
    draw(rows, shown, size)
      .split("\n")
      .find((line) => line.includes("●"));
  // The colour is the last code before the mark.
  const colour = (line = "") => line.split("●")[0]?.split("\x1b[").at(-1);
  expect(colour(markLine("app-12"))).toBe(colour(markLine("lead")));
});

test("a failed thread is red even while it needs you, as its word says failed", () => {
  const screen = draw([thread("app-12", { status: "failed", word: "failed" })], "lead", size);
  expect(screen).toContain("\x1b[38;5;210m●");
  expect(screen).toContain("\x1b[38;5;210mfailed");
  expect(screen).not.toContain("\x1b[38;5;221m");
});

test("the lead keeps its diamond", () => {
  expect(draw([lead], "app-12", size)).toContain("\x1b[90m◆");
});

test("a thread's word takes its mark's colour, and a dim circle gives a dim word", () => {
  const word = (status: Row["status"], said: string) =>
    draw([thread("app-12", { status, word: said })], "lead", size);
  expect(word("working", "reviewing")).toContain("\x1b[90mreviewing");
  expect(word("failed", "failed")).toContain("\x1b[38;5;210mfailed");
  expect(word("waiting", "checks")).toContain("\x1b[90mchecks");
  expect(word("stopped", "stopped")).toContain("\x1b[90mstopped");
});

// The lines of a drawn sidebar that have the grey background of the row you are looking at.
const shaded = "\x1b[48;5;238m";
const selected = (screen: string) => screen.split("\n").filter((line) => line.includes(shaded));

test("the row you are looking at is shaded, and nothing is when it isn't listed", () => {
  const rows = [lead, thread("app-12")];
  expect(read(selected(draw(rows, "app-12", size)).join("\n"))).toEqual([
    "  ○ 12 app-12",
    "    claude",
    "    working",
  ]);
  expect(selected(draw(rows, "gone", size))).toEqual([]);
});

test("the mark stays in its column, whether or not you are looking at the row", () => {
  const rows = [lead, thread("app-12")];
  const column = (shown: string) =>
    plain(draw(rows, shown, size))
      .split("\n")[0]
      ?.indexOf("◆");
  expect(column("lead")).toBe(column("app-12"));
});

test("the grey runs the whole width, on every line of the row, and ends with it", () => {
  const name = "a-very-long-repository-name-1234";
  const lines = selected(draw([lead, thread(name)], name, size));
  expect(lines).toHaveLength(3);
  for (const line of lines) {
    expect(Bun.stringWidth(line.split("\x1b[49m")[0] ?? "")).toBe(size.width - 1);
    // A full reset inside the line would end the grey partway across.
    expect(line).not.toContain("\x1b[0m");
  }
});

test("on the grey, every colour is a fixed light one, as a theme's own can vanish there", () => {
  const rows = [
    thread("app-1"),
    thread("app-2", { status: "done", word: "done" }),
    thread("app-3", { status: "waiting", word: "checks" }),
    thread("app-4", { word: "approved" }),
    thread("app-5", { status: "failed", word: "failed" }),
  ];
  const on = (session: string) => selected(draw(rows, session, size)).join("\n");
  expect(on("app-1")).toContain("\x1b[1;38;5;231m○");
  expect(on("app-1")).toContain("\x1b[1;38;5;231m1 app-1");
  expect(on("app-1")).toContain("\x1b[38;5;253mclaude");
  expect(on("app-1")).toContain("\x1b[38;5;250mworking");
  expect(on("app-2")).toContain("\x1b[38;5;250m○");
  expect(on("app-3")).toContain("\x1b[38;5;250m○");
  expect(on("app-3")).toContain("\x1b[38;5;250mchecks");
  expect(on("app-4")).toContain("\x1b[38;5;120m●");
  expect(on("app-4")).toContain("\x1b[38;5;120mapproved");
  expect(on("app-5")).toContain("\x1b[38;5;210m●");
  expect(on("app-5")).toContain("\x1b[38;5;210mfailed");
  expect(selected(draw([lead], "lead", size)).join("\n")).toContain("\x1b[38;5;250m◆");
});

test("a running time follows the harness on the second line, in the same grey as the rest of it", () => {
  const screen = draw([thread("app-12", { age: "5m" })], "lead", size);
  expect(listed(screen)).toEqual(["  ○ 12 app-12", "    claude · 5m", "    working"]);
  expect(screen).toContain("\x1b[38;5;250mclaude · 5m");
});

test("the longest time and a large count of tokens fit on the line whole", () => {
  const long = thread("app-12", { age: "59m", tokens: "999k tok" });
  expect(listed(draw([long], "lead", size))[1]).toBe("    claude · 59m · 999k tok");
});

test("a running time starts below a minute, then counts minutes, hours and days", () => {
  const minute = 60_000;
  const start = 1_000_000;
  const after = (ms: number) => threadAge(start, start + ms);
  expect(after(0)).toBe("<1m");
  expect(after(minute - 1)).toBe("<1m");
  expect(after(minute)).toBe("1m");
  expect(after(5 * minute)).toBe("5m");
  expect(after(60 * minute - 1)).toBe("59m");
  expect(after(60 * minute)).toBe("1h");
  expect(after(24 * 60 * minute - 1)).toBe("23h");
  expect(after(24 * 60 * minute)).toBe("1d");
  expect(after(3 * 24 * 60 * minute)).toBe("3d");
});

test("a clock set back never shows a time that makes no sense", () => {
  expect(threadAge(1_000_000, 0)).toBe("<1m");
});

test("a title too long for its line is cut with …, so a row never takes more lines", () => {
  const name = "a-very-long-repository-name-1234";
  expect(listed(draw([thread(name)], "lead", size))).toEqual([
    "  ○ 1234 a-very-long-repository-na…",
    "    claude",
    "    working",
  ]);
});

test("a pane narrower than the sidebar cuts every row to fit, down to a few columns", () => {
  const rows = [lead, thread("a-very-long-repository-name-1234")];
  for (let width = 10; width < sidebarWidth; width++)
    for (const line of draw(rows, "lead", { width, height: 20 }).split("\n"))
      expect(Bun.stringWidth(line)).toBe(width);
});

test("a faint line fills the last column of every line, from top to bottom, at any height", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5, 6].map((n) => thread(`app-${n}`))];
  for (const list of [[lead], rows])
    for (let height = 1; height < 30; height++)
      for (const shown of ["lead", "app-6", "gone"]) {
        const lines = draw(list, shown, { width: sidebarWidth, height }).split("\n");
        expect(lines).toHaveLength(height);
        for (const line of lines) {
          // The lines between lists join the edge.
          const end = plain(line).startsWith("─") ? "┤" : "│";
          expect(line).toContain(`\x1b[38;5;237m${end}`);
          expect(Bun.stringWidth(line)).toBe(sidebarWidth);
          expect(plain(line).at(-1)).toBe(end);
        }
      }
});

test("the grey stops at the line, which keeps its own background", () => {
  const [first = ""] = selected(draw([lead], "lead", size));
  expect(first).toEndWith("\x1b[49m\x1b[38;5;237m│\x1b[22;39m");
});

// The keys you need most are in the footer, across the bottom of the screen.
test("the sidebar fills its height with no keys at the bottom, however few rows there are", () => {
  const lines = read(draw([lead], "lead", size));
  expect(lines).toHaveLength(size.height);
  expect(lines.slice(-2)).toEqual(["", ""]);
  expect(lines.join("\n")).not.toContain("⌥");
});

test("a release installed in the background shows as a notice, cut at words to fit", () => {
  const lines = noticeLines("Skelcrew 0.4.3 installed · restart to use it", sidebarWidth);
  expect(lines.map((line) => Bun.stripANSI(line).slice(0, -1).trimEnd())).toEqual([
    "  Skelcrew 0.4.3 installed ·",
    "  restart to use it",
    "",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
  expect(noticeLines("", sidebarWidth)).toEqual([]);
});

test("a list too long for the sidebar scrolls, down to its bottom line", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 8 };
  expect(read(draw(rows, "app-4", short))).toEqual([
    "",
    "  ○ 3 app-3",
    "    claude",
    "    working",
    "  ○ 4 app-4",
    "    claude",
    "    working",
    "  ○ 5 app-5",
  ]);
});

test("the row you are looking at stays on screen however far down the list it is", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5, 6].map((n) => thread(`app-${n}`))];
  for (const height of [4, 5, 6, 7, 8, 9, 12])
    for (const { session } of rows) {
      const shown = { width: sidebarWidth, height };
      const lines = selected(draw(rows, session, shown));
      expect(lines).toHaveLength(session === "lead" ? 2 : 3);
      expect(lines.map(plain).join("")).toContain(session);
    }
});

test("Alt-Up and Alt-Down move one row, stop at the ends, and skip agents that aren't running", () => {
  const rows = [lead, thread("app-1"), thread("app-2", { running: false }), thread("app-3")];
  expect(stepped(rows, "lead", 1)).toBe("app-1");
  expect(stepped(rows, "app-1", 1)).toBe("app-3");
  expect(stepped(rows, "app-3", -1)).toBe("app-1");
  expect(stepped(rows, "lead", -1)).toBeNull();
  expect(stepped(rows, "app-3", 1)).toBeNull();
});

test("moving from an agent that isn't listed goes to the lead", () => {
  expect(stepped([lead, thread("app-1")], "gone", 1)).toBe("lead");
});

test("a click on any line of a row picks it, but no row, nor an agent that isn't running", () => {
  const rows = [lead, thread("app-1"), thread("app-2", { running: false })];
  // The blank line on top, the lead's two lines, the line under it, the heading and its blank
  // line, then the threads.
  expect(picked(rows, "app-1", size, 0)).toBeNull();
  expect(picked(rows, "app-1", size, 1)).toBe("lead");
  expect(picked(rows, "app-1", size, 2)).toBe("lead");
  for (const y of [3, 4, 5]) expect(picked(rows, "lead", size, y)).toBeNull();
  for (const y of [6, 7, 8]) expect(picked(rows, "lead", size, y)).toBe("app-1");
  expect(picked(rows, "lead", size, 9)).toBeNull();
  expect(picked(rows, "lead", size, 11)).toBeNull();
});

test("a click follows the list as it scrolls", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 8 };
  expect(picked(rows, "app-4", short, 1)).toBe("app-3");
  for (const y of [4, 5, 6]) expect(picked(rows, "app-4", short, y)).toBe("app-4");
  expect(picked(rows, "app-4", short, 7)).toBe("app-5");
  expect(picked(rows, "app-4", short, 8)).toBeNull();
});

// The entries of a repository with a tracker and a forge, with what each counts.
const entries: EntryCount[] = [
  { entry: "issues", name: "Issues", total: 12, notes: [] },
  { entry: "threads", name: "Threads", total: 6, notes: [["1 needs you", "38;5;221"]] },
  { entry: "prs", name: "PRs", total: 5, notes: [] },
];
const tall = { width: sidebarWidth, height: 30 };
const threads = [lead, thread("app-12", { age: "5m" })];
const drawn = (shown: string | null, room = tall, rows = threads) =>
  drawWith(rows, entries, shown, room);

test("the lead sits on top, then the entries, then ACTIVE, with a line between each part", () => {
  expect(read(drawn("lead")).slice(1, 15)).toEqual([
    "  ◆ lead",
    "    running · claude",
    rule,
    "    Issues                       12",
    "",
    "    Threads         1 needs you · 6",
    "",
    "    PRs                           5",
    rule,
    "  Active",
    "",
    "  ○ 12 app-12",
    "    claude · 5m",
    "    working",
  ]);
});

test("an entry's count is dim, what needs you on Threads is yellow, and ready PRs are green", () => {
  const ready = entries.map((e): EntryCount => {
    if (e.entry !== "prs") return e;
    return { ...e, notes: [["2 ready", "38;5;120"]] };
  });
  const screen = drawWith(threads, ready, "lead", tall);
  expect(screen).toContain(`Issues${" ".repeat(23)}\x1b[90m12\x1b[22;39m`);
  expect(screen).toContain("\x1b[38;5;221m1 needs you\x1b[22;39m\x1b[90m · 6");
  expect(screen).toContain("\x1b[38;5;120m2 ready\x1b[22;39m\x1b[90m · 5");
});

test("with no PRs, Threads says how many are ready, in green, before how many need you", () => {
  const notes: [string, string][] = [
    ["1 ready", "38;5;120"],
    ["2 need you", "38;5;221"],
  ];
  const both: EntryCount[] = [{ entry: "threads", name: "Threads", total: 6, notes }];
  const screen = drawWith(threads, both, "lead", tall);
  // Both notes and the total don't fit beside the name, so the total gives way.
  expect(read(screen)).toContain("    Threads    1 ready · 2 need you");
  expect(screen).toContain(
    "\x1b[38;5;120m1 ready\x1b[22;39m\x1b[90m · \x1b[22;39m\x1b[38;5;221m2 need you\x1b[22;39m",
  );
  // On a wider sidebar the total shows too.
  const wide = drawWith(threads, both, "lead", { width: 44, height: 30 });
  expect(read(wide)).toContain("    Threads      1 ready · 2 need you · 6");
});

test("each line between the parts has the colour of the sidebar's edge, and joins it", () => {
  const lines = drawn("lead").split("\n");
  const divider = lines.filter((line) => plain(line).startsWith("─"));
  expect(divider).toHaveLength(2);
  for (const line of divider) {
    expect(line).toContain(`\x1b[38;5;237m${rule}`);
    expect(plain(line)).toBe(`${rule}┤`);
  }
});

test("the entry you are on is shaded across the whole width, with its text in the light colours", () => {
  const lines = drawn(":threads").split("\n");
  const shaded = lines.filter((line) => line.includes("48;5;238"));
  expect(shaded.map(plain)).toEqual([`    Threads         1 needs you · 6  │`]);
  expect(shaded[0]).toContain("1;38;5;231");
  expect(shaded[0]).toContain("38;5;221");
  expect(shaded[0]).not.toContain("\x1b[90m");
});

test("only the entries the repository has show, and ACTIVE sits below them", () => {
  const lines = read(drawWith(threads, entries.slice(1, 2), "lead", tall));
  expect(lines.slice(1, 8)).toEqual([
    "  ◆ lead",
    "    running · claude",
    rule,
    "    Threads         1 needs you · 6",
    rule,
    "  Active",
    "",
  ]);
});

test("with no active threads, the entries stay and ACTIVE isn't shown", () => {
  const lines = read(drawn("lead", tall, [lead])).join("\n");
  expect(lines).toContain("    PRs");
  expect(lines).not.toContain("Active");
});

const busy = [lead, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => thread(`app-${n}`))];

test("ACTIVE has the rest of the height and scrolls in it, as the parts above stay", () => {
  const room = { width: sidebarWidth, height: 18 };
  for (const { session } of busy) {
    const lines = read(drawn(session, room, busy));
    expect(lines[1]).toBe("  ◆ lead");
    expect(lines[6]).toBe("    Threads         1 needs you · 6");
    expect(lines[10]).toBe("  Active");
    if (session !== "lead") expect(lines.slice(11).join("\n")).toContain(session);
  }
});

test("a terminal too short for the entries, the heading and your row leaves the lead and threads", () => {
  // The blank line, the lead, a line, three entries with a blank line between each, a line, the
  // heading and its blank line, and a row.
  const enough = { width: sidebarWidth, height: 15 };
  expect(read(drawn("app-7", enough, busy))).toContain("  Active");
  const short = { width: sidebarWidth, height: 14 };
  const whole = read(drawn("app-7", short, busy)).join("\n");
  for (const text of ["Issues", "Threads", "PRs", "Active", "───"])
    expect(whole).not.toContain(text);
  expect(whole).toContain("○ 7 app-7");
  expect(read(drawn("lead", short, busy)).slice(0, 4)).toEqual([
    "",
    "  ◆ lead",
    "    running · claude",
    "  ○ 1 app-1",
  ]);
});

test("the row you are on stays on screen with the entries, at every height", () => {
  for (const height of [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 18, 20, 30])
    for (const { session } of busy) {
      const lines = drawn(session, { width: sidebarWidth, height }, busy).split("\n");
      expect(lines).toHaveLength(height);
      const here = lines.filter((line) => line.includes("48;5;238")).map(plain);
      expect(here.join("")).toContain(session);
      expect(here).toHaveLength(Math.min(height, session === "lead" ? 2 : 3));
      for (const line of lines) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
    }
});

test("a click on an entry picks it, and on a line, heading or blank between entries nothing", () => {
  const y = (text: string) => read(drawn("lead")).findIndex((line) => line.includes(text));
  const click = (line: number) => rowAtLine(threads, entries, "lead", tall, line);
  expect(click(y("Issues"))).toBe(":issues");
  expect(click(y("    Threads"))).toBe(":threads");
  expect(click(y("PRs"))).toBe(":prs");
  expect(click(y("○ 12 app-12"))).toBe("app-12");
  expect(click(y("───"))).toBeNull();
  expect(click(read(drawn("lead")).indexOf("  Active"))).toBeNull();
  expect(click(y("    Threads") + 1)).toBeNull();
});

// Moves from a place, as Alt-Up and Alt-Down or, with Shift, as Alt-Shift-Up and Alt-Shift-Down.
const step = (from: string | null, by: 1 | -1, rows = threads) =>
  nextRow(rows, entries, from, tall, by);
const jump = (from: string | null, by: 1 | -1, rows = threads) =>
  nextList(rows, entries, from, tall, by);

test("moving goes from the lead through the entries to the threads, and stops at the ends", () => {
  const order = ["lead", ":issues", ":threads", ":prs", "app-12"];
  order.slice(0, -1).forEach((place, i) => {
    expect(step(place, 1)).toBe(order[i + 1] ?? "");
    expect(step(order[i + 1] ?? "", -1)).toBe(place);
  });
  expect(step("lead", -1)).toBeNull();
  expect(step("app-12", 1)).toBeNull();
});

test("moving steps over agents that aren't running, but never over an entry", () => {
  const rows = [
    { ...lead, running: false },
    thread("app-12", { running: false }),
    thread("app-13"),
  ];
  expect(step(":prs", 1, rows)).toBe("app-13");
  expect(step(":issues", -1, rows)).toBeNull();
});

test("jumping goes to the first row of the part before or after: the lead, the entries or ACTIVE", () => {
  const rows = [lead, thread("app-12"), thread("app-13")];
  expect(jump("lead", 1, rows)).toBe(":issues");
  expect(jump(":prs", 1, rows)).toBe("app-12");
  expect(jump(":threads", -1, rows)).toBe("lead");
  expect(jump("app-13", -1, rows)).toBe(":issues");
  expect(jump("lead", -1, rows)).toBeNull();
  expect(jump("app-13", 1, rows)).toBeNull();
});

test("a terminal too short for the entries moves through the lead and threads alone", () => {
  const short = { width: sidebarWidth, height: 9 };
  expect(nextRow(threads, entries, "lead", short, 1)).toBe("app-12");
  expect(nextList(threads, entries, "lead", short, 1)).toBe("app-12");
});

const state: Thread = {
  owner: "simon",
  repo: "app",
  task: "12",
  folder: "app-12",
  branch: "skelcrew/12",
  base: null,
  status: "working",
  session: null,
  rounds: 0,
  pr: 34,
  needs_you: false,
  submitting: null,
  reviewing: null,
  queued: null,
  telling: null,
  held: null,
  seen: [],
  last_review: 0,
  last_comment: 0,
  last_check: 0,
  asking: false,
  stalled: false,
  submitted: false,
  erred: false,
  limited: false,
  limit_reset: null,
  review_limited: false,
  review_reset: null,
  conflicts: null,
  noting: null,
  body: null,
  title: null,
  started: null,
  checks: null,
  reviewer: null,
  reviewed_by: null,
  review_round: null,
  verdict: null,
  review_line: null,
  review_at: null,
  harness: null,
  short: null,
  assigned: false,
  changed: null,
  updates: [],
  state: null,
  merge_plan: null,
  merge_by: null,
  merge_at: null,
  merge_waits: null,
  merge_noted: null,
};
const word = (more: Partial<Thread>) => threadWord({ ...state, ...more }, 3);
const needing = { status: "waiting", needs_you: true } satisfies Partial<Thread>;

test("a thread's word says who has it right now", () => {
  expect(word({})).toBe("working");
  expect(word({ status: "waiting", submitting: "the fix" })).toBe("reviewing");
  expect(word({ status: "waiting", reviewing: "abc" })).toBe("reviewing");
  expect(word({ status: "waiting", reviewing: "abc", queued: 5 })).toBe("queued for review");
  expect(word({ status: "waiting", verdict: "approve" })).toBe("checks");
  expect(word({ telling: "fix it", verdict: "changes" })).toBe("changes");
});

// A review that waited when the daemon stopped is saved with when it joined the queue, which a
// newer submit leaves behind until its own review joins.
test("a newer submit is reviewing, not queued, until its own review waits", () => {
  const waited = { status: "waiting", reviewing: "abc", queued: 5 } satisfies Partial<Thread>;
  expect(word({ ...waited, submitting: "the fix" })).toBe("reviewing");
  expect(word({ ...waited, needs_you: true })).toBe("review failed");
});

// A builder that replied to you or the lead and stopped must not hide what you must do next.
test("a builder that stopped without submitting doesn't hide an approval or the round limit", () => {
  const stalled = { ...needing, stalled: true };
  expect(word({ ...stalled, verdict: "approve", checks: "passing" })).toBe("approved");
  expect(word({ ...stalled, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  // Any other reason it needs you says less than the builder's stopping.
  expect(word({ ...stalled, verdict: "approve", checks: "failing" })).toBe("turn ended");
  expect(word({ ...stalled, verdict: "failed" })).toBe("turn ended");
});

test("a builder that took up the changes is working again", () => {
  expect(word({ verdict: "changes", rounds: 1 })).toBe("working");
});

test("each reason a thread needs you has its own word", () => {
  expect(word({ asking: true })).toBe("question");
  // A builder that stopped without submitting may only have replied, so it claims no question.
  expect(word({ stalled: true })).toBe("turn ended");
  expect(word({ erred: true })).toBe("error");
  expect(word({ ...needing, verdict: "approve", checks: "passing" })).toBe("approved");
  expect(word({ ...needing, verdict: "approve" })).toBe("approved");
  expect(word({ ...needing, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  expect(word({ ...needing, verdict: "failed" })).toBe("review failed");
  expect(word({ ...needing, verdict: "timed out" })).toBe("review timed out");
});

test("a round that failed before its review answered reads as a failed review", () => {
  expect(word({ ...needing, submitting: "the fix" })).toBe("review failed");
  expect(word({ ...needing, reviewing: "abc" })).toBe("review failed");
});

test("past the round limit it stays so while the builder submits again", () => {
  expect(word({ ...needing, rounds: 4, submitting: "the fix" })).toBe("round limit");
  expect(word({ ...needing, rounds: 4, reviewing: "abc" })).toBe("round limit");
});

test("approved is only said of a PR whose checks don't say otherwise", () => {
  expect(word({ ...needing, verdict: "approve", checks: "failing" })).toBe("needs you");
  expect(word({ ...needing, verdict: "approve", checks: "pending" })).toBe("needs you");
});

test("a thread that needs you for no reason in the table says just that", () => {
  expect(word({ needs_you: true })).toBe("needs you");
  expect(word({ ...needing, verdict: "changes", rounds: 1 })).toBe("needs you");
});

test("failed and stopped are as the status says, whatever else is true", () => {
  expect(word({ status: "failed", needs_you: true })).toBe("failed");
  expect(word({ status: "failed", asking: true })).toBe("failed");
  expect(word({ status: "stopped", erred: true })).toBe("stopped");
  expect(word({ status: "stopped", reviewing: "abc" })).toBe("stopped");
});

describe("the rows the database gives", () => {
  let home = "";
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "skel-sidebar-test-")));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // Returns the rows after running the SQL, at a moment in milliseconds. It takes a process of
  // its own with HOME set: homedir() keeps the HOME this process started with, so opening the
  // database from here would reach your real one.
  function rowsAfter(sql: string, now: number): Row[] {
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { sidebarRows } from ${JSON.stringify(source("screen/rows.ts"))};
const db = openDb();
db.run(${JSON.stringify(sql)});
const app = { owner: "simon", repo: "app", lead: "lead" };
console.log(JSON.stringify(sidebarRows(db, ["lead", "app-12"], () => 3, ${now}, app)));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!run.success) throw new Error(run.stderr.toString());
    rmSync(join(home, ".local"), { recursive: true, force: true });
    return JSON.parse(run.stdout.toString());
  }
  // app, whose lead is the session named lead, as for a machine whose one lead Skelcrew kept. It
  // has started, so it shows a harness.
  const repository = `INSERT INTO repositories (name, owner, repo, kept_lead, lead_session)
    VALUES ('app', 'simon', 'app', 1, 's');`;
  // Returns the sidebar with one thread that started at 0, in the state given, at a moment.
  function shown(row: Record<string, string | number | null>, now: number): string {
    const sql = `${repository} ${threadSql({ task: "12", started: 0, ...row })}`;
    return draw(rowsAfter(sql, now), "lead", size);
  }
  const hours = (n: number) => n * 3_600_000;

  test("the lead shows the harness it started on", () => {
    const sql = `${repository} UPDATE repositories SET lead_harness = 'codex'`;
    expect(listed(draw(rowsAfter(sql, 0), "lead", size)).slice(0, 2)).toEqual([
      "  ◆ lead",
      "    running · codex",
    ]);
  });

  test("a thread shows the harness its builder runs on, and Claude Code for one from before", () => {
    expect(shown({ harness: "codex" }, 0)).toContain("codex · <1m");
    expect(shown({}, 0)).toContain("claude · <1m");
  });

  // A stopped thread needs nothing and doesn't change, so only the active ones are listed.
  test("THREADS has only active threads, newest first, and no stopped or done one", () => {
    const statuses = ["working", "stopped", "waiting", "stopped", "failed", "done"];
    const sql = `${repository} ${statuses.map((status, i) => threadSql({ task: String(i + 1), status })).join("\n")}`;
    expect(rowsAfter(sql, 0).map((row) => row.name)).toEqual(["lead", "app-5", "app-3", "app-1"]);
  });

  test("a working thread shows how long ago it started, and the lead shows no time", () => {
    expect(listed(shown({}, hours(2)))).toEqual([
      "  ◆ lead",
      "    running · claude",
      "  ○ 12 app-12",
      "    claude · 2h",
      "    working",
    ]);
  });

  // A thread started at 0 whose builder was typed to an hour later has worked for an hour.
  test("a working thread's time counts from the start of its current stretch of work", () => {
    const frame = shown({ working_since: hours(1) }, hours(2));
    expect(listed(frame)[3]).toBe("    claude · 1h");
  });

  // Claude Code writes one line per part of an answer, each with the answer's whole usage.
  // The folder where Claude Code keeps app-12's builder's conversations, made empty.
  function claudeFolder(): string {
    const clone = join(home, ".local", "share", "skelcrew", "threads", "app-12");
    const project = clone.replace(/[^a-zA-Z0-9]/g, "-");
    const data = join(home, ".local", "share", "skelcrew");
    const folder = join(data, "claude", "app-12", "projects", project);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  // A working thread whose builder has nothing to read, or nothing that makes sense, still has
  // its row: the sidebar must go on drawing whatever the agent left in its folder.
  test("a working thread's row stands when its conversation is missing, empty, half-written or nonsense", () => {
    const rows = (row: Record<string, string | null>) => listed(shown(row, 0)).slice(2);
    const plainRow = ["  ○ 12 app-12", "    claude · <1m", "    working"];
    // No session yet, then a session whose file isn't there yet, on either harness.
    expect(rows({ session: null })).toEqual(plainRow);
    expect(rows({ session: "s1" })).toEqual(plainRow);
    expect(rows({ session: "s1", harness: "codex" })).toEqual([
      "  ○ 12 app-12",
      "    codex · <1m",
      "    working",
    ]);
    // An empty file, a folder where the file should be, and lines that aren't what a harness
    // writes.
    writeFileSync(join(claudeFolder(), "empty.jsonl"), "");
    expect(rows({ session: "empty" })).toEqual(plainRow);
    mkdirSync(join(claudeFolder(), "folder.jsonl"));
    expect(rows({ session: "folder" })).toEqual(plainRow);
    const nonsense = [
      "not json",
      "[]",
      "null",
      '{"type":"assistant"}',
      '{"type":"assistant","message":{"id":7,"usage":"lots","content":"text"}}',
      '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":"x"}}]}}',
      '{"type":"assistant","message":{"id":"m","content":[null,{"type":"tool_use","name":"Bash","input":null}]}}',
    ];
    writeFileSync(join(claudeFolder(), "nonsense.jsonl"), `${nonsense.join("\n")}\n`);
    expect(rows({ session: "nonsense" })).toEqual(plainRow);
    // A last line still being written is left for the next read.
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 849 };
    const whole = JSON.stringify({ type: "assistant", message: { id: "m1", usage } });
    writeFileSync(join(claudeFolder(), "half.jsonl"), `${whole}\n{"type":"assistant","mess`);
    expect(rows({ session: "half" })[1]).toBe("    claude · <1m · 850 tok");
  });

  // A line too long for one read would hold every later read where it began.
  test("a line too long to read whole is passed over, and what follows it still counts", () => {
    const usage = { input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 849 };
    const bash = { type: "tool_use", name: "Bash", input: { command: "bun test" } };
    const answer = JSON.stringify({
      type: "assistant",
      message: { id: "m1", usage, content: [bash] },
    });
    const huge = `{"type":"user","pad":"${"a".repeat(17 * 1024 * 1024)}"}`;
    writeFileSync(join(claudeFolder(), "s1.jsonl"), `${huge}\n${answer}\n`);
    // Three looks at the sidebar, ten seconds apart, in one process, as the sidebar keeps what
    // it read between them.
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { sidebarRows } from ${JSON.stringify(source("screen/rows.ts"))};
const db = openDb();
db.run(${JSON.stringify(`${repository} ${threadSql({ task: "12", started: 0, session: "s1" })}`)});
const app = { owner: "simon", repo: "app", lead: "lead" };
const looks = [0, 10_000, 20_000].map((now) => sidebarRows(db, [], () => 3, now, app)[1]);
console.log(JSON.stringify(looks.map((row) => [row?.tokens, row?.step])));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual([
      ["", "working"],
      ["850 tok", "bun test"],
      ["850 tok", "bun test"],
    ]);
  });

  test("a working thread shows its builder's tokens, plan and step from its conversation", () => {
    const folder = claudeFolder();
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 30_000,
      cache_read_input_tokens: 900_000,
      output_tokens: 500,
    };
    const answer = (id: string, part: unknown) =>
      JSON.stringify({ type: "assistant", message: { id, usage, content: [part] } });
    const todos = [{ status: "completed" }, { status: "in_progress" }];
    const lines = [
      JSON.stringify({ type: "user", message: { content: "Add export" } }),
      answer("msg_1", { type: "tool_use", name: "TodoWrite", input: { todos } }),
      answer("msg_1", { type: "tool_use", name: "Read", input: { file_path: "/w/src/db.ts" } }),
      answer("msg_2", { type: "text", text: "Done" }),
    ];
    writeFileSync(join(folder, "s1.jsonl"), `${lines.join("\n")}\n`);
    const frame = listed(shown({ session: "s1" }, 0));
    expect(frame.slice(3)).toEqual(["    claude · <1m · 61k tok · ▰▱ 1/2", "    Reading db.ts"]);
  });

  test("a thread that isn't working reads nothing of its builder's conversation", () => {
    const frame = shown({ status: "waiting", verdict: "approve", session: "s1" }, 0);
    expect(plain(frame)).not.toContain("tok");
  });

  test("only a working thread has a time, so nothing else changes as time passes", () => {
    const quiet = [
      { status: "waiting", verdict: "approve" },
      { status: "waiting", reviewing: "abc" },
      { status: "waiting", needs_you: 1, verdict: "approve" },
      { asking: 1 },
      { stalled: 1 },
      { erred: 1 },
      { needs_you: 1, rounds: 4 },
      { status: "stopped" },
      { status: "failed" },
    ];
    for (const row of quiet) {
      const frame = shown(row, hours(2));
      expect(plain(frame)).not.toMatch(/ · \d/);
      expect(shown(row, hours(30))).toBe(frame);
    }
  });

  test("each repository's tab counts what needs you and what is ready apart", () => {
    // site and app each have a red mark among their yellow ones, docs only a yellow one, and web
    // an approved thread, which is ready rather than needing you. Threads working, stopped or
    // done count for neither.
    const threads = [
      { repo: "site", task: "1", status: "waiting", needs_you: 1 },
      { repo: "site", task: "2", asking: 1 },
      { repo: "site", task: "3", status: "failed", needs_you: 1 },
      { repo: "site", task: "4" },
      { repo: "site", task: "5", status: "done", needs_you: 1 },
      { repo: "app", task: "6", status: "stopped" },
      { repo: "app", task: "7", erred: 1 },
      { repo: "app", task: "8", status: "waiting", stalled: 1 },
      { repo: "docs", task: "9", status: "waiting", stalled: 1 },
      { repo: "docs", task: "10" },
      { repo: "web", task: "11", status: "waiting", needs_you: 1, verdict: "approve" },
    ]
      .map((row) => threadSql(row))
      .join("\n");
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { repositoryTabs } from ${JSON.stringify(source("screen/rows.ts"))};
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site'), ('app', 'simon', 'app'),
  ('docs', 'simon', 'docs'), ('web', 'simon', 'web');
${threads}\`);
console.log(JSON.stringify(repositoryTabs(db, () => 3)));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual([
      { name: "app", fullName: "simon/app", needYou: 2, colour: "red", ready: 0 },
      { name: "docs", fullName: "simon/docs", needYou: 1, colour: "yellow", ready: 0 },
      { name: "site", fullName: "simon/site", needYou: 3, colour: "red", ready: 0 },
      { name: "web", fullName: "simon/web", needYou: 0, colour: "yellow", ready: 1 },
    ]);
  });

  test("a thread with no start time saved shows none", () => {
    const sql = `${repository} ${threadSql({ task: "12" })}`;
    const [, older] = rowsAfter(sql, 5_000);
    expect(older?.word).toBe("working");
    expect(older?.age).toBe("");
  });
});
