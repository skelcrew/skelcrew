// Reading a task: what phase it's in, what it waits on, and what it holds.
// decide, the scheduler, the simulator and the tests all read tasks through
// these, so a question about a task has one answer.

import type { Input, Phase, SessionId, SpecWorktree, Task } from "./types";

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

// Inputs as the developer would say them, for rejection text: "#12 is in
// Spec, so it can't take a merge approval."
export const inputNames: Record<Input["type"], string> = {
  add: "a new task",
  change_project: "a project change",
  request_spec: "a spec request",
  provide_spec: "a written spec",
  approve_spec: "a spec approval",
  revise_spec: "a spec revision",
  answer: "an answer",
  approve_merge: "a merge approval",
  revise_merge: "a merge revision",
  retry: "a retry",
  back_to_spec: "a move back to Spec",
  claim: "a claim",
  drop: "a drop",
  revert: "a revert",
  submit_spec: "a submitted spec",
  ask: "a question",
  report_done: "a done report",
  give_up: "an agent giving up",
  issue_delegated: "a delegated issue",
  external_move: "a move in another tool",
  worktree_created: "a new worktree",
  worktree_failed: "a failed worktree",
  spec_worktree_created: "a new spec worktree",
  spec_worktree_failed: "a failed spec worktree",
  session_started: "a started agent",
  session_failed: "an agent that didn't start",
  gate_result: "a gate result",
  merged: "a finished merge",
  merge_failed: "a failed merge",
  reverted: "a finished revert",
  revert_failed: "a failed revert",
  session_ended: "an agent's end",
  start: "a start",
  usage: "a usage report",
};

// The session of the task's running agent, or null if none is running. In
// Checks the develop agent stays open, so it counts as running. Your
// claimed session counts too.
export function runningSession(task: Task): SessionId | null {
  switch (task.phase) {
    case "spec":
      return task.step.kind === "running" || task.step.kind === "claimed"
        ? task.step.session
        : null;
    case "in_progress":
      return task.step.kind === "running" ? task.step.session : null;
    case "checks":
      return task.step.kind === "gate" ? task.step.session : null;
    default:
      return null;
  }
}

// An agent running or starting, or a worktree being created for one.
export function agentUnderWay(task: Task): boolean {
  if (runningSession(task) !== null) return true;
  switch (task.phase) {
    case "spec":
      return task.step.kind === "starting" || task.step.kind === "creating_worktree";
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

// The spec worktree the task holds, or null if it holds none: while its
// spec agent starts or runs, or while your claimed session works in it.
export function heldSpecWorktree(task: Task): SpecWorktree | null {
  if (task.phase !== "spec") return null;
  switch (task.step.kind) {
    case "starting":
    case "running":
    case "claimed":
      return task.step.worktree;
    default:
      return null;
  }
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

// Waiting for the spec worktree of this request, as above.
export function waitingForSpecWorktree(task: Task, request: number): boolean {
  return (
    task.phase === "spec" && task.step.kind === "creating_worktree" && task.step.request === request
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
