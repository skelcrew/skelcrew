// ? shows every key, and the keys line at the bottom shows only the keys
// used most, so it fits a narrow window.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import { KEYS, lines, loaded, open, TASK_KEYS, task, tick } from "./testing";

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
  "y approve a spec, or a merge once you confirm",
  "x send it back, with what should change",
  "s ask for a spec",
  "r retry a blocked task",
  "D drop the task, once you confirm",
  "p put the task in a project, or take it out of its own",
  "",
  "On a task",
  "j k scroll down and up",
  "g G go to the top or the bottom",
  "o open its pull request in your browser",
  "esc go back to the list, or press h",
  "y x s r D p act on the task, as on the list",
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
