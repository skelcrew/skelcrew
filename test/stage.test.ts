// A task's stage, from its builder thread and whether its issue is open.
import { expect, test } from "bun:test";
import { taskStage } from "../src/flow/stage.ts";
import type { Thread } from "../src/flow/thread.ts";

// A thread at work, with nothing else going on.
const working: Thread = {
  owner: "simon",
  repo: "app",
  task: "12",
  folder: "app-12",
  branch: "skelcrew/12",
  base: null,
  status: "working",
  session: null,
  rounds: 0,
  pr: 34,
  needs_you: false,
  submitting: null,
  reviewing: null,
  queued: null,
  telling: null,
  held: null,
  seen: [],
  last_review: 0,
  last_comment: 0,
  last_check: 0,
  asking: false,
  turn_ended: false,
  submitted: false,
  erred: false,
  limited: false,
  limit_reset: null,
  review_limited: false,
  review_reset: null,
  conflicts: null,
  ci_passed: false,
  noting: null,
  body: null,
  title: null,
  started: null,
  checks: null,
  reviewer: null,
  reviewed_by: null,
  review_round: null,
  verdict: null,
  review_line: null,
  review_at: null,
  harness: null,
  short: null,
  assigned: false,
  changed: null,
  updates: [],
  state: null,
  merged: false,
  issue_link: null,
  closes: null,
  host: "tmux",
  host_id: null,
  merge_plan: null,
  merge_id: null,
  merge_by: null,
  merge_at: null,
  merge_waits: null,
  merge_noted: null,
};
const thread = (more: Partial<Thread>) => ({ ...working, ...more });

test("an open issue never started is in stage issue, and one that closed is closed", () => {
  expect(taskStage(null, true)).toBe("issue");
  expect(taskStage(null, false)).toBe("closed");
});

test("a task with a thread on it is working, stopped or failed too", () => {
  for (const status of ["working", "waiting", "stopped", "failed"] as const)
    expect(taskStage(thread({ status }), true)).toBe("working");
});

test("an approval with green checks is ready for review, and only once it waits on you", () => {
  const approved = {
    status: "waiting" as const,
    verdict: "approve" as const,
    checks: "passing" as const,
    ci_passed: true,
  };
  expect(taskStage(thread({ ...approved, needs_you: true }), true)).toBe("ready for review");
  // A branch without a forge has no CI to wait on.
  const branch = { ...approved, checks: null, ci_passed: false, pr: null };
  expect(taskStage(thread({ ...branch, needs_you: true }), true)).toBe("ready for review");
  expect(taskStage(thread({ ...approved, needs_you: false }), true)).toBe("working");
  expect(taskStage(thread({ ...approved, needs_you: true, checks: "failing" }), true)).toBe(
    "working",
  );
  expect(taskStage(thread({ ...approved, needs_you: true, conflicts: "main" }), true)).toBe(
    "working",
  );
  expect(taskStage(thread({ ...approved, needs_you: true, reviewing: "abc" }), true)).toBe(
    "working",
  );
});

// After the review approves, the forge's checks are unknown until the next poll. A thread that
// needs you meanwhile for another reason, such as a missing builder, hasn't passed CI yet.
test("an approved PR whose checks no poll has seen yet isn't ready for review", () => {
  const approved = { status: "waiting" as const, verdict: "approve" as const, needs_you: true };
  expect(taskStage(thread({ ...approved, checks: null }), true)).toBe("working");
  expect(taskStage(thread({ ...approved, checks: null, ci_passed: true }), true)).toBe(
    "ready for review",
  );
});

test("a thread that failed or stopped after its approval keeps its task working", () => {
  const approved = { verdict: "approve" as const, checks: "passing" as const, needs_you: true };
  expect(taskStage(thread({ ...approved, status: "failed" }), true)).toBe("working");
  expect(taskStage(thread({ ...approved, status: "stopped" }), true)).toBe("working");
});

test("work that ended is merged, or else back in stage issue while the issue is open", () => {
  expect(taskStage(thread({ status: "done", merged: true }), false)).toBe("merged");
  expect(taskStage(thread({ status: "done", merged: true }), true)).toBe("merged");
  expect(taskStage(thread({ status: "done" }), true)).toBe("issue");
  expect(taskStage(thread({ status: "done" }), false)).toBe("closed");
});
