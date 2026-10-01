// One project at a time: enter on the projects screen shows only that
// project's tasks, and esc shows them all again.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import type { ProjectView } from "../cli/status";
import type { Loaded } from "./screen";
import { KEYS, lines, open, task, tick } from "./testing";

const ESC = "\u001B";
const ENTER = "\r";

const projects: ProjectView[] = [
  {
    id: "reports-page",
    name: "Reports page",
    goal: "Export what the reports page shows.",
    status: "active",
  },
  { id: "search", name: "Search", goal: "Find any task.", status: "active" },
];

const tasks = [
  task(1, "CSV export", "spec", { project: "reports-page", waitingOnYou: "spec_approval" }),
  task(2, "PDF export", "idea", { project: "reports-page" }),
  task(3, "Totals", "idea"),
  task(4, "Dark mode", "spec", { waitingOnYou: "spec_approval" }),
];

const load = async (): Promise<Loaded> => ({ ok: true, tasks, projects });

const ONE_KEYS = "j k move · enter open · a add · y approve · x reject · esc all · ? keys · q quit";

// Opens the projects screen, moves down `down` rows, and presses enter.
async function showProject(down: number, options: Parameters<typeof open>[0] = {}) {
  const screen = open({ load, ...options });
  await tick();
  screen.stdin.write("P");
  await tick();
  for (let i = 0; i < down; i++) {
    screen.stdin.write("j");
    await tick();
  }
  screen.stdin.write(ENTER);
  await tick();
  return screen;
}

test("enter on a project shows only its tasks, and the header names it", async () => {
  const { lastFrame } = await showProject(0);
  expect(lines(lastFrame())).toEqual([
    "skelcrew ~/code/app · Reports page 1 waits on you",
    "",
    "Waiting on you",
    "› #1 CSV export Reports page approve its spec",
    "",
    "Ideas",
    "#2 PDF export Reports page Idea",
    "",
    ONE_KEYS,
  ]);
});

test("the keys line fits an 80-column window", () => {
  expect(ONE_KEYS.length).toBeLessThanOrEqual(80);
});

test("esc shows every task again", async () => {
  const { lastFrame, stdin } = await showProject(0);
  stdin.write(ESC);
  await tick();
  const shown = lines(lastFrame());
  expect(shown[0]).toBe("skelcrew ~/code/app 2 wait on you");
  expect(shown).toContain("#4 Dark mode approve its spec");
  expect(shown.at(-1)).toBe(KEYS);
});

test("enter on No project shows the tasks in no project", async () => {
  const { lastFrame } = await showProject(2);
  const shown = lines(lastFrame());
  expect(shown[0]).toBe("skelcrew ~/code/app · No project 1 waits on you");
  expect(shown).toContain("› #4 Dark mode approve its spec");
  expect(shown).toContain("#3 Totals Idea");
  expect(shown.join("\n")).not.toContain("CSV export");
});

test("a project with no tasks says how to add one", async () => {
  const { lastFrame } = await showProject(1);
  expect(lines(lastFrame())).toContain("No tasks in Search yet. Press a to add one.");
});

function cli() {
  const sent: string[][] = [];
  return {
    sent,
    send: async (args: string[]): Promise<Outcome> => {
      sent.push(args);
      return { code: 0, out: ["Done."], err: [] };
    },
  };
}

test("a and A add the idea to the project shown", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = await showProject(0, { send });
  stdin.write("a");
  await tick();
  expect(lines(lastFrame())).toContain("Add an idea to Reports page:");
  stdin.write("Totals row");
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write("A");
  await tick();
  expect(lines(lastFrame())).toContain("Add an idea to Reports page and ask for its spec:");
  stdin.write("XLSX export");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([
    ["add", "--project", "reports-page", "--", "Totals row"],
    ["add", "--spec", "--project", "reports-page", "--", "XLSX export"],
  ]);
});

test("a on No project adds an idea in no project", async () => {
  const { sent, send } = cli();
  const { stdin } = await showProject(2, { send });
  stdin.write("a");
  await tick();
  stdin.write("Totals row");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["add", "--", "Totals row"]]);
});

test("a task opened from a project goes back to that project's tasks", async () => {
  const { lastFrame, stdin } = await showProject(0);
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())[0]).toBe("#1 CSV export Spec · approve its spec");
  stdin.write(ESC);
  await tick();
  expect(lines(lastFrame())[0]).toBe("skelcrew ~/code/app · Reports page 1 waits on you");
});
