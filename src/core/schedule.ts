// Schedule: picks which waiting tasks start next. It only proposes: each
// pick becomes a "start" input that decideTask can still reject.
//
// Finish before start: a retried task in In progress goes first, then
// Ready, then Spec. Work closest to done gets the free slot, so fewer tasks
// sit half-finished. Within a phase, the oldest task goes first.

import { runningSession } from "./task";
import type { Phase, Project, ProjectId, Schedule, Task } from "./types";

const phaseOrder: Partial<Record<Phase, number>> = { in_progress: 0, ready: 1, spec: 2 };

export const schedule: Schedule = (tasks, projects, config, startsInFlight) => {
  const free = config.maxRunning - tasks.filter(runsAgent).length - startsInFlight;
  if (free <= 0) return [];
  return tasks
    .filter((task) => waitingForSlot(task) && inActiveProject(task, projects))
    .sort(
      (a, b) =>
        (phaseOrder[a.phase] ?? 0) - (phaseOrder[b.phase] ?? 0) ||
        a.createdAt - b.createdAt ||
        a.id - b.id,
    )
    .slice(0, free)
    .map((task) => task.id);
};

// An agent that has started and is running. Agents and worktrees still
// being started are counted through startsInFlight instead. A task past its
// gates runs no agent: it was stopped while the merge waits or runs.
function runsAgent(task: Task): boolean {
  return runningSession(task) !== null;
}

// Blocked tasks also sit in "queued", but they wait for the developer.
function waitingForSlot(task: Task): boolean {
  switch (task.phase) {
    case "spec":
    case "ready":
    case "in_progress":
      return task.step.kind === "queued" && task.blocked === null;
    default:
      return false;
  }
}

// Tasks with no project count as active.
function inActiveProject(task: Task, projects: ReadonlyMap<ProjectId, Project>): boolean {
  return task.project === null || projects.get(task.project)?.status !== "parked";
}
