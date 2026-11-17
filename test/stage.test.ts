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
  stalled: false,
  submitted: false,
  erred: false,
  limited: false,
  limit_reset: null,
  review_limited: false,
  review_reset: null,
  conflicts: null,
  ci_failed: false,
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
  };
  expect(taskStage(thread({ ...approved, needs_you: true }), true)).toBe("ready for review");
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
  // A failed check the builder was told of needs its next round, though the check passed since.
  expect(taskStage(thread({ ...approved, needs_you: true, ci_failed: true }), true)).toBe(
    "working",
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
