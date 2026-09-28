// Values and helpers the tests share. A test that needs a different config
// spreads this one and changes only what it's about, so the difference is
// what you read.

import { CommitSha, SessionId, TaskId } from "../core/ids";
import { awaitedRequest, runningSession } from "../core/task";
import type { Config, Spec, Task } from "../core/types";

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
