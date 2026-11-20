// How the screen is laid out: the sidebar's width and edge at every size, the top row, and the
// footer with its keys and load.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import checkout from "../package.json";
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
  tabRow,
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

// The widths of the sidebar, the right side and the footer, as tmux has them.
const widths = () => tmux(screen, "list-panes", "-a", "-F", "#{pane_width}").out.trim().split("\n");

test("resizing the terminal resizes the agent and keeps the sidebar as wide", async () => {
  open("lead");
  await ready("lead");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "26 61\n",
    "the agent's size",
  );
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "40");
  await until(
    () => readFileSync(join(home, "lead.size"), "utf8") === "36 91\n",
    "the agent to resize",
  );
  expect(widths()).toEqual(["58", "91", "150"]);
  // A terminal shorter than the list keeps the row you are looking at in view.
  await toSecondThread();
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "150", "-y", "6");
  await until(() => selected().includes("APP-7"), "the sidebar to scroll");
});

test("on a narrow terminal the sidebar narrows, so the right side keeps half of it", async () => {
  open("lead", "one", "xterm-256color", "80");
  await ready("lead");
  await until(() => widths()[0] === "39", "the sidebar to take what is left");
  expect(widths()).toEqual(["39", "40", "80"]);
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "100", "-y", "30");
  await until(() => widths()[0] === "49", "the sidebar to widen with the terminal");
  expect(widths()).toEqual(["49", "50", "100"]);
  // Every line keeps its edge, at the sidebar's new width.
  await until(() => edge(30, 100).every((columns) => columns === "│ "), "the sidebar's edge");
});

// The columns at the sidebar's edge, on each line of a screen `height` rows high above the
// footer, its line and the gap tmux leaves above them: the sidebar's line, where the lines between
// lists join it, then tmux's border. Blank past the end of a line that holds nothing else.
// The sidebar is `sidebar` columns wide, or narrower on a terminal `width` columns wide, so the
// right side keeps half of it.
const sidebarAt = (width: number) => Math.min(sidebar, Math.floor((width - 1) / 2));
const edge = (height: number, width = 120) =>
  seen()
    .split("\n")
    .slice(0, height - 3)
    .map((line) => `${line[sidebarAt(width) - 1]}${line[sidebarAt(width)] ?? " "}`);

test("the sidebar's line runs down to the footer, with a blank column before the agent", async () => {
  open("lead");
  await ready("lead");
  expect(new Set(edge(30))).toEqual(new Set(["│ "]));
  expect(seen().split("\n")[1]?.indexOf("I am lead")).toBe(sidebar + 1);
});

// Puts a tmux ahead of the real one that says it is this version, and is the real one for
// everything else.
function tmuxSays(version: string): void {
  const real = Bun.which("tmux") ?? "tmux";
  mkdirSync(join(home, "versioned"));
  writeFileSync(
    join(home, "versioned", "tmux"),
    `#!/bin/sh\n[ "$1" = -V ] && echo "${version}" && exit 0\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  given.before = `PATH=${join(home, "versioned")}:$PATH `;
}

// tmux before 3.6 refuses a blank border, and the screen would never open. There the border is
// tmux's own thin line. A version that can't be read is taken as new.
test.each([
  ["tmux 3.5a", "single"],
  ["tmux 3.4", "single"],
  ["tmux 3.6", "spaces"],
  ["tmux 3.6a", "spaces"],
  ["tmux next-3.7", "spaces"],
  ["tmux master", "spaces"],
  ["tmux openbsd-7.6", "spaces"],
])("with %p, the border before the agent is %p", async (version, border) => {
  tmuxSays(version);
  open("lead");
  await ready("lead");
  expect(tmux(screen, "show", "-gv", "pane-border-lines").out.trim()).toBe(border);
});

test("the sidebar's line stays whole however the terminal is resized", async () => {
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
      edge(height ?? 0, width).every((columns) => columns === "│ ") &&
      seen().split("○ lead").length === 2 &&
      seen().includes("⌥Q quit");
    await until(whole, "the sidebar to be whole");
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
    () => edge(30).every((columns) => columns === "│ ") && seen().split("○ lead").length === 2,
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

test("the strip ends the top row, and the agent's height stays as you switch", async () => {
  sql(`UPDATE tasks SET title = 'Fix the login', pr = 34, checks = 'passing',
    review_round = 2, reviewer = 'claude', reviewed_by = 'codex', verdict = 'changes',
    review_line = 'A test is missing.' WHERE task = 7`);
  // Wide enough for the whole strip beside the sidebar.
  open("lead", "one", "xterm-256color", "150");
  await ready("lead");
  const height = readFileSync(join(home, "lead.size"), "utf8");
  await toSecondThread();
  const line = "APP-7  Fix the login  #34  checks passing  round 2 · codex · changes";
  await until(() => tabRow().endsWith(line), "the strip");
  expect(seen()).not.toContain("A test is missing.");
  expect(readFileSync(join(home, "app-7.size"), "utf8")).toBe(height);
  press("M-Up");
  await until(() => tabRow().endsWith("APP-12"), "APP-12's strip");
  await attachTo("app-12");
  expect(readFileSync(join(home, "app-12.size"), "utf8")).toBe(height);
});

// The row above the footer, as you see it.
const aboveFooter = () => (seen().split("\n")[28] ?? "").trimEnd();

test("the footer runs across the screen under a thin line, with move and quit, then what Esc stops", async () => {
  sql("UPDATE threads SET harness = 'codex' WHERE task = 7");
  open("lead");
  await ready("lead");
  const lead = "  ⌥↑↓ move  ⌥Q quit  Esc stops claude";
  await until(() => footer() === lead, "the lead's footer");
  expect(aboveFooter()).toBe("─".repeat(120));
  press("M-S-Down");
  await until(() => footer() === "  ⌥↑↓ move  ⏎ open  1-6 stages  ⌥Q quit", "a task's footer");
  press("M-Down");
  await attachTo("app-7");
  await until(() => footer() === "  ⌥↑↓ move  ⌥Q quit  Esc stops codex", "app-7's footer");
});

test("a pinned load sits at the right end of the footer", async () => {
  open("lead");
  await ready("lead");
  // The lead's harness reaches the footer a moment after the lead starts, so the load can show
  // before what Esc stops does. Wait for both, then check they sit on the row together.
  const lead = "  ⌥↑↓ move  ⌥Q quit  Esc stops claude";
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
  expect(footer()).toBe("  ⌥↑↓ move  ⌥Q quit  Esc stops claude");
});

test("the header, the tabs and the strip share one row, and the agent starts right under it", async () => {
  sql("UPDATE tasks SET title = 'Fix the login', pr = 34 WHERE task = 7");
  open("lead");
  await ready("lead");
  await toSecondThread();
  await until(() => seen().includes("#34"), "the strip");
  const lines = seen().split("\n");
  // Skelcrew above the sidebar, its edge, and the tab above the agent, then the strip.
  expect(lines[0]?.trimEnd()).toMatch(
    /^ {2}Skelcrew v[\d.]+ +│ {3}app +APP-7 {2}Fix the login {2}#34$/,
  );
  // The open tab's grey starts where the agent's text does, with its name two columns in.
  expect(lines[0]?.indexOf("app")).toBe((lines[1]?.indexOf("I am") ?? 0) + 2);
  expect(lines[1]).toContain("I am app-7");
});

test("above the sidebar it says Skelcrew, in white, and the checkout's version when no laptop sent you here", async () => {
  open("lead");
  await ready("lead");
  const above = () => (seen().split("\n")[0] ?? "").slice(0, sidebar - 1).trimEnd();
  await until(() => above() === `  Skelcrew v${checkout.version}`, "the header");
  const colours = tmux(terminal, "capture-pane", "-p", "-e", "-t", "=one:").out;
  const header = colours.split("\n")[0];
  expect(header).toContain("\x1b[1m");
  expect(header).toContain("38;5;231m");
});

test("each terminal says where it came from, as they can come from different laptops", async () => {
  open("lead", "one", "xterm-256color", "120", "simon@workbox");
  await ready("lead");
  open("lead", "two");
  await ready("lead", "two");
  const place = (window: string) => (seen(window).split("\n")[0] ?? "").slice(0, sidebar - 1);
  await until(
    () => place("one").startsWith(`  Skelcrew v${checkout.version} · simon@`),
    "the first place",
  );
  await until(
    () => place("two").trimEnd() === `  Skelcrew v${checkout.version}`,
    "the second header",
    "two",
  );
});

test("the sidebar's edge runs from the top row down to the footer, at every width", async () => {
  open("lead");
  await ready("lead");
  // The sidebar narrows on a terminal too narrow for it beside half the terminal.
  let edgeAt = sidebar - 1;
  const column = () =>
    seen()
      .split("\n")
      .slice(0, 27)
      .map((line) => line[edgeAt]);
  await until(() => column().every((mark) => mark === "│" || mark === "┤"), "the edge");
  for (const width of [150, 90, 120]) {
    edgeAt = Math.min(sidebar, Math.floor((width - 1) / 2)) - 1;
    tmux(terminal, "resize-window", "-t", "=one:", "-x", String(width), "-y", "30");
    // tmux stretches the sidebar for a moment before the screen's hook sets its width back.
    await until(
      () => tabRow().length > edgeAt + 1 && column().every((mark) => mark === "│" || mark === "┤"),
      `the edge at ${width}`,
    );
  }
});

test("a thread's strip follows it as it changes", async () => {
  open("app-7");
  await ready("app-7");
  await until(() => tabRow().endsWith("APP-7"), "the strip");
  sql(`UPDATE tasks SET review_round = 1, reviewed_by = 'codex', verdict = 'approve',
    review_line = 'Looks right.' WHERE task = 7`);
  await until(() => seen().includes("APP-7  round 1 · codex · approved"), "the review");
});

test("what a title says is shown, never run or read as a format", async () => {
  const proof = join(home, "ran");
  const title = `100% %H #(touch ${proof}) #[fg=red] #{pane_pid}`;
  sql(`UPDATE tasks SET title = '${title}' WHERE task = 7`);
  // Wide enough for the whole title, which holds a path as long as the test's folder.
  open("app-7", "one", "xterm-256color", "200");
  await ready("app-7");
  await until(() => seen().includes("#(touch"), "the strip");
  expect(seen()).toContain(title);
  await Bun.sleep(300);
  expect(existsSync(proof)).toBe(false);
});

test("clicking the strip, or turning the wheel over it, does nothing", async () => {
  open("lead");
  await ready("lead");
  click(100, 1);
  type("\x1b[<64;100;1M");
  await Bun.sleep(200);
  const modes = tmux(screen, "list-panes", "-a", "-F", "#{pane_in_mode}").out.trim().split("\n");
  expect(modes).toEqual(["0", "0", "0"]);
  expect(scrolledBack()).not.toContain("1");
  expect(seen()).toContain("I am lead");
});

test("the footer has only the keys you need most, and a click on it away from ? keys does nothing", async () => {
  open("lead");
  await ready("lead");
  await until(() => footer().startsWith("  ⌥↑↓ move  ⌥Q quit"), "the footer");
  expect(seen()).not.toContain("? keys");
  expect(seen()).not.toContain("⌃Q");
  expect(seen()).not.toContain("⌥⇧↑↓");
  expect(seen()).not.toContain("⌥←→");
  click(5, 30);
  click(5, 29);
  click(5, 28);
  await Bun.sleep(200);
  expect(onLead()).toBe(true);
  expect(keysOpen()).toBe(false);
});

// The rows of keys across the screen, between the thin line above them and the one above the
// footer. None while they are hidden.
function keysShown(): string[] {
  // The footer is the last row with anything on it, under its line.
  const lines = seen().trimEnd().split("\n");
  const footerLine = lines.length - 2;
  const rule = (line: string) => /^─{40,}$/.test(line.trimEnd());
  const above = lines.findLastIndex((line, at) => at < footerLine && rule(line));
  return above < 0 ? [] : lines.slice(above + 1, footerLine).map((text) => text.trimEnd());
}
const keysOpen = () => keysShown().some((line) => line.trim() !== "");

test("Alt-/ is no key of Skelcrew's, and plain ? on an agent is the agent's, so neither shows the keys", async () => {
  open("lead");
  await ready("lead");
  type("\x1b/");
  type("?");
  press("Enter");
  await until(() => read("lead.typed").includes("?"), "the agent to get ?");
  expect(keysOpen()).toBe(false);
});
