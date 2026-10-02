// The projects screen: P opens it from the list. It lists every project,
// and n makes one, e archives or unarchives one.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import type { ProjectView } from "../cli/status";
import type { Loaded } from "./screen";
import { KEYS, lines, open, task, tick } from "./testing";

const ESC = "\u001B";
const ENTER = "\r";

const project = (id: string, name: string, goal: string, archived = false): ProjectView => ({
  id,
  name,
  goal,
  status: archived ? "archived" : "active",
});

const projects = [
  project("reports-page", "Reports page", "Export what the reports page shows."),
  project("search", "Search", "Find any task."),
  project("someday", "Someday", "Ideas for later.", true),
];

// Two open tasks in no project, one in Reports page, one in Someday, and
// a done task in Search, which isn't counted as open.
const tasks = [
  task(1, "CSV export", "idea", { project: "reports-page" }),
  task(2, "Dark mode", "spec", { project: "someday", step: "queued" }),
  task(3, "Totals", "idea"),
  task(4, "Old search", "done", { project: "search" }),
  task(5, "Keyboard help", "idea"),
];

const load =
  (list = projects) =>
  async (): Promise<Loaded> => ({ ok: true, tasks, projects: list });

const PROJECT_KEYS = "j k move · n new · e archive · esc back · ? keys · q quit";

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

async function projectsScreen(options: Parameters<typeof open>[0] = {}) {
  const screen = open({ load: load(), ...options });
  await tick();
  screen.stdin.write("P");
  await tick();
  return screen;
}

test("P lists every project, with whether it is archived, its open tasks and its goal", async () => {
  const { lastFrame } = await projectsScreen();
  expect(lines(lastFrame())).toEqual([
    "Projects 2 active · 1 archived",
    "",
    "› Reports page active 1 open Export what the reports page shows.",
    "Search active 0 open Find any task.",
    "Someday archived 1 open Ideas for later.",
    "No project 2 open",
    "",
    PROJECT_KEYS,
  ]);
});

test("the keys line says unarchive on an archived project, and leaves e out on No project", async () => {
  const { lastFrame, stdin } = await projectsScreen();
  stdin.write("j");
  await tick();
  stdin.write("j");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(
    "j k move · n new · e unarchive · esc back · ? keys · q quit",
  );
  stdin.write("j");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe("j k move · n new · esc back · ? keys · q quit");
});

test("e archives the project under the cursor, and unarchives an archived one", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = await projectsScreen({ send });
  stdin.write("e");
  await tick();
  expect(lines(lastFrame())).toContain("Done.");
  stdin.write("j");
  await tick();
  stdin.write("j");
  await tick();
  stdin.write("e");
  await tick();
  expect(sent).toEqual([
    ["project", "archive", "--", "reports-page"],
    ["project", "unarchive", "--", "someday"],
  ]);
});

test("e does nothing on No project", async () => {
  const { sent, send } = cli();
  const { stdin } = await projectsScreen({ send });
  stdin.write("G");
  await tick();
  stdin.write("e");
  await tick();
  expect(sent).toEqual([]);
});

test("n asks for the name, then the goal, and makes the project", async () => {
  const { sent, send } = cli();
  const { lastFrame, stdin } = await projectsScreen({ send });
  stdin.write("n");
  await tick();
  expect(lines(lastFrame())).toContain("New project's name:");
  stdin.write("Billing");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toContain("Billing's goal, in one line:");
  stdin.write("Charge for what is used.");
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(sent).toEqual([["project", "new", "--", "Billing", "Charge for what is used."]]);
});

test("esc while typing the goal makes nothing", async () => {
  const { sent, send } = cli();
  const { stdin } = await projectsScreen({ send });
  stdin.write("n");
  await tick();
  stdin.write("Billing");
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write(ESC);
  await tick();
  expect(sent).toEqual([]);
});

test("the keys that act on tasks do nothing on the projects screen", async () => {
  const { sent, send } = cli();
  const { stdin } = await projectsScreen({ send });
  for (const key of ["y", "s", "r", "a", "p"]) {
    stdin.write(key);
    await tick();
  }
  expect(sent).toEqual([]);
});

test("esc goes back to the list, and so does h", async () => {
  const { lastFrame, stdin } = await projectsScreen();
  stdin.write(ESC);
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
  stdin.write("P");
  await tick();
  stdin.write("h");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
});

test("? on the projects screen goes back to it when closed", async () => {
  const { lastFrame, stdin } = await projectsScreen();
  stdin.write("?");
  await tick();
  expect(lines(lastFrame())[0]).toBe("Keys");
  stdin.write(ESC);
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(PROJECT_KEYS);
});

// 12 lines: the header, 9 for the projects, and 2 for the keys. The first
// and last of the 9 say how many projects are hidden.
test("more projects than fit scroll to keep the cursor in view", async () => {
  const many = Array.from({ length: 30 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return project(`project-${n}`, `Project ${n}`, `Goal ${n}.`);
  });
  const { lastFrame, stdin } = await projectsScreen({
    load: async () => ({ ok: true, tasks: [], projects: many }),
    height: 14,
  });
  let shown = lines(lastFrame());
  expect(shown).toHaveLength(14);
  expect(shown[10]).toBe("↓ 24 more");
  for (let i = 0; i < 7; i++) {
    stdin.write("j");
    await tick();
  }
  shown = lines(lastFrame());
  expect(shown).toContain("› Project 08 active 0 open Goal 08.");
  stdin.write("G");
  await tick();
  shown = lines(lastFrame());
  expect(shown[2]).toBe("↑ 23 more");
  expect(shown).toContain("› Project 30 active 0 open Goal 30.");
  stdin.write("g");
  await tick();
  expect(lines(lastFrame())).toContain("› Project 01 active 0 open Goal 01.");
});

test("with no projects, it says how to make one", async () => {
  const { lastFrame } = await projectsScreen({ load: load([]) });
  const shown = lines(lastFrame());
  expect(shown).toContain("No projects yet. Press n to make one.");
  expect(shown).toContain("› No project 4 open");
});
