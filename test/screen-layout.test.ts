// How the screen is laid out: the sidebar's width and the boxes round the two sides at every
// size, the top row, and the footer with its keys and load.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { panes, sidebarFor } from "../src/screen/screen.ts";
import {
  attachTo,
  click,
  endTest,
  fixedLoad,
  footer,
  given,
  home,
  noteRefreshes,
  onLead,
  open,
  press,
  read,
  ready,
  screen,
  screenSessions,
  scrolledBack,
  seen,
  selected,
  sidebar,
  sidebarRefreshedTwice,
  sql,
  startTest,
  terminal,
  tmux,
  toSecondThread,
  type,
  until,
} from "./screen.ts";

// Longer than the screen's waits, so a test that fails says what it waited for.
setDefaultTimeout(20_000);
beforeEach(startTest);
afterEach(endTest);

// The widths of the pad at the left, the sidebar, the right side, the pad at the right and the
// footer, as tmux has them.
const widths = () => tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");

test("resizing the terminal resizes the agent, and the sidebar with the list's rule", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "27 77\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "37 105\n",
    "the agent to resize",
  );
  expect(widths()).toEqual(["1", "40", "105", "1", "150"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  await toSecondThread();
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "6");
  await until(() => selected().includes("APP-7"), "the sidebar to scroll");
});

test("on a narrow terminal the sidebar narrows, so the right side keeps half of it", async () => {
  open("lead", "one", "xterm-256color", "80");
  await ready("lead");
  await until(() => widths()[1] === "37", "the sidebar to take what is left");
  expect(widths()).toEqual(["1", "37", "38", "1", "80"]);
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "100", "-y", "30");
  await until(() => widths()[1] === "38", "the sidebar to widen with the terminal");
  expect(widths()).toEqual(["1", "38", "57", "1", "100"]);
  // Both boxes stay whole, at the sidebar's new width.
  await until(() => boxesWhole(30, 100), "the boxes");
});

// Returns whether the boxes round the two sides are whole on a screen `height` rows high and
// `width` wide: on each row, the lines at the sidebar's left, between the two sides and at the
// right side's right, ┬ on the top row and ┴ on tmux's line above the footer. The sidebar is as
// wide as the list on a terminal `width` columns wide, or narrower, so the right side keeps half
// of it, and the line the sides share is right after it.
const boxesWhole = (height: number, width = 120) => {
  const lines = seen()
    .split("\n")
    .slice(0, height - 1);
  const at = (line: string) => `${line[1]}${line[sidebarFor(width)]}${line[width - 2]}`;
  return lines.every((line, row) => {
    const shown = at(line);
    if (row === 0) return shown === "┬┬┬";
    if (row === height - 2) return shown === "┴┴┴";
    return shown === "│││";
  });
};

test("each side has a whole box, from the top row to the line above the footer, and the agent starts right inside its own", async () => {
  open("lead");
  await ready("lead");
  await until(() => boxesWhole(30), "the boxes");
  expect(seen().split("\n")[1]?.indexOf("I am lead")).toBe(sidebar + 1);
  // Past the corners, the top row and the line above the footer reach the terminal's edges.
  for (const row of [0, 28]) {
    const line = seen().split("\n")[row] ?? "";
    expect(`${line[0]}${line[119]}`).toBe("──");
  }
});

test("the boxes stay whole however the terminal is resized", async () => {
  open("lead");
  await ready("lead");
  for (const [width, height] of [
    [150, 40],
    [100, 20],
    [121, 21],
    [120, 30],
    [80, 24],
  ]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", `${width}`, "-y", `${height}`);
    // Right after a resize you can see the old frame, cut to the new size.
    const whole = () =>
      boxesWhole(height ?? 0, width) &&
      seen().split("○ lead").length === 2 &&
      seen().includes("⌥Q quit");
    await until(whole, "the boxes to be whole");
  }
});

test("the sidebar is whole after the terminal goes narrower than it and straight back", async () => {
  open("lead");
  await ready("lead");
  for (let turn = 0; turn < 5; turn++) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "20", "-y", "30");
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  }
  // Right after a resize you can see the old frame, cut to the new size.
  await until(
    () => boxesWhole(30) && seen().split("○ lead").length === 2,
    "the sidebar to be whole",
  );
  expect(onLead()).toBe(true);
});

test("a terminal a few lines high still shows the agent, and Ctrl-Q still leaves", async () => {
  noteRefreshes();
  open("lead");
  await ready("lead");
  for (const height of ["4", "3", "2", "1"]) {
    tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", height);
    // The screen learns the terminal's new height a moment later, through the client in it.
    // Its window never goes under three lines, so below four lines its panes see no change.
    // The sidebar refreshing twice from then on shows the screen still at work at this height:
    // the first may have started before.
    await until(
      () => tmux(screen, "list-clients", "-F", "#{client_height}").out.trim() === height,
      `the screen to be ${height} lines high`,
    );
    await sidebarRefreshedTwice();
    expect(screenSessions()).toHaveLength(1);
  }
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  await until(() => seen().includes("I am lead"), "the agent to come back");
  await until(() => seen().includes("⌥↑↓ move"), "the footer to come back");
  press("C-q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
});

// An agent writes its size again on each resize, emptying its file for a moment, so each size
// is waited for. The lead's is taken once it matches the right side, as the footer sizes its own
// pane after the screen opens. A height that changed as you switch never comes, and the wait
// fails.
test("the agent's height stays as you switch", async () => {
  open("lead");
  await ready("lead");
  const rightSide = () =>
    tmux(
      screen,
      "display",
      "-p",
      "-t",
      `=${screenSessions()[0]}:.${panes.right}`,
      "#{pane_height}",
    ).out.trim();
  const heightOf = (file: string) => read(file).split(" ")[0] ?? "";
  await until(() => heightOf("lead.size") === rightSide(), "the lead at the right side's height");
  const height = heightOf("lead.size");
  await toSecondThread();
  await until(() => heightOf("app-7.size") === height, "app-7 at the lead's height");
  press("M-Up");
  await attachTo("app-12");
  await until(() => heightOf("app-12.size") === height, "app-12 at the lead's height");
});

// The row above the footer, as you see it.
const aboveFooter = () => (seen().split("\n")[28] ?? "").trimEnd();

test("the footer runs across the screen under the boxes' line, with where you type, move and quit, then what Esc stops", async () => {
  sql("UPDATE threads SET harness = 'codex' WHERE task = 7");
  open("lead");
  await ready("lead");
  const lead = "  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit  Esc stops claude";
  await until(() => footer() === lead, "the lead's footer");
  expect(aboveFooter()).toMatch(/^─┴─+┴─+┴─$/);
  expect(aboveFooter()).toHaveLength(120);
  press("M-S-Down");
  await until(
    () =>
      footer() ===
      "  ↑↓ move  ⏎ attach  ⇧⏎/a full screen · o output · pgup/pgdn scroll  1-6 stages  ⌥Q quit",
    "a task's footer",
  );
  press("M-Down");
  await attachTo("app-7");
  await until(
    () => footer() === "  typing to APP-7 · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit  Esc stops codex",
    "app-7's footer",
  );
});

test("a pinned load sits at the right end of the footer", async () => {
  open("lead");
  await ready("lead");
  // The lead's harness reaches the footer a moment after the lead starts, so the load can show
  // before what Esc stops does. Wait for both, then check they sit on the row together.
  const lead = "  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit  Esc stops claude";
  await until(() => footer() === lead, "the lead's footer");
  await until(() => (seen().split("\n")[29] ?? "").trimEnd().endsWith(fixedLoad), "the load");
  expect(footer()).toBe(lead);
});

test("the footer ends with the machine's own load, even with no thread working", async () => {
  given.before = "SKELCREW_FIXED_LOAD= ";
  sql("UPDATE threads SET status = 'waiting' WHERE status = 'working'");
  open("lead");
  await ready("lead");
  // The load shows from its second sample, 5 seconds after the footer starts.
  await until(
    () => /cpu \d+% {2}mem [\d.]+\/\d+G *$/.test(seen().split("\n")[29] ?? ""),
    "the load",
  );
  expect(seen()).not.toContain(fixedLoad);
  expect(footer()).toBe("  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit  Esc stops claude");
});

test("the header and the tabs share one row, and the agent starts right under it", async () => {
  open("lead");
  await ready("lead");
  await toSecondThread();
  const lines = seen().split("\n");
  // Skelcrew in the top of the sidebar's box, and the tab in the top of the agent's, with only
  // line after it.
  expect(lines[0]?.trimEnd()).toMatch(/^─┬─ Skelcrew .* ─┬ {2}app {2}─+┬─$/);
  // The open tab's grey starts where the agent's text does, with its name two columns in.
  expect(lines[0]?.indexOf("app")).toBe((lines[1]?.indexOf("I am") ?? 0) + 2);
  expect(lines[1]).toContain("I am app-7");
});

// Puts a git ahead of the real one that says the checkout is at `commit`, with `changes` not
// committed, and is the real one for everything else.
function checkoutAt(commit: string, changes = ""): void {
  const real = Bun.which("git") ?? "git";
  mkdirSync(join(home, "checkout"));
  const answers = `case "$*" in *"rev-parse --short HEAD"*) echo ${commit};; *"status --porcelain"*) echo "${changes}";; *) exec ${real} "$@";; esac`;
  writeFileSync(join(home, "checkout", "git"), `#!/bin/sh\n${answers}\n`, { mode: 0o755 });
  given.before = `PATH=${join(home, "checkout")}:$PATH `;
}

// The header, as it reads in the top of the sidebar's box, without the box's line around it, in a
// terminal `width` columns wide.
const header = (window = "one", width = 120) =>
  (seen(window).split("\n")[0] ?? "")
    .slice(2, sidebarFor(width))
    .replace(/^─ /, "")
    .replace(/ ─*$/, "");

test("above the sidebar it says Skelcrew, in white, and the checkout's commit when no laptop sent you here", async () => {
  checkoutAt("6f1c2ab");
  open("lead");
  await ready("lead");
  await until(() => header() === "Skelcrew 6f1c2ab (checkout)", "the header");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  const topRow = colours.split("\n")[0];
  expect(topRow).toContain("\x1b[1m");
  expect(topRow).toContain("38;5;231m");
});

// git gives a longer commit in a repository with many, or with core.abbrev set. In a terminal
// wide enough for the sidebar's widest, 58 columns, the header has room for 44 columns after the
// name. Words around the commit give way, never the commit.
const roomy = 210;
test.each([
  ["a6bfe6f", " M src/main.ts", "a6bfe6f* (checkout, * = uncommitted changes)"],
  ["a6bfe6fe12", " M src/main.ts", "checkout a6bfe6fe12+changes"],
  ["a6bfe6fe1234567890", "", "a6bfe6fe1234567890 (checkout)"],
  ["a6bfe6fe1234567890a6bfe6fe1234567890abcd", "", "a6bfe6fe1234567890a6bfe6fe1234567890abcd"],
  // Too long to show with +changes, it keeps a * for them, rather than look clean.
  [
    "a6bfe6fe1234567890a6bfe6fe1234567890abcd",
    " M src/main.ts",
    "a6bfe6fe1234567890a6bfe6fe1234567890abcd*",
  ],
])("commit %p with changes %p shows above the sidebar as %p", async (commit, changes, shown) => {
  checkoutAt(commit, changes);
  open("lead", "one", "xterm-256color", String(roomy));
  await ready("lead");
  await until(() => header("one", roomy) === `Skelcrew ${shown}`, "the header");
});

test("each terminal says where it came from, as they can come from different laptops", async () => {
  checkoutAt("6f1c2ab");
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  await until(() => header("one").startsWith("Skelcrew 6f1c2ab (checkout) · s"), "the first place");
  await until(() => header("two") === "Skelcrew 6f1c2ab (checkout)", "the second header", "two");
});

test("the line the sides share runs from the top row down to the footer's line, at every width", async () => {
  open("lead");
  await ready("lead");
  // The sidebar narrows on a terminal too narrow for it beside half the terminal.
  let lineAt = sidebar;
  const column = () =>
    seen()
      .split("\n")
      .slice(0, 29)
      .map((line) => line[lineAt])
      .join("");
  const whole = `┬${"│".repeat(27)}┴`;
  await until(() => column() === whole, "the line");
  for (const width of [150, 90, 120]) {
    lineAt = sidebarFor(width);
    tmux(terminal, "resize-window", "-t", "=one:", "-x", String(width), "-y", "30");
    // tmux stretches the sidebar for a moment before the screen's hook sets its width back.
    await until(() => column() === whole, `the line at ${width}`);
  }
});

test("clicking the top row past the tabs, or turning the wheel over it, does nothing", async () => {
  open("lead");
  await ready("lead");
  click(100, 1);
  type("\x1b[<64;100;1M");
  await Bun.sleep(200);
  const modes = tmux(screen, "list-panes", "-a", "-F", "#{pane_in_mode}").out.trim().split("\n");
  expect(modes).toEqual(["0", "0", "0", "0", "0"]);
  expect(scrolledBack()).not.toContain("1");
  expect(seen()).toContain("I am lead");
});

test("the footer has only the keys you need most, and a click on it does nothing", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => footer().startsWith("  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit"),
    "the footer",
  );
  expect(seen()).not.toContain("⌃Q");
  expect(seen()).not.toContain("⌥⇧↑↓");
  expect(seen()).not.toContain("⌥←→");
  click(5, 30);
  click(5, 29);
  click(5, 28);
  await Bun.sleep(200);
  expect(onLead()).toBe(true);
  expect(footer()).toStartWith("  typing to lead · ⌃\\ to list  ⌥↑↓ move  ⌥Q quit");
});

// ? is text you type to an agent, so no key of the screen's may take it, and Alt-/ is none of
// the screen's keys either.
test("Alt-/ is no key of Skelcrew's, and plain ? on the lead reaches the agent", async () => {
  open("lead");
  await ready("lead");
  type("\x1b/");
  type("?");
  press("Enter");
  await until(() => read("lead.typed").includes("?"), "the agent to get ?");
  expect(onLead()).toBe(true);
});
