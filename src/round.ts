// A round of the build ⇄ review loop: the builder's skel submit, pushed from skel's clone,
// its PR opened on the first round, reviewed by a fresh reviewer, and the review typed back
// into the builder's session when it asks for changes.
import type { Database } from "bun:sqlite";
import {
  findPullRequest,
  openPullRequest,
  postReview,
  pushCommit,
  readIssue,
  setReviewStatus,
} from "./github.ts";
import { cloneDir } from "./paths.ts";
import { type Review, review } from "./reviewer.ts";
import { cloneOf, github, readThread, record, type Thread, threadConfig } from "./thread.ts";
import { typeInto } from "./tmux.ts";

export type Outcome = {
  check: "success" | "failure";
  description: string;
  rounds: number;
  needsYou: boolean;
  status: "working" | "waiting";
  tell: string | null;
  why: string;
};

// Decides what a finished review means for a thread that has had `rounds` rounds of changes:
// the skel/review check to set, the thread's new state, and what to type into the builder,
// if anything. The builder gets max_rounds rounds of changes to fix. A review asking for
// changes after those is posted but not typed in, and, like an approval or a failed review,
// the thread then needs you.
export function afterReview(rounds: number, given: Review, maxRounds: number): Outcome {
  if (given.verdict === "failed")
    return {
      check: "failure",
      description: "review failed",
      rounds,
      needsYou: true,
      status: "waiting",
      tell: null,
      why: `review failed: ${given.body}`,
    };
  if (given.verdict === "approve")
    return {
      check: "success",
      description: "skel's reviewer approved",
      rounds,
      needsYou: true,
      status: "waiting",
      tell: null,
      why: "approved by skel's reviewer",
    };
  const counted = rounds + 1;
  const changes: Pick<Outcome, "check" | "description" | "rounds"> = {
    check: "failure",
    description: "skel's reviewer asked for changes",
    rounds: counted,
  };
  if (counted > maxRounds)
    return {
      ...changes,
      needsYou: true,
      status: "waiting",
      tell: null,
      why: `changes asked for after ${maxRounds} rounds of changes, so the round limit is reached`,
    };
  return {
    ...changes,
    needsYou: false,
    status: "working",
    tell: `skel's reviewer asked for changes:\n\n${given.body}\n\nFix what it asks, commit, and run skel submit "<summary>" again.`,
    why: `changes asked for in round ${counted} of ${maxRounds}`,
  };
}

// Runs git in skel's own clone and returns what it printed, throwing with its error when it
// fails.
async function git(folder: string, ...args: string[]): Promise<string> {
  const run = Bun.spawn(["git", "-C", folder, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Returns the branch the thread's PR goes into: the one it started from with --from, or else
// the default branch, which skel's clone is on.
async function baseOf(thread: Thread): Promise<string> {
  if (thread.base) return thread.base;
  return git(cloneDir(thread.owner, thread.repo), "symbolic-ref", "--short", "HEAD");
}

// Fetches the thread's branch from its clone into skel's clone and pushes the commit it got
// to the thread's branch on GitHub, then opens the PR if there is none yet. Returns the
// commit. git never runs inside the thread's clone: the builder controls everything there,
// .git included, and a planted setting would run with your rights.
async function push(db: Database, folder: string, summary: string): Promise<string> {
  const thread = readThread(db, folder);
  const repo = github(thread);
  const ours = cloneDir(thread.owner, thread.repo);
  // A ref of the thread's own, not FETCH_HEAD, which refreshing skel's clone also writes.
  const ref = `refs/skel/threads/${thread.folder}`;
  await git(
    ours,
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    cloneOf(thread),
    `+refs/heads/${thread.branch}:${ref}`,
  );
  const sha = await git(ours, "rev-parse", "--verify", `${ref}^{commit}`);
  await pushCommit(ours, repo, sha, thread.branch);
  // Found rather than opened when the daemon stopped between opening it and saving it.
  let pr = thread.pr ?? (await findPullRequest(repo, thread.branch));
  if (pr === null) {
    const { title } = await readIssue(repo, thread.task);
    const base = await baseOf(thread);
    pr = await openPullRequest(repo, {
      branch: thread.branch,
      base,
      title,
      body: summary,
      issue: thread.task,
    });
  }
  record(db, folder, { pr }, `pushed ${sha} to ${thread.branch}, for #${pr}`);
  return sha;
}

// Reviews the commit and acts on the verdict: posts it on the PR, sets the skel/review
// check, saves what it means for the thread, and types changes into the builder. Stops
// without a word once a newer round cancels it, since that round now owns the thread.
async function reviewRound(
  db: Database,
  tmux: string,
  folder: string,
  sha: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  const thread = readThread(db, folder);
  const { pr } = thread;
  if (pr === null) throw new Error("the thread has no pull request to review");
  const repo = github(thread);
  const { model, reviewer, maxRounds } = threadConfig();
  await setReviewStatus(repo, sha, "pending", "skel's reviewer is reviewing");
  if (signal.aborted) return;
  record(db, folder, { reviewing: sha, submitting: null }, `reviewing ${sha}`);
  const verdict = await review({
    clone: cloneOf(thread),
    issue: await readIssue(repo, thread.task),
    // The thread's clone has the base branch under origin/, from skel's clone.
    base: `origin/${await baseOf(thread)}`,
    commit: sha,
    model,
    harness: reviewer,
    signal,
  });
  if (signal.aborted) return;
  const outcome = afterReview(readThread(db, folder).rounds, verdict, maxRounds);
  if (verdict.verdict !== "failed") await postReview(repo, pr, verdict.verdict, verdict.body);
  await setReviewStatus(repo, sha, outcome.check, outcome.description);
  if (signal.aborted) return;
  const { rounds, needsYou, status, tell } = outcome;
  const change = { reviewing: null, rounds, needs_you: needsYou, status, telling: tell };
  record(db, folder, change, outcome.why);
  if (tell) await deliver(db, tmux, folder, tell, signal);
}

// Types a review's changes into the builder once it is idle, then forgets them. They are
// saved until then, so a stop of the daemon while the builder is busy doesn't lose them.
// A newer round makes them stale, so they are never typed once one starts.
async function deliver(
  db: Database,
  tmux: string,
  folder: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  // A builder can work long after it submits, but one busy this long has likely hung.
  await typeInto(tmux, folder, text, { timeout: 30 * 60_000, signal });
  if (!signal.aborted) record(db, folder, { telling: null }, "typed the review into the builder");
}

// The latest round of each thread: cancelling it cancels its review, and its push is what
// the next round's push waits for, so two pushes or two PRs never race.
const latest = new Map<string, { cancel: AbortController; pushed: Promise<unknown> }>();

// Keeps the round as the thread's latest, and marks the thread needs you, with the reason,
// when any of it fails, unless a newer round has taken over. `pushed` settles once the
// round's push is done, for the next round's push to wait for.
function follow(
  db: Database,
  folder: string,
  cancel: AbortController,
  pushed: Promise<unknown>,
  rest: Promise<void>,
): void {
  latest.set(folder, { cancel, pushed });
  rest.catch((error) => {
    if (cancel.signal.aborted) return;
    const why = error instanceof Error ? error.message : String(error);
    record(
      db,
      folder,
      { needs_you: true, status: "waiting", telling: null },
      `the round failed: ${why}`,
    );
  });
}

// Pushes the round, after the earlier round's push, then reviews it.
function pushAndReview(
  db: Database,
  tmux: string,
  folder: string,
  summary: string,
  earlier: Promise<unknown>,
): void {
  const cancel = new AbortController();
  const pushed = earlier.then(() => push(db, folder, summary));
  const rest = pushed.then((sha) => reviewRound(db, tmux, folder, sha, cancel.signal));
  follow(db, folder, cancel, pushed, rest);
}

// Starts a round for skel submit, cancelling the thread's older round if one is still under
// way, and returns at once: a shell command can't block long, so pushing and the review go on
// in the background. The submit is saved first, so a stop of the daemon can't lose it. A
// review still waiting to be typed in is dropped, as it is about an older commit. Throws when
// your config isn't valid, so the builder hears why.
export function submitRound(db: Database, tmux: string, folder: string, summary: string): void {
  const { maxRounds } = threadConfig();
  const thread = readThread(db, folder);
  // Past the round limit the thread still needs you, whatever the builder does.
  const needs_you = thread.rounds > maxRounds;
  record(
    db,
    folder,
    { status: "waiting", needs_you, submitting: summary, telling: null },
    `submitted: ${summary}`,
  );
  const before = latest.get(folder);
  before?.cancel.abort();
  pushAndReview(db, tmux, folder, summary, before?.pushed.catch(() => {}) ?? Promise.resolve());
}

// Carries on with a round the daemon's stop cut short: a submit not yet pushed and
// reviewed, a review whose skel/review check was left pending, or changes not yet typed
// into the builder. Pushing again is harmless: GitHub has the commit, or gets it now.
export function resumeRound(db: Database, tmux: string, thread: Thread): void {
  const { folder, submitting, reviewing, telling } = thread;
  const cancel = new AbortController();
  const none = Promise.resolve();
  if (submitting !== null) pushAndReview(db, tmux, folder, submitting, none);
  else if (reviewing !== null)
    follow(db, folder, cancel, none, reviewRound(db, tmux, folder, reviewing, cancel.signal));
  else if (telling !== null)
    follow(db, folder, cancel, none, deliver(db, tmux, folder, telling, cancel.signal));
}
