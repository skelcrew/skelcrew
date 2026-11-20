// The details pane beside the list, as it is drawn: the task's details on top and its agent's live
// screen below, and where it goes beside the list's lines. Drawing reads nothing, so these need
// no terminal and no database.
import { expect, test } from "bun:test";
import type { Details } from "../src/list/details.ts";
import { drawList, type Frame, paneWidth } from "../src/list/layout.ts";
import { drawPane } from "../src/list/pane.ts";
import type { Row } from "../src/list/rows.ts";

// A task at work in Building, whose builder asks a question.
const row: Row = {
  part: "building",
  name: "app-12",
  task: "12",
  title: "Rate limit",
  mark: { sign: "●", colour: "yellow" },
  says: "question",
  colour: "yellow",
  step: "",
  pr: "#43",
  checks: "CI running",
  when: "14:02",
  needsYou: true,
  session: "app-12",
  running: true,
  tmux: true,
  start: null,
  merge: null,
  link: "https://github.com/acme/app/pull/43",
  branch: "skelcrew/12",
  more: 0,
};

// Its details, as sc show reads them from Skelcrew's copy, with its review's findings and events.
const details: Details = {
  view: {
    task: "app-12",
    stage: "working",
    title: "Rate limit the API",
    issue: { id: "#42", link: "https://github.com/acme/app/issues/42" },
    threads: [{ thread: "app-12/builder", status: "working", needsYou: true }],
    body: "Add a limit per user to the public API, so one client can't starve the others.\n\nIt resets each minute. Clients over it get a 429 with a Retry-After header. The limit is set per repository.",
    pr: 43,
    review: { state: "changes", round: 2, at: null },
    prPage: {
      title: "Rate limit the API",
      state: "open",
      branch: "skelcrew/12",
      base: "main",
      ci: "running",
      checks: [
        { name: "test", state: "passed", log: null },
        { name: "lint", state: "running", log: null },
        { name: "build", state: "failed", log: null },
      ],
      review: null,
      body: "",
      link: "https://github.com/acme/app/pull/43",
    },
    merge: null,
  },
  findings: [
    "The limit resets per process, not per user",
    "No test covers the header",
    "The 429 has no body",
    "The docs say 100, the code 60",
  ],
  events: ["13:40 submitted", "13:52 reviewed", "14:02 submitted"],
};

// Returns the pane's lines without their colours, with no spaces at their ends.
const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line).trimEnd());

test("the pane shows the task's details from the top, then its agent's screen below a line", () => {
  const lines = drawPane(row, details, { screen: "I am app-12\n› \n\n\n" }, 50, 30);
  expect(lines).toHaveLength(30);
  expect(plain(lines).slice(0, 23)).toEqual([
    "Rate limit the API",
    "issue #42  https://github.com/acme/app/issues/42",
    "PR    #43  https://github.com/acme/app/pull/43",
    "",
    "Building · question",
    "CI running:  test ✓  lint ●  build ✗",
    "Round 2 · changes asked",
    "  - The limit resets per process, not per user",
    "  - No test covers the header",
    "  - The 429 has no body",
    "  … 1 more",
    "",
    "Add a limit per user to the public API, so one",
    "client can't starve the others. It resets each",
    "minute. Clients over it get a 429 with a…",
    "",
    "13:40 submitted · 13:52 reviewed · 14:02 submitted",
    "",
    "─".repeat(50),
    "I am app-12",
    "›",
    "",
    "",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(50);
});

test("the live view shows the bottom of the screen, colours kept and long lines cut", () => {
  const screen = [
    ...Array.from({ length: 40 }, (_, i) => `line ${i}`),
    `\x1b[31mred words\x1b[39m and ${"0123456789".repeat(10)}`,
    // A link and a cursor move from the agent's screen never reach your terminal.
    "\x1b]8;;https://example.com\x1b\\a link\x1b]8;;\x1b\\\x1b[2Jdone",
    "",
    "",
  ].join("\n");
  const lines = drawPane(row, details, { screen }, 40, 30);
  const live = lines.slice(lines.findIndex((line) => line.includes("───")) + 1);
  expect(plain(live).slice(-3)).toEqual([
    "line 39",
    `red words and ${"0123456789".repeat(3).slice(0, 26)}`,
    "a linkdone",
  ]);
  // Its colour is kept, and reset at the line's end, so it never reaches the next line.
  const red = live.find((line) => line.includes("red words")) ?? "";
  expect(red).toStartWith("\x1b[31mred words");
  expect(red).toEndWith("\x1b[0m");
  expect(lines.join("")).not.toContain("\x1b]8");
  expect(lines.join("")).not.toContain("\x1b[2J");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});

test("a task with no running agent says so, and a row that isn't a task has an empty pane", () => {
  const lines = plain(drawPane(row, details, { note: "Builder not running" }, 50, 30));
  expect(lines.slice(lines.indexOf("─".repeat(50)) + 1, -1).filter(Boolean)).toEqual([
    "Builder not running",
  ]);
  const lead: Row = { ...row, part: "lead", name: "lead", task: null };
  expect(plain(drawPane(lead, null, null, 50, 30))).toEqual(Array(30).fill(""));
});

test("in a short pane the details give way, so the live view keeps a few lines", () => {
  const screen = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const lines = plain(drawPane(row, details, { screen }, 50, 14));
  expect(lines).toHaveLength(14);
  expect(lines.slice(-5)).toEqual(["line 15", "line 16", "line 17", "line 18", "line 19"]);
});

// What the list shows besides its rows.
const frame: Frame = {
  version: "0.6.0",
  where: "",
  name: "app",
  tabs: [{ name: "app", fullName: "simon/app", needYou: 0, colour: "yellow", ready: 0 }],
  notice: "",
  bottom: "↑↓ move",
  load: "cpu 12%",
};

test("the pane shows beside the list only in a terminal wide enough for both", () => {
  expect(paneWidth(100)).toBe(0);
  expect(paneWidth(140)).toBeGreaterThanOrEqual(40);
  const pane = Array.from({ length: 22 }, (_, i) => `pane ${i}`);
  // Too narrow: the list is drawn as it is with no pane.
  const narrow = drawList([row], [], 0, 0, frame, { width: 100, height: 24 }, pane);
  expect(narrow.lines).toEqual(drawList([row], [], 0, 0, frame, { width: 100, height: 24 }).lines);
  // Wide enough: every line between the top and the bottom has the pane at the same column.
  const wide = drawList([row], [], 0, 0, frame, { width: 140, height: 24 }, pane).lines;
  const lines = wide.map((line) => Bun.stripANSI(line));
  expect(lines).toHaveLength(24);
  const edge = 139 - paneWidth(140) - 3;
  for (const [at, line] of lines.slice(1, -1).entries())
    expect(line.slice(edge)).toBe(` │ pane ${at}`);
  // The top and bottom lines take the whole width, and nothing reaches the last column.
  expect(lines.at(-1)).toEndWith(`${" ".repeat(10)}cpu 12%`);
  expect(Bun.stringWidth(lines.at(-1) ?? "")).toBe(139);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(139);
});
