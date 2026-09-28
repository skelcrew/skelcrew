import { describe, expect, test } from "bun:test";
import { commit, id, session, spec, worktree } from "../test/fixtures";
import { evolveTask } from "./evolve";
import { CommitSha, SessionId, TaskId } from "./ids";
import { waitingOnYou } from "./task";
import type { EventBody, Spec, Task } from "./types";

function replay(...bodies: EventBody[]): Task {
  let task: Task | null = null;
  for (const body of bodies) {
    const result = evolveTask(task, { ...body, v: 1, taskId: id, at: 1 });
    if (!result.ok) throw new Error(result.reason);
    task = result.task;
  }
  if (task === null) throw new Error("replay needs events");
  return task;
}

const created: EventBody = {
  type: "task.created",
  title: "CSV export",
  project: null,
  source: null,
};
const specRunning: EventBody[] = [
  created,
  { type: "task.spec_requested" },
  { type: "task.dispatch_started", request: 1 },
  { type: "task.spec_session_started", session },
];
const specced: EventBody[] = [...specRunning, { type: "task.specced", spec, by: "agent" }];
const inChecks: EventBody[] = [
  ...specced,
  { type: "task.ready" },
  { type: "task.dispatch_started", request: 2 },
  { type: "task.worktree_created", worktree, request: 3 },
  { type: "task.dispatched", session },
  {
    type: "task.done_reported",
    branch: { commits: 1, changedFiles: ["src/auth/a.ts"] },
    gate: "local",
    request: 4,
  },
  { type: "task.gate_passed", gate: "local", next: null },
  { type: "task.checks_passed" },
];
const done: EventBody[] = [
  ...inChecks,
  { type: "task.merge_started", request: 5 },
  { type: "task.merged", commit },
];

describe("waitingOnYou", () => {
  test("is nothing while an agent works", () => {
    expect(waitingOnYou(replay(...specRunning))).toBeNull();
  });

  test("is a spec to approve", () => {
    expect(waitingOnYou(replay(...specced))).toBe("spec_approval");
  });

  test("is a merge to approve", () => {
    const task = replay(...inChecks, {
      type: "task.merge_approval_requested",
      criticalFiles: ["src/auth/a.ts"],
    });
    expect(waitingOnYou(task)).toBe("merge_approval");
  });

  test("is an answer to a question", () => {
    const question = {
      from: "spec" as const,
      text: "Deleted rows?",
      options: ["Yes", "No"],
      askedAt: 1,
    };
    const task = replay(...specRunning, { type: "task.question_asked", question });
    expect(waitingOnYou(task)).toBe("answer");
  });

  test("is a retry for a blocked task", () => {
    const reason = { kind: "agent_gave_up" as const, message: "Stuck." };
    const task = replay(...specRunning, { type: "task.blocked", reason });
    expect(waitingOnYou(task)).toBe("retry");
  });

  test("is a failed revert", () => {
    const task = replay(
      ...done,
      { type: "task.revert_started", reason: "Broken.", request: 6 },
      { type: "task.revert_failed", summary: "Conflicts in export.ts" },
    );
    expect(waitingOnYou(task)).toBe("revert_failed");
  });

  test("is nothing for a task that's merged", () => {
    expect(waitingOnYou(replay(...done))).toBeNull();
  });
});
