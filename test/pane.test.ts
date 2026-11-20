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
    threads: [
      { thread: "app-12/builder", status: "working", needsYou: true, needsYouFor: "a question" },
    ],
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
    filed: null,
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

// A host can set a colour once and leave it on over the lines after it, until it is reset.
test("a colour set on one line of the screen goes on over the lines after it until reset", () => {
  const screen = [
    "\x1b[32mgreen from here, out of sight",
    ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
    "\x1b[1mbold too",
    "\x1b[0;34mblue alone",
    "still blue\x1b[m",
    "plain again",
  ].join("\n");
  const lines = drawPane(row, details, { screen }, 50, 30);
  const live = lines.slice(lines.findIndex((line) => line.includes("───")) + 1);
  const at = (text: string) => live.find((line) => Bun.stripANSI(line) === text) ?? "";
  // The green set above the part shown still colours the lines shown.
  expect(at("line 29")).toStartWith("\x1b[32mline 29");
  expect(at("bold too")).toStartWith("\x1b[32m\x1b[1mbold too");
  // A code that resets first drops the colours before it.
  expect(at("still blue")).toContain("34m");
  expect(at("still blue")).not.toContain("32m");
  expect(at("still blue")).not.toContain("\x1b[1m");
  expect(at("plain again")).toStartWith("plain again");
});

test("a task with no running agent says so, and a row that isn't a task has an empty pane", () => {
  const lines = plain(drawPane(row, details, { note: "Builder not running" }, 50, 30));
  expect(lines.slice(lines.indexOf("─".repeat(50)) + 1, -1).filter(Boolean)).toEqual([
    "Builder not running",
  ]);
  const lead: Row = { ...row, part: "lead", name: "lead", task: null };
  expect(plain(drawPane(lead, null, null, 50, 30))).toEqual(Array(30).fill(""));
});

// A terminal 24 lines tall leaves the pane 22. The details are what the pane is for, so they keep
// their room, and the live view has what is left.
test("in a short pane the details show whole, and the live view has what is left", () => {
  const screen = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const lines = plain(drawPane(row, details, { screen }, 50, 22));
  expect(lines).toHaveLength(22);
  expect(lines).toContain("minute. Clients over it get a 429 with a…");
  expect(lines).toContain("13:40 submitted · 13:52 reviewed · 14:02 submitted");
  // What is left under the line shows the bottom of the agent's screen.
  const live = lines.slice(lines.indexOf("─".repeat(50)) + 1);
  expect(live.length).toBeGreaterThan(0);
  expect(live).toEqual(
    Array.from({ length: live.length }, (_, i) => `line ${20 - live.length + i}`),
  );
  const stopped = plain(drawPane(row, details, { note: "Builder not running" }, 50, 22));
  expect(stopped).toContain("13:40 submitted · 13:52 reviewed · 14:02 submitted");
  expect(stopped).toContain("Builder not running");
});

test("a long title and long links show whole, and every check shows however many there are", () => {
  const checks = ["test", "lint", "build", "typecheck", "e2e on linux", "e2e on macos"].map(
    (name, i) => ({ name, state: i === 5 ? ("failed" as const) : ("passed" as const), log: null }),
  );
  const link = "https://github.com/a-long-organisation/a-long-repository-name/pull/12345";
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const long: Details = {
    ...details,
    view: {
      ...details.view,
      title: "Rate limit the public API per user, so one client can never starve all the others",
      prPage: { ...page, checks, link },
    },
  };
  const lines = plain(drawPane(row, long, null, 40, 40));
  expect(lines.slice(0, 7)).toEqual([
    "Rate limit the public API per user, so",
    "one client can never starve all the",
    "others",
    "issue #42  https://github.com/acme/app/issues/42".slice(0, 9),
    "https://github.com/acme/app/issues/42",
    "PR    #43",
    "https://github.com/a-long-organisation/a",
  ]);
  expect(lines[7]).toBe("-long-repository-name/pull/12345");
  expect(lines).toContain("CI running:  test ✓  lint ✓  build ✓");
  expect(lines).toContain("typecheck ✓  e2e on linux ✓");
  expect(lines).toContain("e2e on macos ✗");
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
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

// Details far taller than the pane, from a long title, a long description, many findings and many
// checks, one of them failed.
test("details too tall for the pane tighten so every part shows, and the live view keeps its lines", () => {
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const checks = Array.from({ length: 60 }, (_, i) => ({
    name: `check-${i}`,
    state: i === 50 ? ("failed" as const) : ("passed" as const),
    log: null,
  }));
  const tall: Details = {
    ...details,
    view: { ...details.view, title: "A title ".repeat(40), prPage: { ...page, checks } },
  };
  const screen = "first\nsecond\nthird";
  const lines = plain(drawPane(row, tall, { screen }, 50, 22));
  expect(lines).toHaveLength(22);
  expect(lines[0]).toEndWith("…");
  expect(lines).toContain("issue #42  https://github.com/acme/app/issues/42");
  expect(lines).toContain("Building · question");
  // The failed check comes first, so it stays in sight.
  // The checks take one line, which ends with how many checks it leaves out of the 60.
  const ci = lines.find((line) => line.startsWith("CI running:")) ?? "";
  expect(ci).toStartWith("CI running:  check-50 ✗  check-0 ✓");
  const shown = ci.split("  ").filter((item) => item.startsWith("check-")).length;
  expect(ci).toEndWith(`  … ${60 - shown} more`);
  expect(lines.indexOf(ci) + 1).toBe(lines.indexOf("Round 2 · changes asked"));
  expect(lines).toContain("Round 2 · changes asked");
  expect(lines).toContain("  - The limit resets per process, not per user");
  expect(lines).toContain("Add a limit per user to the public API, so one…");
  expect(lines).toContain("13:40 submitted · 13:52 reviewed · 14:02 submitted");
  // Under the line, the agent's screen has at least two lines.
  const rule = lines.indexOf("─".repeat(50));
  expect(rule).toBeGreaterThan(0);
  expect(rule).toBeLessThanOrEqual(22 - 3);
  expect(
    lines
      .slice(rule + 1)
      .filter(Boolean)
      .slice(-2),
  ).toEqual(["second", "third"]);
  const stopped = plain(drawPane(row, tall, { note: "Builder not running" }, 50, 22));
  expect(stopped).toContain("Builder not running");
  expect(stopped).toContain("13:40 submitted · 13:52 reviewed · 14:02 submitted");
});

// A merged PR can leave the forge's copy, and its row keeps the link saved for it.
test("a PR no longer in the forge's copy shows the link saved on its row", () => {
  const done: Row = {
    ...row,
    part: "done",
    says: "merged",
    link: "https://github.com/acme/app/pull/43",
  };
  const gone: Details = { ...details, view: { ...details.view, prPage: null } };
  expect(plain(drawPane(done, gone, null, 50, 30))).toContain(
    "PR    #43  https://github.com/acme/app/pull/43",
  );
});
