// The round ledger: the record of a thread's review rounds. Every event of a round, such as a
// submit, a verdict or the review going on the PR, is added to the task's record, and every round
// field comes from the record alone, saved with it in the same change, so the two never disagree.
// Callers say what happened and save the change the ledger gives back. They ask it the round's
// number, the round limit and whether the round moved. It is pure, but for reading the round
// limit from your settings.
import { z } from "zod";
import { HarnessName } from "../agents/harness.ts";
import { roundLimit } from "../config.ts";
import type { Review } from "./reviewer.ts";
import type { Thread } from "./thread.ts";

// Skelcrew's review on a PR: the PR, the review's ID on the forge, and the verdict, findings and
// round it last said, so each round edits that one review, or posts again only when what it says
// changed. The round is null in a row from before Skelcrew kept it.
export const ReviewPost = z.object({
  pr: z.number(),
  id: z.string(),
  verdict: z.enum(["approve", "changes"]),
  findings: z.array(z.string()),
  round: z.number().nullable().default(null),
});
export type ReviewPost = z.infer<typeof ReviewPost>;

// A verdict saved on the thread but not yet on the forge: the commit, Skelcrew's check on it,
// and the review to post on the PR with the commit it covers, or null when there is none to
// post. A failed review posts none, but keeps the review before it that is still to post.
// `note` is what the lead hears once it is on the forge, when the round limit holds its
// changes, so the note never names a review the PR doesn't show yet. Null in a row from before.
export const Posting = z.object({
  commit: z.string(),
  check: z.enum(["success", "failure"]),
  description: z.string(),
  review: z
    .object({
      pr: z.number(),
      commit: z.string(),
      verdict: z.enum(["approve", "changes"]),
      body: z.string(),
      findings: z.array(z.string()),
      round: z.number(),
    })
    .nullable(),
  note: z.string().nullable().default(null),
});
export type Posting = z.infer<typeof Posting>;

// The verdicts a finished review can save.
const Verdict = z.enum(["approve", "changes", "failed", "timed out", "not reviewed"]);

// Everything the record says of the round, as the thread's fields of the same names hold it.
const Round = z.object({
  rounds: z.number(),
  top_round: z.number().nullable(),
  limit_decided: z.boolean(),
  submitting: z.string().nullable(),
  reviewing: z.string().nullable(),
  telling: z.string().nullable(),
  held: z.string().nullable(),
  verdict: Verdict.nullable(),
  review_round: z.number().nullable(),
  reviewed_by: HarnessName.nullable(),
  review_line: z.string().nullable(),
  reviewed_commit: z.string().nullable(),
  review_findings: z.array(z.string()).nullable(),
  review_at: z.number().nullable(),
  review_failed: z.boolean(),
  posting: Posting.nullable(),
  review_post: ReviewPost.nullable(),
});
type Round = z.infer<typeof Round>;

// One event of a thread's rounds, with when it happened, in milliseconds since 1970. `before`
// starts the record of a task from before Skelcrew kept one, with its round as its row said.
export const RoundEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("before"), round: Round }),
  // The builder ran sc submit. A flow with no review stage marks it not reviewed at once.
  z.object({
    kind: z.literal("submitted"),
    at: z.number(),
    summary: z.string(),
    unreviewed: z.boolean(),
  }),
  // A review was asked for again, of the commit pushed, or null for a submit not yet pushed.
  z.object({ kind: z.literal("review asked"), at: z.number(), commit: z.string().nullable() }),
  // The commit was pushed, and its review is on its way.
  z.object({ kind: z.literal("review started"), at: z.number(), commit: z.string() }),
  // A review's verdict, with the round it took and the limit it was judged by, its reviewer, the
  // first line of what it said, its findings, the changes it asked for, and what to post.
  z.object({
    kind: z.literal("verdict"),
    at: z.number(),
    round: z.number(),
    verdict: z.enum(["approve", "changes", "failed", "timed out"]),
    limit: z.number(),
    by: HarnessName,
    commit: z.string(),
    line: z.string(),
    findings: z.array(z.string()),
    changes: z.string().nullable(),
    posting: Posting.nullable(),
  }),
  // A submit on a flow with no review stage, marked not reviewed.
  z.object({ kind: z.literal("not reviewed"), at: z.number(), commit: z.string() }),
  // The round failed before its review answered, such as on a push that failed.
  z.object({ kind: z.literal("round failed"), at: z.number() }),
  // A failed review or round is over, as the builder works again or was stopped.
  z.object({ kind: z.literal("failure over"), at: z.number() }),
  z.object({ kind: z.literal("limit decided"), at: z.number() }),
  z.object({ kind: z.literal("let go on"), at: z.number(), limit: z.number() }),
  // The review's changes were typed into the builder.
  z.object({ kind: z.literal("typed"), at: z.number() }),
  // The verdict went on the forge, or without a forge was given at once: the round of the review
  // it put on the PR, or null for none, and the note the lead got, when the limit held changes.
  z.object({
    kind: z.literal("posted"),
    at: z.number(),
    round: z.number().nullable(),
    note: z.string().nullable(),
  }),
  // Skelcrew's review on the PR was posted, edited or found there, as it now says.
  z.object({ kind: z.literal("review on PR"), at: z.number(), post: ReviewPost }),
  // The commit an approval from before Skelcrew saved it stands for, found in Skelcrew's clone.
  z.object({ kind: z.literal("approval found"), commit: z.string() }),
]);
export type RoundEvent = z.infer<typeof RoundEvent>;

// A thread's round before any event: a thread that starts, or starts over, counts anew.
const freshRound: Round = {
  rounds: 0,
  top_round: null,
  limit_decided: false,
  submitting: null,
  reviewing: null,
  telling: null,
  held: null,
  verdict: null,
  review_round: null,
  reviewed_by: null,
  review_line: null,
  reviewed_commit: null,
  review_findings: null,
  review_at: null,
  review_failed: false,
  posting: null,
  review_post: null,
};

// What the record is read from: the record, or for a row from before it, the row's own fields.
type Recorded = Pick<Thread, "round_log"> & Round;

// Returns the thread's record. A row from before Skelcrew kept one starts from what the row
// said, so its round goes on from there.
const recordOf = (thread: Recorded): RoundEvent[] =>
  thread.round_log ?? [
    {
      kind: "before",
      round: {
        rounds: thread.rounds,
        top_round: thread.top_round,
        limit_decided: thread.limit_decided,
        submitting: thread.submitting,
        reviewing: thread.reviewing,
        telling: thread.telling,
        held: thread.held,
        verdict: thread.verdict,
        review_round: thread.review_round,
        reviewed_by: thread.reviewed_by,
        review_line: thread.review_line,
        reviewed_commit: thread.reviewed_commit,
        review_findings: thread.review_findings,
        review_at: thread.review_at,
        review_failed: thread.review_failed,
        posting: thread.posting,
        review_post: thread.review_post,
      },
    },
  ];

// Returns what one event does to the round.
function next(round: Round, event: RoundEvent): Round {
  switch (event.kind) {
    case "before":
      return event.round;
    case "submitted":
      return {
        ...round,
        submitting: event.summary,
        telling: null,
        held: null,
        review_failed: false,
        review_at: event.at,
        verdict: event.unreviewed ? "not reviewed" : round.verdict,
      };
    case "review asked":
      return {
        ...round,
        reviewing: event.commit,
        telling: null,
        held: null,
        review_failed: false,
        review_at: event.at,
      };
    case "review started":
      return { ...round, reviewing: event.commit, submitting: null };
    case "verdict": {
      // Only a verdict asking for changes counts a round of changes. The highest round only goes
      // up, as each verdict that gave one keeps the larger. Each verdict asks anew about the limit.
      const asked = event.verdict === "changes";
      const counted = asked || event.verdict === "approve";
      const rounds = asked ? round.rounds + 1 : round.rounds;
      const held = asked && rounds > event.limit;
      return {
        rounds,
        top_round: counted ? Math.max(round.top_round ?? 0, event.round) : round.top_round,
        limit_decided: false,
        submitting: null,
        reviewing: null,
        telling: held ? null : event.changes,
        held: held ? event.changes : null,
        verdict: event.verdict,
        review_round: event.round,
        reviewed_by: event.by,
        review_line: event.line,
        reviewed_commit: event.commit,
        review_findings: event.findings,
        review_at: event.at,
        review_failed: event.verdict === "failed" || event.verdict === "timed out",
        posting: event.posting,
        review_post: round.review_post,
      };
    }
    case "not reviewed":
      return {
        ...round,
        submitting: null,
        reviewing: null,
        telling: null,
        held: null,
        verdict: "not reviewed",
        reviewed_by: null,
        review_round: null,
        review_line: null,
        reviewed_commit: event.commit,
        review_at: event.at,
      };
    case "round failed":
      return { ...round, review_failed: true, review_at: event.at };
    case "failure over":
      return { ...round, review_failed: false };
    case "limit decided":
      return { ...round, limit_decided: true };
    case "let go on":
      return {
        ...round,
        rounds: event.limit,
        review_failed: false,
        telling: round.held,
        held: null,
      };
    case "typed":
      return { ...round, telling: null };
    case "posted":
      return { ...round, posting: null };
    case "review on PR":
      return { ...round, review_post: event.post };
    case "approval found":
      return { ...round, reviewed_commit: event.commit };
  }
}

// Returns the round the thread's record comes to.
export const roundOf = (thread: Recorded): Round => recordOf(thread).reduce(next, freshRound);

// Returns the change that adds the event to the thread's record, with every round field as the
// record now says, so both are saved in one change. The fields are kept for everything that
// reads the round without the ledger, such as the database's own queries and the lists.
function logged(thread: Thread, event: RoundEvent) {
  const round_log = [...recordOf(thread), event];
  return { round_log, ...round_log.reduce(next, freshRound) } satisfies Partial<Thread>;
}

// The round fields of a thread that starts, or starts over, with an empty record.
export const freshRounds = { round_log: [], ...freshRound } satisfies Partial<Thread>;

// Returns whether the thread's latest submit may go on to CI and ready: Skelcrew's reviewer
// approved it, or its flow has no review stage, so it was never reviewed. Everything that
// waits on an approval waits on this, so a flow without a review never waits on one.
export const passedReviewStage = (thread: Pick<Thread, "verdict">) =>
  thread.verdict === "approve" || thread.verdict === "not reviewed";

// Returns the number the thread's next review round gets, counted from 1 over the thread's whole
// life, which the PR's review and sc ps show. It is one above the highest round a review that
// gave a verdict took, so a review that failed is run again under the same number. It never goes
// down: sc start past the round limit sets the count of rounds of changes back, but not this.
// Every round of changes was a round too, so a thread from an earlier release, whose highest round
// the daemon hasn't read from its log yet, still counts at least those.
export function nextRound(thread: Recorded): number {
  const { rounds, top_round } = roundOf(thread);
  return Math.max(top_round ?? 0, rounds) + 1;
}

// Returns whether the thread has used up its rounds of changes. Past that a review's changes
// are held, and the thread needs you until you decide, let it go on, or its reviewer approves.
// An approval answers the changes the limit held, so an approved thread is ready like any other.
// A flow with no review stage never counts a round, as no review asks for changes.
export function pastRoundLimit(thread: Recorded, maxRounds: number): boolean {
  const round = roundOf(thread);
  return round.rounds > maxRounds && !passedReviewStage(round);
}

// Returns whether the lead or you decided about the round limit since the latest review.
export const limitWasDecided = (thread: Recorded) => roundOf(thread).limit_decided;

// Returns the round limit a thread's word is judged by. Settings that aren't valid already stop
// rounds, with the reason, and mustn't also take the lists away, so they read as no limit. The
// settings are read only when the word depends on them, so drawing the list each second stays
// fast: held changes say so by themselves, and a thread that doesn't need you, has passed its
// review stage or counted no round can't be past it.
export function limitOf(thread: Thread): number {
  const round = roundOf(thread);
  const matters =
    round.held === null && thread.needs_you && !passedReviewStage(round) && round.rounds > 0;
  if (!matters) return Number.POSITIVE_INFINITY;
  try {
    return roundLimit(thread);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Returns whether the thread's word is the round limit, given its limit. Changes held past the
// limit say so whatever else cleared the thread's need of you: the task still waits on sc start.
export const atRoundLimit = (thread: Thread, maxRounds: number) =>
  roundOf(thread).held !== null || (thread.needs_you && pastRoundLimit(thread, maxRounds));

// Returns whether the round limit is what the thread needs you for, with nobody having decided
// yet, so marking, clearing or arming a merge on it is that decision. A mark, a question or an
// error can stand in front of it, and it still waits behind them.
export const limitWaits = (thread: Thread) =>
  (thread.status === "working" || thread.status === "waiting") &&
  thread.needs_you &&
  !limitWasDecided(thread) &&
  atRoundLimit(thread, limitOf(thread));

// The events that move a round on: a submit, a review asked for, started or ended, a round that
// failed, or rounds of changes set back.
const moving = new Set([
  "submitted",
  "review asked",
  "review started",
  "verdict",
  "not reviewed",
  "round failed",
  "let go on",
]);

// Returns whether the thread's round moved on between two reads of it, from the events added to
// its record since. What the forge said in between is then about an older round.
export function roundMoved(before: Thread, after: Thread): boolean {
  const count = (thread: Thread) => recordOf(thread).filter((e) => moving.has(e.kind)).length;
  return before.round_log === null
    ? after.round_log !== null && count(after) > 0
    : count(after) !== count(before);
}

// The builder submitted, which drops what the older review asked for. A flow with no review stage
// saves its verdict as the submit starts, so the thread waits on checks from then on. A submit is
// in flight until its review answers, and waiting on a review never needs you.
export const submitted = (thread: Thread, summary: string, now: number, unreviewed: boolean) =>
  ({
    ...logged(thread, { kind: "submitted", at: now, summary, unreviewed }),
    needs_you: false,
  }) satisfies Partial<Thread>;

// A review was asked for again, with sc review, of the pushed commit, or null for a submit not
// yet pushed. Like a submit, it never needs you while it runs, and drops the older changes.
export const reviewAsked = (thread: Thread, commit: string | null, now: number) =>
  ({
    ...logged(thread, { kind: "review asked", at: now, commit }),
    needs_you: false,
  }) satisfies Partial<Thread>;

// The commit was pushed, and its review is on its way. Only the first of these for a commit adds
// to the record: a review saved again as it waits for CI or a place is the same review.
export const reviewStarted = (thread: Thread, commit: string, now: number) => {
  const round = roundOf(thread);
  if (round.reviewing === commit && round.submitting === null) return {};
  return logged(thread, { kind: "review started", at: now, commit });
};

// The round failed before its review answered. The lead hears of it and can run the review again,
// so it doesn't need you.
export const roundFailed = (thread: Thread, now: number) =>
  logged(thread, { kind: "round failed", at: now });

// A review that failed is over, as the builder works again, or was stopped. A submit its flow
// doesn't review that failed, to push or to set Skelcrew's check, still sits saved, and nothing
// retries it until a new submit or sc review, so working again doesn't end it. Stopping does.
export function failureOver(thread: Thread, now: number, stopping = false) {
  const round = roundOf(thread);
  const unreviewedFailed =
    round.verdict === "not reviewed" && (round.submitting !== null || round.reviewing !== null);
  if (!round.review_failed || (unreviewedFailed && !stopping)) return {};
  return logged(thread, { kind: "failure over", at: now });
}

// A submit on a flow with no review stage was marked not reviewed, so it waits on CI like an
// approval, with no round. `ready` is why it needs you at once, without a forge, or null.
export const notReviewed = (thread: Thread, sha: string, ready: string | null, now: number) =>
  ({
    ...logged(thread, { kind: "not reviewed", at: now, commit: sha }),
    needs_you: ready !== null,
  }) satisfies Partial<Thread>;

// The lead or you decided about the round limit, by marking, clearing or arming a merge, so the
// thread no longer needs you for it. The next review asks again. Nothing changes for a thread the
// limit doesn't hold.
export const limitDecided = (thread: Thread, now: number) =>
  limitWaits(thread) ? logged(thread, { kind: "limit decided", at: now }) : {};

// You let a thread past the round limit go on, with sc start. Its held changes are to be typed
// into the builder, as a round within the limit would have done. Its rounds of changes stand at
// the limit, so it is no longer past it, but the next review asking for changes reaches it again.
export const letGoOn = (thread: Thread, maxRounds: number, now: number) =>
  ({
    ...logged(thread, { kind: "let go on", at: now, limit: maxRounds }),
    needs_you: false,
  }) satisfies Partial<Thread>;

// The review's changes were typed into the builder.
export const changesTyped = (thread: Thread, now: number) =>
  logged(thread, { kind: "typed", at: now });

// The commit an approval from before Skelcrew saved it stands for was found.
export const approvalFound = (thread: Thread, commit: string) =>
  logged(thread, { kind: "approval found", commit });

// Skelcrew's review on the PR was posted, edited or found there, so the next round edits it.
export const reviewOnPr = (thread: Thread, post: ReviewPost, now: number) =>
  logged(thread, { kind: "review on PR", at: now, post });

// Returns the note the lead gets as a verdict is posted: the round limit's, while it still holds
// the thread's changes, as a submit or a decision since ends that.
const noteNow = (round: Round, note: string | null) =>
  round.held !== null && !round.limit_decided ? note : null;

// The saved verdict went on the forge: it is no longer to post, and the record keeps the round of
// the review the PR now shows and the note. Returns the change and the note for the lead, which the
// caller saves with it, so the two can't come apart. The note goes only when the PR shows this
// verdict's own round, so it never names a review the PR doesn't show.
export function verdictPosted(thread: Thread, posting: Posting, now: number) {
  const shown = posting.review;
  const onPr = roundOf(thread).review_post;
  const round = shown !== null && onPr?.pr === shown.pr ? onPr.round : null;
  const change = logged(thread, { kind: "posted", at: now, round, note: posting.note });
  const showsIt = shown !== null && round === shown.round;
  return { change, note: showsIt ? noteNow(roundOf(thread), posting.note) : null };
}

// Returns what a reviewer said in words: its body, then each finding numbered, for the builder
// and the PR to read.
export function reviewText(review: { body: string; findings: string[] }): string {
  const findings = review.findings.map((finding, n) => `${n + 1}. ${finding.trim()}`);
  return [review.body.trim(), ...(findings.length > 0 ? [findings.join("\n")] : [])]
    .filter((part) => part !== "")
    .join("\n\n");
}

// What a review's verdict means for the round. `ready` says why the thread is ready at once,
// without a forge, or is null. `forge` says whether there is one to post on. `kept` names the
// base merged and the approved commit, when the approval stands with no reviewer run.
type Reached = {
  review: Review;
  by: HarnessName;
  sha: string;
  maxRounds: number;
  ready: string | null;
  forge: boolean;
  kept: { base: string; approved: string } | null;
  now: number;
};

// What a verdict gives back: the change to save, the round's number, Skelcrew's check, what to
// type into the builder, why, for the log, whether the round limit now holds the changes, and the
// note for the lead to save with the change, which comes only from its posted event.
type Reaching = {
  change: Partial<Thread>;
  round: number;
  check: "success" | "failure";
  description: string;
  tell: string | null;
  why: string;
  holds: boolean;
  note: string | null;
};

// A review reached its verdict. The builder gets max_rounds rounds of changes. Changes asked for
// after those are posted but not typed in: they are held until sc start lets the thread go on,
// and the thread needs you until you or the lead decide. A review that failed counts no round,
// and is run again under the same number. With a forge, an approved thread waits on CI; without,
// it is ready at once. The verdict goes on the forge from the saved posting, and a failed one
// posts no review, so the review before it that is still to post stays. The lead's note of the
// limit goes with the posting, so it never names a review the PR doesn't show yet. Without a
// forge there is nothing to post, so the verdict is posted at once, in the same change.
export function verdictReached(thread: Thread, reached: Reached): Reaching {
  const { review, by, sha, maxRounds, ready, forge, kept, now } = reached;
  const round = nextRound(thread);
  const failed = review.verdict === "failed" || review.verdict === "timed out";
  const asked = review.verdict === "changes";
  const rounds = roundOf(thread).rounds + (asked ? 1 : 0);
  const held = asked && rounds > maxRounds;
  const changes = asked
    ? `Skelcrew's reviewer asked for changes:\n\n${reviewText(review)}\n\nFix what it asks, commit, and run sc submit "<summary>" again.`
    : null;
  const check: Posting["check"] = review.verdict === "approve" ? "success" : "failure";
  const description = kept
    ? `approval kept: only merged ${kept.base}`
    : review.verdict === "approve"
      ? "Skelcrew's reviewer approved"
      : review.verdict === "changes"
        ? "Skelcrew's reviewer asked for changes"
        : review.verdict === "failed"
          ? "review failed"
          : "review timed out";
  const limitWhy = `changes asked for after ${maxRounds} rounds of changes, so the round limit is reached`;
  const keptWhy = kept && `approval kept: only merged ${kept.base} into ${kept.approved}`;
  const approvedWhy = ready ?? "approved by Skelcrew's reviewer, so it waits on CI";
  const why = failed
    ? review.verdict === "failed"
      ? `review failed: ${review.body}`
      : review.body
    : asked
      ? held
        ? limitWhy
        : `changes asked for in round ${rounds} of ${maxRounds}`
      : keptWhy
        ? ready === null
          ? `${keptWhy}, so it waits on CI`
          : `${keptWhy}; ${ready}`
        : approvedWhy;
  const pr = thread.pr;
  const posted =
    (review.verdict === "approve" || review.verdict === "changes") && pr !== null
      ? { pr, commit: sha, ...review, round }
      : (roundOf(thread).posting?.review ?? null);
  const limitNote = held ? limitWhy : null;
  const posting = forge
    ? { commit: sha, check, description, review: posted, note: limitNote }
    : null;
  const verdict = {
    kind: "verdict" as const,
    at: now,
    round,
    verdict: review.verdict,
    limit: maxRounds,
    by,
    commit: sha,
    line: review.body.trim().split("\n")[0]?.slice(0, 200) ?? "",
    findings: "findings" in review ? review.findings : [],
    changes,
    posting,
  };
  const saved = logged(thread, verdict);
  const recorded = forge
    ? saved
    : logged({ ...thread, ...saved }, { kind: "posted", at: now, round: null, note: limitNote });
  const change = {
    ...recorded,
    needs_you: held || (review.verdict === "approve" && ready !== null),
    status: asked && !held ? ("working" as const) : ("waiting" as const),
  } satisfies Partial<Thread>;
  const note = forge ? null : noteNow(saved, limitNote);
  return { change, round, check, description, tell: saved.telling, why, holds: held, note };
}
