// A round of the build ⇄ review loop: the builder's skel submit, pushed from skel's clone,
// its PR opened on the first round, reviewed by a fresh reviewer, and the review typed back
// into the builder's session when it asks for changes.
import type { Database } from "bun:sqlite";
import { afterReview } from "./decide.ts";
import {
  findPullRequest,
  openPullRequest,
  postReview,
  pushCommit,
  readIssue,
  setReviewStatus,
} from "./github.ts";
import { tellLead } from "./lead.ts";
import { cloneDir } from "./paths.ts";
import { review, reviewerHarness } from "./reviewer.ts";
import { errorText } from "./say.ts";
import {
  baseOf,
  cloneOf,
  github,
  readThread,
  record,
  type Thread,
  threadConfig,
  threadName,
} from "./thread.ts";
import { typeInto } from "./tmux.ts";

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
    const base = baseOf(thread);
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
  const harness = reviewerHarness(reviewer, process.env.PATH ?? "");
  record(db, folder, { reviewing: sha, submitting: null, reviewer: harness }, `reviewing ${sha}`);
  const verdict = await review({
    clone: cloneOf(thread),
    issue: await readIssue(repo, thread.task),
    // Setting up the thread's clone put the base branch there under origin/.
    base: `origin/${baseOf(thread)}`,
    commit: sha,
    model,
    harness: reviewer,
    signal,
  });
  if (signal.aborted) return;
  const before = readThread(db, folder).rounds;
  const outcome = afterReview(before, verdict, maxRounds);
  if (verdict.verdict !== "failed") {
    const id = await postReview(repo, pr, sha, verdict.verdict, verdict.body);
    db.run("INSERT OR IGNORE INTO posted (id) VALUES (?)", [id]);
  }
  // A newer round may be reviewing the same commit, and its check must stay pending.
  if (signal.aborted) return;
  await setReviewStatus(repo, sha, outcome.check, outcome.description);
  if (signal.aborted) return;
  const { rounds, needsYou, status, tell, held } = outcome;
  const change = {
    reviewing: null,
    rounds,
    needs_you: needsYou,
    status,
    telling: tell,
    held,
    reviewed_by: harness,
    review_round: before + 1,
    verdict: verdict.verdict,
    review_line: verdict.body.trim().split("\n")[0]?.slice(0, 200) ?? "",
  };
  record(db, folder, change, outcome.why);
  tellLead(db, tmux);
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

// The latest round of each thread. Cancelling it cancels its review. The next round's push
// waits for its push, so two pushes or two PRs never race, and the next round's review
// waits for it to end, so its last write to the skel/review check comes before the next
// round's pending one. `ended` tells a round still under way from one that failed.
type Round = {
  cancel: AbortController;
  pushed: Promise<unknown>;
  done: Promise<unknown>;
  ended: boolean;
};
const latest = new Map<string, Round>();

// Keeps the round as the thread's latest, and marks the thread needs you, with the reason,
// when any of it fails, unless a newer round has taken over. `pushed` settles once the
// round's push is done.
function follow(
  db: Database,
  tmux: string,
  folder: string,
  cancel: AbortController,
  pushed: Promise<unknown>,
  rest: Promise<void>,
): void {
  const done = rest.catch((error) => {
    if (cancel.signal.aborted) return;
    const why = errorText(error);
    // A review not yet typed in stays saved, so starting the daemon again can type it.
    record(db, folder, { needs_you: true, status: "waiting" }, `the round failed: ${why}`);
    tellLead(db, tmux);
  });
  const round = { cancel, pushed, done, ended: false };
  done.then(() => {
    round.ended = true;
  });
  latest.set(folder, round);
}

// Pushes the round, after the earlier round's push, then reviews it, once the earlier round
// has ended.
function pushAndReview(
  db: Database,
  tmux: string,
  folder: string,
  summary: string,
  earlier: Round | undefined,
): void {
  const cancel = new AbortController();
  const before = earlier?.pushed.catch(() => {}) ?? Promise.resolve();
  const pushed = before.then(() => push(db, folder, summary));
  const rest = Promise.all([pushed, earlier?.done]).then(([sha]) =>
    reviewRound(db, tmux, folder, sha, cancel.signal),
  );
  follow(db, tmux, folder, cancel, pushed, rest);
}

// Starts a round for skel submit, cancelling the thread's older round if one is still under
// way, and returns at once: a shell command can't block long, so pushing and the review go on
// in the background. The submit is saved first, so a stop of the daemon can't lose it. A
// review still waiting to be typed in, or held past the round limit, is dropped, as it is
// about an older commit. Throws when your config isn't valid, so the builder hears why, and
// for a thread skel stop is ending, whose builder may submit while it exits.
export function submitRound(db: Database, tmux: string, folder: string, summary: string): void {
  const { maxRounds, reviewer } = threadConfig();
  const thread = readThread(db, folder);
  if (thread.status === "stopped")
    throw new Error("this thread was stopped, so skel won't push it");
  // Past the round limit the thread still needs you, whatever the builder does.
  const needs_you = thread.rounds > maxRounds;
  record(
    db,
    folder,
    {
      status: "waiting",
      needs_you,
      submitting: summary,
      telling: null,
      held: null,
      // What CI said was about the commit before this one.
      checks: null,
      reviewer: reviewerHarness(reviewer, process.env.PATH ?? ""),
    },
    `submitted: ${summary}`,
  );
  const before = latest.get(folder);
  before?.cancel.abort();
  pushAndReview(db, tmux, folder, summary, before);
}

// Returns the commit skel last fetched from the thread's clone and pushed, or null when it
// has pushed none. Read at once, with no await, so two skel review can't both start one.
function lastPushed(thread: Thread): string | null {
  const ours = cloneDir(thread.owner, thread.repo);
  const ref = `refs/skel/threads/${thread.folder}^{commit}`;
  const run = Bun.spawnSync(["git", "-C", ours, "rev-parse", "--verify", "--quiet", ref], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.success ? run.stdout.toString().trim() : null;
}

// Reviews the thread's last submitted commit again, for skel review, such as after a review
// that failed, and returns at once, as skel submit does. The review runs like any round's,
// so changes count toward the round limit and a newer skel submit cancels it. A submit whose
// push failed is pushed first. Refuses a thread that is done or stopped, one with nothing
// submitted, and one whose review is still waiting or running, since that review answers
// already.
export function rerunReview(db: Database, tmux: string, folder: string): void {
  const thread = readThread(db, folder);
  const name = threadName(db, thread);
  if (thread.status === "done") throw new Error(`${name} is done, so there is nothing to review`);
  if (thread.status === "stopped")
    throw new Error(`${name} is stopped: run skel start ${name} first`);
  const earlier = latest.get(folder);
  const { submitting, reviewing } = thread;
  if ((submitting !== null || reviewing !== null) && earlier && !earlier.ended)
    throw new Error(`a review of ${name}'s last commit is already waiting or running`);
  const sha = submitting === null && thread.pr !== null ? lastPushed(thread) : null;
  if (submitting === null && sha === null)
    throw new Error(`${name} has no submitted commit to review yet`);
  const { maxRounds } = threadConfig();
  // Past the round limit the thread still needs you, whatever the review says.
  const needs_you = thread.rounds > maxRounds;
  // The commit is saved as under review at once, so a second skel review asked before the
  // check is pending again is refused rather than cancelling this one.
  const change = {
    status: "waiting",
    needs_you,
    telling: null,
    held: null,
    reviewing: sha,
  } satisfies Partial<Thread>;
  record(db, folder, change, "asked to review again");
  earlier?.cancel.abort();
  if (submitting !== null) pushAndReview(db, tmux, folder, submitting, earlier);
  else if (sha !== null) {
    const cancel = new AbortController();
    const rest = Promise.resolve(earlier?.done).then(() =>
      reviewRound(db, tmux, folder, sha, cancel.signal),
    );
    follow(db, tmux, folder, cancel, Promise.resolve(), rest);
  }
}

// Carries on with a round the daemon's stop cut short: a submit not yet pushed and
// reviewed, a review whose skel/review check was left pending, or changes not yet typed
// into the builder. Pushing again is harmless: GitHub has the commit, or gets it now. A
// builder brought back can submit before this runs, and then its newer round wins.
export function resumeRound(db: Database, tmux: string, folder: string): void {
  if (latest.has(folder)) return;
  const { submitting, reviewing, telling } = readThread(db, folder);
  const cancel = new AbortController();
  const none = Promise.resolve();
  if (submitting !== null) pushAndReview(db, tmux, folder, submitting, undefined);
  else if (reviewing !== null)
    follow(db, tmux, folder, cancel, none, reviewRound(db, tmux, folder, reviewing, cancel.signal));
  else if (telling !== null)
    follow(db, tmux, folder, cancel, none, deliver(db, tmux, folder, telling, cancel.signal));
}

// Lets a thread past the round limit go on, for skel start: counts its rounds of changes from
// zero again, so it no longer needs you for them, and types the changes of the review that
// reached the limit into the builder, as a round within the limit would have.
export function goOn(db: Database, tmux: string, folder: string): void {
  const { held } = readThread(db, folder);
  const change = { rounds: 0, needs_you: false, held: null, telling: held };
  record(
    db,
    folder,
    held === null ? change : { ...change, status: "working" },
    "you let it go on past the round limit",
  );
  if (held === null) return;
  const cancel = new AbortController();
  follow(
    db,
    tmux,
    folder,
    cancel,
    Promise.resolve(),
    deliver(db, tmux, folder, held, cancel.signal),
  );
}

// Cancels the thread's round, once its PR is merged or closed or skel stop ends its builder,
// so a review still running never changes a thread that is done or stopped.
export function endRound(folder: string): void {
  latest.get(folder)?.cancel.abort();
  latest.delete(folder);
}
