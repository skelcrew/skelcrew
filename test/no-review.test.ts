// A flow with no review stage: what a task on it shows, when it is ready, and what a merge when
// ready waits on, from the same pure functions every list and poll uses.
import { expect, test } from "bun:test";
import {
  type Check,
  decide,
  mergeWaitsOn,
  type PullRequest,
  pastRoundLimit,
  reviewCheck,
} from "../src/flow/decide.ts";
import { shownOf } from "../src/flow/marks.ts";
import { listStage, taskStage } from "../src/flow/stage.ts";
import { readyToMerge, threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";

const head = "a".repeat(40);

// A task on a flow with no review, whose last submit was marked not reviewed and waits on CI.
function thread(change: Partial<Thread> = {}): Thread {
  return {
    owner: "simon",
    repo: "app",
    task: "12",
    folder: "app-12",
    branch: "skelcrew/12-fix-typo",
    base: null,
    status: "waiting",
    session: "s",
    rounds: 0,
    pr: 7,
    needs_you: false,
    submitting: null,
    reviewing: null,
    queued: null,
    telling: null,
    held: null,
    seen: [],
    last_review: null,
    last_comment: null,
    last_check: null,
    asking: false,
    turn_ended: false,
    submitted: true,
    told_lead: false,
    erred: false,
    limited: false,
    limit_reset: null,
    review_limited: false,
    review_reset: null,
    conflicts: null,
    ci_passed: false,
    noting: null,
    title: null,
    body: null,
    started: null,
    checks: null,
    reviewer: null,
    reviewed_by: null,
    review_round: null,
    verdict: "not reviewed",
    review_line: null,
    reviewed_commit: head,
    ci_seen: false,
    review_at: null,
    harness: null,
    short: null,
    assigned: false,
    changed: null,
    updates: [],
    state: "idle",
    host: "tmux",
    host_id: null,
    merged: false,
    issue_link: null,
    closes: null,
    merge_plan: null,
    merge_id: null,
    merge_by: null,
    merge_at: null,
    merge_asked: null,
    merge_waits: null,
    merge_noted: null,
    merge_pinned: null,
    merge_record: null,
    merge_record_id: null,
    merge_followup: null,
    agents: null,
    flow: "noreview",
    review_post: null,
    queued_since: null,
    ...change,
  };
}

// Skelcrew's check, green with "not reviewed", and a CI check.
const ours: Check = { name: reviewCheck, id: null, state: "passed" };
const ci = (state: Check["state"]): Check => ({ name: "test", id: "1", state });

function pr(change: Partial<PullRequest> = {}): PullRequest {
  return {
    kind: "pr",
    id: "7",
    title: "Fix typo",
    body: "",
    state: "open",
    author: null,
    labels: [],
    link: "https://github.com/simon/app/pull/7",
    created: "2026-11-05T10:00:00Z",
    updated: "2026-11-05T10:00:00Z",
    branch: "skelcrew/12-fix-typo",
    head,
    base: "main",
    conflicts: false,
    reviews: [],
    comments: [],
    checks: [ours, ci("passed")],
    ...change,
  };
}

// Green: the poll found every check passed and marked the thread as waiting on you to merge.
const green = { needs_you: true, checks: "passing" as const, ci_passed: true };

test("a submit its flow doesn't review waits on CI, then is ready, and is never called approved", () => {
  // Waiting on CI, it shows checks, under Checks in the list, with a hollow mark.
  const waiting = thread();
  expect(threadWord(waiting, 3)).toBe("checks");
  expect(listStage(waiting, true)).toBe("checks");
  expect(taskStage(waiting, true)).toBe("working");
  expect(shownOf(waiting, 3).mark).toEqual({ sign: "○", colour: "dim" });
  // Green, it is ready to merge with its own word, and a green mark as an approval has.
  const ready = thread(green);
  expect(readyToMerge(ready)).toBe(true);
  expect(threadWord(ready, 3)).toBe("not reviewed");
  expect(shownOf(ready, 3)).toEqual({
    word: "not reviewed",
    status: "ready",
    mark: { sign: "●", colour: "green" },
  });
  expect(taskStage(ready, true)).toBe("ready for review");
  expect(listStage(ready, true)).toBe("ready");
  // Without a forge, it is ready on its branch at once.
  const branch = thread({ pr: null, needs_you: true });
  expect(threadWord(branch, 3)).toBe("not reviewed");
  // A newer submit under way, a failing check or a conflict takes it out of ready.
  expect(readyToMerge(thread({ ...green, submitting: "Round 2" }))).toBe(false);
  expect(readyToMerge(thread({ ...green, checks: "failing" }))).toBe(false);
  expect(readyToMerge(thread({ ...green, conflicts: "main" }))).toBe(false);
});

test("the poll marks a green PR whose flow has no review as ready, and says why", () => {
  const decision = decide(thread(), pr(), { maxRounds: 3, moved: false });
  if ("end" in decision) throw new Error("the thread ended");
  expect(decision.change).toEqual({ needs_you: true });
  expect(decision.why).toBe(
    "not reviewed, as its flow has none, with every check green, so it is ready to merge",
  );
  // CI still running, or Skelcrew's check not on the commit yet, isn't green.
  const running = decide(thread(), pr({ checks: [ours, ci("running")] }), {
    maxRounds: 3,
    moved: false,
  });
  if ("end" in running) throw new Error("the thread ended");
  expect(running.change).toEqual({});
  const without = decide(thread(), pr({ checks: [ci("passed")] }), { maxRounds: 3, moved: false });
  if ("end" in without) throw new Error("the thread ended");
  expect(without.change).toEqual({});
});

// A merge when ready waits only for CI, at the commit last submitted, and follows a newer
// submit as it follows a new approval.
test("a merge when ready on a flow with no review waits only on CI at the commit last submitted", () => {
  expect(mergeWaitsOn(thread(), pr(), head, true)).toBeNull();
  expect(mergeWaitsOn(thread(), pr({ checks: [ours, ci("running")] }), head, true)).toBe(
    "its checks",
  );
  expect(mergeWaitsOn(thread(), pr({ checks: [ours, ci("failed")] }), head, true)).toBe(
    "its failing checks to be fixed",
  );
  // A newer submit waits for its own round, and a push Skelcrew never made is never merged.
  expect(mergeWaitsOn(thread({ submitting: "Round 2" }), pr(), head, true)).toBe("its review");
  expect(mergeWaitsOn(thread(), pr({ head: "b".repeat(40) }), head, true)).toBe(
    "a review of its newest commit",
  );
  // Once that submit is marked not reviewed in turn, the merge goes at its commit.
  const newer = "b".repeat(40);
  const next = thread({ reviewed_commit: newer });
  expect(mergeWaitsOn(next, pr({ head: newer }), newer, true)).toBeNull();
});

test("a flow with no review counts no rounds, so it never reaches the round limit", () => {
  // Even a task whose rounds were counted past the limit before, such as by sc start going on,
  // isn't held there once its submit is marked not reviewed.
  expect(pastRoundLimit(thread({ rounds: 9 }), 3)).toBe(false);
  expect(threadWord(thread({ rounds: 9, needs_you: true }), 3)).not.toBe("round limit");
  expect(pastRoundLimit(thread({ rounds: 9, verdict: "changes" }), 3)).toBe(true);
});
