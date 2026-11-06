// What the sidebar shows and which row a key or click picks, given the rows it was handed, and
// the word each thread gets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sidebarWidth } from "../src/screen.ts";
import {
  draw as drawLists,
  type Link,
  type Lists,
  picked as pickedInLists,
  type Row,
  stepped,
  threadAge,
  threadWord,
} from "../src/sidebar.ts";
import type { Thread } from "../src/thread.ts";

const row = {
  title: null,
  pr: null,
  checks: null,
  review: null,
  needsYou: false,
  running: true,
  harness: "claude",
  age: "",
  github: null,
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
// Removes the colours, to read a row as text.
const plain = (screen: string) => Bun.stripANSI(screen);
// The sidebar's lines as you read them, without what fills them out to the line at its edge.
const read = (screen: string) =>
  plain(screen)
    .split("\n")
    .map((text) => text.slice(0, -1).trimEnd());
// The sidebar's rows, with the empty lines and the two hints at the bottom left out.
const listed = (screen: string) => read(screen).slice(0, -2).filter(Boolean);

test("lists the lead first, then each thread on two lines: a mark and name, then word and harness", () => {
  const rows = [
    lead,
    thread("app-12"),
    thread("site-7", { status: "waiting", word: "reviewing", harness: "codex" }),
  ];
  expect(listed(draw(rows, "lead", size))).toEqual([
    "   ◆ lead",
    "     running · claude",
    "   ● app-12",
    "     working · claude",
    "   ○ site-7",
    "     reviewing · codex",
  ]);
});

test("rows and hints sit three columns in, and the word two further", () => {
  const lines = plain(draw([lead, thread("app-12")], "lead", size)).split("\n");
  expect(lines[0]?.indexOf("◆")).toBe(3);
  expect(lines[1]?.indexOf("running")).toBe(5);
  expect(lines[2]?.indexOf("●")).toBe(3);
  expect(lines[2]?.indexOf("app-12")).toBe(5);
  expect(lines.at(-2)?.indexOf("⌥")).toBe(3);
});

test("the word and harness are grey, so the names stand out", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90mworking");
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90m · claude");
});

test("a thread that needs you has a yellow circle and a yellow word, whatever its status", () => {
  for (const status of ["working", "waiting"] as const) {
    const needing = thread("app-12", { status, needsYou: true, word: "approved" });
    const screen = draw([lead, needing], "lead", size);
    expect(read(screen).join("\n")).toContain("   ● app-12\n     approved · claude");
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
    "   ● app-12",
    "     working · claude",
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
  expect(listed(screen)).toEqual(["   ● app-12", "     working · claude · 5m"]);
  expect(screen).toContain("\x1b[90m · claude · 5m");
});

test("the longest running time fits on the line whole", () => {
  const long = thread("app-12", { age: "59m" });
  expect(listed(draw([long], "lead", size))[1]).toBe("     working · claude · 59m");
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
    "   ● a-very-long-repository-n",
    "     ame-1234",
    "     working · claude",
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

test("two hints with the keys stay at the bottom, below however few rows there are", () => {
  const lines = read(draw([lead], "lead", size));
  expect(lines).toHaveLength(size.height);
  expect(lines.slice(-2)).toEqual(["   ⌥↑↓ switch", "   ⌃Q  quit"]);
  expect(draw([lead], "lead", size)).toContain("\x1b[90m   ⌥↑↓ switch");
});

test("a list too long for the sidebar scrolls above the hints, and never runs into them", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: sidebarWidth, height: 7 };
  expect(read(draw(rows, "app-4", short))).toEqual([
    "   ● app-3",
    "     working · claude",
    "   ● app-4",
    "     working · claude",
    "   ● app-5",
    "   ⌥↑↓ switch",
    "   ⌃Q  quit",
  ]);
});

test("a sidebar too short for a row and the hints drops the hints, as the row matters more", () => {
  const rows = [lead, thread("app-1")];
  for (const height of [1, 2, 3]) {
    const lines = plain(draw(rows, "app-1", { width: sidebarWidth, height })).split("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.join("\n")).not.toContain("switch");
    expect(lines.join("\n")).toContain("   ● app-1");
  }
  expect(plain(draw(rows, "app-1", { width: sidebarWidth, height: 4 }))).toContain("switch");
});

test("the hints also give way to a row whose name takes more lines", () => {
  const name = "a-very-long-repository-name-1234";
  const rows = [lead, thread(name)];
  const tight = { width: sidebarWidth, height: 4 };
  const text = plain(draw(rows, name, tight));
  expect(text).toContain("working · claude");
  expect(text).not.toContain("switch");
  expect(picked(rows, name, tight, 2)).toBe(name);
  expect(plain(draw(rows, name, { width: sidebarWidth, height: 5 }))).toContain("switch");
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
  const short = { width: sidebarWidth, height: 7 };
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
  ...more,
});
const list = (links: Link[], total = links.length) => ({ links, total });
const lists: Lists = {
  issues: list([link("app-31", "Add CSV export"), link("app-12", "Fix login", { dim: true })]),
  prs: list([
    link("app#34", "Fix login", { word: "approved", needing: true }),
    link("app#33", "Bump deps"),
  ]),
};
const tall = { width: sidebarWidth, height: 30 };
const rule = "─".repeat(sidebarWidth - 1);
const threads = [lead, thread("app-12", { age: "5m" })];

test("ISSUES, THREADS and PRS sit in that order, with rows together and a line between lists", () => {
  expect(
    read(drawLists(threads, lists, "lead", tall))
      .filter(Boolean)
      .slice(0, -2),
  ).toEqual([
    "   Issues",
    "     Add CSV export",
    "     app-31",
    "     Fix login",
    "     app-12",
    rule,
    "   Threads",
    "   ◆ lead",
    "     running · claude",
    "   ● app-12",
    "     working · claude · 5m",
    rule,
    "   PRs",
    "     Fix login",
    "     app#34 · approved",
    "     Bump deps",
    "     app#33",
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
    ["   Issues", "     Add CSV export"],
    ["   Threads", "   ◆ lead"],
    ["   PRs", "     Fix login"],
  ]) {
    const y = lines.indexOf(heading ?? "");
    expect(lines.slice(y, y + 3)).toEqual([heading ?? "", "", first ?? ""]);
  }
});

test("headings are dim, and sit where the marks do", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  for (const heading of ["Issues", "Threads", "PRs"])
    expect(screen).toContain(`\x1b[90m   ${heading}`);
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
  const working = link("app#34", "Fix login", { word: "working" });
  const dim = drawLists(threads, { ...lists, prs: list([working]) }, "lead", tall);
  expect(dim).toContain("\x1b[90mworking");
});

test("a PR's name is dim, and one with no thread has no word after it", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  expect(screen).toContain("\x1b[90mapp#34");
  expect(read(screen)).toContain("     app#33");
});

test("both lines of a row that isn't a thread are a terminal link, and only the text is", () => {
  const screen = drawLists(threads, lists, "lead", tall);
  const open = "\x1b]8;;https://github.com/simon/app/issues/31\x1b\\";
  expect(screen).toContain(`     ${open}Add CSV export\x1b]8;;\x1b\\`);
  expect(screen).toContain(`     ${open}\x1b[90mapp-31\x1b[22;39m\x1b]8;;\x1b\\`);
});

test("a long title is cut to the row, and every line still reaches the edge", () => {
  const long = "A very long title that goes on past the edge of the sidebar";
  const wide = "とても長いタイトルがサイドバーの端を越えて続きます";
  const both = list([link("app-31", long), link("app-30", wide)]);
  const screen = drawLists(threads, { issues: both, prs: both }, "lead", tall);
  expect(plain(screen)).toContain("     A very long title that …");
  for (const line of screen.split("\n")) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
});

test("a name that fills the row is cut too, so the row never wraps", () => {
  for (const length of [20, 21, 22, 23, 24, 25, 26, 30, 40]) {
    const name = "n".repeat(length);
    const rows = list([link(name, "A title", { word: "approved" }), link(name, "A title")]);
    const screen = drawLists(threads, { issues: rows, prs: rows }, "lead", tall);
    for (const line of screen.split("\n")) expect(Bun.stringWidth(line)).toBe(sidebarWidth);
  }
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
  const from = lines.indexOf(`   ${heading}`);
  const next = lines.findIndex((line, y) => y > from && (line === rule || line.includes("⌥")));
  return lines.slice(from, next).filter(Boolean);
};

test("a list shows as many rows as fit its third, then a count of the rest", () => {
  const height = 40;
  const room = { width: sidebarWidth, height };
  const lines = read(drawLists(threads, { ...nothing, issues: list(links(9), 240) }, "lead", room));
  expect(third(lines, "Issues")).toHaveLength(10);
  expect(lines).toContain("     app-4");
  expect(lines).not.toContain("     app-5");
  expect(lines).toContain("     + 236 more");
});

test("a list that just fits its third has no count", () => {
  const room = { width: sidebarWidth, height: 40 };
  const lines = read(drawLists(threads, { ...nothing, prs: list(links(5)) }, "lead", room));
  expect(third(lines, "PRs")).toHaveLength(11);
  expect(lines.join("\n")).not.toContain("more");
});

test("the count gives way to the row in a third that only has room for one", () => {
  const room = { width: sidebarWidth, height: 16 };
  const lines = read(drawLists(threads, { ...nothing, issues: list(links(9)) }, "lead", room));
  expect(third(lines, "Issues")).toEqual(["   Issues", "     An issue", "     app-1"]);
});

test("an empty list keeps its heading and a dim none", () => {
  const screen = drawLists(threads, { ...nothing, prs: lists.prs }, "lead", tall);
  const lines = read(screen);
  expect(third(lines, "Issues")).toEqual(["   Issues", "     none"]);
  expect(third(lines, "Threads")[0]).toBe("   Threads");
  expect(screen).toContain("\x1b[90m     none");
  expect(lines.filter((line) => line === rule)).toHaveLength(2);
});

test("with nothing open, all three lists keep their place", () => {
  const lines = read(draw(threads, "lead", tall));
  expect(third(lines, "Issues")).toEqual(["   Issues", "     none"]);
  expect(third(lines, "PRs")).toEqual(["   PRs", "     none"]);
});

test("each list has a third of the sidebar above the hints, and THREADS has what is left over", () => {
  // Returns where each heading and line between lists is.
  const places = (height: number) => {
    const lines = read(drawLists(threads, lists, "lead", { width: sidebarWidth, height }));
    const at = (text: string) => lines.indexOf(text);
    return [at("   Issues"), at("   Threads"), at("   PRs"), lines.length - 2];
  };
  expect(places(40)).toEqual([0, 13, 26, 38]);
  expect(places(41)).toEqual([0, 13, 27, 39]);
  expect(places(42)).toEqual([0, 13, 28, 40]);
  expect(places(43)).toEqual([0, 14, 28, 41]);
});

test("each list stays in its place, however full any of them is", () => {
  const room = { width: sidebarWidth, height: 40 };
  const crowded: Lists = { issues: list(links(9), 240), prs: list(links(9), 240) };
  const moreThreads = [lead, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => thread(`app-${n}`))];
  const places = (rows: Row[], shownLists: Lists) => {
    const lines = read(drawLists(rows, shownLists, "lead", room));
    return ["   Issues", "   Threads", "   PRs"].map((text) => lines.indexOf(text));
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
  const room = { width: sidebarWidth, height: 24 };
  for (const { session } of busy) {
    const lines = read(drawLists(busy, full, session, room));
    expect(lines.indexOf("   Threads")).toBe(7);
    expect(lines.indexOf("   PRs")).toBe(16);
    const name = session === "lead" ? "◆ lead" : `● ${session}`;
    expect(third(lines, "Threads").join("\n")).toContain(name);
  }
});

test("a third too short for a heading and one row leaves THREADS the whole sidebar", () => {
  const short = { width: sidebarWidth, height: 15 };
  const whole = read(drawLists(busy, full, "app-7", short));
  expect(whole.join("\n")).not.toContain("Issues");
  expect(whole.join("\n")).not.toContain("Threads");
  expect(whole.join("\n")).toContain("● app-7");
  expect(read(drawLists(busy, nothing, "app-7", short))).toEqual(whole);
  const enough = read(drawLists(busy, full, "app-7", { width: sidebarWidth, height: 16 }));
  expect(enough).toContain("   Issues");
});

test("a row too tall for THREADS' third leaves THREADS the whole sidebar, as it must stay whole", () => {
  const name = "a-very-long-repository-name-1234";
  const rows = [lead, thread(name)];
  const room = { width: sidebarWidth, height: 16 };
  const lines = read(drawLists(rows, full, name, room));
  expect(lines.join("\n")).not.toContain("Issues");
  expect(lines.join("\n")).toContain("working · claude");
  expect(read(drawLists(rows, full, "lead", room))).toContain("   Issues");
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

test("a click picks a thread below the other lists, and on a link or heading picks nothing", () => {
  const y = (text: string) =>
    read(drawLists(threads, lists, "lead", tall)).findIndex((line) => line.includes(text));
  const click = (line: number) => pickedInLists(threads, lists, "lead", tall, line);
  expect(click(y("● app-12"))).toBe("app-12");
  expect(click(y("working · claude"))).toBe("app-12");
  expect(click(y("◆ lead"))).toBe("lead");
  for (const text of ["Issues", "app-31", "Threads", "PRs", "app#34", "───"])
    expect(click(y(text))).toBeNull();
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
    const src = join(import.meta.dir, "..", "src");
    const code = `import { openDb } from ${JSON.stringify(join(src, "db.ts"))};
import { sidebarLists, sidebarRows } from ${JSON.stringify(join(src, "sidebar.ts"))};
const db = openDb();
db.run(${JSON.stringify(sql)});
const rows = sidebarRows(db, ["lead", "app-12"], 3, ${now});
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
    INSERT INTO open_items (owner, repo, kind, number, title, created) VALUES
      ('simon', 'app', 'issue', 12, 'Fix login', '2026-11-05T10:00:00Z'),
      ('simon', 'app', 'issue', 3, 'Add export', '2026-11-01T10:00:00Z'),
      ('simon', 'site', 'issue', 8, 'Dark mode', '2026-11-03T10:00:00Z'),
      ('simon', 'app', 'pr', 34, 'Fix the login', '2026-11-05T11:00:00Z'),
      ('simon', 'app', 'pr', 40, 'Bump deps', '2026-11-05T09:00:00Z');`;
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

  test("a row links to the issue or PR on GitHub", () => {
    const { issues, prs } = after(open, 0).lists;
    expect(issues.links[0]?.url).toBe("https://github.com/simon/app/issues/12");
    expect(prs.links[0]?.url).toBe("https://github.com/simon/app/pull/34");
  });

  test("only as many rows as could show are read, as the sidebar reads each second", () => {
    const rows = Array.from(
      { length: 9 },
      (_, n) => `('simon', 'app', 'issue', ${n + 1}, 't', '2026-11-0${n + 1}T10:00:00Z')`,
    );
    const sql = `${repository} INSERT INTO open_items
      (owner, repo, kind, number, title, created) VALUES ${rows.join(", ")}`;
    expect(after(sql, 0).lists.issues.links).toHaveLength(5);
  });

  test("a repository skel no longer works on shows nothing", () => {
    const sql = `INSERT INTO open_items (owner, repo, kind, number, title, created)
      VALUES ('simon', 'gone', 'issue', 1, 't', '2026-11-01T10:00:00Z')`;
    expect(after(sql, 0).lists).toEqual(nothing);
  });

  test("a working thread shows how long ago it started, and the lead shows no time", () => {
    expect(listed(shown("status", "'working'", hours(2)))).toEqual([
      "   ◆ lead",
      "     running · claude",
      "   ● app-12",
      "     working · claude · 2h",
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

  test("a thread an older skel started has no time saved, and shows none", () => {
    const sql = `${repository} INSERT INTO threads (owner, repo, task, folder, branch, status)
      VALUES ('simon', 'app', 12, 'app-12', 'skel/12', 'working')`;
    const [, older] = rowsAfter(sql, 5_000);
    expect(older?.word).toBe("working");
    expect(older?.age).toBe("");
  });
});
