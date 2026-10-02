// ? shows every key, and the keys line at the bottom shows only the keys
// used most, so it fits a narrow window.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import {
  IDEA_KEYS,
  IDEA_TASK_KEYS,
  KEYS,
  lines,
  loaded,
  open,
  PLAIN_KEYS,
  PLAIN_TASK_KEYS,
  TASK_KEYS,
  task,
  tick,
} from "./testing";

const ESC = "\u001B";
const ENTER = "\r";

const specToApprove = task(14, "CSV export", "spec", { waitingOnYou: "spec_approval" });

const KEY_LIST = [
  "Keys",
  "",
  "On the list",
  "j k move down and up, or use the arrow keys",
  "g G go to the first or last task",
  "enter open the task, or press l",
  "a add an idea",
  "A add an idea and ask for its spec",
  "y ask for an idea's spec, or approve a spec, or a merge once you confirm",
  "x send it back, with what should change",
  "s ask for a spec",
  "r retry a blocked task",
  "D drop the task, once you confirm",
  "p put the task in a project, or take it out of its own",
  "P open the projects screen",
  "",
  "On a task",
  "j k scroll down and up",
  "g G go to the top or the bottom",
  "o open its pull request in your browser",
  "esc go back to the list, or press h",
  "y x s r D p act on the task, as on the list",
  "",
  "On the projects screen",
  "j k move down and up",
  "n make a project, with its name and goal",
  "e archive the project, or unarchive it",
  "esc go back to the list, or press h",
  "",
  "Anywhere",
  "? show or hide this list",
  "q quit",
  "",
  "esc close · q quit",
];

test("? shows every key and what it does", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]) });
  await tick();
  stdin.write("?");
  await tick();
  expect(lines(lastFrame())).toEqual(KEY_LIST);
});

test("esc closes the list of keys, and so does ? again", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]) });
  await tick();
  stdin.write("?");
  await tick();
  stdin.write(ESC);
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
  stdin.write("?");
  await tick();
  stdin.write("?");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
});

test("? on a task's screen goes back to that task when closed", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]) });
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write("?");
  await tick();
  expect(lines(lastFrame())[0]).toBe("Keys");
  stdin.write(ESC);
  await tick();
  const shown = lines(lastFrame());
  expect(shown[0]).toBe("#14 CSV export Spec · approve its spec");
  expect(shown.at(-1)).toBe(TASK_KEYS);
});

test("the keys that act on tasks do nothing while the list of keys shows", async () => {
  const sent: string[][] = [];
  const send = async (args: string[]): Promise<Outcome> => {
    sent.push(args);
    return { code: 0, out: [], err: [] };
  };
  const { stdin } = open({ load: loaded([specToApprove]), send });
  await tick();
  stdin.write("?");
  await tick();
  for (const key of ["y", "s", "r", "a"]) {
    stdin.write(key);
    await tick();
  }
  expect(sent).toEqual([]);
});

test("q still quits from the list of keys", async () => {
  let quit = 0;
  const { stdin } = open({ load: loaded([specToApprove]), quit: () => quit++ });
  await tick();
  stdin.write("?");
  await tick();
  stdin.write("q");
  await tick();
  expect(quit).toBe(1);
});

test("the keys lines fit an 80-column window", () => {
  expect(KEYS.length).toBeLessThanOrEqual(80);
  expect(TASK_KEYS.length).toBeLessThanOrEqual(80);
});

// The keys line names y and x only when they would work.
const idea = task(16, "Keyboard help", "idea");
const mergeToApprove = task(11, "Retry on 429", "checks", { waitingOnYou: "merge_approval" });
const building = task(12, "Settings page", "in_progress", { session: "you-2", step: "running" });

test("the keys line names approve and reject on a spec or merge that waits for approval", async () => {
  for (const waiting of [specToApprove, mergeToApprove]) {
    const { lastFrame } = open({ load: loaded([waiting]) });
    await tick();
    expect(lines(lastFrame()).at(-1)).toBe(KEYS);
  }
});

test("on an Idea, the keys line says y specs it, and leaves out reject", async () => {
  const { lastFrame } = open({ load: loaded([idea]) });
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(IDEA_KEYS);
});

test("the keys line leaves out y and x while an agent works on the task", async () => {
  const { lastFrame } = open({ load: loaded([building]) });
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(PLAIN_KEYS);
});

test("the keys line follows the cursor", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove, idea]) });
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
  stdin.write("j");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(IDEA_KEYS);
});

test("with no tasks, the keys line leaves out y and x", async () => {
  const { lastFrame } = open({ load: loaded([]) });
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(PLAIN_KEYS);
});

test("a task's own screen names y and x only when they would work", async () => {
  for (const [shown, keys] of new Map([
    [specToApprove, TASK_KEYS],
    [idea, IDEA_TASK_KEYS],
    [building, PLAIN_TASK_KEYS],
  ])) {
    const { lastFrame, stdin } = open({ load: loaded([shown]) });
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lines(lastFrame()).at(-1)).toBe(keys);
  }
});

test("y on an Idea asks for its spec", async () => {
  const sent: string[][] = [];
  const send = async (args: string[]): Promise<Outcome> => {
    sent.push(args);
    return { code: 0, out: ["Asked for a spec for #16."], err: [] };
  };
  const { stdin } = open({ load: loaded([idea]), send });
  await tick();
  stdin.write("y");
  await tick();
  expect(sent).toEqual([["spec", "16"]]);
});
