// The round ledger, in memory: what each event of a review round does to the thread, from plain
// data, with no clock, files or network.
import { expect, test } from "bun:test";
import {
  atRoundLimit,
  changesTyped,
  failureOver,
  letGoOn,
  limitDecided,
  limitWaits,
  nextRound,
  reviewAsked,
  reviewStarted,
  roundFailed,
  roundMoved,
  roundOf,
  submitted,
  verdictPosted,
  verdictReached,
} from "../src/flow/ledger.ts";
import type { Review } from "../src/flow/reviewer.ts";
import type { Thread } from "../src/flow/thread.ts";

function thread(change: Partial<Thread> = {}): Thread {
  return {
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
    title: null,
    body: null,
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
    ...change,
  };
}

const approval = { verdict: "approve" as const, body: "Ready.", findings: [] };
const changes = {
  verdict: "changes" as const,
  body: "Ran the export tests.",
  findings: ["The export has no test.", "The flag is misspelled."],
};
const failed = { verdict: "failed" as const, body: "no verdict" };
const sha = "a".repeat(40);
const reachedNote = "changes asked for after 3 rounds of changes, so the round limit is reached";

// Returns what the review's verdict means for the thread, under a round limit of `maxRounds`,
// with a forge unless `ready` says why the branch is ready at once without one.
const reach = (saved: Thread, review: Review, maxRounds = 3, ready: string | null = null) =>
  verdictReached(saved, {
    review,
    by: "claude",
    sha,
    maxRounds,
    ready,
    forge: ready === null,
    kept: null,
    now: 1000,
  });

test("with a forge, an approved review waits on CI", () => {
  const { change, check, why } = reach(thread(), approval);
  expect(change).toMatchObject({ needs_you: false, status: "waiting", verdict: "approve" });
  expect(check).toBe("success");
  expect(why).toBe("approved by Skelcrew's reviewer, so it waits on CI");
});

// Without a forge there is no CI to wait on, and no PR: the branch is what is ready.
test("without a forge, an approved review needs you at once, saying where the branch is", () => {
  const ready = "app-t1 is ready on branch skelcrew/t1-fix-login";
  const { change, why } = reach(thread({ pr: null }), approval, 3, ready);
  expect(change).toMatchObject({ needs_you: true, status: "waiting", posting: null });
  expect(why).toBe(ready);
});

// The builder gets each finding numbered after the body, so none hides in a paragraph.
test("changes asked for type the body and each finding into the builder, and count a round", () => {
  const { change, tell } = reach(thread({ rounds: 1 }), changes);
  expect(change).toMatchObject({ rounds: 2, status: "working", needs_you: false });
  expect(tell).toContain(
    "Ran the export tests.\n\n1. The export has no test.\n2. The flag is misspelled.",
  );
});

// Past the round limit only a review that asks for changes needs you again. One that failed is
// the lead's to run again.
test("past the round limit, changes are held and need you, and a failed review doesn't", () => {
  const past = reach(thread({ rounds: 3 }), changes);
  expect(past.tell).toBeNull();
  expect(past.change).toMatchObject({ rounds: 4, needs_you: true, telling: null });
  expect(past.change.held).toContain("1. The export has no test.");
  const after = reach(thread({ rounds: 4 }), failed);
  expect(after.change).toMatchObject({ rounds: 4, needs_you: false, held: null });
});

// A round's number goes up with every review that gave a verdict, whatever sc start does to the
// count of rounds of changes. A review that failed is run again under the same number, and an
// approval kept after a merge of main is a round of its own.
test("a thread's round numbers never go backwards, through sc start past the limit", () => {
  let saved = thread({ round_log: [] });
  const numbers: number[] = [];
  const reviewed = (review: Review) => {
    const { change, round } = reach(saved, review, 1);
    saved = { ...saved, ...change };
    numbers.push(round);
  };
  const goOn = () => {
    saved = { ...saved, ...letGoOn(saved, 1, 1500) };
  };
  reviewed(changes);
  reviewed(changes);
  goOn();
  reviewed(failed);
  reviewed(changes);
  reviewed(changes);
  goOn();
  reviewed(approval);
  reviewed(approval);
  expect(numbers).toEqual([1, 2, 3, 3, 4, 5, 6]);
  expect(saved.top_round).toBe(6);
  // A submit asks for the next round, and brings none of the numbers back.
  saved = { ...saved, ...submitted(saved, "Fix", 2000, false) };
  expect(nextRound(saved)).toBe(7);
  // The numbers come from the record, so a field written back by hand can't lower them.
  expect(nextRound({ ...saved, top_round: 1, rounds: 0 })).toBe(7);
  expect(saved.round_log?.map((event) => event.kind)).toEqual([
    "verdict",
    "verdict",
    "let go on",
    "verdict",
    "verdict",
    "verdict",
    "let go on",
    "verdict",
    "verdict",
    "submitted",
  ]);
});

// A task from before Skelcrew kept the record goes on from the counts its row had.
test("a row with no record starts its record from its own counts", () => {
  const old = thread({ rounds: 2, top_round: 5, round_log: null });
  expect(nextRound(old)).toBe(6);
  const { change } = reach(old, changes);
  expect(change).toMatchObject({ rounds: 3, top_round: 6, review_round: 6 });
  expect(change.round_log?.[0]).toMatchObject({
    kind: "before",
    round: { rounds: 2, top_round: 5 },
  });
});

// The lead hears that the round limit holds a thread's changes only once the review is on the PR,
// so the note never names a review the PR doesn't show yet. The note goes with the verdict to
// post, and nothing the verdict saves says it to the lead.
test("the round limit's note waits for the review to be posted", () => {
  const past = reach(thread({ rounds: 3 }), changes);
  expect(past.note).toBeNull();
  expect("noting" in past.change).toBe(false);
  expect(past.change.posting).toMatchObject({ note: reachedNote, review: { round: 4 } });
  // Within the limit, and for an approval, there is no note to post.
  expect(reach(thread({ rounds: 1 }), changes).change.posting?.note).toBeNull();
  expect(reach(thread({ rounds: 3 }), approval).change.posting?.note).toBeNull();
  // A review that failed posts no review, so the one before it still to post stays, without its
  // note, as the failed review no longer holds changes.
  const waiting = { ...thread({ rounds: 4 }), ...past.change };
  const after = reach(waiting, failed);
  expect(after.change.posting).toMatchObject({ review: { round: 4 }, note: null });
});

// Without a forge there is no PR to put the review on, so the verdict is posted at once, in the
// same change, and the note still comes from that posted event.
test("without a forge, the verdict is posted at once and brings the note with it", () => {
  const ready = "app-12 is ready on branch skelcrew/12-add-export";
  const past = reach(thread({ rounds: 3, pr: null }), changes, 3, ready);
  expect(past.note).toBe(reachedNote);
  expect(past.change.round_log?.slice(-2).map((event) => event.kind)).toEqual([
    "verdict",
    "posted",
  ]);
  expect(past.change.round_log?.at(-1)).toMatchObject({ kind: "posted", note: reachedNote });
  expect(reach(thread({ rounds: 1, pr: null }), changes, 3, ready).note).toBeNull();
});

// The note comes from the posted event: once the review is on the PR, the record says so with its
// note, and the lead gets it only while the limit still holds the changes.
test("posting the verdict brings the round limit's note, unless a submit came first", () => {
  const before = thread({ rounds: 3 });
  const onPr = { pr: 7, id: "9", verdict: "changes" as const, findings: changes.findings };
  const past = { ...before, ...reach(before, changes).change, review_post: { ...onPr, round: 4 } };
  const { posting } = past;
  if (posting === null) throw new Error("the verdict saved nothing to post");
  const posted = verdictPosted(past, posting, 2000);
  expect(posted.note).toBe(posting.note);
  expect(posted.change.posting).toBeNull();
  expect(posted.change.round_log?.at(-1)).toEqual({
    kind: "posted",
    at: 2000,
    round: 4,
    note: posting.note,
  });
  const resubmitted = { ...past, ...submitted(past, "Fix", 1500, false) };
  expect(verdictPosted(resubmitted, posting, 2000).note).toBeNull();
  const decided = { ...past, ...limitDecided(past, 1500) };
  expect(verdictPosted(decided, posting, 2000).note).toBeNull();
  // A forge that can't edit, with nothing new said, would leave the older round's review on the
  // PR. The record then says the PR shows that round, and the lead hears nothing of this one.
  const older = { ...past, review_post: { ...onPr, round: 3 } };
  const stale = verdictPosted(older, posting, 2000);
  expect(stale.note).toBeNull();
  expect(stale.change.round_log?.at(-1)).toMatchObject({ kind: "posted", round: 3 });
});

// The round limit needs you until you or the lead decide, and each review reaching it asks again.
test("the round limit waits for a decision, which the next review asks for again", () => {
  const past = { ...thread({ rounds: 3 }), ...reach(thread({ rounds: 3 }), changes).change };
  expect(atRoundLimit(past, 3)).toBe(true);
  expect(limitWaits(past)).toBe(true);
  const decided = { ...past, ...limitDecided(past, 1500) };
  expect(decided.limit_decided).toBe(true);
  expect(limitWaits(decided)).toBe(false);
  // Nothing is decided on a thread the limit doesn't hold.
  expect(limitDecided(thread(), 1500)).toEqual({});
  const again = { ...decided, ...letGoOn(decided, 3, 1600) };
  const next = reach(again, changes);
  expect(next.change).toMatchObject({ limit_decided: false, needs_you: true });
});

// sc start lets a thread past the limit go on: the held changes are typed in, and it is no
// longer past the limit, until the next review asking for changes.
test("letting a thread go on types its held changes in and stops the round limit", () => {
  const past = { ...thread({ rounds: 3 }), ...reach(thread({ rounds: 3 }), changes).change };
  const goOn = letGoOn(past, 3, 1500);
  expect(goOn).toMatchObject({ rounds: 3, held: null, needs_you: false, telling: past.held });
  const on = { ...past, ...goOn };
  expect(atRoundLimit(on, 3)).toBe(false);
  expect(reach(on, changes).change).toMatchObject({ rounds: 4, needs_you: true });
});

// What the forge said while a round moved on is about the older round. Posting a verdict or
// deciding the limit moves nothing on.
test("a submit, a review that starts or ends and letting a thread go on move the round", () => {
  const fresh = thread({ round_log: [] });
  const later = (from: Thread, change: Partial<Thread>): Thread => ({ ...from, ...change });
  expect(roundMoved(fresh, fresh)).toBe(false);
  const sent = later(fresh, submitted(fresh, "Fix", 1000, false));
  expect(roundMoved(fresh, sent)).toBe(true);
  const started = later(sent, reviewStarted(sent, sha, 1100));
  expect(roundMoved(sent, started)).toBe(true);
  expect(reviewStarted(started, sha, 1200)).toEqual({});
  const past = later(started, reach(later(started, { rounds: 3 }), changes).change);
  expect(roundMoved(started, past)).toBe(true);
  const { posting } = past;
  if (posting === null) throw new Error("the verdict saved nothing to post");
  const posted = later(past, verdictPosted(past, posting, 1300).change);
  expect(roundMoved(past, posted)).toBe(false);
  const decided = later(posted, limitDecided(later(posted, { needs_you: true }), 1400));
  expect(roundMoved(posted, decided)).toBe(false);
  expect(roundMoved(decided, later(decided, letGoOn(decided, 3, 1500)))).toBe(true);
});

// Every round field is what the record says, after every event, so the two never disagree.
test("the round fields are always what the record comes to", () => {
  let saved = thread({ round_log: [] });
  const steps: ((from: Thread) => Partial<Thread>)[] = [
    (from) => submitted(from, "Add export", 1000, false),
    (from) => reviewStarted(from, sha, 1100),
    (from) => reach(from, changes, 1).change,
    (from) => changesTyped(from, 1200),
    (from) => submitted(from, "Fix", 1300, false),
    (from) => reviewStarted(from, sha, 1400),
    (from) => reach(from, changes, 1).change,
    (from) => ({ needs_you: true, ...limitDecided({ ...from, needs_you: true }, 1500) }),
    (from) => letGoOn(from, 1, 1600),
    (from) => reviewAsked(from, sha, 1700),
    (from) => reach(from, failed, 1).change,
    (from) => roundFailed(from, 1800),
    (from) => failureOver(from, 1900),
    (from) => reach(from, approval, 1).change,
  ];
  for (const step of steps) {
    saved = { ...saved, ...step(saved) };
    expect(saved).toMatchObject(roundOf(saved));
    expect(roundOf({ ...saved, round_log: null })).toEqual(roundOf(saved));
  }
  expect(saved).toMatchObject({
    verdict: "approve",
    rounds: 1,
    top_round: 3,
    review_failed: false,
  });
});
