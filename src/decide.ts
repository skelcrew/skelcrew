// Deciding what an event means: given a thread and what GitHub returned, these functions say
// what to do. They read no clock, files or network, so they can be tested without them.
import type { Check, Labeled, PullRequest } from "./github.ts";
import type { Review } from "./reviewer.ts";
import type { Thread } from "./thread.ts";

type Change = Partial<Pick<Thread, "status" | "needs_you">>;
type Author = PullRequest["comments"][number]["author"];

export type Decision =
  | { end: string }
  | {
      // The last event of each kind handled once this decision is carried out.
      handled: { last_review: number; last_comment: number; last_check: number };
      // What to type into the builder, besides the failed checks, whose logs come from GitHub.
      tell: string[];
      failed: Check[];
      // The base branch the PR conflicts with, which skel's clone must hold before the
      // builder, told to merge it, fetches it from there.
      conflict: string | null;
      change: Change;
      why: string;
    };

// Conclusions the builder can do something about. A cancelled run was mostly replaced by a
// newer one, and one that needs action needs it from you.
const failing = ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"];

// Returns whether a check passed, so a PR with every check passed is green.
const passed = (check: Check) =>
  check.kind === "run"
    ? check.status === "COMPLETED" &&
      ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")
    : check.state === "SUCCESS";

// Returns whether a check is still to finish.
const running = (check: Check) =>
  check.kind === "run"
    ? check.status !== "COMPLETED"
    : ["PENDING", "EXPECTED"].includes(check.state);

// Returns CI's checks, without skel's own review check, which its rounds look after.
const ciOf = (pr: PullRequest) => pr.checks.filter((c) => c.name !== "skel/review");

// Returns what the PR's CI says, for the strip, or null when it has none. One failure is enough
// to say so, while the rest still run.
export function ciChecks(pr: PullRequest): Thread["checks"] {
  const ci = ciOf(pr);
  if (ci.length === 0) return null;
  if (ci.every(passed)) return "passing";
  return ci.some((c) => !passed(c) && !running(c)) ? "failing" : "pending";
}

// Returns the reviews after the last one handled, oldest first, up to the first one still
// pending. A pending review gets its ID when it is started, not when it is submitted, so the
// reviews after it must wait for it, or it would come in behind the last handled ID.
function newReviews(reviews: PullRequest["reviews"], after: number): PullRequest["reviews"] {
  const later = reviews.filter((r) => r.id > after).sort((a, b) => a.id - b.id);
  const pending = later.findIndex((r) => r.state === "PENDING");
  return pending === -1 ? later : later.slice(0, pending);
}

// Decides what the thread's PR, as GitHub returned it, means for the thread: whether it
// ended, what to type into the builder, and how the thread changes. Events are handled once:
// only reviews, comments and check runs after the last ones handled count. You are `you`, the
// gh login skel uses, and `posted` holds the reviews skel posted with it, which are never
// typed back as yours. Your comments wake the builder even past the round limit. Those of
// `pushers`, who can push to the repository, wake it within the limit. Anyone else's, a bot's
// included, never do: on a public repository anyone can comment, and what is typed in steers
// the builder.
export function decide(
  thread: Thread,
  pr: PullRequest,
  given: { you: string; maxRounds: number; posted: number[]; pushers: string[] },
): Decision {
  if (pr.state === "MERGED") return { end: `PR #${thread.pr} was merged` };
  if (pr.state === "CLOSED") return { end: `PR #${thread.pr} was closed without merging` };
  const runs = pr.checks.flatMap((check) => (check.kind === "run" ? [check] : []));
  const { last_review, last_comment, last_check } = thread;
  if (last_review === null || last_comment === null || last_check === null) {
    const reviews = newReviews(pr.reviews, 0);
    const handled = {
      last_review: Math.max(0, ...reviews.map((r) => r.id)),
      last_comment: Math.max(0, ...pr.comments.map((c) => c.id)),
      last_check: Math.max(0, ...runs.map((r) => r.id)),
    };
    const why = "started after the PR's history";
    return { handled, tell: [], failed: [], conflict: null, change: {}, why };
  }
  const past = thread.rounds > given.maxRounds;
  // Whether what this author wrote is typed into the builder.
  const wakes = (author: Author) =>
    author !== null &&
    !author.bot &&
    (author.login === given.you || (!past && given.pushers.includes(author.login)));
  const who = (author: Author) => author?.login ?? "someone";
  const tell: string[] = [];
  // While skel's reviewer reviews, the review it posts can reach GitHub before skel has
  // noted it as its own, so reviews wait until it is done.
  const reviews = thread.reviewing === null ? newReviews(pr.reviews, last_review) : [];
  for (const r of reviews) {
    if (given.posted.includes(r.id) || !wakes(r.author)) continue;
    const lines = r.comments.map((c) => `${c.path}${c.line ? `:${c.line}` : ""}: ${c.body}`);
    const text = [r.body.trim(), ...lines].filter(Boolean).join("\n\n");
    if (text) tell.push(`${who(r.author)} reviewed the PR:\n\n${text}`);
  }
  const comments = pr.comments.filter((c) => c.id > last_comment).sort((a, b) => a.id - b.id);
  for (const c of comments)
    if (wakes(c.author)) tell.push(`${who(c.author)} commented on the PR:\n\n${c.body}`);
  // Only once nothing is under way, so a conflict or a failed commit status is told once: the
  // builder then works on it until it submits again.
  const quiet =
    thread.status === "waiting" && thread.submitting === null && thread.reviewing === null;
  const ci = ciOf(pr);
  // While a newer round is still being pushed, the checks GitHub shows are an older commit's.
  // Parallel jobs finish out of order, and one that fails later must not fall behind the last
  // handled ID, so failures wait until every check has finished. A commit status has no ID.
  const finished = thread.submitting === null && !ci.some(running);
  const failed = finished
    ? ci.filter((c) =>
        c.kind === "run"
          ? c.id > last_check && failing.includes(c.conclusion ?? "")
          : quiet && ["FAILURE", "ERROR"].includes(c.state),
      )
    : [];
  const conflict = quiet && pr.mergeable === "CONFLICTING" ? pr.base : null;
  if (conflict !== null)
    tell.push(
      `The PR conflicts with ${conflict}. Run git fetch origin, merge origin/${conflict} into your branch and fix the conflict, then commit and run skel submit "<summary>" again.`,
    );
  const handled = {
    last_review: Math.max(last_review, ...reviews.map((r) => r.id)),
    last_comment: Math.max(last_comment, ...comments.map((c) => c.id)),
    last_check: finished ? Math.max(last_check, ...runs.map((r) => r.id)) : last_check,
  };
  if (tell.length > 0 || failed.length > 0) {
    const told = [...failed.map((r) => `${r.name} failed`), ...tell.map((t) => t.split("\n")[0])];
    // Past the round limit the thread still needs you, as the builder's next round would.
    const change: Change = { status: "working", needs_you: past };
    const why = `told the builder: ${told.join("; ")}`;
    return { handled, tell, failed, conflict, change, why };
  }
  // skel's reviewer approves by setting its skel/review check, so an approved PR with every
  // check passed, its own included, is ready. With no CI, that check is the only one.
  const approved = pr.checks.some(
    (c) => c.kind === "status" && c.name === "skel/review" && c.state === "SUCCESS",
  );
  if (quiet && !thread.needs_you && approved && pr.checks.every(passed))
    return {
      handled,
      tell,
      failed,
      conflict,
      change: { needs_you: true },
      why: "approved by skel's reviewer with every check green, so it is ready to merge",
    };
  return { handled, tell, failed, conflict, change: {}, why: "" };
}

// Returns the issues labeled skel that get a thread: those with no thread at all. A thread
// that failed, was stopped or is done keeps its row, so its label never starts it again;
// only skel start does.
export function labeledToStart(threads: Thread[], labeled: Labeled[]): Labeled[] {
  return labeled.filter((issue) => !threads.some((t) => t.task === issue.number));
}

// Returns who wrote the reviews and comments that are new on the threads' PRs, so a poll asks
// GitHub whether they can push only about them. You and bots are left out, as decide never
// needs the answer for either, and so are stopped threads, whose events wait for them to start
// again, and threads that haven't taken in their PR's history yet.
export function newAuthors(
  threads: Thread[],
  prs: Map<number, PullRequest>,
  you: string,
): Set<string> {
  const authors = new Set<string>();
  for (const t of threads) {
    const pr = t.pr === null || t.status === "stopped" ? undefined : prs.get(t.pr);
    for (const item of [
      ...(pr?.reviews.filter((r) => r.id > (t.last_review ?? Number.POSITIVE_INFINITY)) ?? []),
      ...(pr?.comments.filter((c) => c.id > (t.last_comment ?? Number.POSITIVE_INFINITY)) ?? []),
    ])
      if (item.author && !item.author.bot && item.author.login !== you)
        authors.add(item.author.login);
  }
  return authors;
}

export type Outcome = {
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

// Decides what a finished review means for a thread that has had `rounds` rounds of changes:
// the skel/review check to set, the thread's new state, and what to type into the builder,
// if anything. The builder gets max_rounds rounds of changes to fix. A review asking for
// changes after those is posted but not typed in, only held for skel start to let the thread
// go on, and, like a failed review, the thread then needs you. An approved thread waits on
// CI: polling GitHub marks it needs you once every check is green.
export function afterReview(rounds: number, given: Review, maxRounds: number): Outcome {
  if (given.verdict === "failed")
    return {
      check: "failure",
      description: "review failed",
      rounds,
      needsYou: true,
      status: "waiting",
      tell: null,
      held: null,
      why: `review failed: ${given.body}`,
    };
  if (given.verdict === "approve")
    return {
      check: "success",
      description: "skel's reviewer approved",
      rounds,
      needsYou: false,
      status: "waiting",
      tell: null,
      held: null,
      why: "approved by skel's reviewer, so it waits on CI",
    };
  const counted = rounds + 1;
  const changes: Pick<Outcome, "check" | "description" | "rounds"> = {
    check: "failure",
    description: "skel's reviewer asked for changes",
    rounds: counted,
  };
  const tell = `skel's reviewer asked for changes:\n\n${given.body}\n\nFix what it asks, commit, and run skel submit "<summary>" again.`;
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
