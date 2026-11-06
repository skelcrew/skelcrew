// What the sidebar shows and which row a key or click picks, given the rows it was handed, and
// the word each thread gets.
import { expect, test } from "bun:test";
import { draw, picked, type Row, stepped, threadWord } from "../src/sidebar.ts";
import type { Thread } from "../src/thread.ts";

const row = {
  title: null,
  pr: null,
  checks: null,
  review: null,
  needsYou: false,
  running: true,
  harness: "claude",
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

const size = { width: 29, height: 12 };
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
    "  ◆ lead",
    "    running · claude",
    "  ● app-12",
    "    working · claude",
    "  ○ site-7",
    "    reviewing · codex",
  ]);
});

test("the word and harness are grey, so the names stand out", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90mworking");
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[90m · claude");
});

test("a thread that needs you has a yellow ? and a yellow word, whatever its status", () => {
  const screen = draw([lead, thread("app-12", { needsYou: true, word: "approved" })], "lead", size);
  expect(read(screen).join("\n")).toContain("  ? app-12\n    approved · claude");
  expect(screen).toContain("\x1b[33m?");
  expect(screen).toContain("\x1b[33mapproved");
});

test("colour comes with a mark: blue for working, green for done", () => {
  expect(draw([thread("app-12")], "lead", size)).toContain("\x1b[34m●");
  expect(draw([thread("app-12", { status: "done" })], "lead", size)).toContain("\x1b[32m✓");
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
  ];
  const on = (session: string) => selected(draw(rows, session, size)).join("\n");
  expect(on("app-1")).toContain("\x1b[38;5;117m●");
  expect(on("app-1")).toContain("\x1b[1;38;5;231mapp-1");
  expect(on("app-1")).toContain("\x1b[38;5;250mworking");
  expect(on("app-1")).toContain("\x1b[38;5;250m · claude");
  expect(on("app-2")).toContain("\x1b[38;5;120m✓");
  expect(on("app-3")).toContain("\x1b[38;5;250m○");
  expect(on("app-4")).toContain("\x1b[38;5;221m?");
  expect(on("app-4")).toContain("\x1b[38;5;221mapproved");
  expect(selected(draw([lead], "lead", size)).join("\n")).toContain("\x1b[38;5;250m◆");
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
  for (let width = 0; width < 29; width++) {
    const text = plain(draw(rows, "lead", { width, height: 60 })).replace(/[\s\n│]/g, "");
    expect(text).toContain("a-very-long-repository-name-1234");
  }
});

test("a grey line fills the last column of every line, from top to bottom, at any height", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5, 6].map((n) => thread(`app-${n}`))];
  for (const list of [[lead], rows])
    for (let height = 1; height < 30; height++)
      for (const shown of ["lead", "app-6", "gone"]) {
        const lines = draw(list, shown, { width: 29, height }).split("\n");
        expect(lines).toHaveLength(height);
        for (const line of lines) {
          expect(line).toContain("\x1b[38;5;237m│");
          expect(Bun.stringWidth(line)).toBe(29);
          expect(plain(line).at(-1)).toBe("│");
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
  expect(lines.slice(-2)).toEqual(["  ⌥↑↓ switch", "  ⌃Q  quit"]);
  expect(draw([lead], "lead", size)).toContain("\x1b[90m  ⌥↑↓ switch");
});

test("a list too long for the sidebar scrolls above the hints, and never runs into them", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5].map((n) => thread(`app-${n}`))];
  const short = { width: 29, height: 7 };
  expect(read(draw(rows, "app-4", short))).toEqual([
    "  ● app-3",
    "    working · claude",
    "  ● app-4",
    "    working · claude",
    "  ● app-5",
    "  ⌥↑↓ switch",
    "  ⌃Q  quit",
  ]);
});

test("a sidebar too short for a row and the hints drops the hints, as the row matters more", () => {
  const rows = [lead, thread("app-1")];
  for (const height of [1, 2, 3]) {
    const lines = plain(draw(rows, "app-1", { width: 29, height })).split("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.join("\n")).not.toContain("switch");
    expect(lines.join("\n")).toContain("  ● app-1");
  }
  expect(plain(draw(rows, "app-1", { width: 29, height: 4 }))).toContain("switch");
});

test("the hints also give way to a row whose name takes more lines", () => {
  const name = "a-very-long-repository-name-1234";
  const rows = [lead, thread(name)];
  const tight = { width: 29, height: 4 };
  const text = plain(draw(rows, name, tight));
  expect(text).toContain("working · claude");
  expect(text).not.toContain("switch");
  expect(picked(rows, name, tight, 2)).toBe(name);
  expect(plain(draw(rows, name, { width: 29, height: 5 }))).toContain("switch");
});

test("the row you are looking at stays on screen however far down the list it is", () => {
  const rows = [lead, ...[1, 2, 3, 4, 5, 6].map((n) => thread(`app-${n}`))];
  for (const height of [4, 5, 6, 7, 8, 9, 12])
    for (const { session } of rows) {
      const shown = { width: 29, height };
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
  const short = { width: 29, height: 7 };
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
