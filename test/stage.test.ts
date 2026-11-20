// A task's stage, from its builder thread and whether its issue is open, and the stage of the
// list it shows under.
import { expect, test } from "bun:test";
import { listStage, taskStage } from "../src/flow/stage.ts";
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
  told_lead: false,
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
  reviewed_commit: null,
  no_ci: null,
  ci_shown: [],
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
  merge_asked: null,
  merge_waits: null,
  merge_noted: null,
  merge_noted_for: [],
  merge_pinned: null,
  merge_record: null,
  merge_record_id: null,
  merge_followup: null,
  needs_you_for: null,
  limit_decided: false,
  ended_at: null,
  ended_said: null,
  review_failed: false,
  agents: null,
  flow: "default",
  review_post: null,
  posting: null,
  queued_since: null,
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

// Each state a task can be in, and the stage of the list it shows under.
test("the list puts each task in exactly one stage, from its state", () => {
  const approved = { status: "waiting" as const, verdict: "approve" as const };
  const ready = { ...approved, needs_you: true, checks: "passing" as const, ci_passed: true };
  const cases: [string, Thread | null, boolean, string][] = [
    ["an open issue never started", null, true, "backlog"],
    ["an issue whose work ended without a merge", thread({ status: "done" }), true, "backlog"],
    ["a builder at work", working, true, "building"],
    ["a builder at work on an issue that closed", working, false, "building"],
    ["a builder asking a question", thread({ asking: true, needs_you: true }), true, "building"],
    ["a builder whose harness erred", thread({ erred: true, needs_you: true }), true, "building"],
    ["a builder on its usage limit", thread({ erred: true, limited: true }), true, "building"],
    ["a builder whose turn ended", thread({ turn_ended: true }), true, "building"],
    ["changes waiting to be typed in", thread({ telling: "Fix it." }), true, "building"],
    ["a builder at work on changes", thread({ verdict: "changes", rounds: 1 }), true, "building"],
    [
      "changes held at the round limit",
      thread({ status: "waiting", verdict: "changes", held: "Fix it.", needs_you: true }),
      true,
      "building",
    ],
    ["a thread that stopped", thread({ status: "stopped" }), true, "building"],
    ["a thread that failed", thread({ status: "failed" }), true, "building"],
    [
      "a thread that stopped after its approval",
      thread({ ...ready, status: "stopped" }),
      true,
      "building",
    ],
    [
      "a failed check sent to the builder",
      thread({ ...approved, status: "working", checks: "failing" }),
      true,
      "building",
    ],
    [
      "a conflict sent to the builder",
      thread({ ...approved, status: "working", conflicts: "main" }),
      true,
      "building",
    ],
    [
      "a submit not yet pushed",
      thread({ status: "waiting", submitting: "Add it" }),
      true,
      "reviewing",
    ],
    ["a review under way", thread({ status: "waiting", reviewing: "abc" }), true, "reviewing"],
    [
      "a review queued for a place",
      thread({ status: "waiting", reviewing: "abc", queued: 1 }),
      true,
      "reviewing",
    ],
    [
      "a review held on its usage limit",
      thread({ status: "waiting", review_limited: true }),
      true,
      "reviewing",
    ],
    [
      "a review that failed",
      thread({ status: "waiting", verdict: "failed", review_failed: true }),
      true,
      "reviewing",
    ],
    [
      "a review that timed out",
      thread({ status: "waiting", verdict: "timed out", review_failed: true }),
      true,
      "reviewing",
    ],
    [
      "a review of a builder past its round limit",
      thread({ status: "waiting", reviewing: "abc", needs_you: true, held: "Fix it." }),
      true,
      "reviewing",
    ],
    [
      "a submit past the round limit, under review",
      thread({ status: "waiting", reviewing: "abc", needs_you: true, rounds: 6 }),
      true,
      "reviewing",
    ],
    ["an approval waiting on CI", thread({ ...approved, checks: "pending" }), true, "checks"],
    ["an approval no poll has checked yet", thread(approved), true, "checks"],
    [
      "an approval waiting on CI whose builder asks",
      thread({ ...approved, checks: "pending", asking: true, needs_you: true }),
      true,
      "checks",
    ],
    ["an approval with green checks", thread(ready), true, "ready"],
    [
      "an approval with no forge",
      thread({ ...ready, checks: null, ci_passed: false, pr: null }),
      true,
      "ready",
    ],
    [
      "an approval with green checks whose builder asks",
      thread({ ...ready, asking: true }),
      true,
      "ready",
    ],
    [
      "an approval armed to merge when ready",
      thread({ ...ready, merge_plan: "armed" }),
      true,
      "ready",
    ],
    ["a merged task", thread({ status: "done", merged: true }), false, "done"],
    [
      "a merged task whose issue is still open",
      thread({ status: "done", merged: true }),
      true,
      "done",
    ],
    ["a task closed without a merge", thread({ status: "done" }), false, "done"],
  ];
  for (const [what, given, issueOpen, stage] of cases)
    expect(`${what}: ${listStage(given, issueOpen)}`).toBe(`${what}: ${stage}`);
});
