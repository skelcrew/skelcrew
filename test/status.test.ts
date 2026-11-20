// The status module's five words: what a host shows for each thread's builder, from the same
// fields as its word in the sidebar.
import { expect, test } from "bun:test";
import { readyToMerge, shownOf } from "../src/flow/marks.ts";
import { statusOf, threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";

// A thread at work, with nothing else going on.
const state: Thread = {
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
  ci_seen: false,
  review_at: null,
  harness: null,
  short: null,
  assigned: false,
  changed: null,
  updates: [],
  state: null,
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
  needs_you_for: null,
  limit_decided: false,
  ended_at: null,
  ended_said: null,
  review_failed: false,
  agents: null,
  flow: "default",
  review_post: null,
  queued_since: null,
};
const status = (more: Partial<Thread>) => statusOf({ ...state, ...more }, 3);

test("a working builder works, and one waiting on its review or checks idles", () => {
  expect(status({})).toBe("working");
  expect(status({ status: "waiting", reviewing: "abc" })).toBe("idle");
  expect(status({ status: "waiting", verdict: "approve", checks: "pending" })).toBe("idle");
  expect(status({ status: "stopped" })).toBe("idle");
  expect(status({ status: "done" })).toBe("idle");
});

test("an approval with green checks is ready to merge", () => {
  const approved = { status: "waiting", needs_you: true, verdict: "approve" } as const;
  const green = { ...approved, ci_passed: true };
  expect(status({ ...green, checks: "passing" })).toBe("ready");
  // A PR with no CI, whose only check is Skelcrew's approval, and a branch without a forge.
  expect(status({ ...green, checks: null })).toBe("ready");
  expect(status({ ...approved, checks: null, pr: null })).toBe("ready");
  expect(status({ ...green, checks: "failing" })).toBe("needs you");
  // Needing you for another reason, such as a missing builder, before a poll found CI green.
  expect(status({ ...approved, checks: null })).toBe("needs you");
});

// An approved PR that conflicts left ready to merge. Something else making the thread need you
// again, such as its builder missing while messages wait, doesn't make it ready.
test("an approval whose PR conflicts isn't ready to merge, even once the thread needs you", () => {
  const approved = { status: "waiting", verdict: "approve", checks: "passing" } as const;
  expect(status({ ...approved, needs_you: true, conflicts: "main" })).toBe("needs you");
  expect(status({ ...approved, conflicts: "main" })).toBe("idle");
});

test("a question or the round limit needs you, and a failed review doesn't", () => {
  expect(status({ asking: true })).toBe("needs you");
  expect(status({ status: "waiting", needs_you: true, rounds: 4 })).toBe("needs you");
  // The lead hears of a failed review and can run it again.
  const failed = { status: "waiting", verdict: "failed", review_failed: true } as const;
  expect(status(failed)).toBe("idle");
  expect(threadWord({ ...state, ...failed }, 3)).toBe("review failed");
});

// The lead marks a thread when only you can unblock it, saying what to do, and the word says it.
test("a thread the lead marked needs you, and its word is the action", () => {
  const marked = {
    status: "waiting",
    needs_you_for: "apply the check.yml split in PR #463",
  } as const;
  expect(status(marked)).toBe("needs you");
  expect(threadWord({ ...state, ...marked }, 3)).toBe("apply the check.yml split in PR #463");
  expect(shownOf({ ...state, ...marked }, 3).mark).toEqual({ sign: "●", colour: "yellow" });
  // It says what you must do even over an approval, as the lead knows something blocks the merge.
  const approved = { ...marked, needs_you: true, verdict: "approve", checks: "passing" } as const;
  expect(status({ ...approved, ci_passed: true })).toBe("needs you");
  // A question or an error the builder stopped on comes first: you must answer it before anything.
  expect(threadWord({ ...state, ...marked, asking: true }, 3)).toBe("question");
  expect(threadWord({ ...state, ...marked, erred: true }, 3)).toBe("error");
});

// Past the round limit the thread needs you until someone decides: you arm a merge, or the lead
// or you clear it, and then it shows the round limit without needing you.
test("the round limit needs you only until a merge is armed or its mark is cleared", () => {
  const past = { status: "waiting", needs_you: true, rounds: 4, verdict: "changes" } as const;
  const word = (more: Partial<Thread>) => threadWord({ ...state, ...past, ...more }, 3);
  expect(status(past)).toBe("needs you");
  expect(word({})).toBe("round limit");
  expect(status({ ...past, merge_plan: "armed" })).toBe("idle");
  expect(word({ merge_plan: "armed" })).toBe("round limit");
  expect(shownOf({ ...state, ...past, merge_plan: "armed" }, 3).mark.sign).toBe("○");
  expect(status({ ...past, limit_decided: true })).toBe("idle");
});

// An armed merge merges an approved, green thread itself, so you have nothing to do.
test("an approved thread with a merge armed waits, hollow, and isn't counted as ready", () => {
  const ready = {
    status: "waiting",
    needs_you: true,
    verdict: "approve",
    checks: "passing",
    ci_passed: true,
    merge_plan: "armed",
  } as const;
  expect(status(ready)).toBe("idle");
  const mark = shownOf({ ...state, ...ready }, 3).mark;
  expect(mark).toEqual({ sign: "○", colour: "green" });
  expect(readyToMerge(mark)).toBe(false);
  expect(threadWord({ ...state, ...ready }, 3)).toBe("approved");
  // Without the merge armed, it waits on you to merge it.
  expect(status({ ...ready, merge_plan: null })).toBe("ready");
});

// The lead or you may mark a thread whatever its status, and the word must say what to do.
test("a mark on a queued, failed or stopped thread still says what to do", () => {
  for (const status of ["queued", "failed", "stopped"] as const)
    expect(threadWord({ ...state, status, needs_you_for: "approve the new design" }, 3)).toBe(
      "approve the new design",
    );
  // A done thread's end clears its mark, so it never shows one.
  expect(threadWord({ ...state, status: "done", needs_you_for: "approve it" }, 3)).toBe("done");
});

// Its last message went to the lead, who brings a real question to you.
test("a builder that stopped without submitting idles, and doesn't need you", () => {
  expect(status({ turn_ended: true, state: "idle" })).toBe("idle");
  expect(status({ status: "waiting", turn_ended: true, state: "idle" })).toBe("idle");
});

test("a harness that stopped on an error, or a thread that failed, is in error", () => {
  expect(status({ erred: true })).toBe("error");
  expect(status({ status: "failed" })).toBe("error");
  expect(status({ status: "failed", needs_you: true })).toBe("error");
});

test("a builder waiting out its usage limit idles, as it is woken once the limit resets", () => {
  expect(status({ erred: true, limited: true })).toBe("idle");
  expect(status({ erred: true, limited: true, asking: true })).toBe("needs you");
});

test("the builder's own state says whether it works, once a hook or its screen has told", () => {
  // Stopped with Esc, or on a Codex error the screen showed, while its thread still works.
  expect(status({ state: "idle" })).toBe("idle");
  // Still finishing the turn in which it submitted, while its review runs.
  expect(status({ status: "waiting", reviewing: "abc", state: "working" })).toBe("working");
  // A builder that isn't running doesn't work, whatever its last state was.
  expect(status({ status: "stopped", state: "working" })).toBe("idle");
  expect(status({ status: "done", state: "working" })).toBe("idle");
  // A question or an error needs you, as their flags say.
  expect(status({ state: "asking", asking: true })).toBe("needs you");
  expect(status({ state: "error", erred: true })).toBe("error");
});
