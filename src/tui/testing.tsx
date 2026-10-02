// What the TUI's tests share: tasks to show, and the screen opened on them
// without a daemon.

import { stripVTControlCharacters } from "node:util";
import { render } from "ink-testing-library";
import type { Outcome } from "../cli/cli";
import type { TaskView } from "../cli/status";
import { TaskId } from "../core/ids";
import { type Loaded, Screen } from "./screen";
import type { LoadedLog } from "./task-screen";

// Ink reads keys and runs effects on a later tick, so a test waits for it.
export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

export function task(
  number: number,
  title: string,
  phase: TaskView["phase"],
  fields: Partial<Omit<TaskView, "task" | "title" | "phase">> = {},
): TaskView {
  return {
    task: TaskId.parse(number),
    title,
    phase,
    project: null,
    step: null,
    session: null,
    blocked: null,
    question: null,
    waitingOnYou: null,
    ...fields,
  };
}

// One of each kind of row, as in the sketch the developer approved.
export const tasks: TaskView[] = [
  task(7, "Old idea", "dropped"),
  task(8, "Totals", "done"),
  task(9, "Dark mode", "in_progress", {
    project: "ui",
    step: "queued",
    blocked: "Out of attempts. The last failure, in local: bun test\n2 tests failed.",
    waitingOnYou: "retry",
  }),
  task(11, "Retry on 429", "checks", {
    waitingOnYou: "merge_approval",
    pullRequest: "https://github.com/o/r/pull/71",
  }),
  task(12, "Settings page", "in_progress", { project: "ui", session: "you-2", step: "working" }),
  task(13, "Linear import", "spec", { session: "you-3", step: "working" }),
  task(14, "CSV export", "spec", { project: "reports", waitingOnYou: "spec_approval" }),
  task(15, "Rate limit", "ready", { step: "queued" }),
  task(16, "Keyboard help", "idea"),
  task(17, "Spec me", "spec", { step: "queued" }),
  task(18, "Pick a format", "spec", {
    session: "you-4",
    question: "CSV or Markdown?",
    waitingOnYou: "answer",
  }),
];

export const loaded = (list: TaskView[]): (() => Promise<Loaded>) => {
  return async () => ({ ok: true, tasks: list });
};

// The screen's lines, with runs of spaces made one, so a test reads the
// words and not the column widths.
export function lines(frame: string | undefined): string[] {
  return (frame ?? "").split("\n").map((line) => line.replace(/\s+/g, " ").trim());
}

// The keys line at the bottom of the list: the keys used most, and ? for
// the rest. y and x show only when they would work on the task under the
// cursor: KEYS on a spec or merge that waits for approval, IDEA_KEYS on
// an Idea, and PLAIN_KEYS on any other task, or none.
export const KEYS = "j k move · enter open · a add · y approve · x reject · ? keys · q quit";
export const IDEA_KEYS = "j k move · enter open · a add · y spec it · ? keys · q quit";
export const PLAIN_KEYS = "j k move · enter open · a add · ? keys · q quit";

// The keys line on a task's own screen, the same way.
export const TASK_KEYS = "j k scroll · y approve · x reject · esc back · ? keys · q quit";
export const IDEA_TASK_KEYS = "j k scroll · y spec it · esc back · ? keys · q quit";
export const PLAIN_TASK_KEYS = "j k scroll · esc back · ? keys · q quit";

type Options = {
  repo?: string;
  load?: () => Promise<Loaded>;
  quit?: () => void;
  refreshMs?: number;
  spinMs?: number;
  send?: (args: string[]) => Promise<Outcome>;
  loadLog?: (task: TaskId) => Promise<LoadedLog>;
  browse?: (url: string) => void;
  // The terminal's height in lines. Without it, the screen is as tall as
  // what it shows.
  height?: number;
};

// The screen opened with a stand-in for the daemon and the CLI. Its
// `lastFrame` is the text the screen drew, without colour codes. In a
// terminal, Ink adds them for bold, dim and coloured words, and a test
// reads only the words.
export function open(options: Options = {}) {
  const screen = draw(options);
  return {
    ...screen,
    lastFrame: () => {
      const frame = screen.lastFrame();
      return frame === undefined ? undefined : stripVTControlCharacters(frame);
    },
  };
}

function draw(options: Options) {
  const send = options.send ?? (async () => ({ code: 0, out: [], err: [] }));
  return render(
    <Screen
      repo={options.repo ?? "~/code/app"}
      quit={options.quit ?? (() => {})}
      load={options.load ?? loaded(tasks)}
      refreshMs={options.refreshMs ?? 1000}
      {...(options.spinMs === undefined ? {} : { spinMs: options.spinMs })}
      send={send}
      loadLog={options.loadLog ?? (async () => ({ ok: true, events: [], leftOut: 0 }))}
      browse={options.browse ?? (() => {})}
      {...(options.height === undefined ? {} : { height: options.height })}
    />,
  );
}
