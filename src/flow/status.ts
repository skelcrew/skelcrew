// The status module: knows whether each thread's builder works, idles, needs you, is ready or
// hit an error. It learns this from the hooks the builder's harness runs, and gives the word the
// sidebar and sc ps show for it. Leads have no status: they get none of these hooks.
import type { Database } from "bun:sqlite";
import { forQuestion } from "../agents/transport.ts";
import { pastRoundLimit } from "./decide.ts";
import { typeLeadNotes } from "./lead.ts";
import { clockTime, endWake, wakeAfterLimit } from "./limits.ts";
import { stopDelivering } from "./messages.ts";
import { untagged } from "./tell.ts";
import { builderHarness, queuedForReview, readThread, record, type Thread } from "./thread.ts";

// The status a host shows for a thread's builder.
export type Status = "working" | "idle" | "needs you" | "ready" | "error";

// Returns whether the thread needs you: for a review, the round limit or an approval, for the
// builder's question or its stopping without submitting, or for its harness stopping on an error.
// A usage limit isn't one, as the builder is woken once it resets.
export const needsYou = (thread: Thread) =>
  thread.needs_you || thread.asking || thread.stalled || (thread.erred && !thread.limited);

// Returns whether a builder that just ended its turn is waiting on you, on any harness. A
// builder that stops without sc submit in that turn has a question for you, written as plain
// text, or is stuck, and nothing else would tell you. One that submitted waits on its review.
// One asking with AskUserQuestion, or stopped on an error, already needs you, and one already
// waiting has nothing new to say. The status is not enough: a review can set it back to working
// while the builder that submitted is still finishing its turn.
export const endedTurnAsks = (thread: Thread) =>
  (thread.status === "working" || thread.status === "waiting") &&
  !thread.submitted &&
  !thread.asking &&
  !thread.stalled &&
  !thread.erred;

// Returns the thread's status, one of the five words a host can show, from the same fields and
// in the same order as its word in the sidebar, which then serves as the reason. A thread that
// failed, or whose harness stopped on an error, is in error. An approval with green checks is
// ready to merge. Anything else that needs you comes next. A builder waiting out its usage limit
// idles, as it is woken once the limit resets. Otherwise a working thread works, and the rest
// idle: one waiting on its checks or review, stopped or done.
export function statusOf(thread: Thread, maxRounds: number, now = Date.now()): Status {
  const word = threadWord(thread, maxRounds, now);
  if (thread.status === "failed" || word === "error") return "error";
  if (word === "approved") return "ready";
  if (needsYou(thread)) return "needs you";
  if (thread.erred && thread.limited) return "idle";
  return thread.status === "working" ? "working" : "idle";
}

// Returns the word for what the thread is doing, given the rounds of changes it may have. Its
// status and needs you stay as they are: the word only describes them, from what they and the
// latest review say. Past the limit a thread goes on needing you while its builder submits, so
// that comes before a round under way. A round that failed keeps its submit or review saved.
// A thread can need you for a reason with no word of its own, such as a builder that couldn't be
// told about an event. Its word is then "needs you", rather than something untrue. A review or
// builder waiting out its harness's usage limit says when the limit resets, as this machine's
// clock shows it, such as "limit · 13:59", or only "limit" when the harness didn't say. Anything
// that needs you comes before a limit, which only waits.
export function threadWord(thread: Thread, maxRounds: number, now = Date.now()): string {
  const { status, verdict, checks } = thread;
  // A thread that failed, stopped or is done says just that. Otherwise a question from its builder
  // comes first, then its harness stopping on an error, then why it needs you, then what it is
  // doing.
  if (status === "failed" || status === "stopped" || status === "done") return status;
  const underWay = thread.submitting !== null || thread.reviewing !== null;
  if (thread.asking) return "question";
  if (thread.erred && !thread.limited) return "error";
  // The round limit and an approval say what you must do next, so they stay ahead of a builder
  // that stopped without submitting. Otherwise any reply it gave you, or the lead, would hide
  // that the thread is ready to merge.
  const past = thread.needs_you && pastRoundLimit(thread, maxRounds);
  const failed = underWay || verdict === "failed";
  // A PR that conflicts isn't ready to merge, even when something else, such as its builder
  // missing, makes the thread need you again.
  const green =
    verdict === "approve" && (checks === "passing" || checks === null) && thread.conflicts === null;
  if (past) return "round limit";
  if (thread.needs_you && !failed && green) return "approved";
  // Stopping without submitting is a question written as plain text.
  if (thread.stalled) return "question";
  if (thread.needs_you && verdict === "timed out" && !underWay) return "review timed out";
  if (thread.needs_you) return failed ? "review failed" : "needs you";
  // Not needing you: a builder or a review waiting out a usage limit says until when.
  const limitWord = (reset: number | null) =>
    reset === null ? "limit" : `limit · ${clockTime(reset, now)}`;
  if (thread.erred && thread.limited) return limitWord(thread.limit_reset);
  if (thread.review_limited) return limitWord(thread.review_reset);
  // A review waiting for a place shows as queued, any other round under way as reviewing, and
  // a review's changes still waiting to be typed into the builder as changes. Otherwise it
  // works or waits on checks.
  if (queuedForReview(thread)) return "queued for review";
  if (underWay) return "reviewing";
  if (thread.telling !== null) return "changes";
  return status === "working" ? "working" : "checks";
}

// The builder asked you a question with AskUserQuestion, from Claude Code's PreToolUse hook.
// The thread needs you until the question is over, and the lead hears of it. A message being
// typed in now would answer the question for you, so that typing is cancelled, and the message
// waits until the question is over.
export function questionAsked(db: Database, sessions: string, folder: string): void {
  record(db, folder, { asking: true }, "its builder asked a question");
  stopDelivering(db, folder, false, forQuestion);
  typeLeadNotes(db, sessions);
}

// The builder's turn ended, from its harness's Stop hook, with what it last said. A builder
// that didn't submit in that turn waits on you, so the thread needs you and the lead hears of
// it. Returns whether it does.
export function turnEnded(
  db: Database,
  sessions: string,
  folder: string,
  said: string | undefined,
): boolean {
  if (!endedTurnAsks(readThread(db, folder))) return false;
  // The note quotes what the builder last said, so you see what it waits on. In quotes,
  // and with no tags of Skelcrew's, it can't pass for Skelcrew's own words or another's.
  // The quote, escapes included, is kept to 100 characters, as a note is cut at 200,
  // which would lose the closing quote. Each " or \ doubles in length once escaped, so
  // the words are cut until the quote fits.
  let words = untagged(said ?? "").slice(0, 100);
  while (JSON.stringify(words).length > 100) words = words.slice(0, -1);
  const quote = words ? `, saying ${JSON.stringify(words)}` : "";
  record(db, folder, { stalled: true }, `its builder stopped without submitting${quote}`);
  typeLeadNotes(db, sessions);
  return true;
}

// The builder's turn ended on an error, from Claude Code's StopFailure hook, with the kind of
// error and its message. A usage limit, or a rate limit, passes by itself, so the builder is
// woken once it resets, and the thread doesn't need you for it. Any other error does.
export function turnFailed(
  db: Database,
  sessions: string,
  thread: Thread,
  error: string | undefined,
  message: string | undefined,
): void {
  // Only the kind of error the hook names decides: its message can hold the builder's own last
  // words, such as about the rate limiting it was writing. The message only gives the reset.
  const said = message ?? "";
  if (error === "rate_limit") {
    const reset = builderHarness(thread).usageLimit(said, Date.now())?.reset ?? null;
    const change = { erred: true, limited: true, limit_reset: reset };
    record(db, thread.folder, change, `its builder's harness reached its usage limit: ${said}`);
    wakeAfterLimit(db, sessions, thread.folder);
    return;
  }
  // A limit it stopped on before is over: this error is new, and needs you, so the wake
  // planned for the old one never types "continue" over it.
  endWake(thread.folder);
  const erred = { erred: true, limited: false, limit_reset: null };
  record(db, thread.folder, erred, "its builder's harness stopped on an error");
  typeLeadNotes(db, sessions);
}

// AskUserQuestion returned your answer, from Claude Code's PostToolUse hook, and the builder
// goes on in the same turn, so a submit earlier in it still counts.
export function questionClosed(db: Database, folder: string): void {
  // Your answer starts a new stretch of work all the same, which the sidebar times, as anything
  // typed into the builder does.
  db.run("UPDATE threads SET working_since = ? WHERE folder = ?", [Date.now(), folder]);
  if (readThread(db, folder).asking)
    record(db, folder, { asking: false }, "its builder's question is over");
}

// Something was typed into the builder, from its harness's UserPromptSubmit hook: a review's
// changes, a message from the lead, or your answer. It starts a new turn, and ends whatever the
// builder was waiting on you for.
export function questionAnswered(db: Database, folder: string): void {
  const thread = readThread(db, folder);
  // The new stretch of work is timed by the sidebar. Not logged, as only the sidebar shows it.
  db.run("UPDATE threads SET working_since = ? WHERE folder = ?", [Date.now(), folder]);
  // Run before every message typed into the builder, so only a question or an error that
  // was open is logged. Typing to a builder that stopped on an error means you fixed it,
  // such as with /login, so it ends the error as it ends a question. A usage limit it
  // stopped on ends too, as the builder now works again or meets it again. Typing to one
  // that stopped without submitting answers it, whether you typed or the lead told it.
  // Each message starts a new turn, with no submit in it yet.
  const over = {
    asking: false,
    stalled: false,
    erred: false,
    submitted: false,
    limited: false,
    limit_reset: null,
  };
  // The builder has something to work on, so a "continue" still waiting to be typed must
  // not land. A wake already typing has cleared the error, so it is ended whatever the
  // flags say. One whose "continue" ran this hook has nothing left to type.
  endWake(folder);
  if (thread.asking || thread.stalled) record(db, folder, over, "its builder's question is over");
  else if (thread.erred) record(db, folder, over, "its builder was typed to after its error");
  else if (thread.submitted) record(db, folder, { submitted: false });
}
