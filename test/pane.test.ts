// The details pane beside the list, as it is drawn: the task's details on top and its agent's live
// screen below, and where it goes beside the list's lines. Drawing reads nothing, so these need
// no terminal and no database.
import { expect, test } from "bun:test";
import type { Details } from "../src/list/details.ts";
import { drawList, type Frame, paneWidth } from "../src/list/layout.ts";
import { drawPane } from "../src/list/pane.ts";
import type { Row } from "../src/list/rows.ts";

// A task at work in Building, whose builder asks a question, so it shows under Needs you.
const row: Row = {
  part: "building",
  section: "needs you",
  name: "app-12",
  label: "12",
  task: "12",
  title: "Rate limit",
  mark: { sign: "●", colour: "yellow" },
  says: "question",
  colour: "yellow",
  step: "",
  pr: "#43",
  ci: "running",
  review: null,
  when: "14:02",
  changed: null,
  needsYou: true,
  session: "app-12",
  running: true,
  working: false,
  tmux: true,
  start: null,
  startNow: null,
  merge: null,
  link: "https://github.com/acme/app/pull/43",
  branch: "skelcrew/12",
  more: 0,
  place: null,
  waits: "",
  ask: {
    title: "Its builder asked a question",
    text: "Should the limit count per user or per key?",
    options: ["Open the builder", "Let the lead handle it"],
    acts: ["open", "lead"],
  },
};

// The box its item shows in, 50 columns wide, without its colours.
const box = [
  `┌${"─".repeat(48)}┐`,
  `│ ${"Its builder asked a question".padEnd(46)} │`,
  `│ ${"".padEnd(46)} │`,
  `│ ${"Should the limit count per user or per key?".padEnd(46)} │`,
  `│ ${"".padEnd(46)} │`,
  `│ ${"a) Open the builder".padEnd(46)} │`,
  `│ ${"b) Let the lead handle it".padEnd(46)} │`,
  `└${"─".repeat(48)}┘`,
];

// Its details, as sc show reads them from Skelcrew's copy, with its review's findings and events.
const details: Details = {
  view: {
    task: "app-12",
    stage: "working",
    title: "Rate limit the API",
    issue: { id: "#42", link: "https://github.com/acme/app/issues/42" },
    threads: [
      { thread: "app-12/builder", status: "working", needsYou: true, needsYouFor: "question" },
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
    notBlocking: [],
    item: null,
    decisions: [],
    mustStayTrue: [],
  },
  findings: [
    "The limit resets per process, not per user",
    "No test covers the header",
    "The 429 has no body",
    "The docs say 100, the code 60",
  ],
  updates: [],
  events: [
    { ago: "40m ago", text: "submitted" },
    { ago: "28m ago", text: "review round 2: changes asked" },
    { ago: "18m ago", text: "submitted" },
  ],
  changed: "2m ago",
  started: "3h ago",
  flow: "default",
  spinner: "",
};

// Returns the pane's lines without their colours, with no spaces at their ends.
const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line).trimEnd());

test("the pane shows a summary card, then the task, then what happened, and the agent below", () => {
  const lines = drawPane(row, details, { screen: "I am app-12\n› \n\n\n" }, 50, 40).lines;
  expect(lines).toHaveLength(40);
  expect(plain(lines)).toEqual([
    "app-12  Rate limit the API                Building",
    "─".repeat(50),
    ...box,
    "",
    "Now      question · 2m ago",
    "Issue    #42",
    "         https://github.com/acme/app/issues/42",
    "PR       #43  https://github.com/acme/app/pull/43",
    "CI       ✓ test  ● lint  ✗ build",
    "Review   r2 · changes asked",
    "         1. The limit resets per process, not per…",
    "         2. No test covers the header",
    "         3. The 429 has no body",
    "         … 1 more",
    "Started  3h ago · default flow",
    "",
    "Task",
    "Add a limit per user to the public API, so one",
    "client can't starve the others.",
    "",
    "It resets each minute. Clients over it get a 429",
    "with a Retry-After header. The limit is set per",
    "repository.",
    "",
    "Activity",
    "40m ago  submitted",
    "28m ago  review round 2: changes asked",
    "18m ago  submitted",
    ...Array(1).fill(""),
    "─".repeat(50),
    "I am app-12",
    "›",
    "",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(50);
  // Shorter details leave the strip at the bottom all the same, and so does a builder not running.
  const brief: Details = { ...details, findings: [], view: { ...details.view, body: "" } };
  const short = plain(drawPane(row, brief, { screen: "I am app-12\n› \n" }, 50, 40).lines);
  expect(short.slice(36)).toEqual(plain(lines).slice(36));
  const stopped = plain(drawPane(row, brief, { note: "Builder not running" }, 50, 40).lines);
  expect(stopped.slice(36, 38)).toEqual(["─".repeat(50), "Builder not running"]);
});

test("the details take the list's look: bold title, stage and verdicts in colour, dim labels, links", () => {
  const lines = drawPane(row, details, null, 50, 40).lines;
  const esc = "\x1b";
  const yellow = `${esc}[38;5;136m`;
  // Returns the line that reads `text` once its colours are taken off.
  const line = (text: string) => lines.find((drawn) => Bun.stripANSI(drawn).trimEnd() === text);
  // The title is bold, and the stage takes the colour of the row's mark, yellow as it needs you.
  expect(lines[0]).toBe(
    `${esc}[1mapp-12  Rate limit the API${esc}[22;39m${" ".repeat(16)}${yellow}Building${esc}[22;39m`,
  );
  // The item is in a box drawn in the colour of the screen's other edges, its title bold.
  expect(line(box[0] ?? "")).toBe(`${esc}[90m${box[0]}${esc}[22;39m`);
  expect(line(box[1] ?? "")).toContain(`${esc}[1mIts builder asked a question${esc}[22;39m`);
  // Its options are plain text, not yellow: the box is what sets the item apart.
  expect(line(box[5] ?? "")).toBe(
    `${esc}[90m│${esc}[22;39m a) Open the builder${" ".repeat(27)} ${esc}[90m│${esc}[22;39m`,
  );
  // Each label is dim, and each link is a terminal link to itself.
  const pr = "https://github.com/acme/app/pull/43";
  expect(line(`PR       #43  ${pr}`)).toBe(
    `${esc}[90mPR       ${esc}[22;39m#43  ${esc}]8;;${pr}${esc}\\${pr}${esc}]8;;${esc}\\`,
  );
  // Each check has its mark in its colour, and the review its round and verdict, as a row shows
  // its round, in the verdict's colour.
  expect(line("CI       ✓ test  ● lint  ✗ build")).toBe(
    `${esc}[90mCI       ${esc}[22;39m${esc}[38;5;34m✓${esc}[22;39m test  ${yellow}●${esc}[22;39m lint  ${esc}[38;5;203m✗${esc}[22;39m build`,
  );
  expect(line("Review   r2 · changes asked")).toBe(
    `${esc}[90mReview   ${esc}[22;39m${yellow}r2 · changes asked${esc}[22;39m`,
  );
  // What the task does now takes the row's word in its colour.
  expect(line("Now      question · 2m ago")).toContain(`${yellow}question${esc}[22;39m`);
});

test("a working builder's stage has a spinner, and a task that needs nothing has no callout", () => {
  const working: Row = {
    ...row,
    section: "building",
    mark: { sign: "○", colour: "bright" },
    ask: null,
  };
  const busy: Details = {
    ...details,
    spinner: "⠙",
    view: {
      ...details.view,
      threads: [
        {
          ...details.view.threads[0],
          thread: "app-12/builder",
          status: "working",
          needsYou: false,
          needsYouFor: null,
        },
      ],
    },
  };
  const lines = drawPane(working, busy, null, 50, 40).lines;
  expect(plain(lines)[0]).toBe("app-12  Rate limit the API              ⠙ Building");
  expect(lines[0]).toContain("\x1b[1m⠙ Building");
  expect(plain(lines)).not.toContain(box[0]);
  expect(plain(lines)[2]).toStartWith("Now ");
});

// The card leaves out each line its task has nothing for: a task of the backlog has no PR, CI,
// review, merge or start yet.
test("the card shows only the lines a task has something for", () => {
  const backlog: Row = {
    ...row,
    part: "backlog",
    section: "backlog",
    says: "",
    step: "",
    needsYou: false,
    ask: null,
  };
  const fresh: Details = {
    ...details,
    findings: [],
    events: [],
    changed: "",
    started: "",
    flow: "",
    view: {
      ...details.view,
      threads: [],
      pr: null,
      prPage: null,
      review: null,
      merge: null,
      issue: null,
    },
  };
  const bare = plain(drawPane(backlog, fresh, null, 50, 40).lines).filter(Boolean);
  expect(bare.slice(0, 3)).toEqual([
    "app-12  Rate limit the API                 Backlog",
    "─".repeat(50),
    "Task",
  ]);
  expect(bare.join("\n")).not.toContain("Activity");
  // An armed merge, a CI with no checks and a step each get their line.
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const armed: Details = {
    ...details,
    view: {
      ...details.view,
      merge: "merges when ready · waiting on its review",
      prPage: { ...page, ci: "passed", checks: [] },
    },
  };
  const stepping: Row = { ...row, says: "working", step: "Editing rows.ts" };
  const lines = plain(drawPane(stepping, armed, null, 50, 40).lines);
  expect(lines).toContain("Now      working · Editing rows.ts · 2m ago");
  expect(lines).toContain("CI       ✓ passed");
  expect(lines).toContain("Merge    merges when ready · waiting on its review");
  // CI with no checks and no verdict says nothing.
  const none: Details = {
    ...details,
    view: { ...details.view, prPage: { ...page, ci: "none", checks: [] } },
  };
  expect(
    plain(drawPane(row, none, null, 50, 40).lines).some((line) => line.startsWith("CI ")),
  ).toBe(false);
});

test("the lead's updates show as dated entries, each wrapped under its text", () => {
  const told: Details = {
    ...details,
    updates: [
      { ago: "2h ago", text: "Use a **sliding** window instead." },
      { ago: "4m ago", text: "Keep the limit per repository, and say so in the docs for the API." },
    ],
  };
  const lines = plain(drawPane(row, told, null, 50, 60).lines);
  const at = lines.indexOf("Updates from the lead (2)");
  expect(lines.slice(at, at + 5)).toEqual([
    "Updates from the lead (2)",
    "2h ago  Use a sliding window instead.",
    "4m ago  Keep the limit per repository, and say so",
    "        in the docs for the API.",
    "",
  ]);
  expect(lines.indexOf("Task")).toBeLessThan(at);
  expect(lines.indexOf("Activity")).toBeGreaterThan(at);
});

test("a link with control characters in it never reaches your terminal as codes", () => {
  const bad = "https://github.com/acme/app/issues/42\x07\x1b]2;owned\x07";
  const issue = { id: "#42", link: bad };
  const drawn = drawPane(row, { ...details, view: { ...details.view, issue } }, null, 50, 30).lines;
  const text = drawn.join("\n");
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\x1b]2;");
});

// CI with no checks to list shows the mark a row shows, then its word, so it reads without colour.
test("an approved review and passed CI show green, a failed one red", () => {
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const green = "\x1b[38;5;34m";
  const red = "\x1b[38;5;203m";
  const passed: Details = {
    ...details,
    view: {
      ...details.view,
      review: { state: "approved", round: 3, at: null },
      prPage: { ...page, ci: "passed", checks: [] },
    },
  };
  const drawn = drawPane(row, passed, null, 50, 40).lines;
  expect(drawn).toContain(`\x1b[90mCI       \x1b[22;39m${green}✓ passed\x1b[22;39m`);
  expect(drawn.find((line) => line.includes("approved"))).toContain(`${green}r3 · approved`);
  const failed: Details = {
    ...details,
    view: {
      ...details.view,
      review: { state: "failed", round: 3, at: null },
      prPage: { ...page, ci: "failed", checks: [] },
    },
  };
  const redLines = drawPane(row, failed, null, 50, 40).lines;
  expect(redLines).toContain(`\x1b[90mCI       \x1b[22;39m${red}✗ failed\x1b[22;39m`);
  expect(redLines.find((line) => line.includes("review failed"))).toContain(
    `${red}r3 · review failed`,
  );
  // CI still running is yellow, with the mark a row shows while it runs.
  const running: Details = {
    ...details,
    view: { ...details.view, prPage: { ...page, ci: "running", checks: [] } },
  };
  expect(plain(drawPane(row, running, null, 50, 40).lines)).toContain("CI       ● running");
});

test("by default the live view is a strip of the agent's last three lines, the details above it", () => {
  const screen = ["line 1", "", "line 2", "line 3", "", "line 4", "", "› ", "", ""].join("\n");
  const lines = plain(drawPane(row, details, { screen }, 50, 30).lines);
  expect(lines).toHaveLength(30);
  // The details come whole, then the line over the strip, then the last three lines with text.
  const rule = lines.lastIndexOf("─".repeat(50));
  expect(lines.slice(0, rule - 1)).toEqual(
    plain(drawPane(row, details, null, 50, 30).lines).slice(0, rule - 1),
  );
  expect(lines[rule - 1]).toBe("↓ more");
  expect(lines.slice(rule + 1, rule + 4)).toEqual(["line 3", "line 4", "›"]);
  expect(lines.slice(rule + 4)).toEqual(Array(30 - rule - 4).fill(""));
  // In a short pane, the details tighten so the strip keeps its three lines.
  const short = plain(drawPane(row, details, { screen }, 50, 12).lines);
  expect(short.slice(-4)).toEqual(["─".repeat(50), "line 3", "line 4", "›"]);
  expect(short[0]).toStartWith("app-12  Rate limit the API");
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
  const lines = drawPane(row, details, { screen }, 40, 30, true).lines;
  const live = lines.slice(lines.findLastIndex((line) => line.includes("───")) + 1);
  expect(plain(live).slice(-3)).toEqual([
    "line 39",
    `red words and ${"0123456789".repeat(3).slice(0, 26)}`,
    "a linkdone",
  ]);
  // Its colour is kept, and reset at the line's end, so it never reaches the next line.
  const red = live.find((line) => line.includes("red words")) ?? "";
  expect(red).toStartWith("\x1b[31mred words");
  expect(red).toEndWith("\x1b[0m");
  expect(live.join("")).not.toContain("\x1b]8");
  expect(live.join("")).not.toContain("\x1b[2J");
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
  const lines = drawPane(row, details, { screen }, 50, 30, true).lines;
  const live = lines.slice(lines.findLastIndex((line) => line.includes("───")) + 1);
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
  const lines = plain(drawPane(row, details, { note: "Builder not running" }, 50, 30).lines);
  expect(lines.slice(lines.lastIndexOf("─".repeat(50)) + 1, -1).filter(Boolean)).toEqual([
    "Builder not running",
  ]);
  const lead: Row = { ...row, part: "lead", name: "lead", task: null };
  expect(plain(drawPane(lead, null, null, 50, 30).lines)).toEqual(Array(30).fill(""));
});

// A terminal 24 lines tall leaves the pane 22. While it shows the agent's whole screen, the
// details take half of it at most, and the agent's screen the rest.
test("with the agent's whole screen, the details take half the pane, and the screen the rest", () => {
  const screen = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const lines = plain(drawPane(row, details, { screen }, 50, 22, true).lines);
  expect(lines).toHaveLength(22);
  expect(lines.slice(0, 11)).toEqual([
    ...plain(drawPane(row, details, null, 50, 22).lines).slice(0, 10),
    "↓ more",
  ]);
  // What is left under the line shows the bottom of the agent's screen.
  const live = lines.slice(lines.lastIndexOf("─".repeat(50)) + 1);
  expect(live).toEqual(Array.from({ length: 9 }, (_, i) => `line ${11 + i}`));
  // Details that fit in half take only what they need.
  const brief: Details = {
    ...details,
    events: [],
    view: { ...details.view, body: "", issue: null, pr: null, prPage: null, review: null },
  };
  const short = plain(drawPane({ ...row, ask: null }, brief, { screen }, 50, 22, true).lines);
  expect(short.slice(2, 6)).toEqual([
    "Now      question · 2m ago",
    "Started  3h ago · default flow",
    "",
    "─".repeat(50),
  ]);
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
  const lines = plain(drawPane({ ...row, ask: null }, long, null, 40, 40).lines);
  expect(lines.slice(0, 3)).toEqual([
    "app-12  Rate limit the public   Building",
    "API per user, so one client can never",
    "starve all the others",
  ]);
  expect(lines.slice(5, 15)).toEqual([
    "Issue    #42",
    "         https://github.com/acme/app/iss",
    "         ues/42",
    "PR       #43",
    "         https://github.com/a-long-organ",
    "         isation/a-long-repository-name/",
    "         pull/12345",
    "CI       ✓ test  ✓ lint  ✓ build",
    "         ✓ typecheck  ✓ e2e on linux",
    "         ✗ e2e on macos",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});

// What the list shows besides its rows.
const frame: Frame = {
  versions: ["0.6.0"],
  where: "",
  name: "app",
  tabs: [{ name: "app", fullName: "simon/app", needYou: 0, colour: "yellow", ready: 0 }],
  notice: "",
  bottom: "↑↓ move",
  load: "cpu 12%",
};

test("the list takes a little over a quarter of the terminal, and the pane the rest", () => {
  // Returns how wide the list's rows are beside the pane, past the line between them.
  const list = (width: number) => width - 1 - paneWidth(width) - 3;
  expect(list(160)).toBe(44);
  // On a terminal not that wide, the list keeps room for a row's name, short title and word.
  expect(list(120)).toBe(40);
  expect(paneWidth(120)).toBe(76);
  // On a very wide one, it stops at what a busy task's second line needs, and the pane takes the rest.
  expect(list(300)).toBe(48);
  // A terminal too narrow for both shows no pane.
  expect(paneWidth(113)).toBe(0);
  expect(paneWidth(114)).toBe(70);
});

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

// The description of an issue, with paragraphs, a list and a line too long for the pane.
const written = [
  "Add a limit per user to the public API.",
  "",
  "",
  "Steps:",
  "- Count each client's calls per minute, in the database rather than in memory",
  "  1. Over the limit, answer 429 with a Retry-After header",
  "",
  "The limit is set per repository.",
].join("\n");

test("the description shows whole, its lines kept and long ones wrapped under their list item", () => {
  const described: Details = { ...details, view: { ...details.view, body: written } };
  const lines = plain(drawPane(row, described, null, 40, 40).lines);
  const from = lines.indexOf("Add a limit per user to the public API.");
  expect(lines.slice(from, from + 10)).toEqual([
    "Add a limit per user to the public API.",
    "",
    "Steps:",
    "",
    "- Count each client's calls per minute,",
    "  in the database rather than in memory",
    "  1. Over the limit, answer 429 with a",
    "     Retry-After header",
    "",
    "The limit is set per repository.",
  ]);
  expect(lines).not.toContain("…");
});

// Details far taller than the pane, from a long description and many checks.
test("details taller than the pane scroll, say there is more below, and leave the strip in place", () => {
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const checks = Array.from({ length: 60 }, (_, i) => ({
    name: `check-${i}`,
    state: "passed" as const,
    log: null,
  }));
  const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
  const tall: Details = {
    ...details,
    view: { ...details.view, body, prPage: { ...page, checks } },
  };
  const screen = "first\nsecond\nthird";
  const whole = plain(drawPane(row, tall, null, 50, 500).lines).filter((_, i, all) =>
    all.slice(i).some(Boolean),
  );
  // At the top, the details show from their title, and their last line says there is more.
  const top = drawPane(row, tall, { screen }, 50, 22);
  const lines = plain(top.lines);
  expect(top.scroll).toBe(0);
  expect(top.room).toBe(18);
  expect(lines.slice(0, 17)).toEqual(whole.slice(0, 17));
  expect(lines[17]).toBe("↓ more");
  expect(lines.slice(18)).toEqual(["─".repeat(50), "first", "second", "third"]);
  // Scrolled, they show from further down, and the strip stays where it was.
  const down = plain(drawPane(row, tall, { screen }, 50, 22, false, 20).lines);
  expect(down.slice(0, 18)).toEqual([...whole.slice(20, 37), "↓ more"]);
  expect(down.slice(18)).toEqual(lines.slice(18));
  // Scrolled past their end, they stop at it, with nothing more below.
  const end = drawPane(row, tall, { screen }, 50, 22, false, 1000);
  expect(end.scroll).toBe(whole.length - 18);
  expect(plain(end.lines).slice(0, 18)).toEqual(whole.slice(-18));
  expect(plain(end.lines).slice(18)).toEqual(lines.slice(18));
  // With room for a single line, it shows the details, a line each way you scroll.
  const tiny = (scroll: number) =>
    plain(drawPane(row, tall, { screen }, 50, 5, false, scroll).lines)[0];
  expect([0, 1, 2].map(tiny)).toEqual(whole.slice(0, 3));
  // Scrolled above their top, they start at it.
  expect(drawPane(row, tall, { screen }, 50, 22, false, -5).scroll).toBe(0);
  const stopped = plain(drawPane(row, tall, { note: "Builder not running" }, 50, 22).lines);
  expect(stopped.slice(17)).toEqual(["↓ more", "─".repeat(50), "Builder not running", "", ""]);
});

// Text in the details can look like an option: the builder's screen, a quote in the task's
// description, or the item's own question. Only the item's option lines count, while they show.
test("the pane counts only the item's option lines it shows, never text that looks like one", () => {
  const body = ["> a) yes", ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`)].join(
    "\n\n",
  );
  const tall: Details = { ...details, view: { ...details.view, body } };
  const asking: Row = row.ask
    ? { ...row, ask: { ...row.ask, text: "a) per user, or per key?" } }
    : row;
  const live = { screen: "│ a) yes\n│ b) no" };
  const at = (scroll: number) => drawPane(asking, tall, live, 50, 22, false, scroll);
  expect(at(0).picks).toEqual(["a", "b"]);
  const quoted = plain(drawPane(asking, tall, null, 50, 500).lines).indexOf("│ a) yes");
  expect(quoted).toBeGreaterThan(0);
  const past = at(quoted - 1);
  expect(plain(past.lines)).toContain("│ a) yes");
  expect(past.picks).toEqual([]);
  const question = plain(at(0).lines).findIndex((line) => line.includes("a) per user"));
  const options = plain(at(0).lines).findIndex((line) => line.includes("a) Open the builder"));
  expect(at(options + 1).picks).toEqual(["b"]);
  expect(at(options + 2).picks).toEqual([]);
  const alone = drawPane(asking, tall, null, 50, 1, false, question);
  expect(plain(alone.lines)).toEqual([`│ ${"a) per user, or per key?".padEnd(46)} │`]);
  expect(alone.picks).toEqual([]);
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
  expect(plain(drawPane(done, gone, null, 50, 30).lines)).toContain(
    "PR       #43  https://github.com/acme/app/pull/43",
  );
});

// A queued task says it is in the task queue, and what it waits on is what it does now.
test("the pane of a queued task says it is in the task queue and what it waits on", () => {
  const queued: Row = {
    ...row,
    section: "task queue",
    mark: { sign: "○", colour: "dim" },
    says: "3rd in line",
    colour: "dim",
    needsYou: false,
    place: 3,
    waits: "3rd in line: 4 of 4 builders busy",
  };
  const waiting: Details = { ...details, view: { ...details.view, prPage: null, pr: null } };
  const lines = plain(drawPane(queued, waiting, null, 60, 30).lines);
  expect(lines[0]).toBe("app-12  Rate limit the API                        Task queue");
  expect(lines).toContain("Now      3rd in line: 4 of 4 builders busy · 2m ago");
});

// A wait reason wider than the pane wraps, so the claim holding the queue, or the command that
// brings a paused task back, is never cut off.
test("a queued task's wait reason wraps whole in a narrow pane", () => {
  const waits = "2nd in line: app-21 waits for its issue's claim to reach the tracker";
  const queued: Row = { ...row, section: "task queue", says: "2nd in line", place: 2, waits };
  const waiting: Details = { ...details, view: { ...details.view, prPage: null, pr: null } };
  const lines = plain(drawPane(queued, waiting, null, 30, 40).lines);
  const at = lines.findIndex((line) => line.startsWith("Now "));
  expect(lines.slice(at, at + 4)).toEqual([
    "Now      2nd in line: app-21",
    "         waits for its issue's",
    "         claim to reach the",
    "         tracker · 2m ago",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
});

// A description written in markdown, as the lead and the trackers write them.
const markdown = [
  "## What to build",
  "",
  "Add a **per-user** limit to the `public` API,",
  "counted in the database.",
  "",
  "1. Count each call",
  "2. Answer 429 over the limit",
  "",
  "```",
  "limit: 60",
  "```",
].join("\n");

test("the task's description shows as markdown, without its raw marks", () => {
  const described: Details = { ...details, view: { ...details.view, body: markdown } };
  const lines = drawPane(row, described, null, 60, 50).lines;
  const from = plain(lines).indexOf("Task");
  expect(plain(lines).slice(from, from + 10)).toEqual([
    "Task",
    "What to build",
    "",
    "Add a per-user limit to the public API, counted in the",
    "database.",
    "",
    "1. Count each call",
    "2. Answer 429 over the limit",
    "",
    "  limit: 60",
  ]);
  // The heading and the bold words are bold, and the inline code dim.
  expect(lines[from + 1]).toBe("\x1b[1mWhat to build\x1b[22m");
  expect(lines[from + 3]).toContain("\x1b[1mper-user\x1b[22m");
  expect(lines[from + 3]).toContain("\x1b[90mpublic\x1b[39m");
  expect(plain(lines).join("\n")).not.toMatch(/##|\*\*|`/);
});

// In a wide pane, the card and the timeline take its width, and the text no more than 80 columns.
test("the task, the lead's updates and the findings wrap at 80 columns in a wide pane", () => {
  const long = "Every client gets its own limit, counted over a sliding minute. ".repeat(4);
  const wide: Details = {
    ...details,
    findings: [long],
    updates: [{ ago: "4m ago", text: long }],
    view: {
      ...details.view,
      body: long,
      merge: `merges when ready · ${"waiting on its review ".repeat(4)}`,
    },
  };
  const lines = plain(drawPane(row, wide, null, 120, 60).lines);
  const at = (name: string) => lines.indexOf(name);
  const text = [
    ...lines.slice(at("Task") + 1, at("Updates from the lead (1)") - 1),
    ...lines.slice(at("Updates from the lead (1)") + 1, at("Activity") - 1),
  ];
  expect(text.length).toBeGreaterThan(6);
  for (const line of text) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(Math.max(...text.map((line) => Bun.stringWidth(line)))).toBeGreaterThan(70);
  // A finding is cut at 80 columns, on one line.
  const finding = lines.find((line) => line.includes("1. Every client")) ?? "";
  expect(Bun.stringWidth(finding)).toBe(80);
  expect(finding).toEndWith("…");
  // The card's lines and the line under the title take the pane's width.
  expect(Bun.stringWidth(lines.find((line) => line.startsWith("Merge")) ?? "")).toBeGreaterThan(80);
  expect(lines[1]).toBe("─".repeat(120));
});

test("a code block's first line keeps its indent, and a long link wraps inside a narrow pane", () => {
  const code = ["```", "  indented", "  as well", "```"].join("\n");
  const coded: Details = { ...details, view: { ...details.view, body: code } };
  const lines = plain(drawPane(row, coded, null, 50, 50).lines);
  const from = lines.indexOf("Task");
  expect(lines.slice(from + 1, from + 3)).toEqual(["    indented", "    as well"]);
  // A link too long for the pane breaks over lines, and one whose text differs shows its address.
  const body = "<https://example.com/a/long/path> and [the docs](https://example.com/docs)";
  const linked: Details = { ...details, view: { ...details.view, body } };
  const narrow = plain(drawPane(row, linked, null, 20, 80).lines);
  for (const line of narrow) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
  const task = narrow.slice(narrow.indexOf("Task") + 1, narrow.indexOf("Activity") - 1);
  expect(task).toEqual([
    "https://example.com/",
    "a/long/path and the",
    "docs (https://exampl",
    "e.com/docs)",
  ]);
});

test("a check too long for the card has its name cut, and keeps its mark's colour", () => {
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const name = "end-to-end tests on every supported browser";
  const long: Details = {
    ...details,
    view: { ...details.view, prPage: { ...page, checks: [{ name, state: "failed", log: null }] } },
  };
  const lines = drawPane(row, long, null, 30, 40).lines;
  const ci = lines.find((line) => Bun.stripANSI(line).startsWith("CI ")) ?? "";
  expect(Bun.stripANSI(ci)).toBe("CI       ✗ end-to-end tests o…");
  expect(ci).toContain("\x1b[38;5;203m✗\x1b[22;39m");
});

test("a task list keeps its boxes, and an image shows its alt text and address", () => {
  const body = [
    "- [ ] Deploy it to every one of the servers",
    "- [x] Test",
    "",
    "![diagram](https://example.com/d.png)",
  ].join("\n");
  const listed: Details = { ...details, view: { ...details.view, body } };
  const lines = plain(drawPane(row, listed, null, 40, 60).lines);
  const from = lines.indexOf("Task");
  expect(lines.slice(from + 1, from + 6)).toEqual([
    "- [ ] Deploy it to every one of the",
    "      servers",
    "- [x] Test",
    "",
    "diagram (https://example.com/d.png)",
  ]);
});

// A task approved and green waits on you to merge it, though its thread needs you for nothing
// else.
test("a task ready to merge says so in its box, with what each option does", () => {
  const ready: Row = {
    ...row,
    part: "ready",
    section: "needs you",
    mark: { sign: "●", colour: "green" },
    says: "ready to merge",
    colour: "green",
    needsYou: false,
    ask: {
      title: "Ready to merge",
      text: "#43 is ready at abcdef1 and its checks passed.",
      options: ["Merge it", "Not yet"],
      acts: ["merge", "lead"],
    },
  };
  const lines = plain(drawPane(ready, details, null, 50, 40).lines);
  expect(lines.slice(2, 10)).toEqual([
    `┌${"─".repeat(48)}┐`,
    `│ ${"Ready to merge".padEnd(46)} │`,
    `│ ${"".padEnd(46)} │`,
    `│ ${"#43 is ready at abcdef1 and its checks passed.".padEnd(46)} │`,
    `│ ${"".padEnd(46)} │`,
    `│ ${"a) Merge it".padEnd(46)} │`,
    `│ ${"b) Not yet".padEnd(46)} │`,
    `└${"─".repeat(48)}┘`,
  ]);
  // A task ready and waiting on nothing of yours, such as one whose merge is armed, has none.
  const armed: Row = { ...ready, section: "ready", says: "merges when ready", ask: null };
  expect(plain(drawPane(armed, details, null, 50, 40).lines)[2]).toStartWith("Now ");
});

// An item's whole text and options wrap inside its box on a narrow pane, never cut and never past
// its edge.
test("an item's text and options wrap inside its box", () => {
  const long: Row = {
    ...row,
    ask: {
      title: "Pi sign-ins expire",
      text: "Pi's sign-in lasts a day, so a builder on Pi stops each morning until someone signs in again.",
      options: ["Sign in again each morning (recommended)", "Move the Pi builders to Claude"],
      acts: null,
    },
  };
  const lines = plain(drawPane(long, details, null, 30, 40).lines);
  const top = lines.indexOf(`┌${"─".repeat(28)}┐`);
  const bottom = lines.indexOf(`└${"─".repeat(28)}┘`);
  const inside = lines.slice(top + 1, bottom);
  for (const line of inside) {
    expect(Bun.stringWidth(line)).toBe(30);
    expect(line).toStartWith("│ ");
    expect(line).toEndWith(" │");
  }
  const text = inside.map((line) => line.slice(2, -2).trim());
  expect(text.join(" ").replace(/\s+/g, " ")).toContain(
    "Pi's sign-in lasts a day, so a builder on Pi stops each morning until someone signs in again.",
  );
  expect(text).toContain("a) Sign in again each");
  expect(text).toContain("morning (recommended)");
  expect(text).toContain("b) Move the Pi builders to");
  expect(text).toContain("r) reply");
});

// Returns the styles on at the first place `word` shows in a line: bold, italic, struck and dim,
// as the codes before it turned them on and off.
function stylesAt(line: string, word: string): string[] {
  const on = new Set<string>();
  const codes: Record<string, [string, boolean]> = {
    "1": ["bold", true],
    "22": ["bold", false],
    "3": ["italic", true],
    "23": ["italic", false],
    "9": ["struck", true],
    "29": ["struck", false],
    "90": ["dim", true],
    "39": ["dim", false],
  };
  const before = line.slice(0, line.indexOf(word));
  for (const [, numbers = ""] of before.matchAll(new RegExp(`${"\x1b"}\\[([0-9;]*)m`, "g")))
    for (const number of numbers.split(";")) {
      const [name, set] = codes[number] ?? [];
      if (name) set ? on.add(name) : on.delete(name);
    }
  return [...on].sort();
}

// Each case nests one span in another, then ends the inner one before `tail`, which must keep
// the outer style alone, and `inner` both.
test.each([
  ["# **inner** tail", ["bold"], ["bold"]],
  ["# `inner` tail", ["bold", "dim"], ["bold"]],
  ["**`inner` tail**", ["bold", "dim"], ["bold"]],
  ["**[inner](https://example.com) tail**", ["bold"], ["bold"]],
  ["**[inner `x`](https://example.com) tail**", ["bold"], ["bold"]],
  ["*inner **bold** tail*", ["italic"], ["italic"]],
  ["~~**inner** tail~~", ["bold", "struck"], ["struck"]],
  ["***inner** tail*", ["bold", "italic"], ["italic"]],
  ["**a *inner* tail**", ["bold", "italic"], ["bold"]],
] as const)(
  "nested markdown keeps the outer style after the inner one ends: %s",
  (written, inner, tail) => {
    const described: Details = { ...details, view: { ...details.view, body: written } };
    const lines = drawPane(row, described, null, 60, 40).lines;
    const line = lines.find((drawn) => Bun.stripANSI(drawn).includes("tail")) ?? "";
    expect(stylesAt(line, "inner")).toEqual([...inner]);
    expect(stylesAt(line, "tail")).toEqual([...tail]);
  },
);
