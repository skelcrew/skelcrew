// Evolve: folds one event into a task. It only applies facts that decide
// already accepted, so it holds no rules of its own. Replaying a task's
// events through it, starting from null, rebuilds the task exactly.

import type { Evolve, Evolved, Phase, Task, TaskEvent } from "./types";

const noUsage = { tokens: 0, ms: 0 };

export const evolve: Evolve = (task, event) => {
  if (event.type === "task.created") {
    if (task !== null) {
      return refuse(event, `#${event.taskId} already exists`);
    }
    return {
      ok: true,
      task: {
        phase: "idea",
        id: event.taskId,
        title: event.title,
        project: event.project,
        source: event.source,
        createdAt: event.at,
        question: null,
        blocked: null,
        builds: 0,
        usage: noUsage,
        usageAtRetry: noUsage,
      },
    };
  }
  if (task === null) {
    return refuse(event, `#${event.taskId} doesn't exist`);
  }

  switch (event.type) {
    case "task.spec_requested":
      if (task.phase !== "idea") return wrongPhase(event, task);
      return {
        ok: true,
        task: { ...task, phase: "spec", spec: null, note: null, step: { kind: "queued" } },
      };

    case "task.specced":
      if (task.phase !== "spec") return wrongPhase(event, task);
      return {
        ok: true,
        task: { ...task, spec: event.spec, note: null, step: { kind: "awaiting_approval" } },
      };

    default:
      return refuse(event, "not handled yet");
  }
};

function refuse(event: TaskEvent, why: string): Evolved {
  return { ok: false, reason: `${event.type} can't apply: ${why}.` };
}

function wrongPhase(event: TaskEvent, task: Task): Evolved {
  return {
    ok: false,
    reason: `${event.type} can't apply to #${task.id} in ${phaseNames[task.phase]}.`,
  };
}

const phaseNames: Record<Phase, string> = {
  idea: "Idea",
  spec: "Spec",
  ready: "Ready",
  in_progress: "In progress",
  checks: "Checks",
  done: "Done",
  dropped: "Dropped",
};
