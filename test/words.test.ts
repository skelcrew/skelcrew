// A thread's word: the one word that says who has it now, or what it needs you for, which
// sc ps, the list and the tabs' badges all read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shownOf } from "../src/flow/marks.ts";
import { threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";
import { source, threadSql } from "./harness.ts";

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
  top_round: null,
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
  host: "tmux",
  host_id: null,
  merged: false,
  issue_link: null,
  issue: null,
  alias: null,
  closes: null,
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
  review_findings: null,
  round_log: null,
  queued_since: null,
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
  // Checks is only for an approval waiting on CI. Changes asked for wait on the builder, and a
  // thread with neither only waits.
  expect(word({ status: "waiting", verdict: "changes", checks: "passing" })).toBe("changes");
  expect(word({ status: "waiting", verdict: null })).toBe("waiting");
  expect(word({ status: "waiting", verdict: "failed" })).toBe("waiting");
});

// A review that waited when the daemon stopped is saved with when it joined the queue, which a
// newer submit leaves behind until its own review joins.
test("a newer submit is reviewing, not queued, until its own review waits", () => {
  const waited = { status: "waiting", reviewing: "abc", queued: 5 } satisfies Partial<Thread>;
  expect(word({ ...waited, submitting: "the fix" })).toBe("reviewing");
  expect(word({ ...waited, review_failed: true })).toBe("review failed");
});

// A builder that replied to you or the lead and stopped waits on the lead, so it must not hide
// what you must do next.
test("a builder that stopped without submitting doesn't hide anything that needs you", () => {
  const ended = { ...needing, turn_ended: true };
  expect(word({ ...ended, verdict: "approve", checks: "passing", ci_passed: true })).toBe(
    "approved",
  );
  expect(word({ ...ended, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  expect(word({ ...ended, verdict: "approve", checks: "failing" })).toBe("needs you");
  expect(word({ ...ended, verdict: "failed", review_failed: true })).toBe("review failed");
  // Alone it says so, without claiming a question, as it may only have replied.
  expect(word({ turn_ended: true })).toBe("turn ended");
});

test("a builder that took up the changes is working again", () => {
  expect(word({ verdict: "changes", rounds: 1 })).toBe("working");
});

test("each reason a thread needs you has its own word", () => {
  expect(word({ asking: true })).toBe("question");
  expect(word({ erred: true })).toBe("error");
  const green = { ...needing, verdict: "approve", ci_passed: true } as const;
  expect(word({ ...green, checks: "passing" })).toBe("approved");
  expect(word(green)).toBe("approved");
  expect(word({ ...needing, verdict: "changes", rounds: 4, held: "fix" })).toBe("round limit");
  expect(word({ asking: true, needs_you_for: "apply the fix in #463" })).toBe("question");
  expect(word({ needs_you_for: "apply the fix in #463" })).toBe("apply the fix in #463");
});

// The lead hears of a review that failed and can run it again, so it doesn't need you, but the
// word says so until the builder works again or a new round starts.
test("a review that failed or timed out says so, without needing you", () => {
  const failed = { status: "waiting", review_failed: true } satisfies Partial<Thread>;
  expect(word({ ...failed, verdict: "failed" })).toBe("review failed");
  expect(word({ ...failed, verdict: "timed out" })).toBe("review timed out");
});

test("a round that failed before its review answered reads as a failed review", () => {
  const failed = { status: "waiting", review_failed: true } satisfies Partial<Thread>;
  expect(word({ ...failed, submitting: "the fix" })).toBe("review failed");
  expect(word({ ...failed, reviewing: "abc" })).toBe("review failed");
});

// A submit past the round limit drops the held changes and waits on its review, which never
// needs you, so it reads as reviewing until a review asks for changes again.
test("past the round limit, a submit under way reads as reviewing", () => {
  const past = { status: "waiting", rounds: 4, verdict: "changes" } satisfies Partial<Thread>;
  expect(word({ ...past, submitting: "the fix" })).toBe("reviewing");
  expect(word({ ...past, reviewing: "abc" })).toBe("reviewing");
});

// A thread past the round limit can still be approved, such as once you rerun its review. The
// approval answers the changes the limit held, so it must not keep saying round limit.
test("an approval past the round limit reads as approved, not as the round limit", () => {
  const green = { ...needing, verdict: "approve", checks: "passing", ci_passed: true } as const;
  expect(word({ ...green, rounds: 4 })).toBe("approved");
  expect(shownOf({ ...state, ...green, rounds: 4 }, 3).mark).toEqual({
    sign: "●",
    colour: "green",
  });
  // Waiting on CI after it, it needs you for nothing.
  expect(word({ status: "waiting", verdict: "approve", rounds: 4 })).toBe("checks");
});

test("approved is only said of a PR whose checks don't say otherwise", () => {
  expect(word({ ...needing, verdict: "approve", checks: "failing" })).toBe("needs you");
  expect(word({ ...needing, verdict: "approve", checks: "pending" })).toBe("needs you");
  // No poll has seen its checks since the approval.
  expect(word({ ...needing, verdict: "approve" })).toBe("needs you");
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

describe("the tabs' badges", () => {
  let home = "";
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "skel-words-test-")));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("each repository's tab counts what needs you and what is ready apart", () => {
    // app has a red mark, for its harness error, site and docs only yellow ones, and web an
    // approved thread, which is ready rather than needing you. Threads working, stopped, failed
    // or done count for neither, nor does one whose turn ended, as each waits on the lead. old's
    // lead was exited, which closed its tab.
    const threads = [
      { repo: "site", task: "1", status: "waiting", needs_you: 1 },
      { repo: "site", task: "2", asking: 1 },
      { repo: "site", task: "3", status: "failed", needs_you: 1 },
      { repo: "site", task: "4" },
      { repo: "site", task: "5", status: "done", needs_you: 1 },
      { repo: "app", task: "6", status: "stopped" },
      { repo: "app", task: "7", erred: 1 },
      { repo: "app", task: "8", status: "waiting", turn_ended: 1 },
      { repo: "docs", task: "9", asking: 1 },
      { repo: "docs", task: "10" },
      { repo: "web", task: "11", status: "waiting", needs_you: 1, verdict: "approve" },
    ]
      .map((row) => threadSql(row))
      .join("\n");
    const code = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { repositoryTabs } from ${JSON.stringify(source("list/rows.ts"))};
const db = openDb();
db.run(\`INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site'), ('app', 'simon', 'app'),
  ('docs', 'simon', 'docs'), ('web', 'simon', 'web');
INSERT INTO repositories (name, owner, repo, tab_closed) VALUES ('old', 'simon', 'old', 1);
${threads}\`);
console.log(JSON.stringify(repositoryTabs(db, null)));`;
    const run = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual([
      { name: "app", fullName: "simon/app", needYou: 1, colour: "red", ready: 0 },
      { name: "docs", fullName: "simon/docs", needYou: 1, colour: "yellow", ready: 0 },
      { name: "site", fullName: "simon/site", needYou: 2, colour: "yellow", ready: 0 },
      { name: "web", fullName: "simon/web", needYou: 0, colour: "yellow", ready: 1 },
    ]);
  });
});
