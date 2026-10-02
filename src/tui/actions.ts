// The keys that act on tasks. Each one ends in a `skelcrew` command, the
// same one you would type, so the TUI can do nothing the CLI can't. The
// rules stay in the daemon: the screen sends what you ask for, and shows
// what the CLI says, refusals too.

import type { TaskView } from "../cli/status";

// A command to run: its arguments after `skelcrew`, and what the screen
// says while it runs. `task` is the task it is about, if any.
export type Run = { args: string[]; doing: string; task: number | null };

// What a key leads to: a command at once, a y/n question first, or a line
// to type first. A typed line can lead to another, such as a project's
// name, then its goal.
export type Step =
  | { kind: "run"; run: Run }
  | { kind: "confirm"; question: string; run: Run }
  | { kind: "type"; prompt: string; run: (text: string) => Run | Step };

// `hint` is the word in the keys line, which shows the keys used most. A
// key without one is only in the list ? shows, with its `help`. `onTask`
// keys act on one task, so they work on the task screen too.
type Action = {
  key: string;
  hint: string | null;
  help: string;
  onTask: boolean;
  // The word the keys line shows for this task, in place of `hint`, or
  // null to leave the key out. The key still works either way, and the
  // daemon says if it can't.
  hintFor?: (task: TaskView | undefined) => string | null;
  // The step for the task under the cursor. null when the key needs a
  // task and there is none.
  step: (task: TaskView | undefined, where: Where) => Step | null;
};

// Where the screen is: the project whose tasks it shows, or null for all
// tasks, or for the tasks in no project.
export type Where = { project: { id: string; name: string } | null };

// Approve and reject work only on a spec or a merge that waits for you.
const awaitsApproval = (task: TaskView | undefined) =>
  task?.waitingOnYou === "spec_approval" || task?.waitingOnYou === "merge_approval";

const askForSpec = (task: TaskView): Run => ({
  args: ["spec", `${task.task}`],
  doing: `Asking for a spec for #${task.task}…`,
  task: task.task,
});

// An idea goes into the project the screen shows, if any.
const adding = (spec: boolean, where: Where): Step => {
  const project = where.project;
  const into = project === null ? "" : ` to ${project.name}`;
  const flags = [
    ...(spec ? ["--spec"] : []),
    ...(project === null ? [] : ["--project", project.id]),
  ];
  return {
    kind: "type",
    prompt: `Add an idea${into}${spec ? " and ask for its spec" : ""}:`,
    // After --, a title that starts with a dash is still a title.
    run: (title) => ({ args: ["add", ...flags, "--", title], doing: "Adding…", task: null }),
  };
};

export const actions: Action[] = [
  {
    key: "a",
    hint: "add",
    help: "add an idea",
    onTask: false,
    step: (_, where) => adding(false, where),
  },
  {
    key: "A",
    hint: null,
    help: "add an idea and ask for its spec",
    onTask: false,
    step: (_, where) => adding(true, where),
  },
  {
    key: "y",
    hint: "approve",
    help: "ask for an idea's spec, or approve a spec, or a merge once you confirm",
    onTask: true,
    // y moves the task on: an Idea to Spec, or an approval through.
    hintFor: (task) =>
      task?.phase === "idea" ? "spec it" : awaitsApproval(task) ? "approve" : null,
    step: (task) => {
      if (task === undefined) return null;
      if (task.phase === "idea") return { kind: "run", run: askForSpec(task) };
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
    hint: "reject",
    help: "send it back, with what should change",
    onTask: true,
    hintFor: (task) => (awaitsApproval(task) ? "reject" : null),
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
    step: (task) => (task === undefined ? null : { kind: "run", run: askForSpec(task) }),
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
  {
    key: "p",
    hint: null,
    help: "put the task in a project, or take it out of its own",
    onTask: true,
    step: (task) =>
      task === undefined
        ? null
        : {
            kind: "type",
            prompt: `Move #${task.task} to which project? Type none to take it out:`,
            // The project by its name or its ID, as the CLI takes it.
            run: (typed) => {
              const project = typed.trim();
              return project.toLowerCase() === "none"
                ? {
                    args: ["project", "remove", `${task.task}`],
                    doing: `Taking #${task.task} out of its project…`,
                    task: task.task,
                  }
                : {
                    args: ["project", "add", `${task.task}`, "--", project],
                    doing: `Moving #${task.task}…`,
                    task: task.task,
                  };
            },
          },
  },
];

// The keys line's words: "a add · y approve · …" on the list, and only
// the keys that act on one task on the task screen. `task` is the task
// under the cursor, or the task that is open.
export function hints(screen: "list" | "task", task: TaskView | undefined): string {
  return actions
    .filter((action) => screen === "list" || action.onTask)
    .flatMap((action) => {
      const hint = action.hintFor === undefined ? action.hint : action.hintFor(task);
      return hint === null ? [] : [`${action.key} ${hint}`];
    })
    .join(" · ");
}
