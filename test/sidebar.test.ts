// What the sidebar shows and which row a key or click picks, given the rows it was handed, and
// the word each thread gets.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printThreads } from "../src/flow/list.ts";
import type { Thread } from "../src/flow/thread.ts";
import { draw as drawWith, noticeLines } from "../src/screen/layout.ts";
import type { EntryCount } from "../src/screen/lists.ts";
import { nextList, nextRow, rowAtLine } from "../src/screen/moves.ts";
import { type Row, threadAge, threadWord } from "../src/screen/rows.ts";
import { sidebarWidth } from "../src/screen/screen.ts";
import { source } from "./harness.ts";

const row = {
  title: null,
  short: null,
  pr: null,
  checks: null,
  review: null,
  needsYou: false,
  running: true,
  harness: "claude",
  age: "",
  fullName: null,
} satisfies Partial<Row>;
const lead: Row = { ...row, name: "lead", session: "lead", status: null, word: "running" };
const thread = (name: string, more: Partial<Row> = {}): Row => ({
  ...row,
  name,
  session: name,
  status: "working",
  word: "working",
  ...more,
});

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
// The sidebar's rows, with the empty lines, the headings, the lines between lists and the two
// hints at the bottom left out.
const listed = (screen: string) =>
  read(screen)
    .slice(0, -2)
    .filter((line) => line && line !== rule && !["  Issues", "  Threads", "  PRs"].includes(line));

test("a thread's first line is its short title, and its second its name, word and harness", () => {
  const rows = [
    lead,
    thread("app-12", { short: "Login redirect", title: "Fix the login redirect" }),
    thread("site-7", { title: "Add docs", status: "waiting", word: "reviewing", harness: "codex" }),
  ];
  expect(listed(draw(rows, "lead", { width: sidebarWidth, height: 14 }))).toEqual([
    "  ◆ lead",
    "    running · claude",
    "  ● Login redirect",
    "    app-12 · working · claude",
    "  ○ Add docs",
    "    site-7 · reviewing · codex",
  ]);
});

test("the sidebar is 38 columns wide, with room for 31 of a title", () => {
  expect(sidebarWidth).toBe(38);
  const title = "Send people back to the page they came from after signing in";
  expect(listed(draw([thread("app-9", { title })], "lead", size))[0]).toBe(
    "  ● Send people back to the page t…",
  );
});

// sc ps shows a thread with no short title by its title, cut as the sidebar cuts it.
test("sc ps cuts a long title where the sidebar does", () => {
  const title = "Send people back to the page they came from after signing in";
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [{ thread: "app-9", short: null, title, status: "failed", needsYou: false }],
      false,
    );
  } finally {
    log.mockRestore();
  }
  const sidebar = listed(draw([thread("app-9", { title })], "lead", size))[0]?.slice(4) ?? "";
  expect(sidebar).toEndWith("…");
  expect(said[1]).toBe(`app-9   ${sidebar}  failed`);
});

// A title comes from the tracker and a short title from the lead, so either could hold a line
// break or a code your terminal would act on.
test("sc ps prints a title or short title with control codes as one clean row", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        {
          thread: "app-9",
          short: null,
          title: "Fix\nlogin\x1b[2J",
          status: "working",
          needsYou: false,
        },
        {
          thread: "app-8",
          short: "Bad\x1b]8;;http://x\x07 one",
          title: "Ok",
          status: "working",
          needsYou: false,
        },
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

test("the second line is cut with … too, with the name and word whole before it", () => {
  const long = thread("repository-12", { word: "reviewing", harness: "codex", age: "5m" });
  expect(listed(draw([long], "lead", size))[1]).toBe("    repository-12 · reviewing · co…");
});

test("the name is dim on the second line, beside the word in its own colour", () => {
  const needing = thread("app-12", { needsYou: true, word: "approved", title: "Fix login" });
  const screen = draw([needing], "lead", size);
  expect(screen).toContain("\x1b[90mapp-12 · \x1b[22;39m\x1b[38;5;221mapproved");
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

test("rows and hints sit two columns in, and the line below a mark two further", () => {
  const lines = plain(draw([lead, thread("app-12")], "lead", size)).split("\n");
  const y = lines.findIndex((line) => line.includes("●"));
  expect(lines[1]?.indexOf("◆")).toBe(2);
  expect(lines[2]?.indexOf("running")).toBe(4);
  expect(lines[y]?.indexOf("●")).toBe(2);
  expect(lines[y]?.indexOf("app-12")).toBe(4);
  expect(lines[y + 1]?.indexOf("app-12")).toBe(4);
  expect(lines.at(-2)?.indexOf("⌥")).toBe(2);
});

test("the word and harness are grey, so the names stand out", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90mworking");
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90m · claude");
});

test("a thread that needs you has a yellow circle and a yellow word, whatever its status", () => {
  for (const status of ["working", "waiting"] as const) {
    const needing = thread("app-12", { status, needsYou: true, word: "approved" });
    const screen = draw([lead, needing], "lead", size);
    expect(read(screen).join("\n")).toContain("  ● app-12\n    app-12 · approved · claude");
    expect(screen).toContain("\x1b[38;5;221m●");
    expect(screen).toContain("\x1b[38;5;221mapproved");
  }
});

test("every thread's mark is a circle, in its status's colour", () => {
  const mark = (more: Partial<Row>) => draw([thread("app-12", more)], "lead", size);
  expect(mark({ status: "working" })).toContain("\x1b[38;5;120m●");
  expect(mark({ status: "failed", word: "failed" })).toContain("\x1b[38;5;210m●");
  expect(mark({ status: "waiting", word: "checks" })).toContain("\x1b[90m○");
  expect(mark({ status: "stopped", word: "stopped" })).toContain("\x1b[90m○");
  expect(mark({ status: "done", word: "done" })).toContain("\x1b[38;5;120m●");
});

test("a mark looks the same whether or not you are on its row", () => {
  // A theme's own green can be olive, close to the yellow of needs you, so marks never use it.
  const rows = [lead, thread("app-12")];
  const markLine = (shown: string) =>
    draw(rows, shown, size)
      .split("\n")
      .find((line) => line.includes("●"));
  // The colour is the last code before the mark.
  const colour = (line = "") => line.split("●")[0]?.split("\x1b[").at(-1);
  expect(colour(markLine("app-12"))).toBe(colour(markLine("lead")));
});

test("a failed thread is red even while it needs you, as its word says failed", () => {
  const screen = draw(
    [thread("app-12", { status: "failed", needsYou: true, word: "failed" })],
    "lead",
    size,
  );
  expect(screen).toContain("\x1b[38;5;210m●");
  expect(screen).toContain("\x1b[90mfailed");
  expect(screen).not.toContain("\x1b[38;5;221m");
});

test("the lead keeps its diamond", () => {
  expect(draw([lead], "app-12", size)).toContain("\x1b[90m◆");
});

test("only the word of a thread that needs you takes a colour", () => {
  for (const status of ["working", "failed", "waiting", "stopped"] as const)
    expect(draw([thread("app-12", { status, word: "said" })], "lead", size)).toContain(
      "\x1b[90msaid",
    );
});

// The lines of a drawn sidebar that have the grey background of the row you are looking at.
const shaded = "\x1b[48;5;238m";
const selected = (screen: string) => screen.split("\n").filter((line) => line.includes(shaded));

test("the row you are looking at is shaded, and nothing is when it isn't listed", () => {
  const rows = [lead, thread("app-12")];
  expect(read(selected(draw(rows, "app-12", size)).join("\n"))).toEqual([
    "  ● app-12",
    "    app-12 · working · claude",
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

test("the grey runs the whole width, on both lines of the row, and ends with it", () => {
  const name = "a-very-long-repository-name-1234";
  const lines = selected(draw([lead, thread(name)], name, size));
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(Bun.stringWidth(line.split("\x1b[49m")[0] ?? "")).toBe(size.width - 1);
    // A full reset inside the line would end the grey partway across.
    expect(line).not.toContain("\x1b[0m");
  }
});

test("on the grey, every colour is a fixed light one, as a theme's own can vanish there", () => {
  const rows = [
    thread("app-1"),
    thread("app-2", { status: "done" }),
    thread("app-3", { status: "waiting" }),
    thread("app-4", { needsYou: true, word: "approved" }),
    thread("app-5", { status: "failed", word: "failed" }),
  ];
  const on = (session: string) => selected(draw(rows, session, size)).join("\n");
  expect(on("app-1")).toContain("\x1b[38;5;120m●");
  expect(on("app-1")).toContain("\x1b[1;38;5;231mapp-1");
  expect(on("app-1")).toContain("\x1b[38;5;250mworking");
  expect(on("app-1")).toContain("\x1b[38;5;250m · claude");
  expect(on("app-2")).toContain("\x1b[38;5;120m●");
  expect(on("app-3")).toContain("\x1b[38;5;250m○");
  expect(on("app-4")).toContain("\x1b[38;5;221m●");
  expect(on("app-4")).toContain("\x1b[38;5;221mapproved");
  expect(on("app-5")).toContain("\x1b[38;5;210m●");
  expect(on("app-5")).toContain("\x1b[38;5;250mfailed");
  expect(selected(draw([lead], "lead", size)).join("\n")).toContain("\x1b[38;5;250m◆");
});

test("a running time ends the second line, dim like the rest of it", () => {
  const screen = draw([thread("app-12", { age: "5m" })], "lead", size);
  expect(listed(screen)).toEqual(["  ● app-12", "    app-12 · working · claude · 5m"]);
  expect(screen).toContain("\x1b[90m · claude · 5m");
});

test("the longest running time fits on the line whole, after a name as long as app-12", () => {
  const long = thread("app-12", { age: "59m" });
  expect(listed(draw([long], "lead", size))[1]).toBe("    app-12 · working · claude · 59m");
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

test("a name too long for its line is cut with …, so a row never takes more than two lines", () => {
  const name = "a-very-long-repository-name-1234";
  expect(listed(draw([thread(name)], "lead", size))).toEqual([
    "  ● a-very-long-repository-name-12…",
    "    a-very-long-repository-name-12…",
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

test("two hints with the keys stay at the bottom, below however few rows there are", () => {
  const lines = read(draw([lead], "lead", size));
  expect(lines).toHaveLength(size.height);
  expect(lines.slice(-3)).toEqual(["", "  ⌥↑↓ move", "  ⌃Q quit"]);
  expect(draw([lead], "lead", size)).toContain("\x1b[90m  ⌥↑↓ move");
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

test("a list too long for the sidebar scrolls above the hints, and never runs into them", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 8 };
  expect(read(draw(rows, "app-4", short))).toEqual([
    "",
    "  ● app-3",
    "    app-3 · working · claude",
    "  ● app-4",
    "    app-4 · working · claude",
    "  ● app-5",
    "  ⌥↑↓ move",
    "  ⌃Q quit",
  ]);
});

test("a sidebar too short for a row and the hints drops the hints, as the row matters more", () => {
  const rows = [lead, thread("app-1")];
  for (const height of [1, 2, 3, 4]) {
    const lines = plain(draw(rows, "app-1", { width: sidebarWidth, height })).split("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.join("\n")).not.toContain("⌥");
    expect(lines.join("\n")).toContain("  ● app-1");
  }
  expect(plain(draw(rows, "app-1", { width: sidebarWidth, height: 5 }))).toContain("⌥");
});

test("the row you are looking at stays on screen however far down the list it is", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5, 6].map((n) => thread(`app-${n}`))];
  for (const height of [4, 5, 6, 7, 8, 9, 12])
    for (const { session } of rows) {
      const shown = { width: sidebarWidth, height };
      const lines = selected(draw(rows, session, shown));
      expect(lines).toHaveLength(2);
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

test("a click on either line of a row picks it, but no row, nor an agent that isn't running", () => {
  const rows = [lead, thread("app-1"), thread("app-2", { running: false })];
  // The blank line on top, the lead's two lines, the line under it, the heading and its blank
  // line, then the threads.
  expect(picked(rows, "app-1", size, 0)).toBeNull();
  expect(picked(rows, "app-1", size, 1)).toBe("lead");
  expect(picked(rows, "app-1", size, 2)).toBe("lead");
  for (const y of [3, 4, 5]) expect(picked(rows, "lead", size, y)).toBeNull();
  expect(picked(rows, "lead", size, 6)).toBe("app-1");
  expect(picked(rows, "lead", size, 7)).toBe("app-1");
  expect(picked(rows, "lead", size, 8)).toBeNull();
  expect(picked(rows, "lead", size, 10)).toBeNull();
});

test("a click follows the list as it scrolls, and on a hint picks nothing", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 8 };
  expect(picked(rows, "app-4", short, 1)).toBe("app-3");
  expect(picked(rows, "app-4", short, 3)).toBe("app-4");
  expect(picked(rows, "app-4", short, 4)).toBe("app-4");
  expect(picked(rows, "app-4", short, 5)).toBe("app-5");
  expect(picked(rows, "app-4", short, 6)).toBeNull();
  expect(picked(rows, "app-4", short, 7)).toBeNull();
});

// The entries of a repository with a tracker and a forge, with what each counts.
const entries: EntryCount[] = [
  { entry: "issues", name: "Issues", total: 12, note: "4 new", warn: false },
  { entry: "threads", name: "Threads", total: 6, note: "1 needs you", warn: true },
  { entry: "prs", name: "PRs", total: 5, note: "", warn: true },
];
const tall = { width: sidebarWidth, height: 30 };
const threads = [lead, thread("app-12", { age: "5m" })];
const drawn = (shown: string | null, room = tall, rows = threads) =>
  drawWith(rows, entries, shown, room);

test("the lead sits on top, then the entries, then THREADS, with a line between each part", () => {
  expect(read(drawn("lead")).filter(Boolean).slice(0, -2)).toEqual([
    "  ◆ lead",
    "    running · claude",
    rule,
    "    Issues               4 new · 12",
    "    Threads         1 needs you · 6",
    "    PRs                           5",
    rule,
    "  Threads",
    "  ● app-12",
    "    app-12 · working · claude · 5m",
  ]);
});

test("an entry's count is dim, and what needs you on Threads and PRs is yellow", () => {
  const ready = entries.map((e) => (e.entry === "prs" ? { ...e, note: "2 ready" } : e));
  const screen = drawWith(threads, ready, "lead", tall);
  expect(screen).toContain("\x1b[90m4 new\x1b[22;39m\x1b[90m · 12");
  expect(screen).toContain("\x1b[38;5;221m1 needs you\x1b[22;39m\x1b[90m · 6");
  expect(screen).toContain("\x1b[38;5;221m2 ready\x1b[22;39m\x1b[90m · 5");
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

test("only the entries the repository has show, and THREADS sits below them", () => {
  const lines = read(drawWith(threads, entries.slice(1, 2), "lead", tall));
  expect(lines.slice(1, 8)).toEqual([
    "  ◆ lead",
    "    running · claude",
    rule,
    "    Threads         1 needs you · 6",
    rule,
    "  Threads",
    "",
  ]);
});

test("with no active threads, the entries stay and THREADS isn't shown", () => {
  const lines = read(drawn("lead", tall, [lead])).join("\n");
  expect(lines).toContain("    PRs");
  expect(lines.match(/Threads/g)).toHaveLength(1);
});

const busy = [lead, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => thread(`app-${n}`))];

test("THREADS has the rest of the height and scrolls in it, as the parts above stay", () => {
  const room = { width: sidebarWidth, height: 16 };
  for (const { session } of busy) {
    const lines = read(drawn(session, room, busy));
    expect(lines[1]).toBe("  ◆ lead");
    expect(lines[5]).toBe("    Threads         1 needs you · 6");
    expect(lines[8]).toBe("  Threads");
    if (session !== "lead") expect(lines.join("\n")).toContain(`● ${session}`);
  }
});

test("a terminal too short for the entries, the heading and your row leaves the lead and threads", () => {
  // The blank line, the lead, a line, three entries, a line, the heading and its blank line,
  // a row and the hints.
  const enough = { width: sidebarWidth, height: 14 };
  expect(read(drawn("app-7", enough, busy))).toContain("  Threads");
  const short = { width: sidebarWidth, height: 13 };
  const whole = read(drawn("app-7", short, busy)).join("\n");
  for (const text of ["Issues", "Threads", "PRs", "───"]) expect(whole).not.toContain(text);
  expect(whole).toContain("● app-7");
  expect(read(drawn("lead", short, busy)).slice(0, 4)).toEqual([
    "",
    "  ◆ lead",
    "    running · claude",
    "  ● app-1",
  ]);
});

test("the row you are on stays on screen with the entries, at every height", () => {
  for (const height of [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 18, 20, 30])
    for (const { session } of busy) {
      const lines = drawn(session, { width: sidebarWidth, height }, busy).split("\n");
      expect(lines).toHaveLength(height);
      const here = lines.filter((line) => line.includes("48;5;238")).map(plain);
      expect(here.join("")).toContain(session);
      if (height >= 2) expect(here).toHaveLength(2);
      for (const line of lines) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
    }
});

test("a click on an entry picks it, and on a line or heading nothing", () => {
  const y = (text: string) => read(drawn("lead")).findIndex((line) => line.includes(text));
  const click = (line: number) => rowAtLine(threads, entries, "lead", tall, line);
  expect(click(y("Issues"))).toBe(":issues");
  expect(click(y("    Threads"))).toBe(":threads");
  expect(click(y("PRs"))).toBe(":prs");
  expect(click(y("● app-12"))).toBe("app-12");
  expect(click(y("───"))).toBeNull();
  expect(click(read(drawn("lead")).indexOf("  Threads"))).toBeNull();
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

test("jumping goes to the first row of the part before or after: the lead, the entries or THREADS", () => {
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
  telling: null,
  held: null,
  seen: [],
  last_review: 0,
  last_comment: 0,
  last_check: 0,
  asking: false,
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
  harness: null,
  short: null,
  assigned: false,
  changed: null,
};
const word = (more: Partial<Thread>) => threadWord({ ...state, ...more }, 3);
const needing = { status: "waiting", needs_you: true } satisfies Partial<Thread>;

test("a thread's word says who has it right now", () => {
  expect(word({})).toBe("working");
  expect(word({ status: "waiting", submitting: "the fix" })).toBe("reviewing");
  expect(word({ status: "waiting", reviewing: "abc" })).toBe("reviewing");
  expect(word({ status: "waiting", verdict: "approve" })).toBe("checks");
  expect(word({ telling: "fix it", verdict: "changes" })).toBe("changes");
});

test("a builder that took up the changes is working again", () => {
  expect(word({ verdict: "changes", rounds: 1 })).toBe("working");
});

test("each reason a thread needs you has its own word", () => {
  expect(word({ asking: true })).toBe("question");
  expect(word({ ...needing, verdict: "approve", checks: "passing" })).toBe("approved");
  expect(word({ ...needing, verdict: "approve" })).toBe("approved");
  expect(word({ ...needing, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  expect(word({ ...needing, verdict: "failed" })).toBe("review failed");
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
  function shown(columns: string, values: string, now: number): string {
    const sql = `${repository} INSERT INTO threads
      (owner, repo, task, folder, branch, started, ${columns})
      VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 0, ${values})`;
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
    expect(shown("status, harness", "'working', 'codex'", 0)).toContain("· codex · <1m");
    expect(shown("status", "'working'", 0)).toContain("· claude · <1m");
  });

  // A stopped thread needs nothing and doesn't change, so only the active ones are listed.
  test("THREADS has only active threads, newest first, and no stopped or done one", () => {
    const sql = `${repository} INSERT INTO threads (owner, repo, task, folder, branch, status)
      VALUES ('simon', 'app', 1, 'app-1', 'b', 'working'), ('simon', 'app', 2, 'app-2', 'b', 'stopped'),
        ('simon', 'app', 3, 'app-3', 'b', 'waiting'), ('simon', 'app', 4, 'app-4', 'b', 'stopped'),
        ('simon', 'app', 5, 'app-5', 'b', 'failed'), ('simon', 'app', 6, 'app-6', 'b', 'done')`;
    expect(rowsAfter(sql, 0).map((row) => row.name)).toEqual(["lead", "app-5", "app-3", "app-1"]);
  });

  test("a working thread shows how long ago it started, and the lead shows no time", () => {
    expect(listed(shown("status", "'working'", hours(2)))).toEqual([
      "  ◆ lead",
      "    running · claude",
      "  ● app-12",
      "    app-12 · working · claude · 2h",
    ]);
  });

  test("only a working thread has a time, so nothing else changes as time passes", () => {
    const quiet = [
      ["status, verdict", "'waiting', 'approve'"],
      ["status, reviewing", "'waiting', 'abc'"],
      ["status, needs_you, verdict", "'waiting', 1, 'approve'"],
      ["status, asking", "'working', 1"],
      ["status, needs_you, rounds", "'working', 1, 4"],
      ["status", "'stopped'"],
      ["status", "'failed'"],
    ] as const;
    for (const [columns, values] of quiet) {
      const frame = shown(columns, values, hours(2));
      expect(plain(frame)).not.toMatch(/ · \d/);
      expect(shown(columns, values, hours(30))).toBe(frame);
    }
  });

  test("each repository's tab counts its threads that need you or failed", () => {
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { repositoryTabs } from ${JSON.stringify(source("screen/rows.ts"))};
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site'), ('app', 'simon', 'app');
INSERT INTO threads (owner, repo, task, folder, branch, status, needs_you, asking) VALUES
  ('simon', 'site', 1, 'site-1', 'b', 'waiting', 1, 0),
  ('simon', 'site', 2, 'site-2', 'b', 'working', 0, 1),
  ('simon', 'site', 3, 'site-3', 'b', 'failed', 1, 0),
  ('simon', 'site', 4, 'site-4', 'b', 'working', 0, 0),
  ('simon', 'site', 5, 'site-5', 'b', 'done', 1, 0),
  ('simon', 'app', 6, 'app-6', 'b', 'stopped', 0, 0)\`);
console.log(JSON.stringify(repositoryTabs(db)));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual([
      { name: "app", fullName: "simon/app", count: 0 },
      { name: "site", fullName: "simon/site", count: 3 },
    ]);
  });

  test("a thread with no start time saved shows none", () => {
    const sql = `${repository} INSERT INTO threads (owner, repo, task, folder, branch, status)
      VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working')`;
    const [, older] = rowsAfter(sql, 5_000);
    expect(older?.word).toBe("working");
    expect(older?.age).toBe("");
  });
});
