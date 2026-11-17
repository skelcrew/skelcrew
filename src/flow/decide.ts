// Deciding what an event means: given a thread and what its forge returned, these functions
// say what to do. They read no clock, files or network, so they can be tested without them.
import type { Item } from "./copy.ts";
import type { Review } from "./reviewer.ts";
import type { Thread } from "./thread.ts";

// How an event changes the thread's status and its needs you flag.
type Change = Partial<Pick<Thread, "status" | "needs_you">>;
export type PullRequest = Extract<Item, { kind: "pr" }>;
export type Check = PullRequest["checks"][number];
type Author = PullRequest["comments"][number]["author"];

// The check Skelcrew sets on a thread's commit with the review's verdict. It is Skelcrew's own, so
// it is neither CI nor a failure for the builder to fix.
export const reviewCheck = "skelcrew/check";

// Returns whether the thread has used up its rounds of changes. Past that it goes on needing
// you, whatever its builder or reviewer does, until you let it go on.
export const pastRoundLimit = (thread: Thread, maxRounds: number) => thread.rounds > maxRounds;

// What decide says to do with a thread: end it, with the reason, or tell its builder what is
// new and change the thread.
export type Decision =
  | { end: string }
  | {
      // The IDs of the reviews, comments and check runs handled once this decision is carried
      // out, among those the PR shows.
      seen: string[];
      // What to type into the builder, besides the failed checks, whose logs come from the forge.
      tell: string[];
      // The reviews and comments by people that are typed in. The forge marks them seen once
      // they are.
      typedIn: { kind: "review" | "comment"; id: string }[];
      failed: Check[];
      // The base branch the PR conflicts with, or null. The builder is told to merge it and
      // fetches it from Skelcrew's clone, so that clone must fetch it first.
      conflict: string | null;
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

// Returns whether a change of these files touches only docs and Markdown: each is under docs/
// or ends in .md. CI skips such a commit, and so does the reviewer's run of the tests, as no
// code changed. No files at all says nothing, so it isn't.
export function onlyDocs(files: string[]): boolean {
  return files.length > 0 && files.every((f) => f.startsWith("docs/") || f.endsWith(".md"));
}

// How long a review waits for CI's first check on its commit, when CI shows on another PR or
// the commit has workflows. A forge shows a check within seconds of a push, and Skelcrew's copy
// has it by the next poll, 30 seconds later.
export const ciWait = 2 * 60_000;

// How long a review waits for a first check when nothing says CI runs: no workflows and no CI
// on any PR. CI outside GitHub, such as Buildkite, still shows a check, and a poll brings it.
export const checkWait = 40_000;

// Returns who runs the whole test suite on `commit`, the head of `own`, the thread's PR, so it
// runs once: CI, once a CI check shows on this commit, as only that proves CI runs on it. A
// workflow can skip one PR while it runs on others, such as with a branch or paths filter.
// Until then the review waits, while a check may still come, for `waited` milliseconds so far:
// up to ciWait when CI shows on another of the repository's `prs` or the commit `setsUpCi`, as
// on a first PR, and up to checkWait otherwise, as CI outside GitHub has no workflows to read.
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
}): "ci" | "reviewer" | "wait" {
  const { own, commit, prs, setsUpCi, waitedInVain, waited } = given;
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

// Decides what the thread's PR, as its forge returned it, means for the thread: whether it
// ended, what to type into the builder, and how the thread changes. Events are handled once:
// only reviews, comments and check runs whose IDs the thread hasn't seen count. Your comments
// wake the builder even past the round limit. Those of someone who can push to the repository
// wake it within the limit. Anyone else's, a bot's included, never do: on a public repository
// anyone can comment, and what is typed in steers the builder. Skelcrew's own reviews come from
// its forge's app, a bot.
export function decide(thread: Thread, pr: PullRequest, given: { maxRounds: number }): Decision {
  // A merged or closed PR ends the thread.
  if (pr.state === "merged") return { end: `PR #${thread.pr} was merged` };
  if (pr.state === "closed") return { end: `PR #${thread.pr} was closed without merging` };
  // A thread with nothing to go on takes in everything the PR shows as handled, so its whole
  // history isn't typed into the builder at once.
  const runs = pr.checks.flatMap((check) => (check.id === null ? [] : [check.id]));
  const shown = [...pr.reviews.map((r) => r.id), ...pr.comments.map((c) => c.id), ...runs];
  const before = handledBefore(thread, pr);
  if (before === null) {
    const why = "started after the PR's history";
    return { seen: shown, tell: [], typedIn: [], failed: [], conflict: null, change: {}, why };
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
  if (conflict !== null)
    tell.push(
      `The PR conflicts with ${conflict}. Run git fetch origin, merge origin/${conflict} into your branch and fix the conflict, then commit and run sc submit "<summary>" again.`,
    );
  // The IDs the PR no longer shows can never come back, so they are left out.
  const seen = shown.filter(
    (id) =>
      before.has(id) ||
      reviews.some((r) => r.id === id) ||
      comments.some((c) => c.id === id) ||
      (finished && runs.includes(id)),
  );
  // Anything to tell sets the builder working again.
  if (tell.length > 0 || failed.length > 0) {
    const told = [...failed.map((r) => `${r.name} failed`), ...tell.map((t) => t.split("\n")[0])];
    // Past the round limit the thread still needs you, as the builder's next round would.
    const change: Change = { status: "working", needs_you: past };
    const why = `told the builder: ${told.join("; ")}`;
    return { seen, tell, typedIn, failed, conflict, change, why };
  }
  // Skelcrew's reviewer approves by setting its check, so an approved PR with every check passed,
  // its own included, is ready. With no CI, that check is the only one.
  const approved = pr.checks.some((c) => c.name === reviewCheck && c.state === "passed");
  if (quiet && !thread.needs_you && approved && pr.checks.every((c) => c.state === "passed"))
    return {
      seen,
      tell,
      typedIn,
      failed,
      conflict,
      change: { needs_you: true },
      why: "approved by Skelcrew's reviewer with every check green, so it is ready to merge",
    };
  return { seen, tell, typedIn, failed, conflict, change: {}, why: "" };
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

// Decides what a finished review means for a thread that has had `rounds` rounds of changes.
// It returns Skelcrew's check to set, the thread's new state, and what to type into the
// builder, if anything. The builder gets max_rounds rounds of changes. Changes asked for after
// those are posted but not typed in. They are held until sc start lets the thread go on, and
// the thread needs you, as after a failed review. With a forge, an approved thread waits on CI,
// and polling marks it needs you once every check is green. Without a forge there is no CI, so
// `ready` is the reason it needs you at once, such as the branch it is ready on.
export function afterReview(
  rounds: number,
  review: Review,
  maxRounds: number,
  ready: string | null,
): Outcome {
  // A review that failed to give a verdict, or timed out, needs you, and counts no round.
  if (review.verdict === "failed" || review.verdict === "timed out")
    return {
      check: "failure",
      description: review.verdict === "failed" ? "review failed" : "review timed out",
      rounds,
      needsYou: true,
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
  const tell = `Skelcrew's reviewer asked for changes:\n\n${review.body}\n\nFix what it asks, commit, and run sc submit "<summary>" again.`;
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
