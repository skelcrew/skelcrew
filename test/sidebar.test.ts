// What the sidebar shows and which row a key or click picks, given the rows it was handed, and
// the word each thread gets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "../src/flow/thread.ts";
import { type Link, type Lists, type Row, threadAge, threadWord } from "../src/screen/rows.ts";
import { sidebarWidth } from "../src/screen/screen.ts";
import {
  draw as drawLists,
  jumped,
  noticeLines,
  picked as pickedInLists,
  stepped as steppedInLists,
} from "../src/screen/sidebar.ts";
import { itemSql, source } from "./harness.ts";

const row = {
  title: null,
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
const nothing: Lists = { issues: { links: [], total: 0 }, prs: { links: [], total: 0 } };
// The sidebar and a click with nothing open on GitHub, as most of these tests need.
const draw = (rows: Row[], shown: string | null, room: typeof size) =>
  drawLists(rows, nothing, shown, room);
const picked = (rows: Row[], shown: string | null, room: typeof size, y: number) =>
  pickedInLists(rows, nothing, shown, room, y);
const stepped = (rows: Row[], shown: string | null, by: 1 | -1) =>
  steppedInLists(rows, nothing, shown, size, by);
// Removes the colours, to read a row as text.
const plain = (screen: string) => Bun.stripANSI(screen);
// The sidebar's lines as you read them, without what fills them out to the line at its edge.
const read = (screen: string) =>
  plain(screen)
    .split("\n")
    .map((text) => text.slice(0, -1).trimEnd());
// The sidebar's rows, with the empty lines and the three hints at the bottom left out.
const listed = (screen: string) => read(screen).slice(0, -3).filter(Boolean);

test("lists the lead first, then each thread on two lines: a mark and name, then word and harness", () => {
  const rows = [
    lead,
    thread("app-12"),
    thread("site-7", { status: "waiting", word: "reviewing", harness: "codex" }),
  ];
  expect(listed(draw(rows, "lead", size))).toEqual([
    "  ◆ lead",
    "    running · claude",
    "  ● app-12",
    "    working · claude",
    "  ○ site-7",
    "    reviewing · codex",
  ]);
});

test("rows and hints sit two columns in, and the word two further", () => {
  const lines = plain(draw([lead, thread("app-12")], "lead", size)).split("\n");
  expect(lines[0]?.indexOf("◆")).toBe(2);
  expect(lines[1]?.indexOf("running")).toBe(4);
  expect(lines[2]?.indexOf("●")).toBe(2);
  expect(lines[2]?.indexOf("app-12")).toBe(4);
  expect(lines.at(-3)?.indexOf("⌥")).toBe(2);
});

test("the word and harness are grey, so the names stand out", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90mworking");
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90m · claude");
});

test("a thread that needs you has a yellow circle and a yellow word, whatever its status", () => {
  for (const status of ["working", "waiting"] as const) {
    const needing = thread("app-12", { status, needsYou: true, word: "approved" });
    const screen = draw([lead, needing], "lead", size);
    expect(read(screen).join("\n")).toContain("  ● app-12\n    approved · claude");
    expect(screen).toContain("\x1b[33m●");
    expect(screen).toContain("\x1b[33mapproved");
  }
});

test("every thread's mark is a circle, in its status's colour", () => {
  const mark = (more: Partial<Row>) => draw([thread("app-12", more)], "lead", size);
  expect(mark({ status: "working" })).toContain("\x1b[32m●");
  expect(mark({ status: "failed", word: "failed" })).toContain("\x1b[31m●");
  expect(mark({ status: "waiting", word: "checks" })).toContain("\x1b[90m○");
  expect(mark({ status: "stopped", word: "stopped" })).toContain("\x1b[90m○");
  expect(mark({ status: "done", word: "done" })).toContain("\x1b[32m●");
});

test("a failed thread is red even while it needs you, as its word says failed", () => {
  const screen = draw(
    [thread("app-12", { status: "failed", needsYou: true, word: "failed" })],
    "lead",
    size,
  );
  expect(screen).toContain("\x1b[31m●");
  expect(screen).toContain("\x1b[90mfailed");
  expect(screen).not.toContain("\x1b[33m");
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
    "    working · claude",
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
  expect(listed(screen)).toEqual(["  ● app-12", "    working · claude · 5m"]);
  expect(screen).toContain("\x1b[90m · claude · 5m");
});

test("the longest running time fits on the line whole", () => {
  const long = thread("app-12", { age: "59m" });
  expect(listed(draw([long], "lead", size))[1]).toBe("    working · claude · 59m");
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

test("a name too long for a line goes on to the next, whole", () => {
  const name = "a-very-long-repository-name-1234";
  expect(listed(draw([thread(name)], "lead", size))).toEqual([
    "  ● a-very-long-repository-n",
    "    ame-1234",
    "    working · claude",
  ]);
});

test("a pane narrower than the sidebar keeps every name whole, at any width", () => {
  const rows = [lead, thread("a-very-long-repository-name-1234")];
  for (let width = 0; width < sidebarWidth; width++) {
    const text = plain(draw(rows, "lead", { width, height: 120 })).replace(/[\s\n│]/g, "");
    expect(text).toContain("a-very-long-repository-name-1234");
  }
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

test("three hints with the keys stay at the bottom, below however few rows there are", () => {
  const lines = read(draw([lead], "lead", size));
  expect(lines).toHaveLength(size.height);
  expect(lines.slice(-3)).toEqual(["  ⌥↑↓ move", "  ⌥⇧↑↓ list", "  ⌃Q quit"]);
  expect(draw([lead], "lead", size)).toContain("\x1b[90m  ⌥↑↓ move");
});

test("a release installed in the background shows as a notice, cut at words to fit", () => {
  const lines = noticeLines("skel 0.4.3 installed · restart to use it", sidebarWidth);
  expect(lines.map((line) => Bun.stripANSI(line).slice(0, -1).trimEnd())).toEqual([
    "  skel 0.4.3 installed ·",
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
    "  ● app-3",
    "    working · claude",
    "  ● app-4",
    "    working · claude",
    "  ● app-5",
    "  ⌥↑↓ move",
    "  ⌥⇧↑↓ list",
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

test("the hints also give way to a row whose name takes more lines", () => {
  const name = "a-very-long-repository-name-1234";
  const rows = [lead, thread(name)];
  const tight = { width: sidebarWidth, height: 5 };
  const text = plain(draw(rows, name, tight));
  expect(text).toContain("working · claude");
  expect(text).not.toContain("⌥");
  expect(picked(rows, name, tight, 2)).toBe(name);
  expect(plain(draw(rows, name, { width: sidebarWidth, height: 6 }))).toContain("⌥");
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
  expect(picked(rows, "lead", size, 2)).toBe("app-1");
  expect(picked(rows, "lead", size, 3)).toBe("app-1");
  expect(picked(rows, "lead", size, 4)).toBeNull();
  expect(picked(rows, "lead", size, 9)).toBeNull();
});

test("a click follows the list as it scrolls, and on a hint picks nothing", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 8 };
  expect(picked(rows, "app-4", short, 0)).toBe("app-3");
  expect(picked(rows, "app-4", short, 2)).toBe("app-4");
  expect(picked(rows, "app-4", short, 3)).toBe("app-4");
  expect(picked(rows, "app-4", short, 4)).toBe("app-5");
  expect(picked(rows, "app-4", short, 5)).toBeNull();
  expect(picked(rows, "app-4", short, 6)).toBeNull();
});

test("a click goes to the row below a name that took two lines", () => {
  const rows = [thread("a-very-long-repository-name-1234"), thread("app-1")];
  expect(picked(rows, "lead", size, 2)).toBe("a-very-long-repository-name-1234");
  expect(picked(rows, "lead", size, 3)).toBe("app-1");
});

const link = (name: string, title: string, more: Partial<Link> = {}): Link => ({
  name,
  title,
  url: `https://github.com/simon/app/issues/${name.slice(4)}`,
  word: "",
  needing: false,
  dim: false,
  mark: null,
  ...more,
});
// A row of PRS, with the dim mark of a PR that has no thread unless it is given another.
const pr = (name: string, title: string, more: Partial<Link> = {}): Link =>
  link(name, title, { mark: ["○", 90], ...more });
const list = (links: Link[], total = links.length) => ({ links, total });
const lists: Lists = {
  issues: list([link("app-31", "Add CSV export"), link("app-12", "Fix login", { dim: true })]),
  prs: list([
    pr("app#34", "Fix login", { word: "approved", needing: true, mark: ["●", 33] }),
    pr("app#33", "Bump deps"),
  ]),
};
const tall = { width: sidebarWidth, height: 30 };
const rule = "─".repeat(sidebarWidth - 1);
const threads = [lead, thread("app-12", { age: "5m" })];

test("ISSUES, THREADS and PRS sit in that order, with rows together and a line between lists", () => {
  expect(
    read(drawLists(threads, lists, "lead", tall))
      .filter(Boolean)
      .slice(0, -3),
  ).toEqual([
    "  Issues",
    "  Add CSV export",
    "  app-31",
    "  Fix login",
    "  app-12",
    rule,
    "  Threads",
    "  ◆ lead",
    "    running · claude",
    "  ● app-12",
    "    working · claude · 5m",
    rule,
    "  PRs",
    "  ● Fix login",
    "    app#34 · approved",
    "  ○ Bump deps",
    "    app#33",
  ]);
});

test("the line between lists has the colour of the sidebar's edge, and joins it", () => {
  const lines = drawLists(threads, lists, "lead", tall).split("\n");
  const divider = lines.filter((line) => plain(line).startsWith("─"));
  expect(divider).toHaveLength(2);
  for (const line of divider) {
    expect(line).toContain(`\x1b[38;5;237m${rule}`);
    expect(plain(line)).toBe(`${rule}┤`);
    expect(Bun.stringWidth(line)).toBe(sidebarWidth);
  }
});

test("one blank line parts each heading from its first row", () => {
  const lines = read(drawLists(threads, lists, "lead", tall));
  for (const [heading, first] of [
    ["  Issues", "  Add CSV export"],
    ["  Threads", "  ◆ lead"],
    ["  PRs", "  ● Fix login"],
  ]) {
    const y = lines.indexOf(heading ?? "");
    expect(lines.slice(y, y + 3)).toEqual([heading ?? "", "", first ?? ""]);
  }
});

test("headings are dim, and sit where the marks do", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  for (const heading of ["Issues", "Threads", "PRs"])
    expect(screen).toContain(`\x1b[90m  ${heading}`);
});

test("an issue with a thread is dim on both lines, and one without only on its name", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  expect(screen).toContain("\x1b[90mFix login");
  expect(screen).toContain("\x1b\\Add CSV export");
  expect(screen).not.toContain("\x1b[90mAdd CSV export");
});

test("a PR takes its thread's word, in yellow when the thread needs you, and dim otherwise", () => {
  const needing = drawLists(threads, lists, "lead", tall);
  expect(needing).toContain("\x1b[33mapproved");
  const working = pr("app#34", "Fix login", { word: "working" });
  const dim = drawLists(threads, { ...lists, prs: list([working]) }, "lead", tall);
  expect(dim).toContain("\x1b[90mworking");
});

test("a PR's name is dim, and one with no thread has no word after it", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  expect(screen).toContain("\x1b[90mapp#34");
  expect(read(screen)).toContain("    app#33");
});

test("both lines of a row that isn't a thread are a terminal link, and only the text is", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  const open = "\x1b]8;;https://github.com/simon/app/issues/31\x1b\\";
  expect(screen).toContain(`  ${open}Add CSV export\x1b]8;;\x1b\\`);
  expect(screen).toContain(`  ${open}\x1b[90mapp-31\x1b[22;39m\x1b]8;;\x1b\\`);
  const pull = "\x1b]8;;https://github.com/simon/app/pull/34\x1b\\";
  const prs = list([pr("app#34", "Fix login", { url: "https://github.com/simon/app/pull/34" })]);
  const marked = drawLists(threads, { ...lists, prs }, "lead", tall);
  expect(marked).toContain(`\x1b[90m○\x1b[22;39m ${pull}Fix login\x1b]8;;\x1b\\`);
  expect(marked).toContain(`    ${pull}\x1b[90mapp#34\x1b[22;39m\x1b]8;;\x1b\\`);
});

test("a long title is cut to the row, and every line still reaches the edge", () => {
  const long = "A very long title that goes on past the edge of the sidebar";
  const wide = "とても長いタイトルがサイドバーの端を越えて続きます";
  const issues = list([link("app-31", long), link("app-30", wide)]);
  const prs = list([pr("app#31", long), pr("app#30", wide)]);
  const screen = drawLists(threads, { issues, prs }, "lead", tall);
  expect(read(screen)).toContain("  A very long title that go…");
  expect(read(screen)).toContain("  ○ A very long title that …");
  for (const line of screen.split("\n")) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
});

test("a name that fills the row is cut too, so the row never wraps", () => {
  for (const length of [20, 21, 22, 23, 24, 25, 26, 30, 40]) {
    const name = "n".repeat(length);
    const issues = list([link(name, "A title"), link(name, "A title")]);
    const prs = list([pr(name, "A title", { word: "approved" }), pr(name, "A title")]);
    const screen = drawLists(threads, { issues, prs }, "lead", tall);
    for (const line of screen.split("\n")) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
  }
});

test("an issue's title and name start where the Issues heading does", () => {
  const lines = plain(drawLists(threads, lists, "lead", tall)).split("\n");
  const column = (text: string) => lines.find((line) => line.includes(text))?.indexOf(text);
  expect(column("Add CSV export")).toBe(column("Issues"));
  expect(column("app-31")).toBe(column("Issues"));
});

test("a PR has a mark in the mark column, with its title and name in the name column", () => {
  const lines = plain(drawLists(threads, lists, "lead", tall)).split("\n");
  const column = (text: string) => lines.find((line) => line.includes(text))?.indexOf(text);
  expect(column("○ Bump deps")).toBe(column("◆ lead"));
  expect(column("Bump deps")).toBe(column("lead"));
  expect(column("app#33")).toBe(column("lead"));
});

test("a PR's mark takes the colour it was given, and one with no thread is dim", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  expect(screen).toContain("\x1b[33m●");
  expect(screen).toContain("\x1b[90m○");
});

test("padding is two columns on the left and two before the edge, on every line of text", () => {
  const long = "A very long title that goes on past the edge of the sidebar";
  const wide = "とても長いタイトルがサイドバーの端を越えて続きます";
  const name = "a-very-long-repository-name-1234";
  const issues = list([link(name, long), link("app-30", wide)], 900);
  const prs = list([pr(name, long, { word: "review failed" }), pr("app#30", wide)], 900);
  const rows = [lead, thread(name), thread("app-7", { word: "review failed", age: "59m" })];
  for (const shown of ["lead", name]) {
    const screen = drawLists(rows, { issues, prs }, shown, { width: sidebarWidth, height: 40 });
    for (const line of plain(screen).split("\n")) {
      if (line.startsWith("─")) continue;
      expect(line.slice(0, 2)).toBe("  ");
      expect(line.slice(-3)).toBe("  │");
    }
  }
});

test("a title keeps as much room as a thread's name, and the grey still runs past it", () => {
  const name = "n".repeat(24);
  const rows = [lead, thread(name)];
  const prs = list([pr("app#34", "t".repeat(24))]);
  const screen = drawLists(rows, { ...nothing, prs }, name, tall);
  expect(read(screen)).toContain(`  ● ${name}`);
  expect(read(screen)).toContain(`  ○ ${"t".repeat(24)}`);
  expect(selected(screen)[0]).toContain("\x1b[22;39m  \x1b[49m");
});

test("on a narrow pane the hints are cut two columns before the edge", () => {
  const lines = plain(draw([lead], "lead", { width: 10, height: 6 })).split("\n");
  expect(lines.at(-3)).toBe("  ⌥↑↓ m  │");
});

test("control codes in a title never reach your terminal", () => {
  const bad = list([link("app-31", "evil\x1b]8;;http://x\x07\x1b[2Jtitle")]);
  const screen = drawLists(threads, { ...nothing, issues: bad }, "lead", tall);
  expect(screen).not.toContain("\x1b]8;;http://x");
  expect(screen).not.toContain("\x1b[2J");
});

const links = (count: number) =>
  Array.from({ length: count }, (_, n) => link(`app-${n + 1}`, "An issue"));
// The lines of one list, from its heading to the line under it or the hints.
const third = (lines: string[], heading: string) => {
  const from = lines.indexOf(`  ${heading}`);
  const next = lines.findIndex((line, y) => y > from && (line === rule || line.includes("⌥")));
  return lines.slice(from, next).filter(Boolean);
};

test("a list shows as many rows as fit its third, then a count of the rest", () => {
  const height = 40;
  const room = { width: sidebarWidth, height };
  const lines = read(drawLists(threads, { ...nothing, issues: list(links(9), 240) }, "lead", room));
  expect(third(lines, "Issues")).toHaveLength(10);
  expect(lines).toContain("  app-4");
  expect(lines).not.toContain("  app-5");
  expect(lines).toContain("  + 236 more");
});

test("a list that just fits its third has no count", () => {
  const room = { width: sidebarWidth, height: 41 };
  const lines = read(drawLists(threads, { ...nothing, prs: list(links(5)) }, "lead", room));
  expect(third(lines, "PRs")).toHaveLength(11);
  expect(lines.join("\n")).not.toContain("more");
});

test("the count gives way to the row in a third that only has room for one", () => {
  const room = { width: sidebarWidth, height: 17 };
  const lines = read(drawLists(threads, { ...nothing, issues: list(links(9)) }, "lead", room));
  expect(third(lines, "Issues")).toEqual(["  Issues", "  An issue", "  app-1"]);
});

test("an empty list keeps its heading and a dim none", () => {
  const screen = drawLists(threads, { ...nothing, prs: lists.prs }, "lead", tall);
  const lines = read(screen);
  expect(third(lines, "Issues")).toEqual(["  Issues", "  none"]);
  expect(third(lines, "Threads")[0]).toBe("  Threads");
  expect(screen).toContain("\x1b[90m  none");
  expect(lines.filter((line) => line === rule)).toHaveLength(2);
});

test("with nothing open, all three lists keep their place", () => {
  const lines = read(draw(threads, "lead", tall));
  expect(third(lines, "Issues")).toEqual(["  Issues", "  none"]);
  expect(third(lines, "PRs")).toEqual(["  PRs", "  none"]);
});

test("each list has a third of the sidebar above the hints, and THREADS has what is left over", () => {
  // Returns where each heading and line between lists is.
  const places = (height: number) => {
    const lines = read(drawLists(threads, lists, "lead", { width: sidebarWidth, height }));
    const at = (text: string) => lines.indexOf(text);
    return [at("  Issues"), at("  Threads"), at("  PRs"), lines.length - 3];
  };
  expect(places(41)).toEqual([0, 13, 26, 38]);
  expect(places(42)).toEqual([0, 13, 27, 39]);
  expect(places(43)).toEqual([0, 13, 28, 40]);
  expect(places(44)).toEqual([0, 14, 28, 41]);
});

test("each list stays in its place, however full any of them is", () => {
  const room = { width: sidebarWidth, height: 41 };
  const crowded: Lists = { issues: list(links(9), 240), prs: list(links(9), 240) };
  const moreThreads = [lead, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => thread(`app-${n}`))];
  const places = (rows: Row[], shownLists: Lists) => {
    const lines = read(drawLists(rows, shownLists, "lead", room));
    return ["  Issues", "  Threads", "  PRs"].map((text) => lines.indexOf(text));
  };
  const expected = [0, 13, 26];
  expect(places(threads, nothing)).toEqual(expected);
  expect(places(threads, lists)).toEqual(expected);
  expect(places(threads, crowded)).toEqual(expected);
  expect(places(moreThreads, crowded)).toEqual(expected);
});

const many = Array.from({ length: 5 }, (_, n) => link(`app-${n + 1}`, "A row"));
const full: Lists = { issues: list(many, 40), prs: list(many, 40) };
const busy = [lead, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => thread(`app-${n}`))];

test("THREADS scrolls inside its third, and the lists around it stay", () => {
  const room = { width: sidebarWidth, height: 25 };
  for (const { session } of busy) {
    const lines = read(drawLists(busy, full, session, room));
    expect(lines.indexOf("  Threads")).toBe(7);
    expect(lines.indexOf("  PRs")).toBe(16);
    const name = session === "lead" ? "◆ lead" : `● ${session}`;
    expect(third(lines, "Threads").join("\n")).toContain(name);
  }
});

test("a third too short for a heading and one row leaves THREADS the whole sidebar", () => {
  const short = { width: sidebarWidth, height: 16 };
  const whole = read(drawLists(busy, full, "app-7", short));
  expect(whole.join("\n")).not.toContain("Issues");
  expect(whole.join("\n")).not.toContain("Threads");
  expect(whole.join("\n")).toContain("● app-7");
  expect(read(drawLists(busy, nothing, "app-7", short))).toEqual(whole);
  const enough = read(drawLists(busy, full, "app-7", { width: sidebarWidth, height: 17 }));
  expect(enough).toContain("  Issues");
});

test("a row too tall for THREADS' third leaves THREADS the whole sidebar, as it must stay whole", () => {
  const name = "a-very-long-repository-name-1234";
  const rows = [lead, thread(name)];
  const room = { width: sidebarWidth, height: 17 };
  const lines = read(drawLists(rows, full, name, room));
  expect(lines.join("\n")).not.toContain("Issues");
  expect(lines.join("\n")).toContain("working · claude");
  expect(read(drawLists(rows, full, "lead", room))).toContain("  Issues");
});

test("the thread you are on stays on screen with the lists, at every height", () => {
  for (const height of [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 18, 20, 22, 24, 30, 38, 60])
    for (const { session } of busy) {
      const room = { width: sidebarWidth, height };
      const lines = drawLists(busy, full, session, room).split("\n");
      expect(lines).toHaveLength(height);
      const here = lines.filter((line) => line.includes(shaded)).map(plain);
      expect(here.join("")).toContain(session);
      if (height >= 2) expect(here).toHaveLength(2);
      for (const line of lines) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
    }
});

test("a click picks a thread below the other lists or a row of them, and on a heading nothing", () => {
  const y = (text: string) =>
    read(drawLists(threads, lists, "lead", tall)).findIndex((line) => line.includes(text));
  const click = (line: number) => pickedInLists(threads, lists, "lead", tall, line);
  expect(click(y("● app-12"))).toBe("app-12");
  expect(click(y("working · claude"))).toBe("app-12");
  expect(click(y("◆ lead"))).toBe("lead");
  for (const text of ["Issues", "Threads", "PRs", "───"]) expect(click(y(text))).toBeNull();
  expect(click(y("Add CSV export"))).toBe(lists.issues.links[0]?.url ?? "");
  expect(click(y("app-31"))).toBe(lists.issues.links[0]?.url ?? "");
  expect(click(y("app#34"))).toBe(lists.prs.links[0]?.url ?? "");
  // The blank line under a heading is no row, and the first row is just below it.
  expect(click(y("Threads") + 1)).toBeNull();
  expect(click(y("Threads") + 2)).toBe("lead");
});

test("a click finds its row as THREADS scrolls between the other lists", () => {
  const room = { width: sidebarWidth, height: 20 };
  for (const { session } of busy) {
    const lines = read(drawLists(busy, full, session, room));
    const name = session === "lead" ? "◆ lead" : `● ${session}`;
    const y = lines.findIndex((line) => line.endsWith(name));
    expect(pickedInLists(busy, full, session, room, y)).toBe(session);
  }
});

const urls = {
  a: lists.issues.links[0]?.url ?? "",
  b: lists.issues.links[1]?.url ?? "",
  c: lists.prs.links[0]?.url ?? "",
  d: lists.prs.links[1]?.url ?? "",
};
// Moves from a place, as Alt-Up and Alt-Down or, with Shift, as Alt-Shift-Up and Alt-Shift-Down.
const step = (from: string | null, by: 1 | -1, rows = threads) =>
  steppedInLists(rows, lists, from, tall, by);
const jump = (from: string | null, by: 1 | -1, rows = threads) =>
  jumped(rows, lists, from, tall, by);

test("moving goes through ISSUES, THREADS and PRS, top to bottom, and stops at the ends", () => {
  const order = [urls.a, urls.b, "lead", "app-12", urls.c, urls.d];
  order.slice(0, -1).forEach((place, i) => {
    expect(step(place, 1)).toBe(order[i + 1] ?? "");
    expect(step(order[i + 1] ?? "", -1)).toBe(place);
  });
  expect(step(urls.a, -1)).toBeNull();
  expect(step(urls.d, 1)).toBeNull();
});

test("moving steps over a thread whose agent isn't running, into the next list", () => {
  const rows = [lead, thread("app-12", { running: false })];
  expect(step("lead", 1, rows)).toBe(urls.c);
  expect(step(urls.c, -1, rows)).toBe("lead");
});

test("moving lands only on rows you can see, and skips what is under the count", () => {
  const links = [31, 30, 29, 28, 27, 26].map((n) => link(`app-${n}`, `Issue ${n}`));
  const crowded: Lists = { issues: list(links), prs: nothing.prs };
  const room = { width: sidebarWidth, height: 26 };
  const lines = read(drawLists(threads, crowded, "lead", room)).join("\n");
  expect(lines).toContain("app-30");
  expect(lines).not.toContain("app-29");
  expect(steppedInLists(threads, crowded, links[0]?.url ?? "", room, 1)).toBe(links[1]?.url ?? "");
  expect(steppedInLists(threads, crowded, links[1]?.url ?? "", room, 1)).toBe("lead");
});

test("moving passes straight through a list that is empty", () => {
  const none: Lists = { issues: lists.issues, prs: nothing.prs };
  expect(steppedInLists(threads, none, "app-12", tall, 1)).toBeNull();
  const noIssues: Lists = { issues: nothing.issues, prs: lists.prs };
  expect(steppedInLists(threads, noIssues, "lead", tall, -1)).toBeNull();
});

test("a terminal too short for ISSUES and PRS moves through THREADS alone", () => {
  const short = { width: sidebarWidth, height: 9 };
  expect(read(drawLists(threads, lists, "lead", short)).join("\n")).not.toContain("app-31");
  expect(steppedInLists(threads, lists, "lead", short, -1)).toBeNull();
  expect(steppedInLists(threads, lists, "app-12", short, 1)).toBeNull();
});

test("moving from a row that has gone goes to the lead", () => {
  expect(step("https://github.com/simon/app/issues/999", 1)).toBe("lead");
  expect(jump("https://github.com/simon/app/issues/999", 1)).toBe("lead");
});

test("jumping goes to the first row of the next or previous list, from any row of this one", () => {
  expect(jump(urls.a, 1)).toBe("lead");
  expect(jump(urls.b, 1)).toBe("lead");
  expect(jump("lead", 1)).toBe(urls.c);
  expect(jump("app-12", 1)).toBe(urls.c);
  expect(jump(urls.d, -1)).toBe("lead");
  expect(jump("app-12", -1)).toBe(urls.a);
});

test("jumping stops at the first and last list", () => {
  expect(jump(urls.b, -1)).toBeNull();
  expect(jump(urls.c, 1)).toBeNull();
});

test("jumping passes over a list with nothing in it to land on", () => {
  const stopped = [{ ...lead, running: false }, thread("app-12", { running: false })];
  expect(jump(urls.a, 1, stopped)).toBe(urls.c);
  expect(jump(urls.d, -1, stopped)).toBe(urls.a);
  const noPrs: Lists = { issues: lists.issues, prs: nothing.prs };
  expect(jumped(threads, noPrs, "lead", tall, 1)).toBeNull();
});

test("jumping into THREADS lands on the first agent that runs", () => {
  const rows = [{ ...lead, running: false }, thread("app-12")];
  expect(jump(urls.a, 1, rows)).toBe("app-12");
});

test("the issue or PR you are on is shaded across the whole width, on both its lines", () => {
  for (const [url, name] of [
    [urls.a, "app-31"],
    [urls.c, "app#34"],
  ] as const) {
    const lines = drawLists(threads, lists, url, tall).split("\n");
    const shaded = lines.filter((line) => line.includes("48;5;238"));
    expect(shaded).toHaveLength(2);
    expect(shaded.map(plain).join("")).toContain(name);
    for (const line of shaded) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
  }
});

test("on the grey, an issue's or PR's text takes the fixed light colours", () => {
  const lines = drawLists(threads, lists, urls.c, tall).split("\n");
  const shaded = lines.filter((line) => line.includes("48;5;238")).join("\n");
  expect(shaded).toContain("1;38;5;231");
  expect(shaded).toContain("38;5;221");
  expect(shaded).not.toContain("\x1b[90m");
  expect(shaded).not.toContain("\x1b[33m");
});

test("a shaded row is still a terminal link", () => {
  const lines = drawLists(threads, lists, urls.a, tall).split("\n");
  const shaded = lines.filter((line) => line.includes("48;5;238"));
  for (const line of shaded) expect(line).toContain(`\x1b]8;;${urls.a}\x1b\\`);
});

test("no thread is shaded while you are on an issue", () => {
  const lines = drawLists(threads, lists, urls.a, tall).split("\n");
  expect(lines.filter((line) => line.includes("48;5;238")).join("")).not.toContain("lead");
});

const state: Thread = {
  owner: "simon",
  repo: "app",
  task: 12,
  folder: "app-12",
  branch: "skel/12",
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
  last_review: 0,
  last_comment: 0,
  last_check: 0,
  asking: false,
  noting: null,
  title: null,
  started: null,
  checks: null,
  reviewer: null,
  reviewed_by: null,
  review_round: null,
  verdict: null,
  review_line: null,
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
  function after(sql: string, now: number): { rows: Row[]; lists: Lists } {
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { sidebarLists, sidebarRows } from ${JSON.stringify(source("screen/rows.ts"))};
const db = openDb();
db.run(${JSON.stringify(sql)});
const rows = sidebarRows(db, ["lead", "app-12"], () => 3, ${now}, "lead");
console.log(JSON.stringify({ rows, lists: sidebarLists(db, rows, 5) }));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!run.success) throw new Error(run.stderr.toString());
    rmSync(join(home, ".local"), { recursive: true, force: true });
    return JSON.parse(run.stdout.toString());
  }
  const rowsAfter = (sql: string, now: number) => after(sql, now).rows;
  const repository = "INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app');";
  // Returns the sidebar with one thread that started at 0, in the state given, at a moment.
  function shown(columns: string, values: string, now: number): string {
    const sql = `${repository} INSERT INTO threads
      (owner, repo, task, folder, branch, started, ${columns})
      VALUES ('simon', 'app', 12, 'app-12', 'skel/12', 0, ${values})`;
    return draw(rowsAfter(sql, now), "lead", size);
  }
  const hours = (n: number) => n * 3_600_000;

  // Adds two repositories' open issues and PRs, whose dates and numbers run in different
  // orders, with a total for each repository.
  const open = `INSERT INTO repositories (name, owner, repo, open_issues, open_prs)
      VALUES ('app', 'simon', 'app', 212, 3), ('site', 'simon', 'site', 1, 0);
    ${itemSql("app", "task", 12, "Fix login", "2026-11-05T10:00:00Z")}
    ${itemSql("app", "task", 3, "Add export", "2026-11-01T10:00:00Z")}
    ${itemSql("site", "task", 8, "Dark mode", "2026-11-03T10:00:00Z")}
    ${itemSql("app", "pr", 34, "Fix the login", "2026-11-05T11:00:00Z")}
    ${itemSql("app", "pr", 40, "Bump deps", "2026-11-05T09:00:00Z")}`;
  // Adds a thread on issue 12, with PR 34.
  const onTwelve = (status: string, needing = 0) =>
    `INSERT INTO threads (owner, repo, task, folder, branch, status, pr, needs_you)
      VALUES ('simon', 'app', 12, 'app-12', 'skel/12', '${status}', 34, ${needing});`;

  test("issues come newest first across repositories, with those on a thread dim and last", () => {
    const { issues } = after(`${open} ${onTwelve("working")}`, 0).lists;
    expect(issues.links.map(({ name, dim }) => [name, dim])).toEqual([
      ["site-8", false],
      ["app-3", false],
      ["app-12", true],
    ]);
    expect(issues.total).toBe(213);
  });

  test("a thread that is done no longer dims its issue, as it is gone from THREADS", () => {
    const { issues } = after(`${open} ${onTwelve("done")}`, 0).lists;
    expect(issues.links[0]).toMatchObject({ name: "app-12", dim: false });
  });

  test("PRs come newest first, and one from a thread has that thread's word", () => {
    const { prs } = after(`${open} ${onTwelve("waiting", 1)}`, 0).lists;
    expect(prs.links.map(({ name, word, needing }) => [name, word, needing])).toEqual([
      ["app#34", "needs you", true],
      ["app#40", "", false],
    ]);
    expect(prs.total).toBe(3);
  });

  test("a PR shows the same mark and colour as its thread, in every state", () => {
    const states = [
      ["working", 0, "\x1b[32m●"],
      ["waiting", 0, "\x1b[90m○"],
      ["stopped", 0, "\x1b[90m○"],
      ["failed", 0, "\x1b[31m●"],
      ["failed", 1, "\x1b[31m●"],
      ["waiting", 1, "\x1b[33m●"],
    ] as const;
    for (const [status, needing, mark] of states) {
      const seen = after(`${open} ${onTwelve(status, needing)}`, 0);
      const screen = drawLists(seen.rows, seen.lists, "lead", tall);
      expect(screen).toContain(`${mark}\x1b[22;39m app-12`);
      expect(screen).toContain(`${mark}\x1b[22;39m \x1b]8;;https://github.com/simon/app/pull/34`);
    }
  });

  test("a PR with no thread shows the dim circle, and an issue has no mark", () => {
    const { issues, prs } = after(open, 0).lists;
    expect(prs.links[0]?.mark).toEqual(["○", 90]);
    expect(issues.links[0]?.mark).toBeNull();
  });

  test("a PR whose thread is done has no thread left, so it shows the dim circle", () => {
    const { prs } = after(`${open} ${onTwelve("done")}`, 0).lists;
    expect(prs.links[0]?.mark).toEqual(["○", 90]);
  });

  test("a row links to the issue or PR on GitHub", () => {
    const { issues, prs } = after(open, 0).lists;
    expect(issues.links[0]?.url).toBe("https://github.com/simon/app/issues/12");
    expect(prs.links[0]?.url).toBe("https://github.com/simon/app/pull/34");
  });

  test("only as many rows as could show are read, as the sidebar reads each second", () => {
    const rows = Array.from({ length: 9 }, (_, n) =>
      itemSql("app", "task", n + 1, "t", `2026-11-0${n + 1}T10:00:00Z`),
    );
    const sql = `${repository} ${rows.join(" ")}`;
    expect(after(sql, 0).lists.issues.links).toHaveLength(5);
  });

  test("a repository skel no longer works on shows nothing", () => {
    const sql = itemSql("gone", "task", 1, "t", "2026-11-01T10:00:00Z");
    expect(after(sql, 0).lists).toEqual(nothing);
  });

  test("a working thread shows how long ago it started, and the lead shows no time", () => {
    expect(listed(shown("status", "'working'", hours(2)))).toEqual([
      "  ◆ lead",
      "    running · claude",
      "  ● app-12",
      "    working · claude · 2h",
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

  test("a thread with no start time saved shows none", () => {
    const sql = `${repository} INSERT INTO threads (owner, repo, task, folder, branch, status)
      VALUES ('simon', 'app', 12, 'app-12', 'skel/12', 'working')`;
    const [, older] = rowsAfter(sql, 5_000);
    expect(older?.word).toBe("working");
    expect(older?.age).toBe("");
  });
});
