// What sc ps prints of each thread, and the word each thread gets wherever it is listed: in the
// list and in sc ps.
import { expect, spyOn, test } from "bun:test";
import { printThreads, type ThreadRow } from "../src/flow/list.ts";
import { threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";

// A row of sc ps for a thread, with no PR or review unless given.
const psRow = (change: Partial<ThreadRow>): ThreadRow => ({
  thread: "app-9",
  short: null,
  title: "Ok",
  status: "working",
  needsYou: false,
  queued: false,
  branch: "skelcrew/9",
  pr: null,
  prUrl: null,
  checks: null,
  review: null,
  waiting: 0,
  ...change,
});

test("sc ps says how many messages wait for each builder, and --json counts them", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  const rows = [
    psRow({ thread: "app-9", short: "Fix", waiting: 1 }),
    psRow({ thread: "app-8", short: "Ok", status: "waiting", needsYou: true }),
  ];
  try {
    printThreads(rows, false);
    printThreads(rows, true);
  } finally {
    log.mockRestore();
  }
  expect(said[0]).toEndWith("NEEDS YOU  WAITING");
  expect(said[1]).toEndWith("1");
  expect(said[2]).toEndWith("yes");
  expect(JSON.parse(said[3] ?? "")).toEqual(rows);
});

// sc ps shows a thread with no short title by its title, cut so the whole row, with its PR, CI
// and review, fits a terminal 80 columns wide.
test("sc ps cuts a long title so each row fits 80 columns", () => {
  const title = "Send people back to the page they came from after signing in";
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "dotfiles-t12",
          title,
          status: "waiting",
          needsYou: true,
          pr: 242,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(2);
  for (const line of said) expect(line.length).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("dotfiles-t12  Send people");
  expect(said[1]).toContain("…  waiting  #242  running  reviewing r12  yes");
});

// A Japanese title takes two columns for each letter, so it is measured and padded by the
// columns it takes, not its letters, and the columns after it still line up.
test("sc ps lines up and fits rows whose titles mix wide and narrow letters", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ thread: "app-1", title: "ログインのリダイレクトを直して元のページに戻す", pr: 1 }),
        psRow({ thread: "app-2", title: "Send people back to the page they came from", pr: 2 }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  // STATUS starts in the same column on every row.
  const at = (line: string) => Bun.stringWidth(line.slice(0, line.indexOf("working")));
  expect(at(said[1] ?? "")).toBe(at(said[2] ?? ""));
});

// A repository's name can be long, and so its threads' names. The name is cut in its middle, so
// its task, which tells threads apart, still shows, and the row still fits.
test("sc ps cuts a long thread name in its middle, keeping its task", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({
          thread: "a-repository-with-a-perfectly-valid-long-name-t7",
          title: "Send people back to the page they came from",
          status: "waiting",
          needsYou: true,
          pr: 1234,
          checks: "running",
          review: { state: "reviewing", round: 12, at: null },
        }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-repository-wit…-t7  ");
});

test("sc ps says a thread whose review waits for a place is queued for review", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = { short: "Export", title: null, status: "waiting" } as const;
    printThreads(
      [psRow({ ...row, thread: "app-9", queued: true }), psRow({ ...row, thread: "app-8" })],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toEqual([
    "THREAD  TITLE   STATUS             PR  CI  REVIEW  NEEDS YOU",
    "app-9   Export  queued for review",
    "app-8   Export  waiting",
  ]);
});

// With every other column at its widest, a thread queued for review next to one in its twelfth
// round, a long thread name is cut further, to what the row has left, and its task still shows.
test("sc ps fits 80 columns with a long name, a queued review and a late round", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    const row = {
      title: "Send people back to the page they came from",
      status: "waiting",
      needsYou: true,
      pr: 1234,
      checks: "running",
    } as const;
    printThreads(
      [
        psRow({ ...row, thread: "a-repository-with-a-perfectly-valid-long-name-t7", queued: true }),
        psRow({ ...row, thread: "app-8", review: { state: "reviewing", round: 12, at: null } }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  for (const line of said) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  expect(said[1]).toStartWith("a-reposi…-t7  Send…  queued for review  #1234  running");
  expect(said[2]).toContain("reviewing r12  yes");
});

// A title comes from the tracker and a short title from the lead, so either could hold a line
// break or a code your terminal would act on.
test("sc ps prints a title or short title with control codes as one clean row", () => {
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => said.push(line));
  try {
    printThreads(
      [
        psRow({ title: "Fix\nlogin\x1b[2J" }),
        psRow({ thread: "app-8", short: "Bad\x1b]8;;http://x\x07 one" }),
      ],
      false,
    );
  } finally {
    log.mockRestore();
  }
  expect(said).toHaveLength(3);
  for (const line of said) expect(line).not.toMatch(/\p{Cc}/u);
  expect(said[1]).toStartWith("app-9   Fix login [2J");
});

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
  closes: null,
};
const word = (more: Partial<Thread>) => threadWord({ ...state, ...more }, 3);
const needing = { status: "waiting", needs_you: true } satisfies Partial<Thread>;

test("a thread's word says who has it right now", () => {
  expect(word({})).toBe("working");
  expect(word({ status: "waiting", submitting: "the fix" })).toBe("reviewing");
  expect(word({ status: "waiting", reviewing: "abc" })).toBe("reviewing");
  expect(word({ status: "waiting", reviewing: "abc", queued: 5 })).toBe("queued for review");
  expect(word({ status: "waiting", verdict: "approve" })).toBe("checks");
  expect(word({ telling: "fix it", verdict: "changes" })).toBe("changes");
});

// A review that waited when the daemon stopped is saved with when it joined the queue, which a
// newer submit leaves behind until its own review joins.
test("a newer submit is reviewing, not queued, until its own review waits", () => {
  const waited = { status: "waiting", reviewing: "abc", queued: 5 } satisfies Partial<Thread>;
  expect(word({ ...waited, submitting: "the fix" })).toBe("reviewing");
  expect(word({ ...waited, needs_you: true })).toBe("review failed");
});

// A builder that replied to you or the lead and stopped must not hide what you must do next.
test("a builder that stopped without submitting doesn't hide an approval or the round limit", () => {
  const stalled = { ...needing, stalled: true };
  expect(word({ ...stalled, verdict: "approve", checks: "passing" })).toBe("approved");
  expect(word({ ...stalled, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  // Any other reason it needs you says less than the builder's stopping.
  expect(word({ ...stalled, verdict: "approve", checks: "failing" })).toBe("turn ended");
  expect(word({ ...stalled, verdict: "failed" })).toBe("turn ended");
});

test("a builder that took up the changes is working again", () => {
  expect(word({ verdict: "changes", rounds: 1 })).toBe("working");
});

test("each reason a thread needs you has its own word", () => {
  expect(word({ asking: true })).toBe("question");
  // A builder that stopped without submitting may only have replied, so it claims no question.
  expect(word({ stalled: true })).toBe("turn ended");
  expect(word({ erred: true })).toBe("error");
  expect(word({ ...needing, verdict: "approve", checks: "passing" })).toBe("approved");
  expect(word({ ...needing, verdict: "approve" })).toBe("approved");
  expect(word({ ...needing, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  expect(word({ ...needing, verdict: "failed" })).toBe("review failed");
  expect(word({ ...needing, verdict: "timed out" })).toBe("review timed out");
});

test("a round that failed before its review answered reads as a failed review", () => {
  expect(word({ ...needing, submitting: "the fix" })).toBe("review failed");
  expect(word({ ...needing, reviewing: "abc" })).toBe("review failed");
});

test("past the round limit it stays so while the builder submits again", () => {
  expect(word({ ...needing, rounds: 4, submitting: "the fix" })).toBe("round limit");
  expect(word({ ...needing, rounds: 4, reviewing: "abc" })).toBe("round limit");
});

test("approved is only said of a PR whose checks don't say otherwise", () => {
  expect(word({ ...needing, verdict: "approve", checks: "failing" })).toBe("needs you");
  expect(word({ ...needing, verdict: "approve", checks: "pending" })).toBe("needs you");
});

test("a thread that needs you for no reason in the table says just that", () => {
  expect(word({ needs_you: true })).toBe("needs you");
  expect(word({ ...needing, verdict: "changes", rounds: 1 })).toBe("needs you");
});

test("failed and stopped are as the status says, whatever else is true", () => {
  expect(word({ status: "failed", needs_you: true })).toBe("failed");
  expect(word({ status: "failed", asking: true })).toBe("failed");
  expect(word({ status: "stopped", erred: true })).toBe("stopped");
  expect(word({ status: "stopped", reviewing: "abc" })).toBe("stopped");
});
