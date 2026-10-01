// Values and helpers the tests share. A test that needs a different config
// spreads this one and changes only what it's about, so the difference is
// what you read.

import { CommitSha, type ProjectId, SessionId, TaskId } from "../core/ids";
import { awaitedRequest, runningSession } from "../core/task";
import type { Config, Spec, Task, TaskEvent } from "../core/types";

export const config: Config = {
  gates: ["local", "review"],
  maxAttempts: 3,
  maxRunning: 2,
  specApproval: "always",
  criticalPaths: ["src/auth/**"],
  safetyCap: { tokens: 200_000, ms: 60 * 60_000 },
};

export const id = TaskId.parse(12);

export const spec: Spec = {
  scope: "Add a CSV export button to the reports page.",
  acceptance: ["Clicking Export downloads a CSV of the visible rows."],
  openQuestions: [],
};

export const session = SessionId.parse("session-1");
export const worktree = { path: "/repo/.worktrees/12", branch: "task/12-csv-export" };
// The copy of main #12's spec is written in.
export const specWorktree = { path: "/repo/.skelcrew/spec-worktrees/12-csv-export" };
export const commit = CommitSha.parse("a".repeat(40));
// The commit at a branch's tip when its agent reports done.
export const head = CommitSha.parse("d".repeat(40));

// The session of the task's running agent, the way the daemon names the
// sender of an agent's report. "nobody" when no agent is running.
export function agentOf(task: Task | null): SessionId {
  return (task && runningSession(task)) ?? SessionId.parse("nobody");
}

// The request the task's current step waits on, or 0 if none, so a reply
// can answer it the way the daemon matches replies.
export function awaited(task: Task | null): number {
  return (task && awaitedRequest(task)) ?? 0;
}

// The events of a task whose spec an agent Skelcrew started has written,
// now waiting for your approval. The daemon can't start agents yet, so
// tests write these straight into the store. The agent is named after the
// task, such as agent-1.
export function backgroundSpecced(
  taskId: TaskId,
  title: string,
  project: ProjectId | null = null,
): TaskEvent[] {
  const stamp = { v: 1 as const, taskId, at: 1 };
  return [
    { ...stamp, type: "task.created", title, project, source: null },
    { ...stamp, type: "task.spec_requested" },
    { ...stamp, type: "task.dispatch_started", request: 1 },
    {
      ...stamp,
      type: "task.spec_worktree_created",
      worktree: { path: `/repo/.skelcrew/spec-worktrees/${taskId}` },
      request: 2,
    },
    { ...stamp, type: "task.spec_session_started", session: SessionId.parse(`agent-${taskId}`) },
    { ...stamp, type: "task.specced", spec, by: "agent" },
  ];
}
