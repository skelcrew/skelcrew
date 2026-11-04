// What each event on a thread's PR means for the thread, decided from plain data: the
// thread's row and what GitHub returned, with no clock, files or network.
import { expect, test } from "bun:test";
import { decide } from "../src/events.ts";
import type { Check, PullRequest } from "../src/github.ts";
import type { Thread } from "../src/thread.ts";

function thread(change: Partial<Thread> = {}): Thread {
  return {
    owner: "simon",
    repo: "app",
    task: 12,
    folder: "app-12",
    branch: "skel/12-add-export",
    base: null,
    status: "waiting",
    session: "s",
    rounds: 0,
    pr: 7,
    needs_you: false,
    submitting: null,
    reviewing: null,
    telling: null,
    last_review: 0,
    last_comment: 0,
    last_check: 0,
    asking: false,
    noting: null,
    ...change,
  };
}

const you = { login: "simon", bot: false };
const someone = { login: "ana", bot: false };
const bot = { login: "dependabot", bot: true };
const approved: Check = { kind: "status", name: "skel/review", state: "SUCCESS", url: null };
const run = (
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
): Extract<Check, { kind: "run" }> => ({
  kind: "run",
  id,
  name,
  status,
  conclusion,
  url: `https://github.com/simon/app/actions/runs/1/job/${id}`,
});

function pr(change: Partial<PullRequest> = {}): PullRequest {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    base: "main",
    reviews: [],
    comments: [],
    checks: [],
    ...change,
  };
}

const given: { you: string; maxRounds: number; posted: number[] } = {
  you: "simon",
  maxRounds: 3,
  posted: [],
};

// The decision for a thread whose PR is open and not ending.
function acted(t: Thread, p: PullRequest, g = given) {
  const decision = decide(t, p, g);
  if ("end" in decision) throw new Error(`the thread ended: ${decision.end}`);
  return decision;
}

test("a merged PR ends the thread", () => {
  expect(decide(thread(), pr({ state: "MERGED" }), given)).toEqual({ end: "PR #7 was merged" });
});

test("a PR closed without merging ends the thread too", () => {
  expect(decide(thread(), pr({ state: "CLOSED" }), given)).toEqual({
    end: "PR #7 was closed without merging",
  });
});

test("a failed check is handed on to tell the builder, with the thread working again", () => {
  const failing = run(30, "test", "COMPLETED", "FAILURE");
  const decision = acted(
    thread(),
    pr({ checks: [run(29, "lint", "COMPLETED", "SUCCESS"), failing] }),
  );
  expect(decision.failed).toEqual([failing]);
  expect(decision.handled.last_check).toBe(30);
  expect(decision.change).toEqual({ status: "working", needs_you: false });
});

test("a check still running, or cancelled, tells the builder nothing", () => {
  const checks = [run(30, "test", "IN_PROGRESS", null), run(31, "build", "COMPLETED", "CANCELLED")];
  const decision = acted(thread(), pr({ checks }));
  expect(decision.failed).toEqual([]);
  expect(decision.tell).toEqual([]);
  expect(decision.change).toEqual({});
});

test("a failed check already handled isn't told again", () => {
  const checks = [run(30, "test", "COMPLETED", "FAILURE")];
  const decision = acted(thread({ last_check: 30 }), pr({ checks }));
  expect(decision.failed).toEqual([]);
  expect(decision.change).toEqual({});
});

test("a failed check waits while a newer round is still being pushed", () => {
  const checks = [run(30, "test", "COMPLETED", "FAILURE")];
  const decision = acted(thread({ submitting: "Round 2" }), pr({ checks }));
  expect(decision.failed).toEqual([]);
  expect(decision.handled.last_check).toBe(0);
});

test("approved by skel's reviewer and every check green: the thread needs you", () => {
  const checks = [approved, run(30, "test", "COMPLETED", "SUCCESS")];
  const decision = acted(thread(), pr({ checks }));
  expect(decision.change).toEqual({ needs_you: true });
  expect(decision.why).toContain("ready to merge");
});

test("approved with no CI at all: the thread needs you", () => {
  expect(acted(thread(), pr({ checks: [approved] })).change).toEqual({ needs_you: true });
});

test("approved while a check still runs: the thread waits on CI", () => {
  const checks = [approved, run(30, "test", "IN_PROGRESS", null)];
  expect(acted(thread(), pr({ checks })).change).toEqual({});
});

test("green checks without skel's approval don't need you", () => {
  const checks = [run(30, "test", "COMPLETED", "SUCCESS")];
  expect(acted(thread(), pr({ checks })).change).toEqual({});
});

test("green checks don't need you while the builder works or a round is under way", () => {
  const checks = [approved];
  expect(acted(thread({ status: "working" }), pr({ checks })).change).toEqual({});
  expect(acted(thread({ reviewing: "abc" }), pr({ checks })).change).toEqual({});
  expect(acted(thread({ submitting: "Round 2" }), pr({ checks })).change).toEqual({});
});

test("a thread that already needs you isn't marked again", () => {
  expect(acted(thread({ needs_you: true }), pr({ checks: [approved] })).change).toEqual({});
});

test("your comment is typed into the builder, even past the round limit", () => {
  const comments = [{ id: 50, author: you, body: "Rename it to exportJson." }];
  const decision = acted(thread({ rounds: 4, needs_you: true }), pr({ comments }));
  expect(decision.tell).toEqual([expect.stringContaining("Rename it to exportJson.")]);
  expect(decision.tell[0]).toContain("simon");
  expect(decision.handled.last_comment).toBe(50);
  // Past the round limit the thread still needs you, as a round now would.
  expect(decision.change).toEqual({ status: "working", needs_you: true });
});

test("another person's comment is typed in, but not past the round limit", () => {
  const comments = [{ id: 50, author: someone, body: "Also handle CSV." }];
  expect(acted(thread(), pr({ comments })).tell).toEqual([
    expect.stringContaining("Also handle CSV."),
  ]);
  const past = acted(thread({ rounds: 4, needs_you: true }), pr({ comments }));
  expect(past.tell).toEqual([]);
  expect(past.handled.last_comment).toBe(50);
  expect(past.change).toEqual({});
});

test("a person's review is typed in with its line comments", () => {
  const reviews = [
    {
      id: 60,
      state: "CHANGES_REQUESTED",
      author: someone,
      body: "Two things.",
      comments: [{ path: "src/export.ts", line: 12, body: "Use the helper here." }],
    },
  ];
  const decision = acted(thread(), pr({ reviews }));
  expect(decision.tell).toHaveLength(1);
  expect(decision.tell[0]).toContain("Two things.");
  expect(decision.tell[0]).toContain("src/export.ts:12");
  expect(decision.tell[0]).toContain("Use the helper here.");
  expect(decision.handled.last_review).toBe(60);
  expect(decision.change).toEqual({ status: "working", needs_you: false });
});

test("skel's own review is never typed back, though it carries your login", () => {
  const reviews = [
    { id: 60, state: "COMMENTED", author: you, body: "**Approved.**\n\nFine.", comments: [] },
  ];
  const decision = acted(thread(), pr({ reviews }), { ...given, posted: [60] });
  expect(decision.tell).toEqual([]);
  expect(decision.handled.last_review).toBe(60);
});

test("a review of yours that skel didn't post is typed in", () => {
  const reviews = [{ id: 61, state: "COMMENTED", author: you, body: "Nit: naming.", comments: [] }];
  const decision = acted(thread(), pr({ reviews }), { ...given, posted: [60] });
  expect(decision.tell).toEqual([expect.stringContaining("Nit: naming.")]);
});

test("bot comments and reviews are ignored", () => {
  const comments = [{ id: 50, author: bot, body: "Bumped a dependency." }];
  const reviews = [{ id: 60, state: "COMMENTED", author: bot, body: "Summary.", comments: [] }];
  const decision = acted(thread(), pr({ comments, reviews }));
  expect(decision.tell).toEqual([]);
  expect(decision.handled).toEqual({ last_review: 60, last_comment: 50, last_check: 0 });
});

test("a comment or review already handled isn't typed in again", () => {
  const comments = [{ id: 50, author: you, body: "Old." }];
  const reviews = [{ id: 60, state: "COMMENTED", author: you, body: "Old.", comments: [] }];
  const decision = acted(thread({ last_comment: 50, last_review: 60 }), pr({ comments, reviews }));
  expect(decision.tell).toEqual([]);
  expect(decision.change).toEqual({});
});

test("a review still pending holds back the reviews after it until it is submitted", () => {
  const reviews = [
    { id: 60, state: "PENDING", author: you, body: "Draft.", comments: [] },
    { id: 61, state: "COMMENTED", author: someone, body: "Later.", comments: [] },
  ];
  const decision = acted(thread(), pr({ reviews }));
  expect(decision.tell).toEqual([]);
  expect(decision.handled.last_review).toBe(0);
});

test("a merge conflict tells the builder to merge the base branch", () => {
  const decision = acted(thread({ base: "next" }), pr({ mergeable: "CONFLICTING", base: "next" }));
  expect(decision.tell).toEqual([expect.stringContaining("conflicts with next")]);
  expect(decision.change).toEqual({ status: "working", needs_you: false });
});

test("a merge conflict is told once: the builder works on it until it submits", () => {
  const conflicting = pr({ mergeable: "CONFLICTING" });
  expect(acted(thread({ status: "working" }), conflicting).tell).toEqual([]);
  expect(acted(thread({ reviewing: "abc" }), conflicting).tell).toEqual([]);
});

test("an approved PR with a conflict doesn't need you yet", () => {
  const decision = acted(thread(), pr({ mergeable: "CONFLICTING", checks: [approved] }));
  expect(decision.change).toEqual({ status: "working", needs_you: false });
});

test("a thread never polled before starts after the PR's history, acting on none of it", () => {
  const comments = [{ id: 50, author: you, body: "Old." }];
  const reviews = [{ id: 60, state: "COMMENTED", author: someone, body: "Old.", comments: [] }];
  const checks = [run(30, "test", "COMPLETED", "FAILURE")];
  const fresh = thread({ last_review: null, last_comment: null, last_check: null });
  const decision = acted(fresh, pr({ comments, reviews, checks }));
  expect(decision).toMatchObject({
    handled: { last_review: 60, last_comment: 50, last_check: 30 },
    tell: [],
    failed: [],
    change: {},
  });
});

test("events that come together are told together", () => {
  const comments = [
    { id: 50, author: you, body: "First." },
    { id: 51, author: someone, body: "Second." },
  ];
  const checks = [run(30, "test", "COMPLETED", "TIMED_OUT")];
  const decision = acted(thread(), pr({ comments, checks }));
  expect(decision.tell).toHaveLength(2);
  expect(decision.failed).toHaveLength(1);
  expect(decision.handled).toEqual({ last_review: 0, last_comment: 51, last_check: 30 });
});
