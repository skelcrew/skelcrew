// The round ledger: what a thread's review rounds have come to, and every way that changes.
// Callers say what happened to the round and save the change it gives back, and ask it the
// round's number, the round limit and whether the round moved. Its transitions are pure.
import type { HarnessName } from "../agents/harness.ts";
import { roundLimit } from "../config.ts";
import type { Review } from "./reviewer.ts";
import type { Posting, ReviewPost, Thread } from "./thread.ts";

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
export const nextRound = (thread: Pick<Thread, "top_round" | "rounds">) =>
  Math.max(thread.top_round ?? 0, thread.rounds) + 1;

// Returns whether the thread has used up its rounds of changes. Past that a review's changes
// are held, and the thread needs you until you decide, let it go on, or its reviewer approves.
// An approval answers the changes the limit held, so an approved thread is ready like any other.
// A flow with no review stage never counts a round, as no review asks for changes.
export const pastRoundLimit = (thread: Pick<Thread, "rounds" | "verdict">, maxRounds: number) =>
  thread.rounds > maxRounds && !passedReviewStage(thread);

// Returns the round limit a thread's word is judged by. Settings that aren't valid already stop
// rounds, with the reason, and mustn't also take the lists away, so they read as no limit. The
// settings are read only when the word depends on them, so drawing the list each second stays
// fast: held changes say so by themselves, and a thread that doesn't need you, has passed its
// review stage or counted no round can't be past it.
export function limitOf(thread: Thread): number {
  const matters =
    thread.held === null && thread.needs_you && !passedReviewStage(thread) && thread.rounds > 0;
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
  thread.held !== null || (thread.needs_you && pastRoundLimit(thread, maxRounds));

// Returns whether the round limit is what the thread needs you for, with nobody having decided
// yet, so marking, clearing or arming a merge on it is that decision. A mark, a question or an
// error can stand in front of it, and it still waits behind them.
export const limitWaits = (thread: Thread) =>
  (thread.status === "working" || thread.status === "waiting") &&
  thread.needs_you &&
  !thread.limit_decided &&
  atRoundLimit(thread, limitOf(thread));

// Returns whether the thread's round moved on between two reads of it: a submit, a review that
// started or ended, or a round of changes counted. What the forge said in between is then
// about an older round.
export const roundMoved = (before: Thread, after: Thread) =>
  after.submitting !== before.submitting ||
  after.reviewing !== before.reviewing ||
  after.rounds !== before.rounds ||
  after.review_round !== before.review_round ||
  after.review_at !== before.review_at ||
  after.verdict !== before.verdict;

// The round fields of a thread that starts, or starts over, which counts its rounds anew.
export const freshRounds = {
  rounds: 0,
  telling: null,
  held: null,
  reviewed_by: null,
  review_round: null,
  top_round: null,
  verdict: null,
  review_line: null,
  reviewed_commit: null,
  review_at: null,
  limit_decided: false,
  review_failed: false,
  review_post: null,
  posting: null,
  review_findings: null,
} satisfies Partial<Thread>;

// A review was asked for again, with sc review. It is in flight until it answers, and waiting on
// it never needs you, so a thread past the round limit needs you again only once a review asks
// for changes. Changes not yet typed in, or held at the limit, are about an older review.
export const reviewAsked = (now: number) =>
  ({
    needs_you: false,
    review_failed: false,
    telling: null,
    held: null,
    review_at: now,
  }) satisfies Partial<Thread>;

// The builder submitted, as a review asked for does. A flow with no review stage saves its
// verdict as the submit starts, so the thread waits on checks from then on, rather than showing a
// review no reviewer will run.
export const submitted = (now: number, unreviewed: boolean) =>
  ({
    ...reviewAsked(now),
    ...(unreviewed ? { verdict: "not reviewed" as const } : {}),
  }) satisfies Partial<Thread>;

// The round failed before its review answered, such as on a push that failed. The lead hears of
// it and can run the review again, so it doesn't need you.
export const roundFailed = (now: number) =>
  ({ review_failed: true, review_at: now }) satisfies Partial<Thread>;

// A submit on a flow with no review stage was marked not reviewed, so it waits on CI like an
// approval, with no round. `ready` is why it needs you at once, without a forge, or null.
export const notReviewed = (sha: string, ready: string | null, now: number) =>
  ({
    needs_you: ready !== null,
    telling: null,
    held: null,
    verdict: "not reviewed",
    reviewed_by: null,
    review_round: null,
    review_line: null,
    reviewed_commit: sha,
    review_at: now,
  }) satisfies Partial<Thread>;

// The lead or you decided about the round limit, by marking, clearing or arming a merge, so the
// thread no longer needs you for it. The next review asks again. Nothing changes for a thread the
// limit doesn't hold.
export const limitDecided = (thread: Thread): { limit_decided?: true } =>
  limitWaits(thread) ? { limit_decided: true } : {};

// You let a thread past the round limit go on, with sc start. Its held changes are to be typed
// into the builder, as a round within the limit would have done. Its rounds of changes stand at
// the limit, so it is no longer past it, but the next review asking for changes reaches it again.
export const letGoOn = (thread: Thread, maxRounds: number) =>
  ({
    rounds: maxRounds,
    needs_you: false,
    review_failed: false,
    held: null,
    telling: thread.held,
  }) satisfies Partial<Thread>;

// The review's changes were typed into the builder.
export const changesTyped = { telling: null } satisfies Partial<Thread>;

// Skelcrew's review on the PR was posted or edited, so the next round edits it.
export const reviewOnPr = (post: ReviewPost) => ({ review_post: post }) satisfies Partial<Thread>;

// The saved verdict is on the forge.
export const verdictPosted = { posting: null } satisfies Partial<Thread>;

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
// type into the builder, why, for the log, and the note the lead gets once the review is on the PR, when the
// round limit holds the changes.
type Verdict = {
  change: Partial<Thread>;
  round: number;
  check: "success" | "failure";
  description: string;
  tell: string | null;
  why: string;
  limitNote: string | null;
};

// A review reached its verdict. The builder gets max_rounds rounds of changes. Changes asked for
// after those are posted but not typed in: they are held until sc start lets the thread go on,
// and the thread needs you until you or the lead decide. A review that failed counts no round,
// and is run again under the same number, so a round's number never goes down. With a forge, an
// approved thread waits on CI; without, it is ready at once. The verdict goes on the forge from
// the saved posting, and a failed one posts no review, so the review before it that is still to
// post stays. A new review asks anew about the round limit, so a decision about the last ends.
// The lead's note of the limit waits until the review is on the PR, so it never names one the
// PR doesn't show yet.
export function verdictReached(thread: Thread, reached: Reached): Verdict {
  const { review, by, sha, maxRounds, ready, forge, kept, now } = reached;
  const round = nextRound(thread);
  const failed = review.verdict === "failed" || review.verdict === "timed out";
  const asked = review.verdict === "changes";
  const counted = asked ? thread.rounds + 1 : thread.rounds;
  const held = asked && counted > maxRounds;
  const tell = asked
    ? `Skelcrew's reviewer asked for changes:\n\n${reviewText(review)}\n\nFix what it asks, commit, and run sc submit "<summary>" again.`
    : null;
  const check = review.verdict === "approve" ? "success" : "failure";
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
        : `changes asked for in round ${counted} of ${maxRounds}`
      : keptWhy
        ? ready === null
          ? `${keptWhy}, so it waits on CI`
          : `${keptWhy}; ${ready}`
        : approvedWhy;
  const pr = thread.pr;
  const posted =
    (review.verdict === "approve" || review.verdict === "changes") && pr !== null
      ? { pr, commit: sha, ...review, round }
      : (thread.posting?.review ?? null);
  const limitNote = held ? limitWhy : null;
  const posting: Posting | null = forge
    ? { commit: sha, check, description, review: posted, note: limitNote }
    : null;
  const change = {
    reviewing: null,
    submitting: null,
    rounds: counted,
    needs_you: held || (review.verdict === "approve" && ready !== null),
    review_failed: failed,
    limit_decided: false,
    status: asked && !held ? ("working" as const) : ("waiting" as const),
    telling: held ? null : tell,
    held: held ? tell : null,
    reviewed_by: by,
    review_round: round,
    top_round: failed ? thread.top_round : Math.max(thread.top_round ?? 0, round),
    verdict: review.verdict,
    review_line: review.body.trim().split("\n")[0]?.slice(0, 200) ?? "",
    reviewed_commit: sha,
    review_findings: "findings" in review ? review.findings : [],
    review_at: now,
    posting,
  } satisfies Partial<Thread>;
  return { change, round, check, description, tell: change.telling, why, limitNote };
}
