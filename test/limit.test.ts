// A harness's usage limit as Skelcrew reads it: the error each harness's reviewer ends on, whether
// that is a usage limit and when it resets, how long reviews wait on it, and what a thread
// waiting out a limit shows.
import { expect, test } from "bun:test";
import { claude } from "../src/agents/claude.ts";
import { codex } from "../src/agents/codex.ts";
import { resetTime } from "../src/agents/reset.ts";
import { limitOn, reachLimit } from "../src/flow/limits.ts";
import { needsYou, type Thread } from "../src/flow/thread.ts";
import { threadMark, threadWord } from "../src/screen/rows.ts";

// 16 November 2026 at 10:30 in this machine's time zone, as the harnesses read their times in it.
const now = new Date(2026, 10, 16, 10, 30).getTime();
const at = (day: number, hours: number, minutes: number, year = 2026, month = 10) =>
  new Date(year, month, day, hours, minutes).getTime();

test("a reset time is read as Codex and Claude Code write it, in this machine's time zone", () => {
  expect(resetTime("1:59 PM.", now)).toBe(at(16, 13, 59));
  expect(resetTime("2pm (Europe/London)", now)).toBe(at(16, 14, 0));
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

test("Codex's error is its ERROR line, not the prompt it echoed before it", () => {
  const echoed = "user\nReview this pull request.\n# Fix the login\nIt fails one run in ten.\n";
  const err = `${echoed}ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:59 PM.\n`;
  const error = codex.failure("", err);
  expect(error).toStartWith("You've hit your usage limit.");
  expect(codex.usageLimit(error ?? "", now)).toEqual({ reset: at(16, 13, 59) });
  // Its JSON events, when it prints them, say the same.
  const events = `{"type":"thread.started"}\n{"type":"turn.failed","error":{"message":"stream disconnected"}}\n`;
  expect(codex.failure(events, echoed)).toBe("stream disconnected");
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
  expect(claude.usageLimit(error ?? "", now)).toEqual({ reset: at(16, 14, 0) });
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

test("reviews on a limited harness wait for its reset, or for a growing wait with none", () => {
  reachLimit("codex", at(16, 13, 59), now);
  expect(limitOn("codex", now)?.until).toBe(at(16, 13, 59));
  expect(limitOn("codex", at(16, 13, 59))).toBeNull();
  // With no reset time, 15 minutes, then 30, then an hour each time.
  const minutes = (m: number) => m * 60_000;
  reachLimit("claude", null, now);
  expect(limitOn("claude", now)?.until).toBe(now + minutes(15));
  reachLimit("claude", null, now);
  expect(limitOn("claude", now)?.until).toBe(now + minutes(30));
  reachLimit("claude", null, now);
  reachLimit("claude", null, now);
  expect(limitOn("claude", now)?.until).toBe(now + minutes(60));
  // A reset in the minute just gone is tried a minute on, not at once.
  reachLimit("claude", now - 30_000, now);
  expect(limitOn("claude", now)?.until).toBe(now + minutes(1));
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
  noting: null,
  title: null,
  started: null,
  checks: null,
  reviewer: "codex",
  reviewed_by: null,
  review_round: null,
  verdict: null,
  review_line: null,
  harness: "claude",
  short: null,
  assigned: false,
  changed: null,
  ...change,
});

test("a thread waiting out a usage limit says until when, is dim, and doesn't need you", () => {
  const held = thread({ limited: true, limit_reset: at(16, 13, 59) });
  expect(threadWord(held, 3, now)).toBe("limit · 13:59");
  expect(threadWord(thread({ limited: true, limit_reset: at(17, 13, 59) }), 3, now)).toBe(
    "limit · 17 Nov 13:59",
  );
  expect(threadWord(thread({ limited: true }), 3, now)).toBe("limit");
  expect(needsYou(held)).toBe(false);
  expect(threadMark({ status: "waiting", needsYou: false, word: "limit · 13:59" })[0]).toBe("○");
  // A builder its harness stopped on a usage limit is woken at the reset, so it doesn't need you
  // either. Any other error does.
  const builder = { status: "working" as const, reviewing: null, erred: true };
  expect(needsYou(thread({ ...builder, limited: true }))).toBe(false);
  expect(threadWord(thread({ ...builder, limited: true }), 3, now)).toBe("limit");
  expect(needsYou(thread(builder))).toBe(true);
  expect(threadWord(thread(builder), 3, now)).toBe("error");
});
