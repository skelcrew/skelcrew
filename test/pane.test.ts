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
  place: null,
  waits: "",
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
  const lines = drawPane(row, details, { screen: "I am app-12\n› \n\n\n" }, 50, 30).lines;
  expect(lines).toHaveLength(30);
  expect(plain(lines).slice(0, 26)).toEqual([
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
    "client can't starve the others.",
    "",
    "It resets each minute. Clients over it get a 429",
    "with a Retry-After header. The limit is set per",
    "repository.",
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

test("the details take the list's look: bold title, dim labels, verdicts in colour, links", () => {
  const lines = drawPane(row, details, null, 50, 30).lines;
  const esc = "\x1b";
  // Returns the line that reads `text` once its colours are taken off.
  const line = (text: string) => lines.find((drawn) => Bun.stripANSI(drawn).trimEnd() === text);
  expect(line("Rate limit the API")).toBe(`${esc}[1mRate limit the API${esc}[22;39m`);
  // Each link is a terminal link to itself, after a dim label.
  const issue = "https://github.com/acme/app/issues/42";
  expect(line(`issue #42  ${issue}`)).toBe(
    `${esc}[90missue ${esc}[22;39m#42  ${esc}]8;;${issue}${esc}\\${issue}${esc}]8;;${esc}\\`,
  );
  // CI and the review say their verdicts in the list's colours, with each check's mark.
  const yellow = `${esc}[38;5;221m`;
  expect(line("CI running:  test ✓  lint ●  build ✗")).toBe(
    `${esc}[90mCI${esc}[22;39m ${yellow}running${esc}[22;39m:  test ${esc}[38;5;120m✓${esc}[22;39m  lint ${yellow}●${esc}[22;39m  build ${esc}[38;5;210m✗${esc}[22;39m`,
  );
  expect(line("Round 2 · changes asked")).toBe(
    `${esc}[90mRound 2 · ${esc}[22;39m${yellow}changes asked${esc}[22;39m`,
  );
  // The description is dimmer than the rest, and the events dimmer still.
  expect(line("client can't starve the others.")).toStartWith(`${esc}[38;5;250m`);
  expect(line("13:40 submitted · 13:52 reviewed · 14:02 submitted")).toStartWith(`${esc}[90m`);
});

test("a link with control characters in it never reaches your terminal as codes", () => {
  const bad = "https://github.com/acme/app/issues/42\x07\x1b]2;owned\x07";
  const issue = { id: "#42", link: bad };
  const drawn = drawPane(row, { ...details, view: { ...details.view, issue } }, null, 50, 30).lines;
  const text = drawn.join("\n");
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\x1b]2;");
});

test("an approved review and passed CI show green, a failed one red", () => {
  const page = details.view.prPage;
  if (!page) throw new Error("the details have a PR");
  const green = "\x1b[38;5;120m";
  const red = "\x1b[38;5;210m";
  const passed: Details = {
    ...details,
    view: {
      ...details.view,
      review: { state: "approved", round: 3, at: null },
      prPage: { ...page, ci: "passed", checks: [] },
    },
  };
  const drawn = drawPane(row, passed, null, 50, 30).lines;
  expect(drawn).toContain(`\x1b[90mCI${"\x1b[22;39m"} ${green}passed\x1b[22;39m`);
  expect(drawn.find((line) => line.includes("approved"))).toContain(`${green}approved`);
  const failed: Details = {
    ...details,
    view: {
      ...details.view,
      review: { state: "failed", round: 3, at: null },
      prPage: { ...page, ci: "failed", checks: [] },
    },
  };
  const redLines = drawPane(row, failed, null, 50, 30).lines;
  expect(redLines).toContain(`\x1b[90mCI${"\x1b[22;39m"} ${red}failed\x1b[22;39m`);
  expect(redLines.find((line) => line.includes("review failed"))).toContain(`${red}review failed`);
});

test("by default the live view is a strip of the agent's last three lines, the details above it", () => {
  const screen = ["line 1", "", "line 2", "line 3", "", "line 4", "", "› ", "", ""].join("\n");
  const lines = plain(drawPane(row, details, { screen }, 50, 30).lines);
  expect(lines).toHaveLength(30);
  // The details come whole, then the line over the strip, then the last three lines with text.
  const rule = lines.indexOf("─".repeat(50));
  expect(lines.slice(0, rule)).toEqual(
    plain(drawPane(row, details, null, 50, 30).lines).slice(0, rule),
  );
  expect(lines.slice(rule + 1, rule + 4)).toEqual(["line 3", "line 4", "›"]);
  expect(lines.slice(rule + 4)).toEqual(Array(30 - rule - 4).fill(""));
  // In a short pane, the details tighten so the strip keeps its three lines.
  const short = plain(drawPane(row, details, { screen }, 50, 12).lines);
  expect(short.slice(-4)).toEqual(["─".repeat(50), "line 3", "line 4", "›"]);
  expect(short[0]).toBe("Rate limit the API");
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
  const lines = plain(drawPane(row, details, { note: "Builder not running" }, 50, 30).lines);
  expect(lines.slice(lines.indexOf("─".repeat(50)) + 1, -1).filter(Boolean)).toEqual([
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
  const live = lines.slice(lines.indexOf("─".repeat(50)) + 1);
  expect(live).toEqual(Array.from({ length: 9 }, (_, i) => `line ${11 + i}`));
  // Details that fit in half take only what they need.
  const brief: Details = { ...details, findings: [], view: { ...details.view, body: "" } };
  const short = plain(drawPane(row, brief, { screen }, 50, 22, true).lines);
  expect(short.slice(8, 11)).toEqual([
    "13:40 submitted · 13:52 reviewed · 14:02 submitted",
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
  const lines = plain(drawPane(row, long, null, 40, 40).lines);
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
  expect(list(200)).toBe(56);
  // On a terminal not that wide, the list keeps room for a row's name, short title and word.
  expect(list(120)).toBe(40);
  expect(paneWidth(120)).toBe(76);
  // On a very wide one, it stops at what a task's two lines need, and the pane takes the rest.
  expect(list(300)).toBe(58);
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
    "- Count each client's calls per minute,",
    "  in the database rather than in memory",
    "  1. Over the limit, answer 429 with a",
    "     Retry-After header",
    "",
    "The limit is set per repository.",
    "",
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
  // Scrolled above their top, they start at it.
  expect(drawPane(row, tall, { screen }, 50, 22, false, -5).scroll).toBe(0);
  const stopped = plain(drawPane(row, tall, { note: "Builder not running" }, 50, 22).lines);
  expect(stopped.slice(17)).toEqual(["↓ more", "─".repeat(50), "Builder not running", "", ""]);
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
    "PR    #43  https://github.com/acme/app/pull/43",
  );
});

// A queued task says it is up next, its place, and what it waits on, under its title.
test("the pane of a queued task says it is up next and what it waits on", () => {
  const queued: Row = {
    ...row,
    section: "up next",
    mark: { sign: "○", colour: "dim" },
    says: "3rd in line",
    colour: "dim",
    needsYou: false,
    place: 3,
    waits: "3rd in line: 4 of 4 builders busy",
  };
  const waiting: Details = { ...details, view: { ...details.view, prPage: null, pr: null } };
  const lines = plain(drawPane(queued, waiting, null, 50, 30).lines);
  const at = lines.indexOf("Up next · 3rd in line");
  expect(at).toBeGreaterThan(0);
  expect(lines[at + 1]).toBe("3rd in line: 4 of 4 builders busy");
});

// A wait reason wider than the pane wraps, so the claim holding the queue, or the command that
// brings a paused task back, is never cut off.
test("a queued task's wait reason wraps whole in a narrow pane", () => {
  const waits = "2nd in line: app-21 waits for its issue's claim to reach the tracker";
  const queued: Row = { ...row, section: "up next", says: "2nd in line", place: 2, waits };
  const waiting: Details = { ...details, view: { ...details.view, prPage: null, pr: null } };
  const lines = plain(drawPane(queued, waiting, null, 30, 40).lines);
  const at = lines.indexOf("Up next · 2nd in line");
  expect(lines.slice(at + 1, at + 4)).toEqual([
    "2nd in line: app-21 waits for",
    "its issue's claim to reach the",
    "tracker",
  ]);
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
});
