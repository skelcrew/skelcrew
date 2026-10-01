// One task's own screen: enter opens it from the list, and esc goes back.
// It shows what the task needs, its spec, and its history.

import { expect, test } from "bun:test";
import type { Outcome } from "../cli/cli";
import { TaskId } from "../core/ids";
import type { TaskEvent } from "../core/types";
import { taskEvent } from "../store/schema";
import type { LoadedLog } from "./task-screen";
import { KEYS, lines, loaded, open, task, tick } from "./testing";

const ENTER = "\r";
const ESC = "\u001B";

// Times in the reader's own time zone, as `skelcrew log` shows them.
const at = (hour: number, minute: number) => new Date(2026, 8, 30, hour, minute).getTime();

function event(task: number, hour: number, minute: number, fields: object): TaskEvent {
  return taskEvent.parse({ v: 1, taskId: task, at: at(hour, minute), ...fields });
}

const spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: [
    "Clicking Export downloads a CSV of the visible rows.",
    "The file name holds the date.",
  ],
  openQuestions: [],
};

// #14's history: added, a spec agent started, and its spec came back.
const history: TaskEvent[] = [
  event(14, 9, 38, { type: "task.created", title: "CSV export", project: "reports", source: null }),
  event(14, 9, 40, { type: "task.spec_session_started", session: "you-3" }),
  event(14, 10, 2, { type: "task.specced", spec, by: "agent" }),
];

const specToApprove = task(14, "CSV export", "spec", {
  project: "reports",
  waitingOnYou: "spec_approval",
});
const mergeToApprove = task(11, "Retry on 429", "checks", {
  waitingOnYou: "merge_approval",
  pullRequest: "https://github.com/o/r/pull/71",
});
const blocked = task(9, "Dark mode", "in_progress", {
  step: "queued",
  blocked: "Out of attempts. The last failure, in local: bun test\n2 tests failed.",
  waitingOnYou: "retry",
});

const logOf =
  (events: TaskEvent[], leftOut = 0) =>
  async (): Promise<LoadedLog> => ({ ok: true, events, leftOut });

const TASK_KEYS =
  "j k scroll · y approve · x send back · s spec · r retry · D drop · esc back · q quit";

test("enter opens the task: what it needs, its spec, and its history, newest first", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), loadLog: logOf(history) });
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toEqual([
    "#14 CSV export Spec · approve its spec",
    "",
    "Project: reports",
    "",
    "Scope",
    "Add a CSV export button to the reports page.",
    "",
    "Acceptance criteria",
    "- Clicking Export downloads a CSV of the visible rows.",
    "- The file name holds the date.",
    "",
    "History",
    "2026-09-30 10:02 The agent sent a spec: Add a CSV export button to the reports page.",
    "2026-09-30 09:40 A spec agent started as you-3.",
    "2026-09-30 09:38 Added to project reports: CSV export.",
    "See it all with: skelcrew log 14",
    "",
    TASK_KEYS,
  ]);
});

test("it asks for the log of the task under the cursor", async () => {
  const asked: TaskId[] = [];
  const loadLog = async (task: TaskId): Promise<LoadedLog> => {
    asked.push(task);
    return { ok: true, events: [], leftOut: 0 };
  };
  const { stdin } = open({ load: loaded([mergeToApprove, specToApprove]), loadLog });
  await tick();
  stdin.write("j");
  await tick();
  stdin.write("l");
  await tick();
  expect(asked[0]).toBe(TaskId.parse(14));
});

test("esc goes back to the list, with the cursor on the same task", async () => {
  const tasks = [mergeToApprove, specToApprove];
  const { lastFrame, stdin } = open({ load: loaded(tasks), loadLog: logOf([]) });
  await tick();
  stdin.write("j");
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write(ESC);
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toContain("› #14 CSV export reports approve its spec");
  expect(shown.at(-1)).toBe(KEYS);
});

test("h goes back too", async () => {
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), loadLog: logOf([]) });
  await tick();
  stdin.write("l");
  await tick();
  stdin.write("h");
  await tick();
  expect(lines(lastFrame()).at(-1)).toBe(KEYS);
});

test("a merge links its pull request, and o opens it in the browser", async () => {
  const opened: string[] = [];
  const { lastFrame, stdin } = open({
    load: loaded([mergeToApprove]),
    loadLog: logOf([]),
    browse: (url) => opened.push(url),
  });
  await tick();
  stdin.write(ENTER);
  await tick();
  const shown = lines(lastFrame());
  expect(shown).toContain("Read it on GitHub: https://github.com/o/r/pull/71");
  expect(shown.at(-1)).toBe(
    "j k scroll · y approve · x send back · s spec · r retry · D drop · o open PR · esc back · q quit",
  );
  stdin.write("o");
  await tick();
  expect(opened).toEqual(["https://github.com/o/r/pull/71"]);
});

test("o does nothing for a task with no pull request", async () => {
  const opened: string[] = [];
  const { stdin } = open({
    load: loaded([specToApprove]),
    loadLog: logOf([]),
    browse: (url) => opened.push(url),
  });
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write("o");
  await tick();
  expect(opened).toEqual([]);
});

test("a merge with no pull request says why", async () => {
  const noPullRequest = task(11, "Retry on 429", "checks", {
    waitingOnYou: "merge_approval",
    noPullRequest: "There is no pull request: gh isn't logged in.",
  });
  const { lastFrame, stdin } = open({ load: loaded([noPullRequest]), loadLog: logOf([]) });
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toContain("There is no pull request: gh isn't logged in.");
});

test("a blocked task shows its whole reason, and a question shows in full", async () => {
  const question = task(18, "Pick a format", "spec", {
    session: "you-4",
    question: "CSV or Markdown?",
    waitingOnYou: "answer",
  });
  const { lastFrame, stdin } = open({ load: loaded([blocked, question]), loadLog: logOf([]) });
  await tick();
  stdin.write(ENTER);
  await tick();
  let shown = lines(lastFrame());
  expect(shown).toContain("Blocked: Out of attempts. The last failure, in local: bun test");
  expect(shown).toContain("2 tests failed.");
  stdin.write(ESC);
  await tick();
  stdin.write("j");
  await tick();
  stdin.write(ENTER);
  await tick();
  shown = lines(lastFrame());
  expect(shown).toContain("Question: CSV or Markdown?");
});

test("the keys act on the task shown", async () => {
  const sent: string[][] = [];
  const send = async (args: string[]): Promise<Outcome> => {
    sent.push(args);
    return { code: 0, out: ["Approved #14."], err: [] };
  };
  const { lastFrame, stdin } = open({
    load: loaded([mergeToApprove, specToApprove]),
    loadLog: logOf(history),
    send,
  });
  await tick();
  stdin.write("j");
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write("y");
  await tick();
  expect(sent).toEqual([["approve", "14"]]);
  expect(lines(lastFrame())).toContain("Approved #14.");
  expect(lines(lastFrame())[0]).toBe("#14 CSV export Spec · approve its spec");
});

test("after a command, the task's history is read again", async () => {
  let reads = 0;
  const loadLog = async (): Promise<LoadedLog> => {
    reads += 1;
    return { ok: true, events: history, leftOut: 0 };
  };
  const { stdin } = open({ load: loaded([specToApprove]), loadLog });
  await tick();
  stdin.write(ENTER);
  await tick();
  const before = reads;
  stdin.write("s");
  await tick();
  expect(reads).toBeGreaterThan(before);
});

test("when the history can't be read, the screen says why", async () => {
  const loadLog = async (): Promise<LoadedLog> => ({ ok: false, message: "The daemon stopped." });
  const { lastFrame, stdin } = open({ load: loaded([specToApprove]), loadLog });
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toContain("The history couldn't be read: The daemon stopped.");
});

test("older events left out of the reply are counted", async () => {
  const { lastFrame, stdin } = open({
    load: loaded([specToApprove]),
    loadLog: logOf(history.slice(1), 4),
  });
  await tick();
  stdin.write(ENTER);
  await tick();
  expect(lines(lastFrame())).toContain("4 older events are left out.");
});

test("a scope longer than the screen is wide wraps onto more lines", async () => {
  const long = { ...spec, scope: `${"word ".repeat(40)}end.` };
  const { lastFrame, stdin } = open({
    load: loaded([specToApprove]),
    loadLog: logOf([event(14, 10, 2, { type: "task.specced", spec: long, by: "agent" })]),
  });
  await tick();
  stdin.write(ENTER);
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("end.");
  expect(frame.split("\n").every((line) => line.length <= 100)).toBe(true);
});

// 12 lines: the header, 9 for the body, and 2 for the keys.
test("j and k scroll a task taller than the screen", async () => {
  const { lastFrame, stdin } = open({
    load: loaded([specToApprove]),
    loadLog: logOf(history),
    height: 12,
  });
  await tick();
  stdin.write(ENTER);
  await tick();
  let shown = lines(lastFrame());
  expect(shown).toHaveLength(12);
  expect(shown[1]).toBe("");
  expect(shown[9]).toMatch(/^↓ \d+ more lines?$/);
  stdin.write("G");
  await tick();
  shown = lines(lastFrame());
  expect(shown[1]).toMatch(/^↑ \d+ more lines?$/);
  expect(shown).toContain("See it all with: skelcrew log 14");
  stdin.write("k");
  await tick();
  expect(lines(lastFrame())).not.toContain("See it all with: skelcrew log 14");
  stdin.write("g");
  await tick();
  expect(lines(lastFrame())[3]).toBe("Project: reports");
});
