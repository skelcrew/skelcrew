// The screen on a terminal too narrow for two sides, such as a phone's: it shows the sidebar or
// the agent, one at a time, switched by the keys that move your typing, and a plain q leaves it
// from the sidebar.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  click,
  endTest,
  home,
  open,
  press,
  read,
  ready,
  screen,
  screenSessions,
  seen,
  startTest,
  terminal,
  tmux,
  type,
  until,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

// Returns which side the screen shows: the sidebar alone, the agent alone, or both.
const showing = () => {
  const zoomed = tmux(
    screen,
    "display",
    "-p",
    "-t",
    `=${screenSessions()[0]}:`,
    "#{window_zoomed_flag}",
  );
  if (zoomed.out.trim() !== "1") return "both";
  return seen().includes("○ lead") ? "sidebar" : "agent";
};
// The header, on the top row.
const header = () => (seen().split("\n")[0] ?? "").trimEnd();
// Waits until the screen shows the lead alone, with the sidebar running behind it.
const leadAlone = () =>
  until(() => showing() === "agent" && header().includes("‹ sidebar · lead"), "the lead alone");
// The last rows of the screen, where the sidebar alone shows its keys.
const bottom = () => seen().trimEnd().split("\n").slice(-3).join("\n");

test("below 80 columns the screen shows one side at a time, switched by Enter and Ctrl-\\", async () => {
  open("lead", "one", "xterm-256color", "60");
  await until(() => seen().includes("I am lead") && showing() === "agent", "the lead alone");
  await until(() => header().includes("‹ sidebar · lead"), "the header to name the lead");
  press("C-\\");
  await until(() => showing() === "sidebar", "the sidebar alone");
  expect(seen()).not.toContain("I am lead");
  await until(() => header().includes("Skelcrew sidebar"), "the header to say the sidebar shows");
  press("Enter");
  await until(() => showing() === "agent" && seen().includes("I am lead"), "the lead again");
});

test("at 80 columns and wider, both sides show as before", async () => {
  open("lead", "one", "xterm-256color", "80");
  await ready("lead");
  press("C-\\");
  await until(() => seen().includes("⌥Q quit"), "the sidebar's keys");
  expect(showing()).toBe("both");
  expect(header()).not.toContain("sidebar");
});

test("resizing past 80 columns either way switches the layout and keeps where your typing goes", async () => {
  open("lead");
  await ready("lead");
  press("C-\\");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "60", "-y", "30");
  await until(() => showing() === "sidebar", "the sidebar alone");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  await until(() => showing() === "both" && seen().includes("I am lead"), "both sides");
  press("Enter");
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "60", "-y", "30");
  await leadAlone();
  tmux(terminal, "resize-window", "-t", "=one:", "-x", "120", "-y", "30");
  await until(() => showing() === "both", "both sides again");
  type("still here\r");
  await until(() => read("lead.typed").includes("still here"), "your typing still in the lead");
});

test("Shift-Enter's stand-in a still gives the agent the terminal on a narrow screen", async () => {
  open("lead", "one", "xterm-256color", "60");
  await leadAlone();
  press("C-\\");
  await until(() => showing() === "sidebar", "the sidebar alone");
  type("a");
  await until(() => showing() === "agent", "the lead alone again");
});

test("the sidebar alone shows its keys, q among them, and q leaves the screen", async () => {
  open("lead", "one", "xterm-256color", "60");
  await leadAlone();
  press("C-\\");
  await until(() => bottom().includes("q/⌥Q quit"), "the keys under the sidebar");
  type("q");
  await until(() => existsSync(join(home, "left-one")), "Skelcrew to return");
});

test("on the agent's side q reaches the agent and never leaves", async () => {
  open("lead", "one", "xterm-256color", "60");
  await leadAlone();
  type("q\r");
  await until(() => read("lead.typed").includes("q"), "q to reach the lead");
  expect(existsSync(join(home, "left-one"))).toBe(false);
});

test("on a narrow screen a tap on ‹ sidebar shows the sidebar, and a tap on a row shows its agent", async () => {
  open("lead", "one", "xterm-256color", "60");
  await until(() => header().includes("‹ sidebar"), "the way back in the header");
  click(header().indexOf("‹") + 2, 1);
  await until(() => showing() === "sidebar", "the sidebar alone");
  const row = seen()
    .split("\n")
    .findIndex((line) => line.includes("○ lead"));
  click(10, row + 1);
  await until(() => showing() === "agent" && seen().includes("I am lead"), "the lead alone");
  click(header().indexOf("‹") + 2, 1);
  await until(() => showing() === "sidebar", "the sidebar alone again");
  const task = seen()
    .split("\n")
    .findIndex((line) => line.includes("○ 12"));
  click(10, task + 1);
  await until(() => showing() === "agent" && seen().includes("I am app-12"), "app-12 alone");
  click(header().indexOf("‹") + 2, 1);
  await until(() => showing() === "sidebar", "the sidebar after leaving app-12");
});
