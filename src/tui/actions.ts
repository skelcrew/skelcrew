// The keys that act on tasks. Each one ends in a `skelcrew` command, the
// same one you would type, so the TUI can do nothing the CLI can't. The
// rules stay in the daemon: the screen sends what you ask for, and shows
// what the CLI says, refusals too.

import type { TaskView } from "../cli/status";

// A command to run: its arguments after `skelcrew`, and what the screen
// says while it runs. `task` is the task it is about, if any.
export type Run = { args: string[]; doing: string; task: number | null };

// What a key leads to: a command at once, a y/n question first, or a line
// to type first.
export type Step =
  | { kind: "run"; run: Run }
  | { kind: "confirm"; question: string; run: Run }
  | { kind: "type"; prompt: string; run: (text: string) => Run };

// `hint` is the word in the keys line, which shows the keys used most. A
// key without one is only in the list ? shows, with its `help`. `onTask`
// keys act on one task, so they work on the task screen too.
type Action = {
  key: string;
  hint: string | null;
  help: string;
  onTask: boolean;
  // The step for the task under the cursor. null when the key needs a
  // task and there is none.
  step: (task: TaskView | undefined) => Step | null;
};

const adding = (prompt: string, flags: string[]): Step => ({
  kind: "type",
  prompt,
  // After --, a title that starts with a dash is still a title.
  run: (title) => ({ args: ["add", ...flags, "--", title], doing: "Adding…", task: null }),
});

export const actions: Action[] = [
  {
    key: "a",
    hint: "add",
    help: "add an idea",
    onTask: false,
    step: () => adding("Add an idea:", []),
  },
  {
    key: "A",
    hint: null,
    help: "add an idea and ask for its spec",
    onTask: false,
    step: () => adding("Add an idea and ask for its spec:", ["--spec"]),
  },
  {
    key: "y",
    hint: "approve",
    help: "approve a spec, or a merge once you confirm",
    onTask: true,
    step: (task) => {
      if (task === undefined) return null;
      const run = {
        args: ["approve", `${task.task}`],
        doing: `Approving #${task.task}…`,
        task: task.task,
      };
      // A merge changes main, so it asks first. A spec changes no code.
      return task.waitingOnYou === "merge_approval"
        ? { kind: "confirm", question: `Merge #${task.task} into main now? y/n`, run }
        : { kind: "run", run };
    },
  },
  {
    key: "x",
    hint: "send back",
    help: "send it back, with what should change",
    onTask: true,
    step: (task) =>
      task === undefined
        ? null
        : {
            kind: "type",
            prompt: `Send #${task.task} back. What should change?`,
            run: (note) => ({
              args: ["reject", `${task.task}`, "--", note],
              doing: `Sending #${task.task} back…`,
              task: task.task,
            }),
          },
  },
  {
    key: "s",
    hint: null,
    help: "ask for a spec",
    onTask: true,
    step: (task) =>
      task === undefined
        ? null
        : {
            kind: "run",
            run: {
              args: ["spec", `${task.task}`],
              doing: `Asking for a spec for #${task.task}…`,
              task: task.task,
            },
          },
  },
  {
    key: "r",
    hint: null,
    help: "retry a blocked task",
    onTask: true,
    step: (task) =>
      task === undefined
        ? null
        : {
            kind: "run",
            run: {
              args: ["retry", `${task.task}`],
              doing: `Retrying #${task.task}…`,
              task: task.task,
            },
          },
  },
  {
    key: "D",
    hint: null,
    help: "drop the task, once you confirm",
    onTask: true,
    step: (task) =>
      task === undefined
        ? null
        : {
            kind: "confirm",
            question: `Drop #${task.task} ${task.title}? y/n`,
            run: {
              args: ["drop", `${task.task}`],
              doing: `Dropping #${task.task}…`,
              task: task.task,
            },
          },
  },
];

// The keys line's words: "a add · y approve · …" on the list, and only
// the keys that act on one task on the task screen.
export function hints(screen: "list" | "task"): string {
  return actions
    .filter((action) => screen === "list" || action.onTask)
    .flatMap((action) => (action.hint === null ? [] : [`${action.key} ${action.hint}`]))
    .join(" · ");
}
