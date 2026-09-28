// Reading a task: what phase it's in, what it waits on, and what it holds.
// decide, the scheduler, the simulator and the tests all read tasks through
// these, so a question about a task has one answer.

import type { Phase, SessionId, Task } from "./types";

// A task in one phase, for example TaskIn<"checks">.
export type TaskIn<P extends Phase> = Extract<Task, { phase: P }>;

// Phase names as the developer sees them, for rejection and inbox text.
export const phaseNames: Record<Phase, string> = {
  idea: "Idea",
  spec: "Spec",
  ready: "Ready",
  in_progress: "In progress",
  checks: "Checks",
  done: "Done",
  dropped: "Dropped",
};

// The session of the task's running agent, or null if none is running. In
// Checks the develop agent stays open, so it counts as running.
export function runningSession(task: Task): SessionId | null {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "running" ? task.step.session : null;
    case "checks":
      return task.step.kind === "gate" ? task.step.session : null;
    default:
      return null;
  }
}

// Which agent a question would come from, or null if none is running.
export function agentKind(task: Task): "spec" | "develop" | null {
  if (runningSession(task) === null) return null;
  return task.phase === "spec" ? "spec" : "develop";
}

// An agent running or starting, or a worktree being created for one.
export function agentUnderWay(task: Task): boolean {
  if (runningSession(task) !== null) return true;
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "starting";
    case "ready":
      return task.step.kind !== "queued";
    default:
      return false;
  }
}

// The request a task's current step waits on, or null if it waits on none.
export function awaitedRequest(task: Task): number | null {
  switch (task.phase) {
    case "spec":
    case "ready":
    case "in_progress":
    case "checks":
    case "done":
      return "request" in task.step ? task.step.request : null;
    default:
      return null;
  }
}

// The path of the worktree the task holds, or null if it holds none.
export function heldWorktree(task: Task): string | null {
  if (task.phase === "ready" && task.step.kind === "starting_session")
    return task.step.worktree.path;
  if (task.phase === "in_progress" || task.phase === "checks") return task.worktree.path;
  return null;
}

// Waiting for the worktree of this request. A reply to an earlier request
// is late, even while the task waits for a newer one.
export function waitingForWorktree(task: Task, request: number): boolean {
  return (
    task.phase === "ready" &&
    task.step.kind === "creating_worktree" &&
    task.step.request === request
  );
}

// Waiting for the agent of this request. An agent started for an earlier
// request, such as a spec agent whose task has since moved on, is late.
export function waitingForAgent(task: Task, request: number): boolean {
  switch (task.phase) {
    case "spec":
    case "in_progress":
      return task.step.kind === "starting" && task.step.request === request;
    case "ready":
      return task.step.kind === "starting_session" && task.step.request === request;
    default:
      return false;
  }
}

// What the task waits on the developer for, or null if it waits on nobody.
// The inbox lists every task where this isn't null.
export type WaitingOn = "retry" | "answer" | "spec_approval" | "merge_approval" | "revert_failed";

export function waitingOnYou(task: Task): WaitingOn | null {
  if (task.blocked !== null) return "retry";
  if (task.question !== null) return "answer";
  if (task.phase === "spec" && task.step.kind === "awaiting_approval") return "spec_approval";
  if (task.phase === "checks" && task.step.kind === "awaiting_merge_approval") {
    return "merge_approval";
  }
  if (task.phase === "done" && task.step.kind === "revert_failed") return "revert_failed";
  return null;
}
