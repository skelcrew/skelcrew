// Deciding what an event means: given a thread and what its forge returned, these functions
// say what to do. They read no clock, files or network, so they can be tested without them.
import type { Item } from "./copy.ts";
import type { Review } from "./reviewer.ts";
import type { Thread } from "./thread.ts";

// How an event changes the thread's status and its needs you flag.
type Change = Partial<Pick<Thread, "status" | "needs_you" | "review_failed">>;
export type PullRequest = Extract<Item, { kind: "pr" }>;
export type Check = PullRequest["checks"][number];
type Author = PullRequest["comments"][number]["author"];

// The check Skelcrew sets on a thread's commit with the review's verdict. It is Skelcrew's own, so
// it is neither CI nor a failure for the builder to fix.
export const reviewCheck = "skelcrew/check";

// Returns whether the thread's latest submit may go on to CI and ready: Skelcrew's reviewer
// approved it, or its flow has no review stage, so it was never reviewed. Everything that
// waits on an approval waits on this, so a flow without a review never waits on one.
export const passedReviewStage = (thread: Pick<Thread, "verdict">) =>
  thread.verdict === "approve" || thread.verdict === "not reviewed";

// Returns whether a submit on a flow with no review stage is on its way: being pushed, or waiting
// for CI's first check before it is marked not reviewed. Such a submit saves "not reviewed" as it
// starts, so it is never shown as a review under way: no reviewer will run, and it waits on
// checks.
export const waitsOnFirstCheck = (thread: Pick<Thread, "verdict" | "submitting" | "reviewing">) =>
  thread.verdict === "not reviewed" && (thread.submitting !== null || thread.reviewing !== null);

// Returns how a merge when ready of the thread waits, in words after "once" or "as soon as": for
// an approval and green checks, or on a flow with no review stage for its checks alone.
export const readyWhen = (thread: Pick<Thread, "verdict">) =>
  thread.verdict === "not reviewed" ? "its checks pass" : "it's approved and green";

// Returns whether the thread has used up its rounds of changes. Past that a review's changes
// are held, and the thread needs you until you decide, let it go on, or its reviewer approves.
// A submit or review under way past it is waited on first, as waiting on a review never needs you. An approval
// answers the changes the limit held, so an approved thread is ready like any other rather
// than showing the round limit until it merges. A flow with no review stage never counts a
// round, as no review asks for changes.
export const pastRoundLimit = (thread: Thread, maxRounds: number) =>
  thread.rounds > maxRounds && !passedReviewStage(thread);

// Returns whether the round limit makes the thread need you as an event sets its builder working:
// past the limit, with the last review asking for changes and no submit or review under way, as
// waiting on a review never needs you, and a review that failed is the lead's to run again.
const limitNeedsYou = (thread: Thread, maxRounds: number) =>
  pastRoundLimit(thread, maxRounds) &&
  thread.verdict === "changes" &&
  thread.submitting === null &&
  thread.reviewing === null;

// What decide says to do with a thread: end it, with the reason for its log and the note for
// its lead, or tell its builder what is new and change the thread.
export type Decision =
  | { end: string; note: string }
  | {
      // The IDs of the reviews, comments and check runs handled once this decision is carried
      // out, among those the PR shows.
      seen: string[];
      // What people said on the PR, their reviews and comments, to type into the builder.
      tell: string[];
      // What Skelcrew itself tells the builder of the PR, such as a conflict, besides the failed
      // checks, whose logs come from the forge. Kept apart from people's words, as a new round
      // makes it stale while their words still hold.
      notice: string[];
      // The reviews and comments by people that are typed in. The forge marks them seen once
      // they are.
      typedIn: { kind: "review" | "comment"; id: string }[];
      failed: Check[];
      // The base branch the PR conflicts with, or null. The builder is told to merge it and
      // fetches it from Skelcrew's clone, so that clone must fetch it first.
      conflict: string | null;
      // The commit the thread's branch moved to on the forge, without its builder, or null.
      // The builder fetches it from Skelcrew's clone, so that clone must fetch it first.
      moved: string | null;
      change: Change;
      why: string;
    };

// Returns CI's checks, without Skelcrew's own review check, which its rounds look after.
const ciOf = (pr: PullRequest) => pr.checks.filter((c) => c.name !== reviewCheck);

// Returns what the PR's CI says, for the strip, or null when it has none. One failure is enough
// to say so, while the rest still run. A cancelled check isn't the builder's to fix, but isn't
// green either.
export function ciState(pr: PullRequest): Thread["checks"] {
  const ci = ciOf(pr);
  if (ci.length === 0) return null;
  if (ci.every((c) => c.state === "passed")) return "passing";
  return ci.some((c) => c.state === "failed" || c.state === "cancelled") ? "failing" : "pending";
}

// Returns whether the PR's head has CI's checks to go by: a CI check shows on it, or the wait
// for CI's first check on it ended with none, so no CI runs on it. Until then CI may still be
// starting, and a PR with only Skelcrew's check is neither ready nor merged.
export const ciKnown = (thread: Thread, pr: PullRequest) =>
  ciOf(pr).length > 0 || (pr.head !== null && thread.no_ci === pr.head);

// Returns what to save on the thread about CI on its PR's head, or null for nothing. A CI check
// that shows adds the head to the commits CI showed on, and takes back a "no CI" saved on it, so
// a check that showed and then vanished is never taken for no CI, even when the PR's head goes
// back to that commit after another. Otherwise, once `waitEnded` says the
// wait for CI's first check ended, the head is saved as one no CI runs on, such as a docs-only
// commit CI skips with a paths filter. Only a head that would merge waits: an approved one, one
// its flow doesn't review, or the one a merge without approval pinned, with no round under way. `waitEnded` is asked last,
// as it reads the clock and Skelcrew's clone.
export function ciOnHead(
  thread: Thread,
  pr: PullRequest,
  waitEnded: () => boolean,
): Partial<Pick<Thread, "no_ci" | "ci_shown">> | null {
  const { head } = pr;
  if (head === null) return null;
  const shown = thread.ci_shown.includes(head);
  if (ciOf(pr).length > 0) {
    if (shown && thread.no_ci !== head) return null;
    return {
      ...(shown ? {} : { ci_shown: [...thread.ci_shown, head] }),
      ...(thread.no_ci === head ? { no_ci: null } : {}),
    };
  }
  const waits =
    ["working", "waiting"].includes(thread.status) &&
    (passedReviewStage(thread) || thread.merge_pinned === head) &&
    thread.submitting === null &&
    thread.reviewing === null &&
    pr.state === "open" &&
    thread.no_ci !== head &&
    !shown;
  return waits && waitEnded() ? { no_ci: head } : null;
}

// Returns whether every check on the PR passed, Skelcrew's own included, which it sets once its
// reviewer approves, or as a submit its flow doesn't review is pushed. With no CI, that check
// is the only one, and it counts only once the wait for CI's first check on the head ended with
// none, as CI may still be starting. A thread's saved CI state leaves Skelcrew's check out, so
// this is what says an approved PR is ready to merge.
export function allGreen(thread: Thread, pr: PullRequest): boolean {
  const approved = pr.checks.some((c) => c.name === reviewCheck && c.state === "passed");
  return approved && pr.checks.every((c) => c.state === "passed") && ciKnown(thread, pr);
}

// Returns what an armed merge when ready still waits on, in words for the thread's row and the
// lead, such as "an approval", or null once the PR may merge. It merges only at the commit
// Skelcrew's reviewer approved, `approved`, which must still be the PR's head, or for a flow with
// no review stage the commit last submitted, with every check
// on it passed, Skelcrew's own there and passed too, and the forge saying it merges cleanly. A
// PR with no CI check passes only once the wait for its first check ended with none. A thread
// that failed or stopped keeps its plan, and says so, as starting it again carries the plan on.
export function mergeWaitsOn(
  thread: Thread,
  pr: PullRequest | null,
  approved: string | null,
): string | null {
  if (thread.status === "failed") return "its thread, which failed";
  if (thread.status === "stopped") return "its thread, which is stopped";
  if (pr === null || pr.state !== "open") return "its PR";
  // A submit its flow doesn't review waits on checks, until its push, its PR or Skelcrew's check
  // fails, which needs someone to act.
  if (waitsOnFirstCheck(thread) && thread.review_failed)
    return thread.submitting !== null
      ? "its submit, which failed"
      : "Skelcrew's check, which failed";
  if (waitsOnFirstCheck(thread)) return "its checks";
  if (thread.submitting !== null || thread.reviewing !== null) return "its review";
  if (!passedReviewStage(thread)) return "an approval";
  // A push Skelcrew didn't review, such as someone else's, is never merged unseen.
  if (approved === null || pr.head !== approved) return "a review of its newest commit";
  if (pr.conflicts || thread.conflicts !== null) return `its conflict with ${pr.base} to be fixed`;
  if (pr.checks.some((c) => c.state === "failed" || c.state === "cancelled"))
    return "its failing checks to be fixed";
  if (pr.checks.some((c) => c.state !== "passed")) return "its checks";
  // Skelcrew's own check carries the review's verdict, so a PR the forge shows without it yet
  // waits for it rather than counting as green.
  if (!pr.checks.some((c) => c.name === reviewCheck)) return "its checks";
  if (!ciKnown(thread, pr)) return "its checks";
  return null;
}

// Returns what a merge without Skelcrew's approval still waits on, in the same words as a merge
// when ready, or null once the PR may merge. Only the reviewer's approval is skipped: its review
// may ask for changes, and Skelcrew's own check, which carries that verdict, is left out. A review
// still running is waited for, so its findings are known before the merge. CI must still pass,
// and the PR merge cleanly. A PR with no CI check passes only once the wait for its first check
// ended with none, as for a merge when ready. Whether the head is still the one you saw is the
// caller's, as a push cancels the plan rather than waits.
export function skipReviewWaitsOn(thread: Thread, pr: PullRequest | null): string | null {
  if (thread.status === "failed") return "its thread, which failed";
  if (thread.status === "stopped") return "its thread, which is stopped";
  if (pr === null || pr.state !== "open") return "its PR";
  // A submit under way pushes a commit you never saw, which then cancels the plan.
  if (thread.submitting !== null) return "its builder's new round";
  // A review still running waits to end, so its findings reach the follow-up issue. Its verdict
  // then changes nothing.
  if (thread.reviewing !== null) return "its review";
  if (pr.conflicts || thread.conflicts !== null) return `its conflict with ${pr.base} to be fixed`;
  const ci = ciOf(pr);
  if (ci.some((c) => c.state === "failed" || c.state === "cancelled"))
    return "its failing checks to be fixed";
  if (ci.some((c) => c.state !== "passed")) return "its checks";
  if (!ciKnown(thread, pr)) return "its checks";
  return null;
}

// Returns what the lead's note of a stuck merge is counted by, so it hears once for each: the
// review round, or on a flow with no review stage, which has no rounds, when its last submit was
// marked not reviewed. Null before either.
export const noteRound = (thread: Thread) =>
  thread.verdict === "not reviewed" ? thread.review_at : thread.review_round;

// Returns whether the lead should hear that an armed merge still waits, after a review round
// ended, or a submit its flow doesn't review was marked so. A review or checks still running are
// on their way, so only a wait that needs someone to act counts, and the lead hears it once for
// each round or submit.
export const mergeStuck = (thread: Thread, waits: string | null) =>
  waits !== null &&
  waits !== "its review" &&
  waits !== "its checks" &&
  noteRound(thread) !== null &&
  thread.merge_noted !== noteRound(thread);

// Returns whether a change of these files touches only docs and Markdown: each is under docs/
// or ends in .md. CI skips such a commit, and so does the reviewer's run of the tests, as no
// code changed. No files at all says nothing, so it isn't.
export function onlyDocs(files: string[]): boolean {
  return files.length > 0 && files.every((f) => f.startsWith("docs/") || f.endsWith(".md"));
}

// Returns who runs the whole test suite on `commit`, the head of `own`, the thread's PR, so it
// runs once: CI, once a CI check shows on this commit, as only that proves CI runs on it. A
// workflow can skip one PR while it runs on others, such as with a branch or paths filter.
// Until then the review waits, while a check may still come, for `waited` milliseconds so far:
// up to `ciWait` when CI shows on another of the repository's `prs` or the commit `setsUpCi`, as
// on a first PR, and up to `checkWait` otherwise, as CI outside GitHub has no workflows to read.
// A review here that already `waitedInVain`, with no CI anywhere, as with a workflow that runs
// only on a release or no CI at all, means no PR or commit of the repository waits for one
// again, unless CI shows on another PR. Otherwise the reviewer runs it.
export function whoRunsTheSuite(given: {
  own: PullRequest | null;
  commit: string;
  prs: PullRequest[];
  setsUpCi: boolean;
  waitedInVain: boolean;
  waited: number;
  checkWait: number;
  ciWait: number;
}): "ci" | "reviewer" | "wait" {
  const { own, commit, prs, setsUpCi, waitedInVain, waited, checkWait, ciWait } = given;
  if (own?.head === commit && ciOf(own).length > 0) return "ci";
  if (prs.some((pr) => ciOf(pr).length > 0)) return waited < ciWait ? "wait" : "reviewer";
  if (waitedInVain) return "reviewer";
  return waited < (setsUpCi ? ciWait : checkWait) ? "wait" : "reviewer";
}

// Returns what the reviewer reads about CI on the commit it reviews: whether CI passed, failed
// or still runs, each check's state, and the end of each failed check's log, from `logs` by
// check ID. CI the forge shows for another commit, such as the one before, is never this
// commit's, so the reviewer is told CI hasn't reported yet.
export function ciResult(
  pr: PullRequest | null,
  commit: string,
  logs: Map<string, string>,
): string {
  // Nothing about this commit yet: the forge's copy holds an older head, or no check started.
  const state = pr?.head === commit ? ciState(pr) : null;
  if (pr === null || state === null)
    return "CI is still running: it hasn't reported on this commit yet.\n";
  // The whole result first, in the words the PR's page uses, then each check.
  const ci = ciOf(pr);
  const word = { passing: "passed", failing: "failed", pending: "is still running" };
  const lines = [`CI ${word[state]} on this commit.`, ""];
  for (const check of ci) lines.push(`- ${check.name}: ${check.state}`);
  // Each failed check's log ends with the failing tests, which the reviewer names.
  for (const check of ci) {
    const log = check.id === null ? undefined : logs.get(check.id);
    if (check.state === "failed" && log !== undefined)
      lines.push("", `The end of the log of ${check.name}:`, "", log.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

// Returns the IDs the thread has handled, as a set. A thread saved before Skelcrew kept them has
// the last ID of each kind it handled instead, from a forge whose IDs only grow: everything up
// to those counts as handled. One that never took in its PR's history has neither.
function handledBefore(thread: Thread, pr: PullRequest): Set<string> | null {
  if (thread.seen !== null) return new Set(thread.seen);
  // An older thread: count as handled every numeric ID up to the last of its kind.
  const { last_review, last_comment, last_check } = thread;
  if (last_review === null || last_comment === null || last_check === null) return null;
  const upTo = (last: number) => (id: string) => /^\d+$/.test(id) && Number(id) <= last;
  return new Set([
    ...pr.reviews.map((r) => r.id).filter(upTo(last_review)),
    ...pr.comments.map((c) => c.id).filter(upTo(last_comment)),
    ...pr.checks.flatMap((c) => (c.id === null ? [] : [c.id])).filter(upTo(last_check)),
  ]);
}

// Returns what tells the builder its branch moved on the remote to `commit`, with commits it
// hasn't got, such as a PR merged into it. Its next push would be refused, and pushing over them
// would lose them, so it merges them before anything else.
export function branchMoved(branch: string, commit: string): string {
  return `Your branch ${branch} moved on the remote to ${commit}, with commits you don't have, such as a PR merged into it. Before changing anything else, run git fetch origin, merge origin/${branch} into your branch and commit, then go on. A round submitted without them is refused.`;
}

// Returns the ID among those a thread has seen that says its builder was told its branch moved
// on the forge to the commit, so it is told once.
export const headSeen = (commit: string) => `head:${commit}`;

// Returns the IDs seen without the commits whose moved-branch notice is among the `dropped`
// texts. A new round drops Skelcrew's notices still waiting to be typed in, so those never
// reached the builder. Forgotten, the next poll or refused push tells them again, unless the
// round's commit already merged them. A notice the builder got stays told.
export function forgetMoves(seen: string[] | null, branch: string, dropped: string[]) {
  if (seen === null) return null;
  const notTold = (id: string) =>
    id.startsWith("head:") &&
    dropped.some((text) => text.includes(branchMoved(branch, id.slice("head:".length))));
  return seen.filter((id) => !notTold(id));
}

// Decides what the thread's PR, as its forge returned it, means for the thread: whether it
// ended, what to type into the builder, and how the thread changes. `moved` says the forge's
// head holds commits Skelcrew never pushed for the thread. Events are handled once:
// only reviews, comments and check runs whose IDs the thread hasn't seen count. Your comments
// wake the builder even past the round limit. Those of someone who can push to the repository
// wake it within the limit. Anyone else's, a bot's included, never do: on a public repository
// anyone can comment, and what is typed in steers the builder. Skelcrew's own reviews come from
// its forge's app, a bot.
export function decide(
  thread: Thread,
  pr: PullRequest,
  given: { maxRounds: number; moved: boolean },
): Decision {
  // A merged or closed PR ends the thread. The lead hears which, so it stops listing the PR as
  // open.
  if (pr.state === "merged")
    return {
      end: `PR #${thread.pr} was merged`,
      note: `is done: #${thread.pr} merged into ${pr.base}`,
    };
  if (pr.state === "closed")
    return {
      end: `PR #${thread.pr} was closed without merging`,
      note: `ended: #${thread.pr} closed without merging`,
    };
  // A thread with nothing to go on takes in everything the PR shows as handled, so its whole
  // history isn't typed into the builder at once.
  const runs = pr.checks.flatMap((check) => (check.id === null ? [] : [check.id]));
  const shown = [...pr.reviews.map((r) => r.id), ...pr.comments.map((c) => c.id), ...runs];
  const before = handledBefore(thread, pr);
  if (before === null) {
    const why = "started after the PR's history";
    return {
      seen: shown,
      tell: [],
      notice: [],
      typedIn: [],
      failed: [],
      conflict: null,
      moved: null,
      change: {},
      why,
    };
  }
  const past = pastRoundLimit(thread, given.maxRounds);
  // Whether what this author wrote is typed into the builder.
  const wakes = (author: Author) =>
    author !== null && !author.bot && (author.you || (!past && author.push === true));
  const who = (author: Author) => author?.login ?? "someone";
  // New reviews and comments from those who may wake the builder are typed in, a review with
  // its comments on lines. Each is named, for the forge to mark seen.
  const tell: string[] = [];
  const typedIn: { kind: "review" | "comment"; id: string }[] = [];
  const reviews = pr.reviews.filter((r) => !before.has(r.id));
  for (const r of reviews) {
    if (!wakes(r.author)) continue;
    const lines = r.lines.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.text}`);
    const text = [r.text.trim(), ...lines].filter(Boolean).join("\n\n");
    if (!text) continue;
    tell.push(`${who(r.author)} reviewed the PR:\n\n${text}`);
    typedIn.push({ kind: "review", id: r.id });
  }
  const comments = pr.comments.filter((c) => !before.has(c.id));
  for (const c of comments) {
    if (!wakes(c.author)) continue;
    tell.push(`${who(c.author)} commented on the PR:\n\n${c.text}`);
    typedIn.push({ kind: "comment", id: c.id });
  }
  // Only once nothing is under way, so a conflict or a failed commit status is told once: the
  // builder then works on it until it submits again.
  const quiet =
    thread.status === "waiting" && thread.submitting === null && thread.reviewing === null;
  const ci = ciOf(pr);
  // While a newer round is still being pushed, the checks the forge shows are an older
  // commit's. Parallel jobs finish out of order, so failures wait until every check has
  // finished, and are told together. A check with no ID, such as a commit status, has no log
  // and nothing to remember it by, so it is told only while the thread is quiet.
  const finished = thread.submitting === null && !ci.some((c) => c.state === "running");
  const failed = finished
    ? ci.filter((c) => c.state === "failed" && (c.id === null ? quiet : !before.has(c.id)))
    : [];
  // A conflict with the base is told with how to fix it.
  const conflict = quiet && pr.conflicts ? pr.base : null;
  const notice: string[] = [];
  if (conflict !== null)
    notice.push(
      `The PR conflicts with ${conflict}. Run git fetch origin, merge origin/${conflict} into your branch and fix the conflict, then commit and run sc submit "<summary>" again.`,
    );
  // A branch that moved on the forge is told once for each commit it moved to, remembered
  // among the IDs seen. It is told while a round is submitting too, as a push refused for it
  // may have failed to tell the builder, and a failed round stays submitting.
  const head = pr.head === null ? null : headSeen(pr.head);
  const moved = given.moved && head !== null && !before.has(head) ? pr.head : null;
  if (moved !== null) notice.push(branchMoved(thread.branch, moved));
  // The IDs the PR no longer shows can never come back, so they are left out. The branch's
  // head is kept while it stays where it was told.
  const seen = shown.filter(
    (id) =>
      before.has(id) ||
      reviews.some((r) => r.id === id) ||
      comments.some((c) => c.id === id) ||
      (finished && runs.includes(id)),
  );
  if (head !== null && (before.has(head) || moved !== null)) seen.push(head);
  // Anything to tell sets the builder working again.
  if (tell.length > 0 || notice.length > 0 || failed.length > 0) {
    const told = [
      ...failed.map((r) => `${r.name} failed`),
      ...[...tell, ...notice].map((t) => t.split("\n")[0]),
    ];
    // Past the round limit the thread still needs you, as the builder's next round would.
    const change: Change = {
      status: "working",
      needs_you: limitNeedsYou(thread, given.maxRounds),
      review_failed: false,
    };
    const why = `told the builder: ${told.join("; ")}`;
    return { seen, tell, notice, typedIn, failed, conflict, moved, change, why };
  }
  // An approved PR with every check green is ready. A branch holding commits Skelcrew never
  // pushed is never ready, as no review saw them, such as one that ran on the builder's commit
  // while a PR was merged into its branch.
  if (quiet && !thread.needs_you && !given.moved && allGreen(thread, pr))
    return {
      seen,
      tell,
      notice,
      typedIn,
      failed,
      conflict,
      moved,
      change: { needs_you: true },
      why:
        thread.verdict === "not reviewed"
          ? "not reviewed, as its flow has none, with every check green, so it is ready to merge"
          : "approved by Skelcrew's reviewer with every check green, so it is ready to merge",
    };
  return { seen, tell, notice, typedIn, failed, conflict, moved, change: {}, why: "" };
}

// Decides what a branch at `head` on its remote means for a thread with no PR to poll: one in
// a repository with no forge, or one whose PR didn't open after its push. `moved` says the head
// holds commits Skelcrew never pushed for the thread. The builder is told once for each such
// commit, as decide tells it for a PR, and the thread stops being ready to merge. Returns null
// when there is nothing to tell. A thread saved before Skelcrew kept the IDs it has seen starts
// with none: with no PR, it has no history the IDs would hold back.
export function decideBranch(
  thread: Thread,
  head: string,
  given: { maxRounds: number; moved: boolean },
): Exclude<Decision, { end: string }> | null {
  const seen = thread.seen ?? [];
  if (!given.moved || seen.includes(headSeen(head))) return null;
  const notice = branchMoved(thread.branch, head);
  return {
    seen: [...seen, headSeen(head)],
    tell: [],
    notice: [notice],
    typedIn: [],
    failed: [],
    conflict: null,
    moved: head,
    // Past the round limit the thread still needs you, as the builder's next round would.
    change: {
      status: "working",
      needs_you: limitNeedsYou(thread, given.maxRounds),
      review_failed: false,
    },
    why: `told the builder: ${notice.split(". ")[0]}`,
  };
}

// A task labeled to start, by its ID and title.
type Labeled = { id: string; title: string };

// Returns the tasks labeled to start that get a thread: those with no thread at all. A thread
// that failed, was stopped or is done keeps its row, so its label never starts it again;
// only sc start does.
export function labeledToStart(threads: Thread[], labeled: Labeled[]): Labeled[] {
  return labeled.filter((task) => !threads.some((t) => t.task === task.id));
}

// What a finished review means for a thread: Skelcrew's check to set and its description, the
// thread's new rounds, needs you and status, what to type into the builder, and why.
type Outcome = {
  check: "success" | "failure";
  description: string;
  rounds: number;
  needsYou: boolean;
  status: "working" | "waiting";
  tell: string | null;
  // Changes past the round limit, kept rather than typed in.
  held: string | null;
  why: string;
};

// Returns what a reviewer said in words: its body, then each finding numbered, for the builder
// and the PR to read.
function reviewText(review: { body: string; findings: string[] }): string {
  const findings = review.findings.map((finding, n) => `${n + 1}. ${finding.trim()}`);
  return [review.body.trim(), ...(findings.length > 0 ? [findings.join("\n")] : [])]
    .filter((part) => part !== "")
    .join("\n\n");
}

// Returns the body of Skelcrew's review comment on a PR: which round and commit it covers, then
// what the reviewer said and found. The one comment is edited each round, so its first line says
// which review it now holds. The forge adds the verdict above it.
export function reviewComment(
  review: { body: string; findings: string[] },
  round: number,
  commit: string,
): string {
  return `Round ${round} · commit ${commit.slice(0, 7)}\n\n${reviewText(review)}`;
}

// Decides what a finished review means for a thread that has had `rounds` rounds of changes.
// It returns Skelcrew's check to set, the thread's new state, and what to type into the
// builder, if anything. The builder gets max_rounds rounds of changes. Changes asked for after
// those are posted but not typed in. They are held until sc start lets the thread go on, and
// the thread needs you until you or the lead decide. With a forge, an approved thread waits on CI,
// and polling marks it needs you once every check is green. Without a forge there is no CI, so
// `ready` is the reason it needs you at once, such as the branch it is ready on.
export function afterReview(
  rounds: number,
  review: Review,
  maxRounds: number,
  ready: string | null,
): Outcome {
  // A review that failed to give a verdict, or timed out, counts no round. The lead hears of it
  // and can run it again, so it doesn't need you, past the round limit too: only a review that
  // asks for changes there does.
  if (review.verdict === "failed" || review.verdict === "timed out")
    return {
      check: "failure",
      description: review.verdict === "failed" ? "review failed" : "review timed out",
      rounds,
      needsYou: false,
      status: "waiting",
      tell: null,
      held: null,
      why: review.verdict === "failed" ? `review failed: ${review.body}` : review.body,
    };
  if (review.verdict === "approve" && ready !== null)
    return {
      check: "success",
      description: "Skelcrew's reviewer approved",
      rounds,
      needsYou: true,
      status: "waiting",
      tell: null,
      held: null,
      why: ready,
    };
  if (review.verdict === "approve")
    return {
      check: "success",
      description: "Skelcrew's reviewer approved",
      rounds,
      needsYou: false,
      status: "waiting",
      tell: null,
      held: null,
      why: "approved by Skelcrew's reviewer, so it waits on CI",
    };
  // Asking for changes counts a round. Within the limit the changes are typed in; past it they
  // are held and the thread needs you.
  const counted = rounds + 1;
  const changes: Pick<Outcome, "check" | "description" | "rounds"> = {
    check: "failure",
    description: "Skelcrew's reviewer asked for changes",
    rounds: counted,
  };
  const tell = `Skelcrew's reviewer asked for changes:\n\n${reviewText(review)}\n\nFix what it asks, commit, and run sc submit "<summary>" again.`;
  if (counted > maxRounds)
    return {
      ...changes,
      needsYou: true,
      status: "waiting",
      tell: null,
      held: tell,
      why: `changes asked for after ${maxRounds} rounds of changes, so the round limit is reached`,
    };
  return {
    ...changes,
    needsYou: false,
    status: "working",
    tell,
    held: null,
    why: `changes asked for in round ${counted} of ${maxRounds}`,
  };
}

// Returns what to say when a thread's push was refused for changing a workflow file, from what
// git said, or null for any other failure. GitHub refuses an app's push that touches a file
// under .github/workflows/, and Skelcrew's app has no permission for them. git's own words name
// only the failed command, so the builder wouldn't know to undo the change.
export function refusedWorkflow(name: string, said: string): string | null {
  const file = said.match(/refusing to allow an? .+? to create or update workflow `([^`]+)`/)?.[1];
  if (file === undefined) return null;
  return `${name}'s push was refused: it changes ${file}, which Skelcrew can't push. Undo that change, or a person must make it.`;
}
