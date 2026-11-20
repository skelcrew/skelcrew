// The entries for issues, threads and PRs: their lists and pages on the right, and moving
// through them with keys, clicks and the wheel.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "../src/flow/page.ts";
import { drawPage } from "../src/screen/page.ts";
import {
  clickListRow,
  clickRow,
  endTest,
  given,
  home,
  issueUrl,
  onRight,
  open,
  openIssue,
  openList,
  openOnGitHub,
  press,
  read,
  ready,
  right,
  screen,
  seen,
  selected,
  sidebar,
  startTest,
  tabRow,
  terminal,
  tmux,
  type,
  until,
  wheel,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

test("the entries sit between the lead and ACTIVE, counting what their lists have", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  await until(() => /Issues +2/.test(seen()), "the entries");
  const lines = seen()
    .split("\n")
    .map((line) => line.slice(0, sidebar - 1).trimEnd());
  const at = (text: string) => lines.findIndex((line) => line.includes(text));
  // Each count ends two columns before the sidebar's edge.
  expect(lines[at("Issues")]).toBe(`${"    Issues".padEnd(34)}2`);
  expect(lines[at("    Threads")]).toBe(`${"    Threads".padEnd(34)}2`);
  expect(lines[at("PRs")]).toBe(`${"    PRs".padEnd(34)}1`);
  expect(at("◆ lead")).toBeLessThan(at("Issues"));
  expect(at("PRs")).toBeLessThan(lines.indexOf("  Active"));
});

test("the screen's server turns terminal links on, whatever your terminal says it is", async () => {
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-s", "terminal-features").out).toContain("hyperlinks");
});

// What the issue's page says, as drawn from Skelcrew's copy.
const issuePage: Page = {
  title: "Add CSV export",
  facts: [
    ["State", "open"],
    ["Author", "ana"],
    ["Labels", "skelcrew"],
  ],
  body: Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the description`).join("\n"),
};

test("landing on an entry shows its list across the right side, in groups, with no strip", async () => {
  await openList("Issues");
  await onRight("Not started");
  const lines = right().split("\n");
  const at = (text: string) => lines.findIndex((line) => line.includes(text));
  expect(at("Not started")).toBeLessThan(at("app-31"));
  expect(at("app-31")).toBeLessThan(at("Started"));
  expect(lines[at("app-12")]).toContain("◐ app-12  Fix login");
  expect(lines[at("app-12")]?.trimEnd()).toEndWith("working");
  expect(right()).not.toContain("I am lead");
  await until(() => !tabRow().includes("Add CSV"), "no strip");
  expect(tabRow()).toMatch(/app$/);
});

test("an issue's or PR's row reaches your terminal as a link, through both tmux servers", async () => {
  await openList("Issues");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  // tmux gives each link an id of its own, ahead of the url.
  expect(colours).toContain(`;${issueUrl}\x1b\\`);
});

test("Up and Down move in the list, and Enter opens the issue's page, which fills the strip", async () => {
  await openList("Issues");
  press("Down");
  press("Up");
  press("Enter");
  await onRight("line 1 of the description");
  expect(right()).toContain("← back");
  expect(right()).toContain("Author");
  await until(() => tabRow().endsWith("app-31  Add CSV export"), "the strip");
  // The sidebar stays on the entry.
  expect(selected()).toContain("Issues");
});

test("Left goes back from a page to its list, on the row you opened", async () => {
  await openList("Issues");
  press("Down");
  press("Enter");
  await onRight("Fix login");
  await onRight("← back");
  press("Left");
  await onRight("↑↓ move");
  await until(() => !tabRow().includes("Fix login"), "the strip to go");
  press("Enter");
  await onRight("← back");
  expect(right()).toContain("Fix login");
  press("Up");
  press("Left");
  await onRight("↑↓ move");
  press("Up");
  press("Enter");
  await onRight("line 1 of the description");
});

// Right opens as Left goes back, so the arrows alone take you in and out of a list.
test("Right opens the row on each kind of list, as Enter does", async () => {
  await openList("Issues");
  press("Right");
  await onRight("line 1 of the description");
  press("Left");
  await onRight("↑↓ move");
  clickRow("PRs");
  // The issues list says "↑↓ move" too, so wait until its rows have gone, or Right could open an
  // issue before the PRs list draws.
  await until(() => right().includes("Bump deps") && !right().includes("Fix login"), "the PRs");
  press("Right");
  await onRight("Approved. · codex");
  clickRow("    Threads");
  await onRight("Working");
  press("Right");
  await until(() => seen().includes("I am app-12"), "the agent");
});

// Presses Esc, and returns once the screen has read it. tmux holds an Esc about half a second,
// in case it starts a longer key, and a key within that would join it. So ? goes after that, and
// keys arrive in order: once ? shows the keys, the Esc came before it. A second ? hides them.
async function pressEscape(): Promise<void> {
  press("Escape");
  await Bun.sleep(800);
  type("?");
  await until(() => seen().includes("to go back from a page"), "the list of keys");
  type("?");
  await until(() => !seen().includes("to go back from a page"), "the list of keys to hide");
}

// In an agent Esc stops its turn, so Esc going back on a page would teach your hand to reach for
// it to leave an agent too.
test("Esc does nothing on a list or a page", async () => {
  await openList("Issues");
  press("Down");
  await pressEscape();
  expect(right()).toContain("↑↓ move");
  expect(selected()).toContain("Issues");
  press("Enter");
  await onRight("← back");
  await pressEscape();
  expect(right()).toContain("← back");
  expect(right()).toContain("Fix login");
});

test("a click on a row opens it, and a click on its entry goes back to the list", async () => {
  await openList("Issues");
  clickListRow("Add CSV export");
  await onRight("line 1 of the description");
  clickRow("Issues");
  await onRight("↑↓ move");
  expect(right()).toContain("Fix login");
});

test("Enter on a thread in the list of threads shows its agent, and the sidebar moves to its row", async () => {
  await openList("Threads");
  await onRight("Working");
  expect(right()).toContain("app-12");
  press("Enter");
  await until(() => seen().includes("I am app-12"), "the agent");
  await until(() => selected() === "○ 12 app-12", "the sidebar to follow");
  type("from the list\r");
  await until(() => read("app-12.typed").includes("from the list"), "what you typed");
});

test("Alt-Down moves from the lead through the entries, and Alt-Up back puts you in the agent", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  press("M-Down");
  await onRight("Not started");
  expect(selected()).toContain("Issues");
  press("M-Down");
  await onRight("Working");
  press("M-Down");
  await onRight("In review");
  press("M-Down");
  await until(() => seen().includes("I am app-12"), "the first thread");
  press("M-Up");
  await onRight("In review");
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => selected() === "◆ lead", "the lead's row");
  type("straight back\r");
  await until(() => read("lead.typed").includes("straight back"), "what you typed");
});

test("Alt-Shift-Down and Alt-Shift-Up jump between the lead, the entries and ACTIVE", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await onRight("Not started");
  press("M-S-Down");
  await until(() => selected() === "○ 12 app-12", "the first row of ACTIVE");
  await until(() => seen().includes("I am app-12"), "its agent");
  press("M-S-Up");
  await onRight("Not started");
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the lead");
});

test("landing on an entry from elsewhere starts its list on the first row", async () => {
  await openList("Issues");
  press("Down");
  press("M-S-Down");
  await until(() => seen().includes("I am app-12"), "the thread");
  press("M-S-Up");
  await onRight("↑↓ move");
  press("Enter");
  await onRight("line 1 of the description");
});

test("keys pressed together when leaving a list all count, however slowly the client attaches", async () => {
  // A client attaching slowly, as over a slow link, can't be switched yet.
  const real = Bun.which("tmux") ?? "tmux";
  mkdirSync(join(home, "slow"));
  writeFileSync(
    join(home, "slow", "tmux"),
    `#!/bin/sh\ncase "$*" in *" attach "*) sleep 0.4 ;; esac\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  given.before = `PATH=${join(home, "slow")}:$PATH `;
  await openList("PRs");
  type("\x1b[1;3B\x1b[1;3B");
  await until(() => seen().includes("I am app-7"), "the second row's agent");
  await Bun.sleep(1200);
  expect(selected()).toBe("○ 7 app-7");
  expect(seen()).toContain("I am app-7");
});

test("a pane too narrow for a page's lines cuts them, so every line keeps its own row", async () => {
  await openList("Issues", "49");
  press("Enter");
  await onRight("Author");
  const panes = tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");
  // The right side is the second pane, after the sidebar and before the footer.
  const width = Number(panes[1]);
  expect(width).toBeLessThan(11);
  const rows = right().split("\n").slice(2, 20);
  const lines = drawPage(issuePage, issueUrl, width, "click to open").map((line) =>
    Bun.stripANSI(line).slice(0, width).trimEnd(),
  );
  expect(rows.map((row) => row.trimEnd())).toEqual(lines.slice(0, 18));
});

test("a list leaves none of its terminal's modes behind on the agent", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  const modes = () =>
    tmux(screen, "list-panes", "-a", "-F", "#{wrap_flag} #{cursor_flag} #{mouse_any_flag}").out;
  const before = modes();
  press("M-Down");
  await onRight("Not started");
  expect(modes()).not.toBe(before);
  press("M-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  await until(() => modes() === before, "the modes to come back");
});

test("the wheel, Up and Down scroll a page and stop at both ends", async () => {
  await openIssue();
  wheel(65);
  await until(() => !right().includes("State"), "the page to scroll");
  for (let i = 0; i < 30; i++) wheel(65);
  await onRight("line 80 of the description");
  await Bun.sleep(200);
  const atEnd = right();
  press("Down");
  await Bun.sleep(200);
  expect(right()).toBe(atEnd);
  press("Up");
  await until(() => right() !== atEnd, "a key to scroll");
  for (let i = 0; i < 30; i++) wheel(64);
  await onRight("Author");
});

// Ctrl-\ isn't typed here: it leaves the whole screen, as it leaves an agent everywhere.
test("other typing on a list or page goes nowhere, and the agent never gets it", async () => {
  await openIssue();
  const before = right();
  type("not for anyone\r");
  press("C-c");
  press("C-z");
  await Bun.sleep(300);
  expect(right()).toBe(before);
  press("M-S-Up");
  await until(() => seen().includes("I am lead"), "the agent");
  await Bun.sleep(300);
  expect(read("lead.typed")).toBe("");
});

test("Ctrl-C pressed the moment a list opens can't take the right side away", async () => {
  openOnGitHub();
  open("lead");
  await ready("lead");
  const running = () => tmux(screen, "list-panes", "-a", "-F", "#{pane_pid}").out;
  const before = running();
  press("M-Down");
  await until(() => running() !== before, "the pane to start the list");
  for (let i = 0; i < 10; i++) {
    press("C-c");
    await Bun.sleep(10);
  }
  await Bun.sleep(500);
  // The sidebar, the right side and the footer.
  expect(running().trim().split("\n")).toHaveLength(3);
  press("M-Up");
  await until(() => seen().includes("I am lead"), "the lead");
  type("still here\r");
  await until(() => read("lead.typed").includes("still here"), "what you typed");
});
