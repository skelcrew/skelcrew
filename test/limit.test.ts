// A harness's usage limit as Skelcrew reads it: the error each harness's reviewer ends on, whether
// that is a usage limit and when it resets, how long reviews wait on it, and what a thread
// waiting out a limit shows.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import { resetTime } from "../src/agents/reset.ts";
import { waitUntil, wakeTime } from "../src/flow/limits.ts";
import { shownOf } from "../src/flow/marks.ts";
import { needsYou, threadWord } from "../src/flow/status.ts";
import type { Thread } from "../src/flow/thread.ts";
import { source } from "./harness.ts";

// 16 November 2026 at 10:30 in this machine's time zone, as the harnesses read their times in it.
const now = new Date(2026, 10, 16, 10, 30).getTime();
const at = (day: number, hours: number, minutes: number, year = 2026, month = 10) =>
  new Date(year, month, day, hours, minutes).getTime();

test("a reset time is read as Codex and Claude Code write it, in this machine's time zone", () => {
  expect(resetTime("1:59 PM.", now)).toBe(at(16, 13, 59));
  expect(resetTime("2pm", now)).toBe(at(16, 14, 0));
  expect(resetTime("2:30pm", now)).toBe(at(16, 14, 30));
  expect(resetTime("12 AM", now)).toBe(at(17, 0, 0));
  // A time already gone today is tomorrow's, unless it was less than a minute ago.
  expect(resetTime("9:15 AM", now)).toBe(at(17, 9, 15));
  expect(resetTime("10:30 AM", now + 30_000)).toBe(at(16, 10, 30));
  expect(resetTime("Nov 17th, 2026 1:59 PM.", now)).toBe(at(17, 13, 59));
  expect(resetTime("Nov 20, 9am", now)).toBe(at(20, 9, 0));
  expect(resetTime("Jan 2, 9am", now)).toBe(at(2, 9, 0, 2027, 0));
  expect(resetTime("later", now)).toBeNull();
  expect(resetTime("13:00 PM", now)).toBeNull();
});

test("a reset time read in the zone Claude Code names, whatever this machine's zone", () => {
  // 10:30 UTC on 16 November, when New York is five hours behind.
  const utc = Date.UTC(2026, 10, 16, 10, 30);
  expect(resetTime("2pm (America/New_York)", utc)).toBe(Date.UTC(2026, 10, 16, 19, 0));
  // 3am in New York is 8:00 UTC, which has gone, so it is tomorrow's.
  expect(resetTime("3am (America/New_York)", utc)).toBe(Date.UTC(2026, 10, 17, 8, 0));
  expect(resetTime("Nov 20, 9am (UTC)", utc)).toBe(Date.UTC(2026, 10, 20, 9, 0));
  // A zone this machine doesn't know is read as its own.
  expect(resetTime("2pm (Nowhere/Here)", now)).toBe(at(16, 14, 0));
});

test("Codex's error is its ERROR line, not the prompt it echoed before it", () => {
  const echoed = "user\nReview this pull request.\n# Fix the login\nIt fails one run in ten.\n";
  const err = `${echoed}ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:59 PM.\n`;
  const error = codex.failure("", err);
  expect(error).toStartWith("You've hit your usage limit.");
  expect(codex.usageLimit(error ?? "", now)).toEqual({ reset: at(16, 13, 59) });
  // The prompt has no newline at its end, so the error can follow its last line.
  const glued = "...so the builder can fix it.ERROR: stream disconnected before completion\n";
  expect(codex.failure("", glued)).toBe("stream disconnected before completion");
  // A command it ran can print an ERROR line too. Only Codex's own last line counts.
  expect(codex.failure("", "ERROR: rate limit exceeded\ntests failed: 3\n")).toBeNull();
  expect(codex.failure("", echoed)).toBeNull();
});

test("a Codex usage limit with no reset time, or another error, reads as such", () => {
  expect(codex.usageLimit("You've hit your usage limit. Try again later.", now)).toEqual({
    reset: null,
  });
  expect(codex.usageLimit("stream disconnected before completion", now)).toBeNull();
});

test("Claude Code's error is the result it printed, and a usage limit gives its reset", () => {
  const limit = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    result: "You've hit your limit · resets 2pm (Europe/London)",
  });
  const error = claude.failure(limit, "");
  expect(error).toBe("You've hit your limit · resets 2pm (Europe/London)");
  // London keeps UTC in November.
  const utc = Date.UTC(2026, 10, 16, 10, 30);
  expect(claude.usageLimit(error ?? "", utc)).toEqual({ reset: Date.UTC(2026, 10, 16, 14, 0) });
  // Older versions gave the reset in seconds since 1970.
  expect(claude.usageLimit("Claude AI usage limit reached|1794843540", now)).toEqual({
    reset: 1794843540_000,
  });
  expect(claude.usageLimit("API Error: Rate limit reached", now)).toEqual({ reset: null });
  expect(claude.usageLimit("Invalid API key · Please run /login", now)).toBeNull();
  expect(claude.usageLimit("5-hour limit reached ∙ resets 3pm", now)).toEqual({
    reset: at(16, 15, 0),
  });
  expect(
    claude.usageLimit("Context limit reached · /compact or /clear to continue", now),
  ).toBeNull();
  // An answer is no error.
  const answer = JSON.stringify({ type: "result", is_error: false, structured_output: {} });
  expect(claude.failure(answer, "")).toBeNull();
  expect(claude.failure("not json", "")).toBeNull();
});

// Runs code against the limits, with Skelcrew's database in a home of the test's own, and returns
// what it printed as JSON. Each run is a process of its own, as a daemon is, so a second run
// stands in for the daemon after a restart.
function daemonRun(home: string, code: string): unknown {
  const script = `import { openDb } from ${JSON.stringify(source("db.ts"))};
import { endLimit, limitOn, reachLimit, restoreLimits, tellOfLimit } from ${JSON.stringify(source("flow/limits.ts"))};
const db = openDb();
const now = ${now};
${code}`;
  const ran = Bun.spawnSync([process.execPath, "-e", script], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!ran.success) throw new Error(ran.stderr.toString());
  return JSON.parse(ran.stdout.toString());
}

test("reviews on a limited harness wait for its reset, or for a growing wait with none", () => {
  const home = mkdtempSync(join(tmpdir(), "skel-limit-test-"));
  try {
    const waits = daemonRun(
      home,
      `const until = (h) => limitOn(h, now)?.until ?? null;
const seen = [];
reachLimit(db, "codex", ${at(16, 13, 59)}, now);
seen.push(until("codex"), limitOn("codex", ${at(16, 13, 59)}));
// With no reset time, 15 minutes, then 30, then an hour each time.
for (let i = 0; i < 4; i++) { reachLimit(db, "claude", null, now); seen.push(until("claude")); }
// A reset in the minute just gone is tried a minute on, not at once.
reachLimit(db, "claude", now - 30_000, now);
seen.push(until("claude"));
// The same past reset again means it hasn't reset, such as on a clock running fast: the
// growing wait, so held reviews don't try every minute.
for (let i = 0; i < 2; i++) { reachLimit(db, "codex", now - 30_000, now); }
seen.push(until("codex"));
reachLimit(db, "codex", now - 30_000, now);
seen.push(until("codex"));
console.log(JSON.stringify(seen));`,
    );
    const minutes = (m: number) => now + m * 60_000;
    expect(waits).toEqual([
      at(16, 13, 59),
      null,
      minutes(15),
      minutes(30),
      minutes(60),
      minutes(60),
      minutes(1),
      minutes(15),
      minutes(30),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// With more than one review at once, a review that started before another met the limit can
// finish cleanly after it, as its last call came before the limit. That says nothing of the
// limit, so it holds, and the lead hears nothing.
test("only a review that started after the limit was reached ends it", () => {
  const home = mkdtempSync(join(tmpdir(), "skel-limit-test-"));
  try {
    const seen = daemonRun(
      home,
      `const notes = () => db.query("SELECT COUNT(*) AS n FROM notes").get().n;
reachLimit(db, "codex", null, now);
tellOfLimit(db, "no-tmux", "codex", { owner: "simon", repo: "app" }, null);
endLimit(db, "no-tmux", "codex", now - 1000);
const early = { held: limitOn("codex", now) !== null, notes: notes() };
endLimit(db, "no-tmux", "codex", now + 16 * 60_000);
const late = { held: limitOn("codex", now) !== null, notes: notes() };
console.log(JSON.stringify({ early, late }));`,
    );
    expect(seen).toEqual({ early: { held: true, notes: 1 }, late: { held: false, notes: 2 } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a daemon started again keeps each limit, its backoff and who was told", () => {
  const home = mkdtempSync(join(tmpdir(), "skel-limit-test-"));
  try {
    daemonRun(
      home,
      `reachLimit(db, "codex", null, now);
reachLimit(db, "codex", null, now);
tellOfLimit(db, "no-tmux", "codex", { owner: "simon", repo: "app" }, null);
console.log("{}");`,
    );
    const after = daemonRun(
      home,
      `restoreLimits(db);
const limit = limitOn("codex", now);
const notes = db.query("SELECT COUNT(*) AS n FROM notes").get().n;
tellOfLimit(db, "no-tmux", "codex", { owner: "simon", repo: "app" }, null);
const again = db.query("SELECT COUNT(*) AS n FROM notes").get().n;
console.log(JSON.stringify({ until: limit?.until, tries: limit?.tries, told: [...(limit?.told ?? [])], notes, again }));`,
    );
    // Still held for the second wait, and the lead isn't told a second time.
    expect(after).toEqual({
      until: now + 30 * 60_000,
      tries: 2,
      told: ["simon/app"],
      notes: 1,
      again: 1,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const thread = (change: Partial<Thread>): Thread => ({
  owner: "simon",
  repo: "app",
  task: "12",
  folder: "app-12",
  branch: "skelcrew/12-add-export",
  base: null,
  status: "waiting",
  session: "s",
  rounds: 0,
  pr: 7,
  needs_you: false,
  submitting: null,
  reviewing: "abc",
  telling: null,
  held: null,
  seen: [],
  body: null,
  last_review: 0,
  last_comment: 0,
  last_check: 0,
  asking: false,
  erred: false,
  limited: false,
  limit_reset: null,
  review_limited: false,
  review_reset: null,
  conflicts: null,
  ci_passed: false,
  noting: null,
  title: null,
  started: null,
  checks: null,
  reviewer: "codex",
  reviewed_by: null,
  review_round: null,
  top_round: null,
  verdict: null,
  review_line: null,
  reviewed_commit: null,
  no_ci: null,
  ci_shown: [],
  harness: "claude",
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
  issue_ref: null,
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
  not_blocking_task: null,
  needs_you_for: null,
  limit_decided: false,
  review_failed: false,
  agents: null,
  flow: "default",
  review_post: null,
  posting: null,
  review_findings: null,
  round_log: null,
  queued_since: null,
  turn_ended: false,
  submitted: false,
  told_lead: false,
  queued: null,
  review_at: null,
  ...change,
});

test("a thread waiting out a usage limit says until when, is dim, and doesn't need you", () => {
  const held = thread({ review_limited: true, review_reset: at(16, 13, 59) });
  expect(threadWord(held, 3, now)).toBe("limit · 13:59");
  const later = thread({ review_limited: true, review_reset: at(17, 13, 59) });
  expect(threadWord(later, 3, now)).toBe("limit · 17 Nov 13:59");
  expect(threadWord(thread({ review_limited: true }), 3, now)).toBe("limit");
  expect(needsYou(held)).toBe(false);
  expect(shownOf(held, 3, now).mark).toEqual({ sign: "○", colour: "dim" });
  // It stays dim while its builder works at the same time, as it still waits on the limit.
  for (const reset of [null, at(16, 13, 59)]) {
    const both = thread({ state: "working", review_limited: true, review_reset: reset });
    expect(shownOf(both, 3, now)).toMatchObject({
      word: reset === null ? "limit" : "limit · 13:59",
      status: "working",
      mark: { sign: "○", colour: "dim" },
    });
  }
  // A builder its harness stopped on a usage limit is woken at the reset, so it doesn't need you
  // either. Any other error does.
  const builder = { status: "working" as const, reviewing: null, erred: true };
  expect(needsYou(thread({ ...builder, limited: true }))).toBe(false);
  expect(threadWord(thread({ ...builder, limited: true }), 3, now)).toBe("limit");
  expect(needsYou(thread(builder))).toBe(true);
  expect(threadWord(thread(builder), 3, now)).toBe("error");
});

test("a thread that needs you, or whose review failed, says why, whatever limit it also waits on", () => {
  const failed = thread({ review_limited: true, review_failed: true, verdict: "failed" });
  expect(threadWord(failed, 3, now)).toBe("review failed");
  expect(threadWord(thread({ review_limited: true, asking: true }), 3, now)).toBe("question");
});

test("a builder's limit shows only while its builder is still stopped on it", () => {
  const over = thread({ status: "working", reviewing: null, limited: true, limit_reset: now });
  expect(threadWord(over, 3, now)).toBe("working");
});

test("a builder's limit and a review's hold don't undo each other", () => {
  // The builder's own limit still shows while its review is held, and the other way round.
  const both = thread({ erred: true, limited: true, review_limited: true });
  expect(needsYou(both)).toBe(false);
  expect(threadWord(both, 3, now)).toBe("limit");
  const reviewRuns = thread({ erred: true, limited: true, review_limited: false });
  expect(needsYou(reviewRuns)).toBe(false);
  expect(threadWord(reviewRuns, 3, now)).toBe("limit");
});

test("a builder stopped by a usage limit is woken at its reset, at once once it has passed", () => {
  const minutes = (m: number) => m * 60_000;
  // A reset still to come is when.
  expect(wakeTime(now + minutes(5), now, undefined)).toEqual({
    at: now + minutes(5),
    wakes: undefined,
  });
  // Long past, such as after a restart: at once.
  const past = now - minutes(30);
  expect(wakeTime(past, now, undefined)).toEqual({
    at: now,
    wakes: { tries: 0, woken: now, reset: past },
  });
  // Read in its own minute, as "1:59 PM" at 1:59:20: at the end of that minute.
  expect(wakeTime(now - 20_000, now, undefined).at).toBe(now + 40_000);
  // The same past reset again after a wake means it hasn't reset: the growing wait.
  const again = wakeTime(past, now, { tries: 0, woken: now, reset: past });
  expect(again.at).toBe(now + minutes(15));
  // With no reset time, 15 minutes, then 30, and short again after an hour's work.
  const first = wakeTime(null, now, undefined);
  expect(first.at).toBe(now + minutes(15));
  expect(wakeTime(null, now, first.wakes).at).toBe(now + minutes(30));
  expect(wakeTime(null, now + minutes(61), first.wakes).at).toBe(now + minutes(61 + 15));
});

test("a wait for a reset months away waits, rather than ending at once", async () => {
  // A timer can't wait more than about 24.8 days, and one set longer fires at once.
  const cancel = new AbortController();
  let ended = false;
  const waiting = waitUntil(Date.now() + 90 * 24 * 3600_000, cancel.signal).then(() => {
    ended = true;
  });
  await Bun.sleep(200);
  expect(ended).toBe(false);
  cancel.abort();
  await waiting;
  expect(ended).toBe(true);
});
